import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EffectSummary,
  receiptHasCommandEvidence,
  resolveMigratedOverdueStayPreviewHasEvidence,
  resolveMigratedOverdueStayReceiptHasEvidence
} from "./ui.tsx";

const input = {
  propertyId: "property_qintopia",
  orderId: "order_zhou_huiling",
  holdId: "hold_zhou_huiling",
  newDepartureDate: "2026-08-15",
  postCutoverIncrementAmountMinor: 12_345
};

function validEffect() {
  return {
    operation: "RESOLVE_MIGRATED_OVERDUE_STAY",
    orderId: input.orderId,
    sourceId: "source_order_lai",
    holdId: input.holdId,
    historicalActualAmountMinor: 34_500,
    postCutoverIncrementAmountMinor: input.postCutoverIncrementAmountMinor,
    newContractAmountMinor: 46_845,
    newDepartureDate: input.newDepartureDate
  };
}

const effectHash = "a".repeat(64);

function validReceipt() {
  const effect = validEffect();
  return {
    receiptId: "receipt_zhou_huiling",
    commandId: "command_zhou_huiling",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation_zhou_huiling",
    result: {
      orderId: effect.orderId,
      amendmentId: "amendment_zhou_huiling",
      staySegmentId: "segment_zhou_huiling",
      pricingRevisionId: "revision_zhou_huiling",
      holdId: effect.holdId,
      holdReleaseId: "release_zhou_huiling",
      historicalActualAmountMinor: effect.historicalActualAmountMinor,
      postCutoverIncrementAmountMinor: effect.postCutoverIncrementAmountMinor,
      newContractAmountMinor: effect.newContractAmountMinor,
      newDepartureDate: effect.newDepartureDate,
      effectHash
    },
    resourceRefs: [
      effect.orderId,
      "amendment_zhou_huiling",
      "segment_zhou_huiling",
      "revision_zhou_huiling",
      effect.holdId
    ],
    factRefs: ["release_zhou_huiling"],
    committedAt: "2026-08-10T12:00:00.000Z"
  };
}

describe("historical overdue-stay preview evidence", () => {
  it("accepts the exact effect bound to the operator input", () => {
    expect(resolveMigratedOverdueStayPreviewHasEvidence(validEffect(), input)).toBe(true);
  });

  it("shows the decision facts without exposing internal source or hold identifiers", () => {
    const markup = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_1",
        commandType: "RESOLVE_MIGRATED_OVERDUE_STAY",
        effect: validEffect(),
        effectHash: "a".repeat(64),
        expiresAt: "2026-08-10T12:00:00.000Z"
      } as never,
      businessCommand: "RESOLVE_MIGRATED_OVERDUE_STAY",
      commandInput: input,
      reasonNote: "人工确认续住"
    }));

    expect(markup).toContain("历史实际金额");
    expect(markup).toContain("切换后续住金额");
    expect(markup).toContain("解除历史占房锁");
    expect(markup).not.toContain("source_order_lai");
    expect(markup).not.toContain("hold_zhou_huiling");
  });

  it.each([
    ["extra data", (effect: ReturnType<typeof validEffect>) => Object.assign(effect, { inventoryUnitId: "room_306" })],
    ["different order", (effect: ReturnType<typeof validEffect>) => { effect.orderId = "order_other"; }],
    ["different hold", (effect: ReturnType<typeof validEffect>) => { effect.holdId = "hold_other"; }],
    ["different departure date", (effect: ReturnType<typeof validEffect>) => { effect.newDepartureDate = "2026-08-16"; }],
    ["different increment", (effect: ReturnType<typeof validEffect>) => { effect.postCutoverIncrementAmountMinor += 1; }],
    ["incorrect new total", (effect: ReturnType<typeof validEffect>) => { effect.newContractAmountMinor += 1; }],
    ["negative historical amount", (effect: ReturnType<typeof validEffect>) => { effect.historicalActualAmountMinor = -1; }]
  ])("rejects %s", (_label, corrupt) => {
    const effect = validEffect();
    corrupt(effect);
    expect(resolveMigratedOverdueStayPreviewHasEvidence(effect, input)).toBe(false);
  });
});

describe("historical overdue-stay committed receipt evidence", () => {
  it("accepts only the committed result bound to input, preview and effect hash", () => {
    const receipt = validReceipt();
    expect(resolveMigratedOverdueStayReceiptHasEvidence(receipt, input, validEffect(), effectHash)).toBe(true);
    expect(receiptHasCommandEvidence(
      "RESOLVE_MIGRATED_OVERDUE_STAY",
      receipt as never,
      input,
      validEffect(),
      effectHash
    )).toBe(true);
  });

  it("keeps recovery queries bound to the original order and effect hash", () => {
    expect(resolveMigratedOverdueStayReceiptHasEvidence(validReceipt(), {
      propertyId: input.propertyId,
      orderId: input.orderId
    }, undefined, effectHash)).toBe(true);
    expect(resolveMigratedOverdueStayReceiptHasEvidence(validReceipt(), {
      propertyId: input.propertyId,
      orderId: "order_other"
    }, undefined, effectHash)).toBe(false);
  });

  it.each([
    ["result has an extra key", (receipt: ReturnType<typeof validReceipt>) => Object.assign(receipt.result, { sourceId: "source_order_lai" })],
    ["input hold differs", (receipt: ReturnType<typeof validReceipt>) => { receipt.result.holdId = "hold_other"; }],
    ["increment differs", (receipt: ReturnType<typeof validReceipt>) => { receipt.result.postCutoverIncrementAmountMinor += 1; }],
    ["total differs", (receipt: ReturnType<typeof validReceipt>) => { receipt.result.newContractAmountMinor += 1; }],
    ["effect hash differs", (receipt: ReturnType<typeof validReceipt>) => { receipt.result.effectHash = "b".repeat(64); }],
    ["missing durable resource", (receipt: ReturnType<typeof validReceipt>) => { receipt.resourceRefs = receipt.resourceRefs.filter((id) => id !== receipt.result.pricingRevisionId); }],
    ["missing hold-release fact", (receipt: ReturnType<typeof validReceipt>) => { receipt.factRefs = []; }],
    ["contains an error", (receipt: ReturnType<typeof validReceipt>) => Object.assign(receipt, { error: { code: "INTERNAL_ERROR" } })]
  ])("rejects %s", (_label, corrupt) => {
    const receipt = validReceipt();
    corrupt(receipt);
    expect(resolveMigratedOverdueStayReceiptHasEvidence(receipt, input, validEffect(), effectHash)).toBe(false);
    expect(receiptHasCommandEvidence(
      "RESOLVE_MIGRATED_OVERDUE_STAY",
      receipt as never,
      input,
      validEffect(),
      effectHash
    )).toBe(false);
  });

  it("rejects a receipt when the preview effect differs or the command type is different", () => {
    const receipt = validReceipt();
    const alteredPreview = { ...validEffect(), newDepartureDate: "2026-08-16" };
    expect(resolveMigratedOverdueStayReceiptHasEvidence(receipt, input, alteredPreview, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("EXTEND_STAY", receipt as never, input, validEffect(), effectHash)).toBe(false);
  });
});
