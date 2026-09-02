import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { CommandEffectSchema, CommandEnvelopeSchema, ReceiptSchema } from "../../apps/api/src/schemas.ts";

const expiresAt = "2029-01-01T00:00:00.000Z";
const previousExpiresAt = "2030-01-01T00:00:00.000Z";
const commandCeiling = ["REPRICE_ORDER"];
const persistedCommandCeiling = commandCeiling;

FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));

describe("Token authorization effect and Receipt contract", () => {
  it("keeps client Token ceilings human-grantable and server persistence implicit", () => {
    const envelope = {
      commandType: "ISSUE_TOKEN",
      input: {
        propertyId: "property_contract",
        subjectId: "subject_contract",
        label: "Contract Token",
        accessCeiling: "WRITE",
        commandCeiling,
        expiresAt,
        tokenSecret: `qtp_${"A".repeat(43)}`
      }
    };
    expect(Value.Check(CommandEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, commandCeiling: ["PLACE_INTERNAL_USE"] }
    })).toBe(false);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...envelope,
      input: { ...envelope.input, persistedCommandCeiling }
    })).toBe(false);
  });

  it("requires authoritative subject and persisted-ceiling facts in every Token lifecycle effect", () => {
    const issueEffect = {
      subjectId: "subject_contract",
      subjectDisplayName: "Test Staff",
      label: "Contract Token",
      accessCeiling: "WRITE",
      commandCeiling,
      persistedCommandCeiling,
      expiresAt
    };
    const rotateEffect = {
      tokenId: "token_contract_old",
      subjectId: "subject_contract",
      subjectDisplayName: "Test Staff",
      label: "Contract Token",
      accessCeiling: "WRITE",
      previousCommandCeiling: ["CREATE_ORDER", "REPRICE_ORDER"],
      commandCeiling,
      previousPersistedCommandCeiling: ["CREATE_ORDER", "PLACE_INTERNAL_USE", "REPRICE_ORDER"],
      persistedCommandCeiling,
      previousExpiresAt,
      expiresAt,
      historicalReadCeilingPreserved: false,
      operation: "ROTATE"
    };
    const revokeEffect = {
      tokenId: "token_contract_new",
      subjectId: "subject_contract",
      subjectDisplayName: "Test Staff",
      label: "Contract Token",
      accessCeiling: "WRITE",
      commandCeiling,
      persistedCommandCeiling,
      expiresAt,
      historicalReadCeilingPreserved: false,
      operation: "REVOKE"
    };

    for (const effect of [issueEffect, rotateEffect, revokeEffect]) {
      expect(Value.Check(CommandEffectSchema, effect)).toBe(true);
      const { subjectDisplayName: _subjectDisplayName, ...withoutDisplayName } = effect;
      expect(Value.Check(CommandEffectSchema, withoutDisplayName)).toBe(false);
      const { persistedCommandCeiling: _persistedCommandCeiling, ...withoutPersistedCeiling } = effect;
      expect(Value.Check(CommandEffectSchema, withoutPersistedCeiling)).toBe(false);
    }
  });

  it("validates a rotation Receipt whose persisted ceiling equals the explicit narrowed range", () => {
    expect(Value.Check(ReceiptSchema, {
      receiptId: "receipt_contract",
      commandId: "command_contract",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_contract",
      result: {
        tokenId: "token_contract_new",
        rotatedFromTokenId: "token_contract_old",
        subjectId: "subject_contract",
        subjectDisplayName: "Test Staff",
        label: "Contract Token",
        accessCeiling: "WRITE",
        previousCommandCeiling: ["CREATE_ORDER", "REPRICE_ORDER"],
        commandCeiling,
        previousPersistedCommandCeiling: ["CREATE_ORDER", "PLACE_INTERNAL_USE", "REPRICE_ORDER"],
        persistedCommandCeiling,
        previousExpiresAt,
        expiresAt,
        historicalReadCeilingPreserved: false
      },
      resourceRefs: ["token_contract_old", "token_contract_new", "subject_contract"],
      factRefs: [],
      committedAt: expiresAt
    })).toBe(true);
  });
});
