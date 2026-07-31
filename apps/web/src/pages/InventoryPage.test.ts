import { describe, expect, it } from "vitest";
import {
  QuoteRequestGuard,
  RoomStatusCommandAttemptGuard,
  RoomStatusQueryAttemptGuard,
  SelectedMemberViewRequestGuard,
  GUEST_FULL_NAME_MAX_LENGTH,
  applyMemberSelectionToGuestForms,
  bookingChannelRequiredForStay,
  canAddGuest,
  createOrderGuestInputs,
  createOrderPricingDraft,
  paidStayTypeForDates,
  eligibleMemberProfiles,
  effectiveQuoteMemberId,
  guestFormComplete,
  guestFormInput,
  formatMinorForYuanInput,
  inventoryRecoveryIsBusinessFacing,
  membershipCoverageSummary,
  parseYuanAmountToMinor,
  quotePricingSummary,
  staffQuoteError,
  quoteRecoveryStorageKey,
  readQuoteCommandRecovery,
  roomStatusCommandWriteGate,
  roomStatusFiltersRevealingTarget,
  roomStatusAnchorMatches,
  roomStatusAutoWindowStart,
  roomStatusQuickTargetMatches,
  roomStatusGridSelectedStayId,
  roomStatusOrderContextMode,
  roomStatusOrderCommandScope,
  roomStatusProjectionRefreshAllowed,
  selectedOrderCommandScopeIsCurrent,
  selectedOrderMemberLookup,
  selectedStayDateRequestIsCompatible,
  roomStatusBlockDraftWithinSelection,
  saveQuoteCommandRecovery
} from "./InventoryPage";
import { ApiError } from "../api";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const subjectId = "subject_operator";
const propertyId = "property_qintopia";
const scope = quoteRecoveryStorageKey(subjectId, propertyId);
const pending = {
  version: 1,
  subjectId,
  propertyId,
  input: {
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  },
  inputSignature: JSON.stringify({
    propertyId,
    inventoryUnitId: "unit_room_101",
    stayType: "FREE",
    arrivalDate: "2026-10-10",
    departureDate: "2026-10-12",
    pricingPolicyVersionId: "policy_free_v1"
  }),
  metadata: {
    idempotencyKey: "web-create-quote-original-key",
    correlationId: "web-create-quote-original-correlation"
  },
  state: "SENDING"
} as const;

describe("selected order command authorization scope", () => {
  it("requires every command to keep its bound principal scope", () => {
    expect(selectedOrderCommandScopeIsCurrent(undefined, "property:operator:SESSION:WRITE")).toBe(false);
    expect(selectedOrderCommandScopeIsCurrent("property:operator:SESSION:WRITE", "property:operator:SESSION:WRITE")).toBe(true);
    expect(selectedOrderCommandScopeIsCurrent("property:operator:SESSION:WRITE", "property:viewer:TOKEN:READ")).toBe(false);
  });

  it("binds room-status order commands to the principal, order and Stay", () => {
    const principalScope = "property_qintopia:operator:SESSION:WRITE";
    const selected = roomStatusOrderCommandScope(principalScope, { orderId: "order_1", stayId: "stay_1" });
    expect(selectedOrderCommandScopeIsCurrent(selected, principalScope, { orderId: "order_1", stayId: "stay_1" })).toBe(true);
    expect(selectedOrderCommandScopeIsCurrent(selected, principalScope, { orderId: "order_2", stayId: "stay_1" })).toBe(false);
    expect(selectedOrderCommandScopeIsCurrent(selected, principalScope, { orderId: "order_1", stayId: "stay_2" })).toBe(false);
    expect(selectedOrderCommandScopeIsCurrent(selected, "property_other:operator:SESSION:WRITE", { orderId: "order_1", stayId: "stay_1" })).toBe(false);
  });
});

describe("room-status complete Stay selection", () => {
  it("keeps an exact cell Stay stable across quick-popover and context visibility changes", () => {
    expect(roomStatusGridSelectedStayId(false, null, { stayId: "stay_cross_room" })).toBe("stay_cross_room");
    expect(roomStatusGridSelectedStayId(true, "stay_quick", { stayId: "stay_previous" })).toBe("stay_quick");
    expect(roomStatusGridSelectedStayId(true, null, { stayId: "stay_previous" })).toBeNull();
    expect(roomStatusGridSelectedStayId(true, null, undefined, "stay_from_interval")).toBe("stay_from_interval");
    expect(roomStatusGridSelectedStayId(false, null, undefined, "stay_from_interval")).toBe("stay_from_interval");
    expect(roomStatusGridSelectedStayId(false, null)).toBeNull();
  });

  it("rebinds a quick action only to the same room-status unit and date", () => {
    const anchor = { dataset: { unitId: "unit_room_d_gen_04", serviceDate: "2026-09-12" } } as never;
    expect(roomStatusAnchorMatches(anchor, "unit_room_d_gen_04", "2026-09-12")).toBe(true);
    expect(roomStatusAnchorMatches(anchor, "unit_room_d_gen_05", "2026-09-12")).toBe(false);
    expect(roomStatusAnchorMatches(anchor, "unit_room_d_gen_04", "2026-09-13")).toBe(false);

    const current = { unitId: "unit_room_d_gen_05", serviceDate: "2026-09-12" };
    expect(roomStatusQuickTargetMatches(current, "unit_room_d_gen_04", "2026-09-12")).toBe(false);
    expect(roomStatusQuickTargetMatches(current, "unit_room_d_gen_05", "2026-09-12")).toBe(true);
    expect(roomStatusQuickTargetMatches(undefined, "unit_room_d_gen_05", "2026-09-12")).toBe(false);
  });
});

describe("room-status automatic date window", () => {
  const dates = Array.from({ length: 14 }, (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`);

  it("keeps a restored focus visible when AUTO shrinks the date window", () => {
    expect(roomStatusAutoWindowStart(dates, 0, 10, {
      unitId: "unit_room_e_gen_03",
      serviceDate: dates[10]!
    })).toBe(1);
  });

  it("does not move an AUTO window without a focus or when the focus is already visible", () => {
    expect(roomStatusAutoWindowStart(dates, 2, 10, null)).toBe(2);
    expect(roomStatusAutoWindowStart(dates, 2, 10, {
      unitId: "unit_room_e_gen_03",
      serviceDate: dates[9]!
    })).toBe(2);
  });
});

describe("moved Stay filter recovery", () => {
  it("clears only the filter fields that hide the moved destination", () => {
    const filters = {
      search: "原房间",
      roomTypeCode: "SHARED_BATH_SINGLE",
      salesMode: "WHOLE_ROOM" as const,
      status: "IN_HOUSE" as const,
      kind: "ROOM" as const,
      minimumCapacity: 1
    };
    const recovered = roomStatusFiltersRevealingTarget(filters, (candidate) => (
      candidate.search === ""
      && candidate.status === "ALL"
      && candidate.roomTypeCode === "SHARED_BATH_SINGLE"
      && candidate.salesMode === "WHOLE_ROOM"
      && candidate.kind === "ROOM"
      && candidate.minimumCapacity === 1
    ));

    expect(recovered).toEqual({
      ...filters,
      search: "",
      status: "ALL"
    });
  });

  it("preserves every filter when the moved destination is already visible", () => {
    const filters = {
      search: "D02",
      roomTypeCode: "ALL",
      salesMode: "ALL" as const,
      status: "ALL" as const,
      kind: "ALL" as const,
      minimumCapacity: null
    };
    expect(roomStatusFiltersRevealingTarget(filters, () => true)).toBe(filters);
  });
});

describe("selected order member profile scope", () => {
  it("does not request a member profile for a non-member order", () => {
    expect(selectedOrderMemberLookup({
      order: { id: "order_cash", property_id: propertyId, member_id: null },
      stay: { id: "stay_cash" }
    } as never, propertyId, "stay_cash")).toBeUndefined();
  });

  it("binds member loading to the authoritative property, order and Stay", () => {
    expect(selectedOrderMemberLookup({
      order: { id: "order_member", property_id: propertyId, member_id: "member_1" },
      stay: { id: "stay_member" }
    } as never, propertyId, "stay_member")).toEqual({
      memberId: "member_1",
      scope: `${propertyId}:order_member:stay_member:member_1`
    });
    expect(selectedOrderMemberLookup({
      order: { id: "order_member", property_id: "property_other", member_id: "member_1" },
      stay: { id: "stay_member" }
    } as never, propertyId, "stay_member")).toBeUndefined();
  });

  it("rejects a late member response after the selected order changes", () => {
    const guard = new SelectedMemberViewRequestGuard();
    const first = guard.begin("property:order_1:stay_1:member_1");
    const second = guard.begin("property:order_2:stay_2:member_2");
    let applied = "";

    expect(guard.runIfActive(first, () => { applied = "member_1"; })).toBe(false);
    expect(guard.runIfActive(second, () => { applied = "member_2"; })).toBe(true);
    expect(applied).toBe("member_2");

    guard.invalidate();
    expect(guard.runIfActive(second, () => { applied = "stale"; })).toBe(false);
    expect(applied).toBe("member_2");
  });
});

describe("selected stay date command routing", () => {
  it("allows the unified departure drawer to resolve to either lifecycle command", () => {
    expect(selectedStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "EXTEND_STAY")).toBe(true);
    expect(selectedStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "SHORTEN_STAY")).toBe(true);
    expect(selectedStayDateRequestIsCompatible("SHORTEN_STAY", "ADJUST_DEPARTURE", "EXTEND_STAY")).toBe(true);
    expect(selectedStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "RESCHEDULE_STAY")).toBe(false);
  });

  it("keeps concrete date-change drawers bound to their original command", () => {
    expect(selectedStayDateRequestIsCompatible("RESCHEDULE_STAY", "DATE_CHANGE", "RESCHEDULE_STAY")).toBe(true);
    expect(selectedStayDateRequestIsCompatible("RESCHEDULE_STAY", "DATE_CHANGE", "EXTEND_STAY")).toBe(false);
    expect(selectedStayDateRequestIsCompatible("SHORTEN_STAY", "EARLY_CHECK_OUT", "SHORTEN_STAY")).toBe(true);
    expect(selectedStayDateRequestIsCompatible("SHORTEN_STAY", "EARLY_CHECK_OUT", "EXTEND_STAY")).toBe(false);
  });
});

describe("room-status command recovery presentation", () => {
  it("keeps every staff-facing lodging workflow on the Chinese business recovery path", () => {
    expect(inventoryRecoveryIsBusinessFacing("MEMBER_STAY")).toBe(true);
    expect(inventoryRecoveryIsBusinessFacing("FULFILLMENT")).toBe(true);
    expect(inventoryRecoveryIsBusinessFacing("STAY_DATES")).toBe(true);
    expect(inventoryRecoveryIsBusinessFacing("MOVE_UNIT")).toBe(true);
    expect(inventoryRecoveryIsBusinessFacing(undefined)).toBe(false);
  });
});

describe("room-status command write gates", () => {
  it("blocks a new command from stale projection without invalidating an unchanged active command", () => {
    expect(roomStatusCommandWriteGate({
      projectionWritable: false,
      activeProjectionValid: true,
      recoveryBlocked: false,
      recoveryReady: true,
      recoveryError: undefined,
      contextInvalidated: false,
      targetScopeCurrent: true
    })).toEqual({ startBlocked: true, activeBlocked: false });
  });

  it.each([
    { label: "query or revision changed", contextInvalidated: true, targetScopeCurrent: true, recoveryReady: true, recoveryError: undefined },
    { label: "principal, order, or Stay changed", contextInvalidated: false, targetScopeCurrent: false, recoveryReady: true, recoveryError: undefined },
    { label: "recovery scope is not ready", contextInvalidated: false, targetScopeCurrent: true, recoveryReady: false, recoveryError: undefined },
    { label: "recovery storage failed", contextInvalidated: false, targetScopeCurrent: true, recoveryReady: true, recoveryError: new Error("storage unavailable") }
  ])("fails closed when $label", ({ contextInvalidated, targetScopeCurrent, recoveryReady, recoveryError }) => {
    expect(roomStatusCommandWriteGate({
      projectionWritable: true,
      activeProjectionValid: true,
      recoveryBlocked: false,
      recoveryReady,
      recoveryError,
      contextInvalidated,
      targetScopeCurrent
    }).activeBlocked).toBe(true);
  });

  it("blocks an active command when authorization or projection readiness is lost", () => {
    expect(roomStatusCommandWriteGate({
      projectionWritable: false,
      activeProjectionValid: false,
      recoveryBlocked: false,
      recoveryReady: true,
      recoveryError: undefined,
      contextInvalidated: false,
      targetScopeCurrent: true
    })).toEqual({ startBlocked: true, activeBlocked: true });
  });
});

describe("CREATE_QUOTE request lifecycle", () => {
  it("matches the API's 200-character full-name limit for primary and additional guests", () => {
    expect(GUEST_FULL_NAME_MAX_LENGTH).toBe(200);
  });

  it("normalizes complete occupant drafts without inventing optional personal data", () => {
    expect(guestFormComplete({ fullName: " 同行人甲 ", nickname: " 小满 ", phone: " ", documentNumber: " DOC-2 " })).toBe(true);
    expect(guestFormInput({ fullName: " 同行人甲 ", nickname: " 小满 ", phone: " ", documentNumber: " DOC-2 " })).toEqual({
      fullName: "同行人甲",
      nickname: "小满",
      documentNumber: "DOC-2"
    });
    expect(guestFormComplete({ fullName: "同行人甲", nickname: " ", phone: "", documentNumber: "" })).toBe(false);
  });

  it("only permits companions below the authoritative occupancy capacity", () => {
    expect(canAddGuest(1, 0)).toBe(false);
    expect(canAddGuest(2, 0)).toBe(true);
    expect(canAddGuest(2, 1)).toBe(false);
    expect(canAddGuest(4, 2)).toBe(true);
    expect(canAddGuest(4, 3)).toBe(false);
  });

  it("prefills only the member primary guest and preserves companions through member reselection and quote refresh", () => {
    const member = {
      full_name: "会员主档姓名",
      phone: "13900000001",
      identity_card_number: "MEMBER-ID-001"
    };
    const companions = [{
      fullName: "同行人姓名",
      nickname: "小满",
      phone: "13900000002",
      documentNumber: "COMPANION-ID-002"
    }];

    const selected = applyMemberSelectionToGuestForms(companions, member);
    const refreshed = applyMemberSelectionToGuestForms(selected.additionalGuests, member);
    expect(refreshed.primaryGuest).toEqual({
      fullName: "会员主档姓名",
      nickname: "会员主档姓名",
      phone: "13900000001",
      documentNumber: "MEMBER-ID-001"
    });
    expect(refreshed.additionalGuests).toBe(companions);
    expect(createOrderGuestInputs(refreshed.primaryGuest, refreshed.additionalGuests)).toEqual({
      primaryGuest: refreshed.primaryGuest,
      additionalGuests: companions
    });
    expect(member).toEqual({
      full_name: "会员主档姓名",
      phone: "13900000001",
      identity_card_number: "MEMBER-ID-001"
    });
  });

  it("requires a booking channel only for non-member stays", () => {
    expect(bookingChannelRequiredForStay(false)).toBe(true);
    expect(bookingChannelRequiredForStay(true)).toBe(false);
    expect(bookingChannelRequiredForStay(false, "FREE")).toBe(false);
    expect(bookingChannelRequiredForStay(false, "TRANSIENT")).toBe(true);
    expect(bookingChannelRequiredForStay(true, "TRANSIENT")).toBe(false);
  });

  it("parses whole-yuan CNY input exactly without accepting jiao, fen, or oversized values", () => {
    expect(parseYuanAmountToMinor("850")).toBe(85_000);
    expect(parseYuanAmountToMinor("850.00")).toBe(85_000);
    expect(parseYuanAmountToMinor("850.5")).toBeUndefined();
    expect(parseYuanAmountToMinor("850.05")).toBeUndefined();
    expect(parseYuanAmountToMinor("850.005")).toBeUndefined();
    expect(parseYuanAmountToMinor("-1")).toBeUndefined();
    expect(parseYuanAmountToMinor("21474836")).toBe(2_147_483_600);
    expect(parseYuanAmountToMinor("21474837")).toBeUndefined();
    expect(formatMinorForYuanInput(85_000)).toBe("850");
  });

  it("requires explicit external channel amount and only asks for a reason above 15 percent", () => {
    const base = {
      bookingChannelCode: "CTRIP" as const,
      channelOrderReference: "CTRIP-WEB-001",
      policyBaseAmountMinor: 100_000,
      channelPriceDifferenceReason: "",
      manualPriceAdjustmentReason: ""
    };
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "" })).toMatchObject({ complete: false });
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "850.00" })).toMatchObject({
      targetCurrentContractAmountMinor: 85_000,
      differenceFromPolicyMinor: -15_000,
      channelReasonRequired: false,
      complete: true
    });
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "840.00" })).toMatchObject({
      channelReasonRequired: true,
      complete: false
    });
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "840.00", channelPriceDifferenceReason: "平台活动" })).toMatchObject({
      channelReasonRequired: true,
      complete: true
    });
  });

  it("defaults WECOM semantics to policy price and requires a reason only for a manual deviation", () => {
    const base = {
      bookingChannelCode: "WECOM" as const,
      channelOrderReference: "",
      policyBaseAmountMinor: 100_000,
      channelPriceDifferenceReason: "",
      manualPriceAdjustmentReason: ""
    };
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "1000.00" })).toMatchObject({ manualReasonRequired: false, complete: true });
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "950.00" })).toMatchObject({ manualReasonRequired: true, complete: false });
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "950.00", manualPriceAdjustmentReason: "协议优惠" })).toMatchObject({ manualReasonRequired: true, complete: true });
  });

  it("only keeps a selected member while it remains visible in the current property", () => {
    const members = [
      { id: "member_current", full_name: "当前门店会员", identity_card_number: "CURRENT-001", phone: "13900000001", wechat: "current" },
      { id: "member_other", full_name: "其他门店会员", identity_card_number: "OTHER-001", phone: "13900000002", wechat: "other" }
    ];
    const contracts = [
      { property_id: propertyId, member_id: "member_current" },
      { property_id: "property_other", member_id: "member_other" }
    ];

    expect(eligibleMemberProfiles(members as never[], contracts as never[], propertyId, "当前").map((member) => member.id)).toEqual(["member_current"]);
    expect(effectiveQuoteMemberId([members[0] as never], "member_current")).toBe("member_current");
    expect(effectiveQuoteMemberId([], "member_current")).toBe("");
  });

  it("summarizes full, partial, and zero member coverage without hiding zero", () => {
    const quote = {
      quoteId: "quote_member",
      propertyId,
      inventoryUnitId: "unit_room_d01",
      stayType: "TRANSIENT" as const,
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: "policy_public",
      coverageSet: [{ serviceDate: "2026-08-01", inventoryUnitId: "unit_room_d01", unitKind: "ROOM_NIGHT" as const, entitlementLotId: "lot_member" }],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 39_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 39_000 },
      expiresAt: "2026-08-01T01:00:00.000Z"
    };
    expect(membershipCoverageSummary(quote)).toEqual({ totalNights: 4, coveredNights: 1, uncoveredNights: 3, uncoveredAmount: { currency: "CNY", minorUnits: 39_000 } });
    expect(membershipCoverageSummary({ ...quote, coverageSet: [] })).toMatchObject({ totalNights: 4, coveredNights: 0, uncoveredNights: 4 });
    expect(membershipCoverageSummary({ ...quote, coverageSet: Array.from({ length: 4 }, (_, index) => ({ serviceDate: `2026-08-0${index + 1}`, inventoryUnitId: "unit_room_d01", unitKind: "ROOM_NIGHT" as const, entitlementLotId: "lot_member" })), cashRemainder: { currency: "CNY", minorUnits: 0 } })).toMatchObject({ totalNights: 4, coveredNights: 4, uncoveredNights: 0, uncoveredAmount: { currency: "CNY", minorUnits: 0 } });
  });

  it("derives the paid stay type from the complete date interval", () => {
    expect(paidStayTypeForDates("2026-07-26", "2026-08-01")).toBe("TRANSIENT");
    expect(paidStayTypeForDates("2026-07-26", "2026-08-02")).toBe("CUSTOM");
    expect(paidStayTypeForDates("2026-07-26", "2026-08-05")).toBe("CUSTOM");
  });

  it("summarizes a duration-band quote without exposing protocol fields", () => {
    expect(quotePricingSummary({
      quoteId: "quote_internal",
      propertyId,
      inventoryUnitId: "unit_room_104",
      stayType: "CUSTOM",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-05",
      pricingPolicyVersionId: "policy_internal",
      coverageSet: [],
      cashLines: [{
        lineKind: "STAY_TOTAL",
        arrivalDate: "2026-07-26",
        departureDate: "2026-08-05",
        inventoryUnitId: "unit_room_104",
        description: "internal description",
        pricingBandAnchorNights: 7,
        calculationSegments: [{
          inventoryUnitId: "unit_room_104",
          pricingProductCode: "shared_bath_double_whole_room",
          arrivalDate: "2026-07-26",
          departureDate: "2026-08-05",
          nights: 10,
          anchorAmountMinor: 76_000,
          numeratorMinor: 760_000,
          denominator: 7
        }],
        amount: { currency: "CNY", minorUnits: 108_600 }
      }],
      cashRemainder: { currency: "CNY", minorUnits: 108_600 },
      currentContractAmount: { currency: "CNY", minorUnits: 108_600 },
      expiresAt: "2026-07-26T01:00:00.000Z"
    })).toEqual({ nights: 10, pricingBasis: "按 7 夜价格档", amount: { currency: "CNY", minorUnits: 108_600 } });
  });

  it("turns deterministic API failures into staff language without treating them as network-unknown", () => {
    const error = new ApiError(422, {
      code: "PRICING_POLICY_UNCONFIGURED",
      message: "legacy protocol wording",
      retryable: false
    });
    expect(staffQuoteError(error, "104", "2026-02-24", "2026-02-25").message).toBe(
      "104 在 2026-02-24 至 2026-02-25 暂无已生效价格，请调整日期。"
    );
  });

  it("leaves the original SENDING recovery record untouched after unmount", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const lease = guard.begin(scope);
    guard.unmount();

    if (guard.isActive(lease)) storage.removeItem(quoteRecoveryStorageKey(subjectId, propertyId));

    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
  });

  it("isolates delayed callbacks across property switches, including a switch back", () => {
    const otherScope = quoteRecoveryStorageKey(subjectId, "property_other");
    const guard = new QuoteRequestGuard(scope);
    guard.mount();
    const originalLease = guard.begin(scope);

    guard.enterScope(otherScope);
    expect(guard.isActive(originalLease)).toBe(false);
    const otherPropertyLease = guard.begin(otherScope);
    expect(guard.isActive(otherPropertyLease)).toBe(true);

    guard.enterScope(scope);
    expect(guard.isActive(originalLease)).toBe(false);
    expect(guard.isActive(otherPropertyLease)).toBe(false);
  });

  it("loads a persisted SENDING command with its original idempotency key for recovery", () => {
    const storage = new MemoryStorage();
    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);

    const restored = readQuoteCommandRecovery(storage, subjectId, propertyId);
    expect(restored.kind).toBe("VALID");
    if (restored.kind !== "VALID") throw new Error("expected a valid quote recovery record");
    expect(restored.pending.state).toBe("SENDING");
    expect(restored.pending.metadata.idempotencyKey).toBe(pending.metadata.idempotencyKey);

    const remountedGuard = new QuoteRequestGuard(scope);
    remountedGuard.mount();
    expect(remountedGuard.isActive(remountedGuard.begin(scope))).toBe(true);
  });
});

describe("Room-status order context layout", () => {
  it("keeps every desktop width on the non-compressing drawer path", () => {
    expect(roomStatusOrderContextMode(0, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1239, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1240, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1600, true)).toBe("DRAWER");
  });
});

describe("Room-status command attempt lifecycle", () => {
  it("tracks late recovery outcomes after 403 without letting a stale attempt restart polling state", () => {
    const guard = new RoomStatusCommandAttemptGuard();
    const attemptId = guard.begin();
    let phase = "PREVIEW";
    const persisted: string[] = [];

    guard.invalidate();
    for (const progress of ["UNKNOWN", "RESOLVED"] as const) {
      persisted.push(progress);
      guard.runIfActive(attemptId, () => { phase = "CONFIRMING"; });
    }

    expect(persisted).toEqual(["UNKNOWN", "RESOLVED"]);
    expect(phase).toBe("PREVIEW");

    const nextAttemptId = guard.begin();
    expect(nextAttemptId).toBeGreaterThan(attemptId);
    expect(guard.runIfActive(attemptId, () => { phase = "STALE"; })).toBe(false);
    expect(guard.runIfActive(nextAttemptId, () => { phase = "DRAFT"; })).toBe(true);
    expect(phase).toBe("DRAFT");
  });
});

describe("Room-status query attempt lifecycle", () => {
  it("keeps projection refresh active until the command enters formal confirmation", () => {
    expect(roomStatusProjectionRefreshAllowed("IDLE")).toBe(true);
    expect(roomStatusProjectionRefreshAllowed("DRAFT")).toBe(true);
    expect(roomStatusProjectionRefreshAllowed("PREVIEW")).toBe(true);
    expect(roomStatusProjectionRefreshAllowed("SETTLED")).toBe(true);
    expect(roomStatusProjectionRefreshAllowed("CONFIRMING")).toBe(false);
  });

  it("keeps a slow query active so a polling tick can skip overlapping refreshes", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const slowAttemptId = guard.begin();

    expect(guard.isInFlight()).toBe(true);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    const pollingTickStartedAnotherRequest = guard.isInFlight() ? false : Boolean(guard.begin());
    expect(pollingTickStartedAnotherRequest).toBe(false);
    expect(guard.isActive(slowAttemptId)).toBe(true);

    expect(guard.finish(slowAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });

  it("does not let a superseded range response finish the current query", () => {
    const guard = new RoomStatusQueryAttemptGuard();
    const oldRangeAttemptId = guard.begin();
    expect(guard.invalidate(oldRangeAttemptId)).toBe(true);

    const currentRangeAttemptId = guard.begin();
    expect(guard.finish(oldRangeAttemptId)).toBe(false);
    expect(guard.isActive(currentRangeAttemptId)).toBe(true);
    expect(guard.finish(currentRangeAttemptId)).toBe(true);
    expect(guard.isInFlight()).toBe(false);
  });
});

describe("Room-status Block draft authorization", () => {
  it("only permits a non-empty interval contained by the server-validated selection", () => {
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(true);
    expect(roomStatusBlockDraftWithinSelection("2026-07-19", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-25", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("2026-07-21", "2026-07-21", "2026-07-20", "2026-07-24")).toBe(false);
    expect(roomStatusBlockDraftWithinSelection("", "2026-07-23", "2026-07-20", "2026-07-24")).toBe(false);
  });
});
