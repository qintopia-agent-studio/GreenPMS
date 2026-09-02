import { describe, expect, it } from "vitest";
import type { RetainedTokenSecret, TokenDto } from "../types";
import {
  coordinateTokenPreviewProgress,
  generateTokenSecret,
  retainedTokenCommandUnresolved,
  TOKEN_SECRET_BYTES,
  tokenCommandCeilingForSubmit,
  tokenCommandCeilingOptions,
  tokenHistoricalReadCeilingHint,
  tokenLifecycleStatus,
  tokenLifecycleStatusLabel,
  tokenRotationRelationshipLabel,
  updateMatchingRetainedSecret,
  updateMatchingRetainedSecretForAttempt
} from "./TokensPage";

function token(overrides: Partial<TokenDto> = {}): TokenDto {
  return {
    subjectId: "subject_test",
    displayName: "前台",
    id: "token_test",
    label: "Test token",
    access_ceiling: "READ",
    property_scope: "property_test",
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    commandCeiling: [],
    persistedCommandCeiling: [],
    historicalReadCeilingPreserved: false,
    ...overrides
  };
}

describe("Token secret generation", () => {
  it("requests exactly 256 bits and returns a qtp_ base64url secret", () => {
    let requestedBytes = 0;
    const secret = generateTokenSecret((bytes) => {
      requestedBytes = bytes.byteLength;
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    });

    expect(requestedBytes).toBe(TOKEN_SECRET_BYTES);
    expect(secret).toMatch(/^qtp_[A-Za-z0-9_-]{43}$/);
    expect(secret).not.toContain("=");
  });

  it("rejects an injected entropy source with the wrong shape", () => {
    expect(() => generateTokenSecret(() => new Uint8Array(31))).toThrow(/exactly 32 bytes/);
  });
});

describe("Token lifecycle status", () => {
  const now = new Date("2028-01-01T00:00:00.000Z");

  it("distinguishes active, expired, revoked, and rotated tokens", () => {
    expect(tokenLifecycleStatus(token(), now)).toBe("ACTIVE");
    expect(tokenLifecycleStatus(token({ expires_at: "2027-12-31T23:59:59.000Z" }), now)).toBe("EXPIRED");
    expect(tokenLifecycleStatus(token({ revoked_at: "2027-01-01T00:00:00.000Z" }), now)).toBe("REVOKED");
    expect(tokenLifecycleStatus(token({ revoked_at: "2027-01-01T00:00:00.000Z", replaced_by_id: "token_replacement" }), now)).toBe("ROTATED");
  });

  it("uses business status and relationship copy without exposing rotation IDs", () => {
    expect(tokenLifecycleStatusLabel("ACTIVE")).toBe("有效");
    expect(tokenLifecycleStatusLabel("EXPIRED")).toBe("已过期");
    expect(tokenLifecycleStatusLabel("REVOKED")).toBe("已撤销");
    expect(tokenLifecycleStatusLabel("ROTATED")).toBe("已轮换");

    const relationship = tokenRotationRelationshipLabel({
      rotated_from_id: "token_internal_previous",
      replaced_by_id: "token_internal_next"
    });
    expect(relationship).toBe("由旧 Token 轮换生成，现已由新 Token 替换");
    expect(relationship).not.toContain("token_internal");
  });
});

describe("Token command ceiling", () => {
  it("uses the exact intersection of target grants, caller actions, and optional current ceiling", () => {
    const options = tokenCommandCeilingOptions(
      ["CREATE_ORDER", "REPRICE_ORDER", "ISSUE_TOKEN", "REPRICE_ORDER"],
      new Set(["CREATE_ORDER", "ISSUE_TOKEN", "REVOKE_TOKEN"]),
      ["CREATE_ORDER", "REPRICE_ORDER"]
    );

    expect(options).toEqual(["CREATE_ORDER"]);
    expect(tokenCommandCeilingForSubmit("READ", ["CREATE_ORDER"])).toEqual([]);
    expect(tokenCommandCeilingForSubmit("WRITE", ["CREATE_ORDER", "CREATE_ORDER", "ISSUE_TOKEN"])).toEqual(["CREATE_ORDER", "ISSUE_TOKEN"]);
  });

  it("uses only the server-owned historical flag for list copy", () => {
    const hint = tokenHistoricalReadCeilingHint(token({
      access_ceiling: "WRITE",
      commandCeiling: ["REPRICE_ORDER"],
      persistedCommandCeiling: ["REPRICE_ORDER", "PLACE_INTERNAL_USE"],
      historicalReadCeilingPreserved: true
    }));

    expect(hint).toBe("系统保留历史结果查询与恢复范围");
    expect(hint).not.toContain("PLACE_INTERNAL_USE");
    expect(tokenHistoricalReadCeilingHint(token({
      access_ceiling: "WRITE",
      commandCeiling: ["REPRICE_ORDER"],
      persistedCommandCeiling: ["REPRICE_ORDER", "PLACE_INTERNAL_USE"],
      historicalReadCeilingPreserved: false
    }))).toBeNull();
  });
});

describe("retained Token command identity", () => {
  const retained: RetainedTokenSecret = {
    operationId: "operation-a",
    propertyId: "property_test",
    operation: "ISSUE",
    label: "Agent A",
    value: `qtp_${"A".repeat(43)}`,
    command: {
      commandType: "ISSUE_TOKEN",
      title: "Issue",
      description: "Issue test Token",
      input: { propertyId: "property_test" }
    },
    state: "CONFIRMING",
    confirmationKey: "confirm-a"
  };

  it("ignores a delayed callback from another secret operation", () => {
    expect(updateMatchingRetainedSecret(retained, "operation-old", { state: "EXECUTED" })).toBe(retained);
    expect(updateMatchingRetainedSecret(retained, "operation-a", { state: "UNKNOWN" })).toEqual({
      ...retained,
      state: "UNKNOWN"
    });
  });

  it("does not let a superseded dialog attempt regress the resolved operation", () => {
    const previewMetadata = { idempotencyKey: "preview-key", correlationId: "preview-correlation" };
    let current: RetainedTokenSecret | undefined = { ...retained, state: "PREVIEW_UNKNOWN", previewMetadata };

    current = updateMatchingRetainedSecretForAttempt(current, "operation-a", "attempt-new", "attempt-new", {
      state: "PREVIEWED",
      previewMetadata,
      previewId: "preview-a"
    });
    current = updateMatchingRetainedSecretForAttempt(current, "operation-a", "attempt-new", "attempt-new", {
      state: "CONFIRMING",
      previewId: "preview-a",
      confirmationKey: "confirm-a"
    });
    current = updateMatchingRetainedSecretForAttempt(current, "operation-a", "attempt-new", "attempt-new", {
      state: "EXECUTED",
      confirmationKey: "confirm-a"
    });
    const resolved = current;

    current = updateMatchingRetainedSecretForAttempt(current, "operation-a", "attempt-new", "attempt-old", {
      state: "PREVIEW_UNKNOWN",
      previewMetadata: { idempotencyKey: "old-key", correlationId: "old-correlation" }
    });

    expect(current).toBe(resolved);
    expect(current).toMatchObject({ state: "EXECUTED", previewId: "preview-a", confirmationKey: "confirm-a" });
  });

  it("blocks clearing while Preview or Confirm remains unresolved", () => {
    expect(retainedTokenCommandUnresolved(retained)).toBe(true);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "PREVIEWING" })).toBe(true);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "PREVIEW_UNKNOWN" })).toBe(true);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "PREVIEWED" })).toBe(true);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "UNKNOWN" })).toBe(true);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "NOT_EXECUTED" })).toBe(false);
    expect(retainedTokenCommandUnresolved({ ...retained, state: "EXECUTED" })).toBe(false);
  });

  it("routes Token Preview through the property recovery coordinator before sending", async () => {
    let previewCalls = 0;
    const progress = {
      state: "PREVIEWING" as const,
      previewMetadata: { idempotencyKey: "preview-token", correlationId: "correlation-token" },
      executePreview: async () => { previewCalls += 1; }
    };
    const accepted = await coordinateTokenPreviewProgress(
      retained.command,
      progress,
      async () => false
    );

    expect(accepted).toBe(false);
    expect(previewCalls).toBe(0);
  });
});
