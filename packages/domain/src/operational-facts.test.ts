import { describe, expect, it } from "vitest";
import { DomainError } from "@qintopia/contracts";
import {
  createOrderPricingDecision,
  normalizeChannelOrderReference,
  channelPriceDifferenceExceedsThreshold,
  parseBookingChannelCode,
  requireTransactionReference,
  validateBookingChannel
} from "./operational-facts.ts";

describe("operational fact identifiers", () => {
  it.each(["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"] as const)("accepts booking channel %s", (code) => {
    expect(parseBookingChannelCode(code)).toBe(code);
  });

  it("rejects unknown or free-text booking channels", () => {
    expect(() => parseBookingChannelCode("LEGACY")).toThrow(DomainError);
    expect(() => parseBookingChannelCode("wecom")).toThrow(/bookingChannelCode/);
  });

  it("normalizes optional channel order references without inventing a value", () => {
    expect(normalizeChannelOrderReference(undefined)).toBeNull();
    expect(normalizeChannelOrderReference(null)).toBeNull();
    expect(normalizeChannelOrderReference("   ")).toBeNull();
    expect(normalizeChannelOrderReference("  ctrip-123  ")).toBe("ctrip-123");
  });

  it("requires WECOM orders to have no channel order reference", () => {
    expect(validateBookingChannel("WECOM", null)).toEqual({ bookingChannelCode: "WECOM", channelOrderReference: null });
    expect(() => validateBookingChannel("WECOM", "wx-123")).toThrow(/must be null for WECOM/);
  });

  it("uses exact integer arithmetic for the external-channel 15 percent threshold", () => {
    expect(channelPriceDifferenceExceedsThreshold(100_000, 85_000)).toBe(false);
    expect(channelPriceDifferenceExceedsThreshold(100_000, 115_000)).toBe(false);
    expect(channelPriceDifferenceExceedsThreshold(100_000, 84_000)).toBe(true);
    expect(channelPriceDifferenceExceedsThreshold(100_000, 116_000)).toBe(true);
    expect(channelPriceDifferenceExceedsThreshold(2_147_483_600, 2_147_483_600)).toBe(false);
  });

  it.each(["YOUMUDAO", "CTRIP", "MEITUAN"] as const)("requires channel order reference for %s orders", (code) => {
    expect(validateBookingChannel(code, `  ${code.toLowerCase()}-123  `)).toEqual({ bookingChannelCode: code, channelOrderReference: `${code.toLowerCase()}-123` });
    expect(() => validateBookingChannel(code, null)).toThrow(/channelOrderReference is required/);
    expect(() => validateBookingChannel(code, "   ")).toThrow(/channelOrderReference is required/);
  });

  it.each([
    [85_000, -15_000],
    [115_000, 15_000]
  ])("accepts an external channel contract amount exactly 15%% from policy (%s)", (targetCurrentContractAmountMinor, differenceFromPolicyMinor) => {
    expect(createOrderPricingDecision({
      bookingChannelCode: "CTRIP",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000,
      targetCurrentContractAmountMinor
    })).toEqual({
      pricingBasis: "CHANNEL_CONTRACT",
      policyBaseAmountMinor: 100_000,
      currentContractAmountMinor: targetCurrentContractAmountMinor,
      differenceFromPolicyMinor,
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "" }
    });
  });

  it.each([84_000, 116_000])("requires a channel price difference reason above 15%% (%s)", (targetCurrentContractAmountMinor) => {
    const base = {
      bookingChannelCode: "MEITUAN" as const,
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000,
      targetCurrentContractAmountMinor
    };
    expect(() => createOrderPricingDecision(base)).toThrow(/channelPriceDifferenceReason is required/);
    expect(createOrderPricingDecision({ ...base, channelPriceDifferenceReason: "平台活动合同价" })).toMatchObject({
      pricingBasis: "CHANNEL_CONTRACT",
      currentContractAmountMinor: targetCurrentContractAmountMinor,
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: true,
      reason: { code: "CREATE_ORDER_CHANNEL_CONTRACT", note: "平台活动合同价" }
    });
  });

  it("uses policy price for WECOM and requires an explicit reason for a manual deviation", () => {
    expect(createOrderPricingDecision({
      bookingChannelCode: "WECOM",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000
    })).toMatchObject({
      pricingBasis: "POLICY",
      currentContractAmountMinor: 100_000,
      manualAdjustmentMinor: 0,
      reason: { code: "CREATE_ORDER_POLICY_PRICE", note: "" }
    });
    expect(() => createOrderPricingDecision({
      bookingChannelCode: "WECOM",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000,
      targetCurrentContractAmountMinor: 95_000
    })).toThrow(/manualPriceAdjustmentReason is required/);
    expect(createOrderPricingDecision({
      bookingChannelCode: "WECOM",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000,
      targetCurrentContractAmountMinor: 95_000,
      manualPriceAdjustmentReason: "店长批准协议价"
    })).toMatchObject({
      pricingBasis: "MANUAL_ADJUSTMENT",
      differenceFromPolicyMinor: -5_000,
      manualAdjustmentMinor: -5_000,
      reason: { code: "CREATE_ORDER_MANUAL_PRICE", note: "店长批准协议价" }
    });
  });

  it("requires a target amount for paid orders and rejects pricing overrides for free and member stays", () => {
    expect(() => createOrderPricingDecision({
      bookingChannelCode: "YOUMUDAO",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000
    })).toThrow(/targetCurrentContractAmountMinor is required/);
    expect(() => createOrderPricingDecision({
      bookingChannelCode: null,
      stayType: "FREE",
      memberStay: false,
      policyBaseAmountMinor: 0,
      targetCurrentContractAmountMinor: 0
    })).toThrow(/must not be submitted for FREE or member stays/);
    expect(() => createOrderPricingDecision({
      bookingChannelCode: null,
      stayType: "TRANSIENT",
      memberStay: true,
      policyBaseAmountMinor: 0,
      targetCurrentContractAmountMinor: 0
    })).toThrow(/must not be submitted for FREE or member stays/);
    expect(() => createOrderPricingDecision({
      bookingChannelCode: "CTRIP",
      stayType: "TRANSIENT",
      memberStay: false,
      policyBaseAmountMinor: 100_000,
      targetCurrentContractAmountMinor: 84_050,
      channelPriceDifferenceReason: "非法角分金额"
    })).toThrow(/whole-yuan/);
  });

  it("normalizes and requires a real transaction reference", () => {
    expect(requireTransactionReference("  txn-123  ")).toBe("txn-123");
    expect(() => requireTransactionReference(undefined)).toThrow(/transactionReference is required/);
    expect(() => requireTransactionReference("   ")).toThrow(/transactionReference is required/);
  });
});
