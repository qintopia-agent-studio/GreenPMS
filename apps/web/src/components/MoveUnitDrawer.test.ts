import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InventoryUnitDto, OrderViewDto, UnitAvailabilityDto } from "../types";
import { moveUnitPreviewHasEvidence, moveUnitReceiptHasEvidence } from "../ui";
import {
  buildMoveUnitRequest,
  MoveUnitDrawer,
  inventoryUnitAtDate,
  moveUnitCandidateDisplayName,
  moveUnitCandidateLabel,
  moveUnitCandidateMatches,
  moveUnitCandidateOptionStatusLabel,
  moveUnitCandidateStatusLabel,
  moveUnitInitialDraft
} from "./MoveUnitDrawer";

const units: InventoryUnitDto[] = [
  {
    id: "room_1", property_id: "property_1", kind: "ROOM", parent_room_id: null, code: "101", name: "标准间",
    active: true, catalog_version: "v1", building_code: "1", room_type_code: "STANDARD", pricing_product_code: "ROOM-2",
    inventory_basis: "INDEPENDENT", code_provenance: "SOURCE_EXPLICIT", physical_bed_count: 2, occupancy_capacity: 2
  },
  {
    id: "room_2", property_id: "property_1", kind: "ROOM", parent_room_id: null, code: "202", name: "202 · 四人间（公卫）",
    active: true, catalog_version: "v1", building_code: "2", room_type_code: "DORM4", pricing_product_code: "ROOM-4",
    inventory_basis: "WHOLE_ROOM_COMBINATION", code_provenance: "SOURCE_EXPLICIT", physical_bed_count: 4, occupancy_capacity: 4
  },
  {
    id: "bed_1", property_id: "property_1", kind: "BED", parent_room_id: "room_2", code: "202-A", name: "202 · 床位 A",
    active: true, catalog_version: "v1", building_code: "2", room_type_code: "DORM4", pricing_product_code: "BED-1",
    inventory_basis: "WHOLE_ROOM_COMBINATION", code_provenance: "SOURCE_EXPLICIT", physical_bed_count: null, occupancy_capacity: 1
  }
];

function view(orderOverrides: Partial<OrderViewDto["order"]> = {}): OrderViewDto {
  return {
    accessLevel: "WRITE",
    allowedActions: [{ code: "MOVE_UNIT", enabled: true, disabledReason: null }],
    order: {
      id: "order_1", property_id: "property_1", status: "RESERVED", stay_type: "TRANSIENT",
      arrival_date: "2026-08-02", departure_date: "2026-08-04", primary_guest_snapshot: { nickname: "青山" },
      booking_channel_code: "CTRIP", channel_order_reference: "CTRIP-1", free_stay_reason: null,
     free_stay_category_code: null, pricing_policy_version_id: "policy_1", member_id: null, member_contract_id: null,
      current_revision_id: "revision_1", current_contract_amount_minor: 10_000, currency: "CNY", version: 1, created_at: "2026-08-01T08:00:00.000Z", updated_at: "2026-08-01T08:00:00.000Z",
      ...orderOverrides
    },
    occupants: [], occupantCorrections: [], stay: { id: "stay_1", status: "PLANNED" },
    currentSegment: { id: "segment_1", sequence: 1, inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" },
    segments: [],
    originalArrangement: { arrivalDate: "2026-08-02", departureDate: "2026-08-04", intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" }] },
    effectiveArrangement: { arrivalDate: "2026-08-02", departureDate: "2026-08-04", intervals: [{ inventoryUnitId: "room_1", arrivalDate: "2026-08-02", departureDate: "2026-08-04" }], presentation: "CURRENT", businessDate: "2026-08-01" },
    fulfillment: { state: "NOT_CHECKED_IN", checkIn: null, checkOut: null, checkInRevocation: null }, arrangementHistory: [], amendments: [], pricingRevisions: [],
    coverageSet: [], collectionFacts: [], cleaningTasks: [],
    amounts: {
      currentContractAmount: { currency: "CNY", minorUnits: 20_000 }, netRecordedCollection: { currency: "CNY", minorUnits: 0 },
      collectionDifference: { currency: "CNY", minorUnits: 20_000 }, refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
    }
  };
}

function unitRecord(id: string, code: string) {
  return {
    id, propertyId: "property_1", kind: "ROOM", roomId: id, code, name: `${code} 房`, catalogVersion: "v1",
    buildingCode: "1", roomTypeCode: "STANDARD", pricingProductCode: "ROOM-2", inventoryBasis: "INDEPENDENT",
    codeProvenance: "SOURCE_EXPLICIT", physicalBedCount: 2, occupancyCapacity: 2
  };
}

function availability(unit: InventoryUnitDto, available: boolean): UnitAvailabilityDto {
  return {
    id: unit.id,
    propertyId: unit.property_id,
    kind: unit.kind,
    roomId: unit.kind === "ROOM" ? unit.id : unit.parent_room_id!,
    code: unit.code,
    name: unit.name,
    catalogVersion: unit.catalog_version,
    buildingCode: unit.building_code,
    roomTypeCode: unit.room_type_code,
    pricingProductCode: unit.pricing_product_code,
    inventoryBasis: unit.inventory_basis,
    codeProvenance: unit.code_provenance,
    physicalBedCount: unit.physical_bed_count,
    occupancyCapacity: unit.occupancy_capacity,
    nights: [{ serviceDate: "2026-08-02", available, blockingClaimIds: available ? [] : ["claim_1"] }],
    available
  };
}

function validEffect(): Record<string, unknown> {
  const beforeTimeline = [
    { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
    { serviceDate: "2026-08-03", inventoryUnitId: "room_1" }
  ];
  const afterTimeline = [
    { serviceDate: "2026-08-02", inventoryUnitId: "bed_1" },
    { serviceDate: "2026-08-03", inventoryUnitId: "bed_1" }
  ];
  return {
    operation: "MOVE_UNIT", orderId: "order_1", stayId: "stay_1", businessDate: "2026-08-01",
    toInventoryUnit: { ...unitRecord("bed_1", "202-A"), kind: "BED", roomId: "room_2", physicalBedCount: null, occupancyCapacity: 1 },
    effectiveDate: "2026-08-02", occupantCount: 1, occupancyCapacity: 1,
    before: {
      arrivalDate: "2026-08-02", departureDate: "2026-08-04", nights: 2,
      currentContractAmount: { currency: "CNY", minorUnits: 20_000 }, stayTimeline: beforeTimeline,
      actualCurrentInventoryUnit: null, effectiveDateInventoryUnit: unitRecord("room_1", "101")
    },
    after: {
      arrivalDate: "2026-08-02", departureDate: "2026-08-04", nights: 2, stayTimeline: afterTimeline,
      pricing: {
        coverageSet: [],
        cashLines: [
          {
            lineKind: "NIGHT", serviceDate: "2026-08-02", inventoryUnitId: "bed_1",
            description: "Nightly accommodation", amount: { currency: "CNY", minorUnits: 10_000 }
          },
          {
            lineKind: "NIGHT", serviceDate: "2026-08-03", inventoryUnitId: "bed_1",
            description: "Nightly accommodation", amount: { currency: "CNY", minorUnits: 10_000 }
          }
        ],
        cashRemainder: { currency: "CNY", minorUnits: 20_000 },
        currentContractAmount: { currency: "CNY", minorUnits: 22_000 }
      }
    },
    pricingDecision: {
      pricingBasis: "CHANNEL_CONTRACT", policyBaseAmount: { currency: "CNY", minorUnits: 20_000 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 22_000 }, differenceFromPolicy: { currency: "CNY", minorUnits: 2_000 },
      manualAdjustmentMinor: 0, differenceExceedsThreshold: false, reason: { code: "MOVE_UNIT_CHANNEL_CONTRACT", note: "" }
    },
    inventoryChange: {
      preservedClaims: [], releasedClaims: beforeTimeline, addedClaims: afterTimeline
    },
    entitlementSummary: { preservedCoverageDates: [], migratedHeldCoverageDates: [], consumedCoverageDates: [], ledgerWriteCount: 0 },
    fundsSummary: {
      netRecordedCollection: { currency: "CNY", minorUnits: 0 }, collectionDifference: { currency: "CNY", minorUnits: 22_000 }, factCount: 0
    }
  };
}

describe("move unit drawer", () => {
  it("builds an external-channel request with a mandatory real reason and channel amount", () => {
    const current = view();
    const initial = moveUnitInitialDraft(current, units);
    expect(initial.effectiveDate).toBe("2026-08-02");
    expect(() => buildMoveUnitRequest(current, { ...initial, reason: "住客申请换房" })).toThrow("本单渠道应结金额");
    expect(buildMoveUnitRequest(current, {
      ...initial,
      newInventoryUnitId: "bed_1",
      reason: " 住客申请更换安静房间 ",
      targetContractYuan: "220",
      channelPriceDifferenceReason: "携程确认新房型金额"
    })).toMatchObject({
      commandType: "MOVE_UNIT",
      presentation: "MOVE_UNIT",
      initialReason: { code: "MOVE_UNIT", note: "住客申请更换安静房间" },
      input: {
        propertyId: "property_1", orderId: "order_1", newInventoryUnitId: "bed_1", effectiveDate: "2026-08-02",
        targetCurrentContractAmountMinor: 22_000, channelPriceDifferenceReason: "携程确认新房型金额"
      }
    });
  });

  it("uses policy pricing for WECOM and strips paid fields from member and free stays", () => {
    const wecom = view({ booking_channel_code: "WECOM", channel_order_reference: null });
    const wecomDraft = { ...moveUnitInitialDraft(wecom, units), reason: "调整房间" };
    expect(buildMoveUnitRequest(wecom, wecomDraft).input).not.toHaveProperty("targetCurrentContractAmountMinor");
    expect(() => buildMoveUnitRequest(wecom, { ...wecomDraft, manuallyAdjustWecomPrice: true, targetContractYuan: "199" })).toThrow("人工调价原因");

    const member = view({ booking_channel_code: null, channel_order_reference: null, member_id: "member_1", member_contract_id: "contract_1" });
    const memberRequest = buildMoveUnitRequest(member, { ...moveUnitInitialDraft(member, units), reason: "会员申请换房", targetContractYuan: "999" });
    expect(memberRequest.input).not.toHaveProperty("targetCurrentContractAmountMinor");

    const free = view({ stay_type: "FREE", booking_channel_code: null, channel_order_reference: null });
    const freeRequest = buildMoveUnitRequest(free, { ...moveUnitInitialDraft(free, units), reason: "接待安排调整", targetContractYuan: "999" });
    expect(freeRequest.input).not.toHaveProperty("targetCurrentContractAmountMinor");
  });

  it("distinguishes the business-date position from a future planned position", () => {
    const current = view({ status: "CHECKED_IN", arrival_date: "2026-08-01", departure_date: "2026-08-05" });
    current.effectiveArrangement = {
      arrivalDate: "2026-08-01", departureDate: "2026-08-05", presentation: "CURRENT", businessDate: "2026-08-02",
      intervals: [
        { inventoryUnitId: "room_1", arrivalDate: "2026-08-01", departureDate: "2026-08-03" },
        { inventoryUnitId: "bed_1", arrivalDate: "2026-08-03", departureDate: "2026-08-05" }
      ]
    };
    expect(inventoryUnitAtDate(current, "2026-08-02")).toBe("room_1");
    expect(inventoryUnitAtDate(current, "2026-08-03")).toBe("bed_1");
    expect(moveUnitCandidateLabel(units[2]!, undefined, units[1])).toBe("202-A · 四人间（公卫） · 床位 A · 可住 1 人");
  });

  it("uses concise Chinese candidate labels without exposing internal product codes", () => {
    expect(moveUnitCandidateStatusLabel({ status: "LOADING" })).toBe("正在核对目标区间");
    expect(moveUnitCandidateStatusLabel({ status: "ERROR" })).toBe("目标区间状态暂不可用");
    expect(moveUnitCandidateStatusLabel({ status: "READY", unit: availability(units[0]!, true) })).toBe("目标区间可用");
    expect(moveUnitCandidateStatusLabel({ status: "READY", unit: availability(units[2]!, false) })).toBe("目标区间已有占用");
    expect(moveUnitCandidateOptionStatusLabel({ status: "READY", unit: availability(units[0]!, true) })).toBe("可用");
    expect(moveUnitCandidateOptionStatusLabel({ status: "READY", unit: availability(units[2]!, false) })).toBe("已有占用");
    expect(moveUnitCandidateLabel(units[2]!, "可用", units[1])).toBe("202-A · 四人间（公卫） · 床位 A · 可住 1 人 · 可用");
    expect(moveUnitCandidateLabel(units[2]!, "可用", units[1])).not.toMatch(/BED-1|产品/);
    expect(moveUnitCandidateMatches(units[2]!, "四人间", units[1])).toBe(true);
    expect(moveUnitCandidateMatches(units[2]!, "床位 A", units[1])).toBe(true);
    expect(moveUnitCandidateMatches(units[2]!, "shared_bath_quad_bed", units[1])).toBe(false);

    const duplicatedName = { ...units[0]!, name: "101 · 标准间" };
    expect(moveUnitCandidateDisplayName(duplicatedName)).toBe("标准间");
    expect(moveUnitCandidateLabel(duplicatedName, "可用")).toBe("101 · 标准间 · 整房 · 可住 2 人 · 可用");
    expect(moveUnitCandidateMatches(duplicatedName, "101")).toBe(true);
    expect(moveUnitCandidateMatches(duplicatedName, "标准间")).toBe(true);
    expect(moveUnitCandidateMatches(duplicatedName, "整房")).toBe(true);
    expect(moveUnitCandidateMatches(duplicatedName, "ROOM-2")).toBe(false);
  });

  it("fails closed when any strict MOVE_UNIT preview evidence is damaged", () => {
    const input = { propertyId: "property_1", orderId: "order_1", newInventoryUnitId: "bed_1", effectiveDate: "2026-08-02", targetCurrentContractAmountMinor: 22_000 };
    const effect = validEffect();
    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(true);
    const damaged = structuredClone(effect);
    (damaged.inventoryChange as { addedClaims: unknown[] }).addedClaims = [];
    expect(moveUnitPreviewHasEvidence(damaged, input)).toBe(false);
    const extra = structuredClone(effect);
    extra.rawPayload = {};
    expect(moveUnitPreviewHasEvidence(extra, input)).toBe(false);

    const missingOccupantCount = structuredClone(effect);
    delete missingOccupantCount.occupantCount;
    expect(moveUnitPreviewHasEvidence(missingOccupantCount, input)).toBe(false);

    const overCapacity = structuredClone(effect);
    overCapacity.occupantCount = 2;
    overCapacity.occupancyCapacity = 1;
    expect(moveUnitPreviewHasEvidence(overCapacity, input)).toBe(false);

    const oversizedAmount = structuredClone(effect);
    (oversizedAmount.pricingDecision as { targetCurrentContractAmount: { minorUnits: number } }).targetCurrentContractAmount.minorUnits = 2_147_483_700;
    expect(moveUnitPreviewHasEvidence(oversizedAmount, { ...input, targetCurrentContractAmountMinor: 2_147_483_700 })).toBe(false);

    const impossibleReservedPosition = structuredClone(effect);
    (impossibleReservedPosition.before as { actualCurrentInventoryUnit: unknown }).actualCurrentInventoryUnit = unitRecord("room_1", "101");
    expect(moveUnitPreviewHasEvidence(impossibleReservedPosition, input)).toBe(false);

    const changedPrefix = structuredClone(effect);
    changedPrefix.effectiveDate = "2026-08-03";
    (changedPrefix.after as { stayTimeline: Array<{ inventoryUnitId: string }> }).stayTimeline[0]!.inventoryUnitId = "bed_1";
    expect(moveUnitPreviewHasEvidence(changedPrefix, { ...input, effectiveDate: "2026-08-03" })).toBe(false);

    const mixedSuffix = structuredClone(effect);
    (mixedSuffix.after as { stayTimeline: Array<{ inventoryUnitId: string }> }).stayTimeline[1]!.inventoryUnitId = "room_1";
    (mixedSuffix.inventoryChange as Record<string, unknown>).preservedClaims = [{ serviceDate: "2026-08-03", inventoryUnitId: "room_1" }];
    (mixedSuffix.inventoryChange as Record<string, unknown>).releasedClaims = [{ serviceDate: "2026-08-02", inventoryUnitId: "room_1" }];
    (mixedSuffix.inventoryChange as Record<string, unknown>).addedClaims = [{ serviceDate: "2026-08-02", inventoryUnitId: "bed_1" }];
    expect(moveUnitPreviewHasEvidence(mixedSuffix, input)).toBe(false);

    const missingChannelReason = structuredClone(effect);
    const missingChannelReasonDecision = missingChannelReason.pricingDecision as {
      targetCurrentContractAmount: { minorUnits: number };
      differenceFromPolicy: { minorUnits: number };
      differenceExceedsThreshold: boolean;
    };
    missingChannelReasonDecision.targetCurrentContractAmount.minorUnits = 24_000;
    missingChannelReasonDecision.differenceFromPolicy.minorUnits = 4_000;
    missingChannelReasonDecision.differenceExceedsThreshold = true;
    (missingChannelReason.after as { pricing: { currentContractAmount: { minorUnits: number } } }).pricing.currentContractAmount.minorUnits = 24_000;
    (missingChannelReason.fundsSummary as { collectionDifference: { minorUnits: number } }).collectionDifference.minorUnits = 24_000;
    expect(moveUnitPreviewHasEvidence(missingChannelReason, {
      ...input,
      targetCurrentContractAmountMinor: 24_000
    })).toBe(false);
  });

  it("accepts only complete zero-valued FREE pricing lines", () => {
    const input = { propertyId: "property_1", orderId: "order_1", newInventoryUnitId: "bed_1", effectiveDate: "2026-08-02" };
    const effect = validEffect();
    effect.before = { ...(effect.before as Record<string, unknown>), currentContractAmount: { currency: "CNY", minorUnits: 0 } };
    effect.after = {
      ...(effect.after as Record<string, unknown>),
      pricing: {
        coverageSet: [],
        cashLines: [
          { serviceDate: "2026-08-02", inventoryUnitId: "bed_1", description: "Free accommodation", amount: { currency: "CNY", minorUnits: 0 } },
          { serviceDate: "2026-08-03", inventoryUnitId: "bed_1", description: "Free accommodation", amount: { currency: "CNY", minorUnits: 0 } }
        ],
        cashRemainder: { currency: "CNY", minorUnits: 0 },
        currentContractAmount: { currency: "CNY", minorUnits: 0 }
      }
    };
    effect.pricingDecision = {
      pricingBasis: "FREE", policyBaseAmount: { currency: "CNY", minorUnits: 0 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 }, differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0, differenceExceedsThreshold: false, reason: { code: "MOVE_UNIT_FREE", note: "" }
    };
    effect.fundsSummary = {
      netRecordedCollection: { currency: "CNY", minorUnits: 0 },
      collectionDifference: { currency: "CNY", minorUnits: 0 }, factCount: 0
    };

    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(true);
    const nonzero = structuredClone(effect);
    ((nonzero.after as { pricing: { cashLines: Array<{ amount: { minorUnits: number } }> } }).pricing.cashLines[0]!).amount.minorUnits = 100;
    expect(moveUnitPreviewHasEvidence(nonzero, input)).toBe(false);
    const missingDate = structuredClone(effect);
    (missingDate.after as { pricing: { cashLines: unknown[] } }).pricing.cashLines.pop();
    expect(moveUnitPreviewHasEvidence(missingDate, input)).toBe(false);
    const wrongUnit = structuredClone(effect);
    (wrongUnit.after as { pricing: { cashLines: Array<{ inventoryUnitId: string }> } }).pricing.cashLines[0]!.inventoryUnitId = "room_1";
    expect(moveUnitPreviewHasEvidence(wrongUnit, input)).toBe(false);
  });

  it("accepts a member move with covered nights plus a legitimate cash remainder", () => {
    const input = { propertyId: "property_1", orderId: "order_1", newInventoryUnitId: "room_2", effectiveDate: "2026-08-02" };
    const effect = validEffect();
    effect.toInventoryUnit = unitRecord("room_2", "102");
    effect.occupancyCapacity = 2;
    effect.after = {
      ...(effect.after as Record<string, unknown>),
      stayTimeline: [
        { serviceDate: "2026-08-02", inventoryUnitId: "room_2" },
        { serviceDate: "2026-08-03", inventoryUnitId: "room_2" }
      ],
      pricing: {
        coverageSet: [{
          serviceDate: "2026-08-02", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1"
        }],
        cashLines: [{
          lineKind: "NIGHT", serviceDate: "2026-08-03", inventoryUnitId: "room_2",
          description: "Member cash remainder", amount: { currency: "CNY", minorUnits: 10_000 }
        }],
        cashRemainder: { currency: "CNY", minorUnits: 10_000 },
        currentContractAmount: { currency: "CNY", minorUnits: 10_000 }
      }
    };
    effect.inventoryChange = {
      preservedClaims: [],
      releasedClaims: [
        { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
        { serviceDate: "2026-08-03", inventoryUnitId: "room_1" }
      ],
      addedClaims: [
        { serviceDate: "2026-08-02", inventoryUnitId: "room_2" },
        { serviceDate: "2026-08-03", inventoryUnitId: "room_2" }
      ]
    };
    effect.pricingDecision = {
      pricingBasis: "MEMBER_ENTITLEMENT", policyBaseAmount: { currency: "CNY", minorUnits: 10_000 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 10_000 }, differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0, differenceExceedsThreshold: false, reason: { code: "MOVE_UNIT_MEMBER", note: "" }
    };
    effect.entitlementSummary = {
      preservedCoverageDates: [], migratedHeldCoverageDates: [], consumedCoverageDates: ["2026-08-02"], ledgerWriteCount: 0
    };
    effect.fundsSummary = {
      netRecordedCollection: { currency: "CNY", minorUnits: 0 },
      collectionDifference: { currency: "CNY", minorUnits: 10_000 }, factCount: 0
    };

    expect(moveUnitPreviewHasEvidence(effect, input)).toBe(true);
    const missingRemainderNight = structuredClone(effect);
    (missingRemainderNight.after as { pricing: { cashLines: unknown[] } }).pricing.cashLines = [];
    expect(moveUnitPreviewHasEvidence(missingRemainderNight, input)).toBe(false);
    const coveredDateChargedAgain = structuredClone(effect);
    (coveredDateChargedAgain.after as { pricing: { cashLines: Array<{ serviceDate: string }> } }).pricing.cashLines[0]!.serviceDate = "2026-08-02";
    expect(moveUnitPreviewHasEvidence(coveredDateChargedAgain, input)).toBe(false);
    const wrongRemainder = structuredClone(effect);
    (wrongRemainder.after as { pricing: { cashRemainder: { minorUnits: number } } }).pricing.cashRemainder.minorUnits = 9_900;
    expect(moveUnitPreviewHasEvidence(wrongRemainder, input)).toBe(false);
    const inventedConsumedUnit = structuredClone(effect);
    (inventedConsumedUnit.after as { pricing: { coverageSet: Array<{ inventoryUnitId: string }> } }).pricing.coverageSet[0]!.inventoryUnitId = "room_invented";
    expect(moveUnitPreviewHasEvidence(inventedConsumedUnit, input)).toBe(false);
  });

  it("accepts only a complete committed MOVE_UNIT Receipt matching the approved Preview", () => {
    const input = { propertyId: "property_1", orderId: "order_1", newInventoryUnitId: "bed_1", effectiveDate: "2026-08-02", targetCurrentContractAmountMinor: 22_000 };
    const effect = validEffect();
    const result = {
      orderId: "order_1",
      stayId: "stay_1",
      amendmentId: "amend_1",
      staySegmentId: "segment_2",
      pricingRevisionId: "revision_2",
      businessDate: "2026-08-01",
      effectiveDate: "2026-08-02",
      before: effect.before,
      after: effect.after,
      pricingDecision: effect.pricingDecision,
      inventoryChange: effect.inventoryChange,
      entitlementSummary: effect.entitlementSummary,
      fundsSummary: effect.fundsSummary,
      effectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const receipt = {
      receiptId: "receipt_1",
      commandId: "command_1",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_1",
      result,
      resourceRefs: ["order_1", "stay_1", "amend_1", "segment_2", "revision_2"],
      factRefs: [],
      committedAt: "2026-08-01T10:00:00.000Z"
    };

    expect(moveUnitReceiptHasEvidence(receipt, input, effect, result.effectHash)).toBe(true);
    expect(moveUnitReceiptHasEvidence(receipt, input, effect, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
    expect(moveUnitReceiptHasEvidence({ ...receipt, result: {} }, input, effect)).toBe(false);
    expect(moveUnitReceiptHasEvidence({
      ...receipt,
      result: { ...result, businessDate: "2026-08-02" }
    }, input, effect)).toBe(false);
    expect(moveUnitReceiptHasEvidence({
      ...receipt,
      result: { ...result, effectiveDate: "2026-08-03" }
    }, input, effect)).toBe(false);
    expect(moveUnitReceiptHasEvidence({
      ...receipt,
      resourceRefs: ["order_1", "stay_1", "amend_1", "revision_2"]
    }, input, effect)).toBe(false);

    const mixedSuffixEffect = structuredClone(effect);
    (mixedSuffixEffect.after as { stayTimeline: Array<{ inventoryUnitId: string }> }).stayTimeline[1]!.inventoryUnitId = "room_1";
    (mixedSuffixEffect.inventoryChange as Record<string, unknown>).preservedClaims = [{ serviceDate: "2026-08-03", inventoryUnitId: "room_1" }];
    (mixedSuffixEffect.inventoryChange as Record<string, unknown>).releasedClaims = [{ serviceDate: "2026-08-02", inventoryUnitId: "room_1" }];
    (mixedSuffixEffect.inventoryChange as Record<string, unknown>).addedClaims = [{ serviceDate: "2026-08-02", inventoryUnitId: "bed_1" }];
    expect(moveUnitReceiptHasEvidence({
      ...receipt,
      result: {
        ...result,
        after: mixedSuffixEffect.after,
        inventoryChange: mixedSuffixEffect.inventoryChange
      }
    }, input)).toBe(false);
  });

  it("renders a covered write drawer with exact candidate facts", () => {
    const html = renderToStaticMarkup(createElement(MoveUnitDrawer, {
      view: view(), units, runPreview: (execute) => execute(), onClose: () => undefined, onSubmit: () => undefined
    }));
    expect(html).toContain("modal-drawer");
    expect(html).toContain("room-status-write-drawer");
    expect(html).toContain("青山");
    expect(html).toContain("搜索房号或房型");
    expect(html).toContain("202-A · 四人间（公卫） · 床位 A · 可住 1 人 · 核对中");
    expect(html).not.toMatch(/ROOM-2|ROOM-4|BED-1|产品 |Preview/);
    expect(html).toContain("换房原因");
  });
});
