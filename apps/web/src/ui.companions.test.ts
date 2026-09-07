import { describe, expect, it } from "vitest";
import type { ReceiptDto } from "./types";
import { companionEffectHasEvidence, receiptHasCommandEvidence } from "./ui";

const guest = { fullName: "Companion", nickname: "Guest", phone: null, documentNumber: null };
const input = { orderId: "order_1", action: "ADD", guest };
const effect = { operation: "MANAGE_ORDER_OCCUPANTS", orderId: "order_1", action: "ADD", guest,
  occupantId: "occupant_2", ordinal: 2, arrivalDate: "2026-09-07", departureDate: "2026-09-10",
  beforeCount: 1, afterCount: 2, occupancyCapacity: 2 };
const hash = "a".repeat(64);
const receipt: ReceiptDto = { receiptId: "receipt_1", commandId: "command_1", executionStatus: "EXECUTED", businessCommitted: true,
  correlationId: "companion", committedAt: "2026-09-07T00:00:00Z", resourceRefs: ["order_1", "occupant_2", "amendment_2"], factRefs: [],
  result: { ...effect, amendmentId: "amendment_2", removalId: null, effectHash: hash } };

describe("companion command evidence", () => {
  it("requires correct dates, capacity and the exact requested person before confirmation", () => {
    expect(companionEffectHasEvidence(effect, input)).toBe(true);
    for (const changed of [{ orderId: "other" }, { afterCount: 3 }, { occupancyCapacity: 1 }, { ordinal: 1 },
      { departureDate: "2026-09-07" }, { guest: { ...guest, nickname: "unexpected" } }]) {
      expect(companionEffectHasEvidence({ ...effect, ...changed }, input)).toBe(false);
    }
  });
  it("rejects damaged, mismatched and incomplete committed receipts", () => {
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", receipt, input, effect, hash)).toBe(true);
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", receipt, { orderId: "order_1" }, undefined, hash)).toBe(true);
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", receipt, { orderId: "other" }, undefined, hash)).toBe(false);
    for (const changed of [{ result: {} }, { result: { ...receipt.result, effectHash: "b".repeat(64) } }, { resourceRefs: ["order_1"] },
      { result: { ...receipt.result, afterCount: 1 } }]) {
      expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", { ...receipt, ...changed }, input, effect, hash)).toBe(false);
    }
  });
  it("requires the removal fact and target identity when recovering a removal", () => {
    const removeInput = { orderId: "order_1", action: "REMOVE", occupantId: "occupant_2" };
    const removedEffect = { ...effect, action: "REMOVE", beforeCount: 2, afterCount: 1 };
    const removed = { ...receipt, factRefs: ["removal_1"], result: { ...receipt.result, ...removedEffect, removalId: "removal_1" } };
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", removed, removeInput, removedEffect, hash)).toBe(true);
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", removed, { orderId: "order_1", occupantId: "occupant_2" }, undefined, hash)).toBe(true);
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", { ...removed, factRefs: [] }, removeInput, removedEffect, hash)).toBe(false);
    expect(receiptHasCommandEvidence("MANAGE_ORDER_OCCUPANTS", removed, { ...removeInput, occupantId: "other" }, removedEffect, hash)).toBe(false);
  });
});
