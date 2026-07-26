import { describe, expect, it } from "vitest";
import { DomainError } from "@qintopia/contracts";
import {
  normalizeChannelOrderReference,
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

  it.each(["YOUMUDAO", "CTRIP", "MEITUAN"] as const)("requires channel order reference for %s orders", (code) => {
    expect(validateBookingChannel(code, `  ${code.toLowerCase()}-123  `)).toEqual({ bookingChannelCode: code, channelOrderReference: `${code.toLowerCase()}-123` });
    expect(() => validateBookingChannel(code, null)).toThrow(/channelOrderReference is required/);
    expect(() => validateBookingChannel(code, "   ")).toThrow(/channelOrderReference is required/);
  });

  it("normalizes and requires a real transaction reference", () => {
    expect(requireTransactionReference("  txn-123  ")).toBe("txn-123");
    expect(() => requireTransactionReference(undefined)).toThrow(/transactionReference is required/);
    expect(() => requireTransactionReference("   ")).toThrow(/transactionReference is required/);
  });
});
