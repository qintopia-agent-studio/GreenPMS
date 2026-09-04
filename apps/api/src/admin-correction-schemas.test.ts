import { FormatRegistry } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CommandEnvelopeSchema, ExecutedCommandResultSchema } from "./schemas.ts";

FormatRegistry.Set("date-time", (value) => typeof value === "string" && Number.isFinite(Date.parse(value)));

const propertyId = "property_demo";

const validEnvelopes = [
  {
    commandType: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
    input: {
      propertyId,
      correctionSet: [{
        orderId: "order_a",
        expectedVersion: 3,
        target: {
          arrivalDate: "2026-08-10",
          departureDate: "2026-08-13",
          inventoryUnitId: "unit_108"
        }
      }],
      evidenceNote: "交接表与入住登记复核一致"
    }
  },
  {
    commandType: "CORRECT_MEMBER_PROFILE",
    input: {
      propertyId,
      memberId: "member_a",
      expectedPriorProfile: {
        fullName: "王晶晶",
        nickname: "晶晶",
        identityCardNumber: "510000000000000001",
        phone: "13800000001",
        wechat: "jingjing-old"
      },
      correctedProfile: {
        fullName: "王晶",
        nickname: "晶晶",
        identityCardNumber: "510000000000000001",
        phone: "13800000001",
        wechat: "jingjing"
      },
      evidenceNote: "本人证件与企微资料复核"
    }
  },
  {
    commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
    input: {
      propertyId,
      membershipOrderId: "membership_order_a",
      actualMembershipDate: "2026-08-10",
      evidenceNote: "企微收款凭证日期"
    }
  },
  {
    commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
    input: {
      propertyId,
      memberId: "member_a",
      membershipProductId: "membership_product_shared_bath_quad_v1",
      actualMembershipDate: "2026-08-10",
      payment: {
        amountMinor: 93600,
        businessDate: "2026-08-12",
        transactionReference: "WECOM-HISTORY-001",
        note: "切换期晚录"
      },
      evidenceNote: "企微账单与纸质合同复核"
    }
  },
  {
    commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
    input: {
      propertyId,
      erroneousMembershipOrderId: "membership_order_wrong",
      sourceStayOrderId: "order_history",
      actualMembershipDate: "2026-08-10",
      replacementDirectPayment: {
        businessDate: "2026-08-09",
        transactionReference: "WECOM-DIFFERENCE-001"
      },
      evidenceNote: "住宿收款与升级差额凭证复核"
    }
  }
] as const;

describe("step 9 administrator correction command schemas", () => {
  it("accepts only source facts for all five typed commands", () => {
    for (const envelope of validEnvelopes) {
      expect(Value.Check(CommandEnvelopeSchema, envelope), envelope.commandType).toBe(true);
    }
  });

  it("rejects client-authored derived dates, balances, prices, and reversal amounts", () => {
    const forbiddenFields = [
      { commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE", field: "validUntil", value: "2027-08-10" },
      { commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE", field: "targetAvailableBalance", value: 30 },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "listedPriceMinor", value: 162_000 },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "agreedPriceMinor", value: 100_000 },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "priceAdjustmentMinor", value: -62_000 },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "priceAdjustmentReason", value: "历史特批价格" },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "entitlementUnits", value: 99 },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP", field: "contractStatus", value: "ACTIVE" },
      { commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", field: "reversalAmountMinor", value: 93600 },
      { commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", field: "remainingUnits", value: 30 }
    ] as const;

    for (const forbidden of forbiddenFields) {
      const base = validEnvelopes.find((candidate) => candidate.commandType === forbidden.commandType)!;
      expect(Value.Check(CommandEnvelopeSchema, {
        ...base,
        input: { ...base.input, [forbidden.field]: forbidden.value }
      }), `${forbidden.commandType}:${forbidden.field}`).toBe(false);
    }

    const voidEnvelope = validEnvelopes.find((candidate) =>
      candidate.commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY")!;
    expect(Value.Check(CommandEnvelopeSchema, {
      ...voidEnvelope,
      input: {
        ...voidEnvelope.input,
        replacementDirectPayment: {
          ...voidEnvelope.input.replacementDirectPayment,
          amountMinor: 73_600
        }
      }
    })).toBe(false);
  });

  it("accepts independent membership and payment dates but rejects precise payment timestamps", () => {
    const backfillEnvelope = validEnvelopes.find((candidate) =>
      candidate.commandType === "BACKFILL_HISTORICAL_MEMBERSHIP")!;
    expect(Value.Check(CommandEnvelopeSchema, backfillEnvelope)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...backfillEnvelope,
      input: {
        ...backfillEnvelope.input,
        payment: {
          ...backfillEnvelope.input.payment,
          businessOccurredAt: "2026-08-12T12:30:00.000+08:00"
        }
      }
    })).toBe(false);

    const voidEnvelope = validEnvelopes.find((candidate) =>
      candidate.commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY")!;
    expect(Value.Check(CommandEnvelopeSchema, voidEnvelope)).toBe(true);
    expect(Value.Check(CommandEnvelopeSchema, {
      ...voidEnvelope,
      input: {
        ...voidEnvelope.input,
        replacementDirectPayment: {
          ...voidEnvelope.input.replacementDirectPayment,
          businessOccurredAt: "2026-08-09T12:30:00.000+08:00"
        }
      }
    })).toBe(false);
  });

  it("requires a durable audit narrative in administrator correction receipts", () => {
    expect(Value.Check(ExecutedCommandResultSchema, {
      memberId: "member_a",
      correctionId: "fact_profile_a",
      changedFields: ["phone"],
      before: {
        fullName: "王晶晶",
        nickname: "晶晶",
        identityCardNumber: "510000000000000001",
        phone: "13800000001",
        wechat: "jingjing-old"
      },
      after: {
        fullName: "王晶晶",
        nickname: "晶晶",
        identityCardNumber: "510000000000000001",
        phone: "13800000002",
        wechat: "jingjing-old"
      },
      reason: { code: "DATA_ENTRY_CORRECTION", note: "核对会员资料" },
      evidenceNote: "本人证件与企微资料复核",
      actor: { subjectId: "subject_admin", displayName: "管理员" },
      recordedAt: "2026-09-03T08:00:00.000Z",
      effectHash: "a".repeat(64)
    })).toBe(true);
  });
});
