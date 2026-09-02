import { describe, expect, it } from "vitest";
import { projectMeResponse, projectTokenListCommandCeiling, tokenManagementQueryCommand, webOriginAllowlist } from "./server.ts";

describe("webOriginAllowlist", () => {
  it("accepts both loopback spellings in local development", () => {
    expect(webOriginAllowlist(undefined, undefined)).toEqual([
      "http://127.0.0.1:4173",
      "http://localhost:4173"
    ]);
  });

  it("uses the configured local web port for alternate development servers", () => {
    expect(webOriginAllowlist(undefined, "4174")).toEqual([
      "http://127.0.0.1:4174",
      "http://localhost:4174"
    ]);
  });

  it("keeps an explicitly configured deployment origin strict", () => {
    expect(webOriginAllowlist("  https://pms.example.com  ", "4174")).toEqual([
      "https://pms.example.com"
    ]);
  });
});

describe("projectMeResponse", () => {
  it("projects per-property exact grants while allowed actions require WRITE and enabled features", () => {
    const response = projectMeResponse({
      subjectId: "subject_operator",
      credentialId: "session_operator",
      credentialType: "SESSION",
      displayName: "前台",
      propertyAccess: new Map([
        ["property_write", "WRITE"],
        ["property_read", "READ"]
      ]),
      propertyCommandGrants: new Map([
        ["property_write", new Set([
          "CREATE_ORDER",
          "REPRICE_ORDER",
          "ISSUE_TOKEN",
          "COMPLETE_CLEANING",
          "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
          "BACKFILL_COMPLETED_STAY",
          "ADMIN",
          "REPRICE_*"
        ])],
        ["property_read", new Set(["CREATE_ORDER", "PLACE_INTERNAL_USE"])],
        ["property_other", new Set(["ISSUE_TOKEN"])]
      ])
    });

    expect(response.propertyCommandGrants).toEqual({
      property_write: [
        "CREATE_ORDER",
        "REPRICE_ORDER",
        "COMPLETE_CLEANING",
        "ISSUE_TOKEN",
        "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
        "BACKFILL_COMPLETED_STAY"
      ],
      property_read: ["CREATE_ORDER", "PLACE_INTERNAL_USE"]
    });
    expect(response.allowedActions).toEqual({
      property_write: ["CREATE_ORDER", "REPRICE_ORDER", "ISSUE_TOKEN"],
      property_read: []
    });
  });

  it("fails closed when a Token principal has no command-ceiling snapshot", () => {
    const response = projectMeResponse({
      subjectId: "subject_token",
      credentialId: "token_without_ceiling_snapshot",
      credentialType: "TOKEN",
      displayName: "Token caller",
      propertyAccess: new Map([["property_write", "WRITE"]]),
      propertyCommandGrants: new Map([["property_write", new Set(["CREATE_ORDER", "ISSUE_TOKEN"])]])
    });

    expect(response.propertyCommandGrants).toEqual({ property_write: [] });
    expect(response.allowedActions).toEqual({ property_write: [] });
  });
});

describe("tokenManagementQueryCommand", () => {
  it("selects an exact lifecycle grant that also remains inside a Token ceiling", () => {
    const principal = {
      subjectId: "subject_token_manager",
      credentialType: "TOKEN" as const,
      displayName: "Token manager",
      propertyAccess: new Map([["property_test", "WRITE" as const]]),
      propertyCommandGrants: new Map([["property_test", new Set(["ROTATE_TOKEN", "REVOKE_TOKEN"])]]),
      tokenCommandCeiling: new Set(["REVOKE_TOKEN"])
    };

    expect(tokenManagementQueryCommand(principal, "property_test")).toBe("REVOKE_TOKEN");
    expect(tokenManagementQueryCommand(principal, "property_test", ["ISSUE_TOKEN"])).toBe("ISSUE_TOKEN");
  });
});

describe("projectTokenListCommandCeiling", () => {
  it("separates current executable scope from authoritative persisted scope", () => {
    expect(projectTokenListCommandCeiling("WRITE", new Set([
      "REPRICE_ORDER",
      "PLACE_INTERNAL_USE",
      "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      "UNKNOWN_COMMAND"
    ]))).toEqual({
      commandCeiling: ["REPRICE_ORDER"],
      persistedCommandCeiling: ["REPRICE_ORDER", "CORRECT_HISTORICAL_STAY_ARRANGEMENTS", "PLACE_INTERNAL_USE"],
      historicalReadCeilingPreserved: true
    });
  });

  it("fails closed for READ Token rows even if stale ceiling rows are present", () => {
    expect(projectTokenListCommandCeiling("READ", new Set(["REPRICE_ORDER", "PLACE_INTERNAL_USE"]))).toEqual({
      commandCeiling: [],
      persistedCommandCeiling: [],
      historicalReadCeilingPreserved: false
    });
  });
});
