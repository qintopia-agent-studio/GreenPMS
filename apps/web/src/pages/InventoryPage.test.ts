import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QuoteRequestGuard,
  RoomStatusCommandAttemptGuard,
  RoomStatusQueryAttemptGuard,
  SelectedMemberViewRequestGuard,
  GUEST_FULL_NAME_MAX_LENGTH,
  applyMemberSelectionToGuestForms,
  backfillCollectionCommandInput,
  backfillReviewDetailsComplete,
  backfillReviewValidationError,
  backfillSubmitBlockedReason,
  bookingChannelRequiredForStay,
  canAddGuest,
  completedStayBackfillCommandRequest,
  completedStayBackfillSubmissionError,
  clearCorruptQuoteCommandRecovery,
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
  parseBackfillCollectionYuanToMinor,
  parseYuanAmountToMinor,
  quotePricingSummary,
  QuoteRecoveryPageEntry,
  staffQuoteError,
  readQuoteCommandRecovery,
  recoveredQuoteWaitsForCurrentTarget,
  roomStatusCommandWriteGate,
  roomStatusFiltersRevealingTarget,
  roomStatusAnchorMatches,
  roomStatusQuickTargetMatches,
  roomStatusGridSelectedStayId,
  roomStatusQuickPopoverPreviewStayId,
  roomStatusActionsForPresentation,
  roomStatusActionPresentationBlock,
  roomStatusAuthorizedQuoteAction,
  roomStatusHistoricalSelectionNeedsRefresh,
  roomStatusOrderContextVisible,
  roomStatusOrderIdentityKey,
  roomStatusOrderContextMode,
  roomStatusDesktopContextKind,
  roomStatusQuoteRecoveryDrawerOpen,
  roomStatusOwnQuoteRecoveryMatchesTarget,
  roomStatusOwnQuoteRecoveryVisible,
  roomStatusQuoteRecoveryNeedsPagePresentation,
  roomStatusRecoveryBlocksNewWrites,
  quoteRecoveryContextIdentity,
  shouldAutoOpenQuoteRecoveryContext,
  shouldAutoResolveOwnSendingQuoteRecovery,
  shouldOfferManualOwnSendingQuoteRecovery,
  shouldRenderDetachedQuoteRecoveryWorkbench,
  roomStatusOrderCommandScope,
  roomStatusProjectionRefreshAllowed,
  roomStatusProjectionWritable,
  roomStatusQuoteActionCodeForUnit,
  roomStatusQuoteCommandMatchesTarget,
  roomStatusQuoteRequiresBackfill,
  roomStatusQuoteTargetFromAction,
  roomStatusQuoteTargetForBusinessDate,
  roomStatusTimelineRangeFromStart,
  updateRoomStatusQuoteTargetSelection,
  selectedOrderCommandScopeIsCurrent,
  selectedOrderMemberLookup,
  selectedStayDateRequestIsCompatible,
  roomStatusBlockDraftWithinSelection,
  selectionActions,
  dayActions,
  browserQuoteRecoveryOwnerId,
  saveQuoteCommandRecovery
} from "./InventoryPage";
import { quoteRecoveryStorageKey } from "../ui";
import { ApiError } from "../api";
import { createSharedCommandRecoveryStorage } from "../ui";

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
  ownerTabId: "tab_quote_owner",
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
  it("derives the room-status timeline from one start date and always keeps 30 nights", () => {
    expect(roomStatusTimelineRangeFromStart("2026-08-21")).toEqual({
      arrivalDate: "2026-08-21",
      departureDate: "2026-09-20"
    });
  });

  it("keeps order selection explicit and avoids carrying stale order highlights into plain quick-popovers", () => {
    expect(roomStatusGridSelectedStayId(false, null, { stayId: "stay_cross_room" })).toBe("stay_cross_room");
    expect(roomStatusGridSelectedStayId(true, "stay_quick", { stayId: "stay_previous" })).toBe("stay_quick");
    expect(roomStatusGridSelectedStayId(true, null, { stayId: "stay_previous" })).toBeNull();
    expect(roomStatusGridSelectedStayId(true, null, undefined, "stay_from_interval")).toBeNull();
    expect(roomStatusGridSelectedStayId(false, null, undefined, "stay_from_interval")).toBe("stay_from_interval");
    expect(roomStatusGridSelectedStayId(false, null)).toBeNull();
  });

  it("does not promote a split-bed parent summary to its only child order", () => {
    const parent = { kind: "ROOM", salesMode: "BED_SPLIT" } as const;
    expect(roomStatusQuickPopoverPreviewStayId(parent, null, "stay_child")).toBeNull();
    expect(roomStatusQuickPopoverPreviewStayId(parent, "stay_whole_room", "stay_child"))
      .toBe("stay_whole_room");
  });

  it("keeps the unique-order fallback for concrete bed and whole-room rows", () => {
    expect(roomStatusQuickPopoverPreviewStayId(
      { kind: "BED", salesMode: "BED_SPLIT" },
      null,
      "stay_inherited_whole_room"
    )).toBe("stay_inherited_whole_room");
    expect(roomStatusQuickPopoverPreviewStayId(
      { kind: "ROOM", salesMode: "WHOLE_ROOM" },
      null,
      "stay_whole_room"
    )).toBe("stay_whole_room");
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

  it("blocks new room-status writes while any same-property recovery is unresolved", () => {
    expect(roomStatusCommandWriteGate({
      projectionWritable: true,
      activeProjectionValid: true,
      recoveryBlocked: true,
      recoveryReady: true,
      recoveryError: undefined,
      contextInvalidated: false,
      targetScopeCurrent: true
    }).startBlocked).toBe(true);
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
      nickname: "会员昵称",
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
      nickname: "会员昵称",
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
      nickname: "会员昵称",
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

  it("parses backfill collections to fen, including zero and two decimal places", () => {
    expect(parseBackfillCollectionYuanToMinor("0")).toBe(0);
    expect(parseBackfillCollectionYuanToMinor("84.5")).toBe(8_450);
    expect(parseBackfillCollectionYuanToMinor("84.50")).toBe(8_450);
    expect(parseBackfillCollectionYuanToMinor("0.01")).toBe(1);
    expect(parseBackfillCollectionYuanToMinor("84.501")).toBeUndefined();
    expect(parseBackfillCollectionYuanToMinor("-1")).toBeUndefined();
  });

  it("opens backfill review only after the matching free, channel, or collection evidence is complete", () => {
    const paid = {
      stayType: "TRANSIENT" as const,
      backfillReason: "前台漏录",
      freeStayCategoryCode: "" as const,
      freeStayReason: "",
      bookingChannelCode: "WECOM" as const,
      targetAmountYuan: "100",
      contractAmountMinor: 10_000,
      channelOrderReference: "",
      channelReasonRequired: false,
      channelPriceDifferenceReason: "",
      manualReasonRequired: false,
      manualPriceAdjustmentReason: "",
      collectionAmountYuan: "0",
      collectionAmountMinor: 0,
      collectionMethod: "WECOM",
      transactionReference: "",
      cashCollector: "",
      cashNote: ""
    };
    expect(backfillReviewDetailsComplete(paid)).toBe(true);
    expect(backfillReviewDetailsComplete({ ...paid, backfillReason: " " })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: undefined })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 10_001, transactionReference: "WX-OVER" })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 8_450 })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 8_450, transactionReference: "WX-8450" })).toBe(true);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 8_450, collectionMethod: "BANK_TRANSFER", transactionReference: "BANK-8450" })).toBe(true);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 8_450, collectionMethod: "CASH", cashCollector: "前台甲", cashNote: "现金已核对" })).toBe(true);
    expect(backfillReviewDetailsComplete({ ...paid, collectionAmountMinor: 8_450, collectionMethod: "CASH", cashCollector: "前台甲", cashNote: "" })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, bookingChannelCode: "CTRIP", channelOrderReference: "" })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...paid, bookingChannelCode: "CTRIP", channelOrderReference: "XC-100", collectionAmountMinor: undefined })).toBe(true);

    const free = {
      ...paid,
      stayType: "FREE" as const,
      bookingChannelCode: "" as const,
      targetAmountYuan: "",
      contractAmountMinor: undefined,
      collectionAmountYuan: "",
      collectionAmountMinor: undefined,
      freeStayCategoryCode: "VOLUNTEER" as const,
      freeStayReason: "义工住宿"
    };
    expect(backfillReviewDetailsComplete(free)).toBe(true);
    expect(backfillReviewDetailsComplete({ ...free, freeStayCategoryCode: "" })).toBe(false);
    expect(backfillReviewDetailsComplete({ ...free, freeStayReason: " " })).toBe(false);
  });

  it("explains the exact missing backfill evidence instead of returning one generic error", () => {
    const paid = {
      stayType: "TRANSIENT" as const,
      backfillReason: "前台漏录",
      freeStayCategoryCode: "" as const,
      freeStayReason: "",
      bookingChannelCode: "WECOM" as const,
      targetAmountYuan: "100",
      contractAmountMinor: 10_000,
      channelOrderReference: "",
      channelReasonRequired: false,
      channelPriceDifferenceReason: "",
      manualReasonRequired: false,
      manualPriceAdjustmentReason: "",
      collectionAmountYuan: "84.50",
      collectionAmountMinor: 8_450,
      collectionMethod: "WECOM",
      transactionReference: "",
      cashCollector: "",
      cashNote: ""
    };
    expect(backfillReviewValidationError({ ...paid, backfillReason: " " })).toBe("请填写补录原因");
    expect(backfillReviewValidationError(paid)).toBe("请填写本次实际收款对应的真实交易单号");
    expect(backfillReviewValidationError({ ...paid, collectionAmountMinor: 10_001, transactionReference: "WX-OVER" }))
      .toBe("补录实收金额不能超过本单金额");
    expect(backfillReviewValidationError({ ...paid, collectionAmountYuan: "", collectionAmountMinor: undefined }))
      .toBe("请填写补录实收金额；没有住宿收款时填写 0");
    expect(backfillReviewValidationError({ ...paid, collectionAmountYuan: "84.501", collectionAmountMinor: undefined }))
      .toBe("补录实收金额格式不正确，请填写不超过两位小数的非负金额");
    expect(backfillReviewValidationError({ ...paid, bookingChannelCode: "", collectionAmountYuan: "", collectionAmountMinor: undefined }))
      .toBe("请选择订单来源渠道");
    expect(backfillReviewValidationError({ ...paid, targetAmountYuan: "100.5", contractAmountMinor: undefined }))
      .toBe("本单金额格式不正确，请填写非负整数金额");
    expect(backfillReviewValidationError({ ...paid, bookingChannelCode: "CTRIP", channelOrderReference: "" }))
      .toBe("请填写渠道订单号");
    expect(backfillReviewValidationError({ ...paid, manualReasonRequired: true, manualPriceAdjustmentReason: "" }))
      .toBe("请填写人工调价原因");
    expect(backfillReviewValidationError({ ...paid, channelReasonRequired: true, channelPriceDifferenceReason: "" }))
      .toBe("请填写渠道价格差异说明");
    expect(backfillReviewValidationError({ ...paid, collectionMethod: "CASH", cashCollector: "", cashNote: "" }))
      .toBe("请填写现金收款人");
    expect(backfillReviewValidationError({ ...paid, collectionMethod: "CASH", cashCollector: "前台甲", cashNote: "" }))
      .toBe("请填写现金收款核对备注");
    expect(backfillReviewValidationError({ ...paid, collectionMethod: "CARD" }))
      .toBe("请选择有效的收款方式");
    expect(backfillReviewValidationError({
      ...paid,
      stayType: "FREE",
      freeStayCategoryCode: "",
      freeStayReason: "",
      bookingChannelCode: "",
      targetAmountYuan: "",
      contractAmountMinor: undefined,
      collectionAmountYuan: "",
      collectionAmountMinor: undefined
    })).toBe("请选择免费入住类型");
  });

  it("explains why the backfill review button is temporarily disabled", () => {
    expect(backfillSubmitBlockedReason({
      commandsBlocked: false,
      quoteIsCurrent: false,
      guestCount: 1,
      occupancyCapacity: 1
    })).toBe("房源或住宿日期的最新报价尚未载入，请稍候");
    expect(backfillSubmitBlockedReason({
      commandsBlocked: true,
      quoteIsCurrent: true,
      guestCount: 1,
      occupancyCapacity: 1
    })).toBe("当前房态已变化、正在刷新、权限受限或有操作尚未收口，请按页面提示处理后重试");
    expect(backfillSubmitBlockedReason({
      commandsBlocked: false,
      quoteIsCurrent: true,
      guestCount: 2,
      occupancyCapacity: 1
    })).toBe("住宿人数超过当前房源可入住人数");
    expect(backfillSubmitBlockedReason({
      commandsBlocked: false,
      quoteIsCurrent: true,
      guestCount: 1,
      occupancyCapacity: 1
    })).toBeUndefined();
  });

  it("opens completed and cross-today backfills while keeping today-start stays on ordinary creation", () => {
    expect(completedStayBackfillSubmissionError("2026-08-06", "2026-08-11", "2026-08-14")).toBeUndefined();
    expect(completedStayBackfillSubmissionError("2026-08-06", "2026-08-14", "2026-08-14")).toBeUndefined();
    expect(completedStayBackfillSubmissionError("2026-08-13", "2026-08-15", "2026-08-14"))
      .toBeUndefined();
    expect(completedStayBackfillSubmissionError("2026-08-14", "2026-08-15", "2026-08-14"))
      .toContain("创建订单");
  });

  it("builds one server Preview request with truthful zero, transfer, and cash collection evidence", () => {
    expect(backfillCollectionCommandInput({
      amountMinor: 0,
      method: "WECOM",
      transactionReference: "",
      cashCollector: "",
      cashNote: ""
    })).toEqual({ amountMinor: 0, method: "WECOM" });
    expect(backfillCollectionCommandInput({
      amountMinor: 8_450,
      method: "BANK_TRANSFER",
      transactionReference: "BANK-8450",
      cashCollector: "",
      cashNote: ""
    })).toEqual({ amountMinor: 8_450, method: "BANK_TRANSFER", transactionReference: "BANK-8450" });
    expect(backfillCollectionCommandInput({
      amountMinor: 8_450,
      method: "CASH",
      transactionReference: "",
      cashCollector: "前台甲",
      cashNote: "现金已核对"
    })).toEqual({ amountMinor: 8_450, method: "CASH", cashCollector: "前台甲", note: "现金已核对" });

    expect(completedStayBackfillCommandRequest({
      propertyId: "property_green",
      quoteId: "quote_backfill",
      primaryGuest: { fullName: "测试住客", nickname: "测试" },
      additionalGuests: [],
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: 10_000,
      backfillCollection: { amountMinor: 8_450, method: "WECOM", transactionReference: "WX-8450" }
    }, " 前台漏录 ")).toMatchObject({
      commandType: "CREATE_ORDER",
      title: "补录住宿",
      presentation: "BACKFILL_STAY",
      initialReason: { code: "BACKFILL_STAY", note: "前台漏录" },
      input: {
        propertyId: "property_green",
        quoteId: "quote_backfill",
        backfill: true,
        backfillReason: "前台漏录",
        backfillCollection: { amountMinor: 8_450, method: "WECOM", transactionReference: "WX-8450" }
      }
    });
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
    expect(createOrderPricingDraft({ ...base, targetAmountYuan: "0" })).toMatchObject({ complete: false });
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
        description: "住宿费合计：10 夜按 7 夜档折算",
        pricingBandAnchorNights: 7,
        pricingSummary: "本行最终金额 ¥1,086.00；计算依据：2026-07-26 至 2026-08-05，10 夜按 7 夜档 ¥760.00 折算；按整段住宿金额一次取整。",
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

  it("persists an explicit room-status action intent and rejects unknown recovery intents", () => {
    const storage = new MemoryStorage();
    const backfillPending = { ...pending, actionCode: "BACKFILL_ORDER" as const };
    expect(saveQuoteCommandRecovery(storage, backfillPending)).toBe(true);
    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({
      kind: "VALID",
      pending: backfillPending
    });

    storage.setItem(scope, JSON.stringify({ ...pending, actionCode: "LOCK_MAINTENANCE" }));
    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toMatchObject({ kind: "CORRUPT" });
  });

  it("keeps the quote recovery owner stable across same-document remounts", () => {
    const firstMountOwner = browserQuoteRecoveryOwnerId();
    const remountedOwner = browserQuoteRecoveryOwnerId();

    expect(remountedOwner).toBe(firstMountOwner);
    expect(firstMountOwner).toMatch(/[0-9a-f-]{36}/i);
  });

  it("shares quote recovery writes and removals across tab-specific session mirrors", () => {
    const authoritative = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, new MemoryStorage());
    const secondTabSession = new MemoryStorage();
    const secondTab = createSharedCommandRecoveryStorage(authoritative, secondTabSession);

    expect(saveQuoteCommandRecovery(firstTab, pending)).toBe(true);
    expect(readQuoteCommandRecovery(secondTab, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
    expect(secondTabSession.getItem(scope)).toBe(JSON.stringify(pending));

    firstTab.removeItem(scope);
    expect(readQuoteCommandRecovery(secondTab, subjectId, propertyId)).toEqual({ kind: "ABSENT" });
    expect(secondTabSession.getItem(scope)).toBeNull();
  });

  it("refreshes a stale quote session mirror when the same idempotency key advances state", () => {
    const authoritative = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, new MemoryStorage());
    const secondTabSession = new MemoryStorage();
    const secondTab = createSharedCommandRecoveryStorage(authoritative, secondTabSession);
    const unknown = { ...pending, state: "UNKNOWN" as const };

    expect(saveQuoteCommandRecovery(firstTab, pending)).toBe(true);
    expect(readQuoteCommandRecovery(secondTab, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
    expect(saveQuoteCommandRecovery(firstTab, unknown)).toBe(true);

    expect(readQuoteCommandRecovery(secondTab, subjectId, propertyId)).toEqual({ kind: "VALID", pending: unknown });
    expect(secondTabSession.getItem(scope)).toBe(JSON.stringify(unknown));
  });

  it("clears only a corrupt quote recovery record after staff review", () => {
    const storage = new MemoryStorage();
    storage.setItem(scope, "{damaged-json");
    storage.setItem(quoteRecoveryStorageKey(subjectId, "property_other"), JSON.stringify(pending));

    expect(clearCorruptQuoteCommandRecovery(storage, subjectId, propertyId)).toBe(true);
    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({ kind: "ABSENT" });
    expect(storage.getItem(quoteRecoveryStorageKey(subjectId, "property_other"))).not.toBeNull();

    expect(saveQuoteCommandRecovery(storage, pending)).toBe(true);
    expect(clearCorruptQuoteCommandRecovery(storage, subjectId, propertyId)).toBe(false);
    expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toEqual({ kind: "VALID", pending });
  });

  it("classifies invalid quote inputs and unusable metadata as corrupt recovery records", () => {
    const storage = new MemoryStorage();
    const invalidInputs = [
      { ...pending.input, inventoryUnitId: "" },
      { ...pending.input, stayType: "UNSUPPORTED" },
      { ...pending.input, arrivalDate: "2026-02-30" },
      { ...pending.input, departureDate: pending.input.arrivalDate },
      { ...pending.input, unexpected: "field" }
    ];
    for (const input of invalidInputs) {
      storage.setItem(scope, JSON.stringify({ ...pending, input, inputSignature: JSON.stringify(input) }));
      expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toMatchObject({ kind: "CORRUPT" });
    }
    for (const metadata of [
      { ...pending.metadata, idempotencyKey: "   " },
      { ...pending.metadata, idempotencyKey: "x".repeat(161) },
      { ...pending.metadata, correlationId: "   " },
      { ...pending.metadata, correlationId: "x".repeat(161) }
    ]) {
      storage.setItem(scope, JSON.stringify({ ...pending, metadata }));
      expect(readQuoteCommandRecovery(storage, subjectId, propertyId)).toMatchObject({ kind: "CORRUPT" });
    }
  });
});

describe("Room-status order context layout", () => {
  it("keeps every desktop width on the simple drawer path", () => {
    expect(roomStatusOrderContextMode(0, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1199, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1200, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1600, false)).toBe("DRAWER");
    expect(roomStatusOrderContextMode(1600, true)).toBe("DRAWER");
  });

  it("keeps the quote recovery entry reachable while an order context still exists", () => {
    expect(roomStatusDesktopContextKind(true, true)).toBe("QUOTE_RECOVERY");
    expect(roomStatusDesktopContextKind(false, true)).toBe("ORDER");
    expect(roomStatusDesktopContextKind(false, false)).toBe("SELECTION");
    expect(roomStatusQuoteRecoveryDrawerOpen(false, false)).toBe(false);
    expect(roomStatusQuoteRecoveryDrawerOpen(true, false)).toBe(true);
    expect(roomStatusQuoteRecoveryDrawerOpen(false, true)).toBe(true);

    const html = renderToStaticMarkup(createElement(QuoteRecoveryPageEntry, {
      recovery: { kind: "VALID", pending },
      onOpen: () => undefined
    }));
    expect(html).toContain('data-testid="inventory-quote-recovery-entry"');
    expect(html).toContain("有一笔报价需要处理");
    expect(html).toContain("打开处理入口");
    expect(renderToStaticMarkup(createElement(QuoteRecoveryPageEntry, {
      recovery: { kind: "ABSENT" },
      onOpen: () => undefined
    }))).toBe("");
  });

  it("opens each new desktop Quote recovery once and lets the operator dismiss it", () => {
    const recovery = { kind: "VALID" as const, pending };
    const identity = quoteRecoveryContextIdentity(scope, recovery);
    expect(identity).toContain(pending.metadata.idempotencyKey);
    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: identity,
      dismissedIdentity: undefined,
      autoOpenedIdentity: undefined,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: "another-tab",
      isMobile: false,
      hasSelectedOrder: false
    })).toBe(true);
    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: identity,
      dismissedIdentity: identity,
      autoOpenedIdentity: undefined,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: "another-tab",
      isMobile: false,
      hasSelectedOrder: false
    })).toBe(false);
    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: identity,
      dismissedIdentity: undefined,
      autoOpenedIdentity: undefined,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: "another-tab",
      isMobile: true,
      hasSelectedOrder: false
    })).toBe(false);
    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: identity,
      dismissedIdentity: undefined,
      autoOpenedIdentity: undefined,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId,
      isMobile: false,
      hasSelectedOrder: false
    })).toBe(false);

    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: identity,
      dismissedIdentity: undefined,
      autoOpenedIdentity: identity,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: "another-tab",
      isMobile: false,
      hasSelectedOrder: false
    })).toBe(false);
    expect(shouldAutoOpenQuoteRecoveryContext({
      recoveryIdentity: `${identity}-new`,
      dismissedIdentity: identity,
      autoOpenedIdentity: identity,
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: "another-tab",
      isMobile: false,
      hasSelectedOrder: false
    })).toBe(true);
  });

  it("automatically checks an own SENDING Quote identity only once", () => {
    const identity = quoteRecoveryContextIdentity(scope, { kind: "VALID", pending });
    expect(shouldAutoResolveOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: undefined,
      recoveryState: "SENDING",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId,
      busy: false
    })).toBe(true);
    expect(shouldAutoResolveOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: identity,
      recoveryState: "SENDING",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId,
      busy: false
    })).toBe(false);
    expect(shouldAutoResolveOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: undefined,
      recoveryState: "UNKNOWN",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId,
      busy: false
    })).toBe(false);
  });

  it("keeps an own recovery in the current workbench only for the exact quote target", () => {
    const currentTarget = {
      unitId: "unit_room_101",
      arrivalDate: "2026-10-10",
      departureDate: "2026-10-12",
      initialStayType: "TRANSIENT" as const,
      actionCode: "CREATE_ORDER" as const
    };
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "SENDING",
      recoveryOwnerId: "tab_current",
      currentOwnerId: "tab_current",
      recoveryTarget: currentTarget,
      currentTarget
    })).toBe(true);
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "UNKNOWN",
      recoveryOwnerId: "tab_current",
      currentOwnerId: "tab_current",
      recoveryTarget: currentTarget,
      currentTarget
    })).toBe(true);
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "SENDING",
      recoveryOwnerId: "tab_other",
      currentOwnerId: "tab_current",
      recoveryTarget: currentTarget,
      currentTarget
    })).toBe(false);
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "SENDING",
      recoveryOwnerId: "tab_current",
      currentOwnerId: "tab_current",
      recoveryTarget: { ...currentTarget, departureDate: "2026-10-13" },
      currentTarget
    })).toBe(false);
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "SENDING",
      recoveryOwnerId: "tab_current",
      currentOwnerId: "tab_current",
      recoveryTarget: { ...currentTarget, initialStayType: "CUSTOM" },
      currentTarget
    })).toBe(true);
    expect(roomStatusOwnQuoteRecoveryMatchesTarget({
      recoveryState: "SENDING",
      recoveryOwnerId: "tab_current",
      currentOwnerId: "tab_current",
      recoveryTarget: { ...currentTarget, initialStayType: "FREE" },
      currentTarget
    })).toBe(false);
  });

  it("hides a matching own recovery after that identity is dismissed", () => {
    const identity = quoteRecoveryContextIdentity(scope, { kind: "VALID", pending });
    expect(roomStatusOwnQuoteRecoveryVisible(true, identity, undefined)).toBe(true);
    expect(roomStatusOwnQuoteRecoveryVisible(true, identity, identity)).toBe(false);
    expect(roomStatusOwnQuoteRecoveryVisible(false, identity, undefined)).toBe(false);
  });

  it("keys pending order drawer openings by stable order and stay identity", () => {
    expect(roomStatusOrderIdentityKey(undefined)).toBeUndefined();
    expect(roomStatusOrderIdentityKey({
      orderId: "order_1",
      stayId: "stay_1"
    })).toBe("order_1:stay_1");
    expect(roomStatusOrderIdentityKey({
      orderId: "order_1",
      stayId: "stay_2"
    })).not.toBe(roomStatusOrderIdentityKey({
      orderId: "order_1",
      stayId: "stay_1"
    }));
  });

  it("blocks new room-status writes while Quote recovery has not closed", () => {
    expect(roomStatusRecoveryBlocksNewWrites(false, { kind: "ABSENT" })).toBe(false);
    expect(roomStatusRecoveryBlocksNewWrites(true, { kind: "ABSENT" })).toBe(true);
    expect(roomStatusRecoveryBlocksNewWrites(false, { kind: "VALID", pending })).toBe(true);
    expect(roomStatusRecoveryBlocksNewWrites(false, {
      kind: "READ_ERROR",
      error: new Error("storage unavailable")
    })).toBe(true);
  });

  it("presents an own current SENDING Quote as recovery only after its workbench closes", () => {
    const currentTarget = {
      unitId: pending.input.inventoryUnitId,
      arrivalDate: pending.input.arrivalDate,
      departureDate: pending.input.departureDate,
      initialStayType: "FREE" as const
    };
    const recovery = { kind: "VALID" as const, pending };
    const activeInput = {
      recovery,
      currentOwnerId: pending.ownerTabId,
      activeSubmissionIdentity: pending.metadata.idempotencyKey,
      recoveryTarget: currentTarget,
      currentTarget,
      workbenchOpen: true
    };

    expect(roomStatusQuoteRecoveryNeedsPagePresentation(activeInput)).toBe(false);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      workbenchOpen: false
    })).toBe(true);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      recovery: { kind: "VALID", pending: { ...pending, state: "UNKNOWN" } }
    })).toBe(true);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      currentOwnerId: "another-tab"
    })).toBe(true);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      currentTarget: { ...currentTarget, departureDate: "2026-10-13" }
    })).toBe(false);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      activeSubmissionIdentity: undefined,
      currentTarget: { ...currentTarget, departureDate: "2026-10-13" }
    })).toBe(true);
    expect(roomStatusQuoteRecoveryNeedsPagePresentation({
      ...activeInput,
      recovery: { kind: "READ_ERROR", error: new Error("storage unavailable") }
    })).toBe(true);
  });

  it("retains an authoritative recovered Quote until its room-status target is ready", () => {
    expect(recoveredQuoteWaitsForCurrentTarget(false, "")).toBe(true);
    expect(recoveredQuoteWaitsForCurrentTarget(false, pending.inputSignature)).toBe(false);
    expect(recoveredQuoteWaitsForCurrentTarget(true, "")).toBe(false);
  });

  it("offers a manual result check after an own automatic SENDING check already started", () => {
    const identity = quoteRecoveryContextIdentity(scope, { kind: "VALID", pending });
    expect(shouldOfferManualOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: identity,
      recoveryState: "SENDING",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId
    })).toBe(true);
    expect(shouldOfferManualOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: undefined,
      recoveryState: "SENDING",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId
    })).toBe(false);
    expect(shouldOfferManualOwnSendingQuoteRecovery({
      recoveryIdentity: identity,
      attemptedIdentity: identity,
      recoveryState: "UNKNOWN",
      recoveryOwnerId: pending.ownerTabId,
      currentOwnerId: pending.ownerTabId
    })).toBe(false);
  });

  it("blocks automatic recovery only while an order context is actually visible", () => {
    const selectedOrder = { orderId: "order_1", stayId: "stay_1" };
    expect(roomStatusOrderContextVisible(selectedOrder, true)).toBe(true);
    expect(roomStatusOrderContextVisible(selectedOrder, false)).toBe(false);
    expect(roomStatusOrderContextVisible(undefined, true)).toBe(false);
  });

  it("keeps the recovery workbench renderable when the first room-status Query failed", () => {
    expect(shouldRenderDetachedQuoteRecoveryWorkbench(false, true, { kind: "VALID", pending })).toBe(true);
    expect(shouldRenderDetachedQuoteRecoveryWorkbench(false, false, { kind: "VALID", pending })).toBe(false);
    expect(shouldRenderDetachedQuoteRecoveryWorkbench(true, true, { kind: "VALID", pending })).toBe(false);
    expect(shouldRenderDetachedQuoteRecoveryWorkbench(false, true, { kind: "ABSENT" })).toBe(false);
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
  it("pauses projection refresh while an operator command is active", () => {
    expect(roomStatusProjectionRefreshAllowed("IDLE")).toBe(true);
    expect(roomStatusProjectionRefreshAllowed("DRAFT")).toBe(false);
    expect(roomStatusProjectionRefreshAllowed("PREVIEW")).toBe(false);
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

describe("Room-status backfill entry routing", () => {
  const targetReference = { type: "INVENTORY_UNIT" as const, id: "unit_backfill", label: "102-B", href: null };
  const action = (
    code: "CREATE_ORDER" | "CREATE_FREE_STAY" | "BACKFILL_ORDER" | "LOCK_MAINTENANCE",
    unitId = "unit_backfill",
    enabled = true
  ) => ({
    code,
    enabled,
    disabledReason: enabled ? null : "服务端暂停该操作",
    requiresFullInterval: false,
    targetReference: { ...targetReference, id: unitId }
  });
  const day = (serviceDate: string, available: boolean) => ({
    serviceDate,
    status: "AVAILABLE" as const,
    available,
    intervalIds: [],
    conflicts: []
  });
  const unit = {
    id: "unit_backfill",
    days: [
      day("2026-08-12", false),
      day("2026-08-13", false),
      day("2026-08-14", true),
      day("2026-08-15", true)
    ],
    allowedActions: [action("CREATE_ORDER"), action("CREATE_FREE_STAY"), action("BACKFILL_ORDER"), action("LOCK_MAINTENANCE")],
    intervals: []
  } as unknown as NonNullable<Parameters<typeof selectionActions>[0]>;

  it("offers backfill for completed historical and cross-today selections", () => {
    expect(selectionActions(unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-12",
      focusDate: "2026-08-12",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-13"
    }, "2026-08-14").map((candidate) => candidate.code)).toEqual(["BACKFILL_ORDER"]);

    expect(selectionActions(unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-13",
      focusDate: "2026-08-14",
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-15"
    }, "2026-08-14").map((candidate) => candidate.code)).toEqual(["BACKFILL_ORDER"]);

    expect(selectionActions(unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-12",
      focusDate: "2026-08-13",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-14"
    }, "2026-08-14").map((candidate) => candidate.code)).toEqual(["BACKFILL_ORDER"]);
  });

  it("keeps normal creation for selections starting today and routes a historical single day to backfill", () => {
    expect(selectionActions(unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-14",
      focusDate: "2026-08-15",
      arrivalDate: "2026-08-14",
      departureDate: "2026-08-16"
    }, "2026-08-14").map((candidate) => candidate.code)).toEqual(["CREATE_ORDER", "CREATE_FREE_STAY", "LOCK_MAINTENANCE"]);
    expect(dayActions(unit, unit!.days[0]!, "2026-08-14").map((candidate) => candidate.code)).toEqual(["BACKFILL_ORDER"]);
  });

  it("fails closed when a selected date is occupied or missing from the authoritative window", () => {
    const blocked = {
      ...unit!,
      days: unit!.days.map((candidate) => candidate.serviceDate === "2026-08-14"
        ? { ...candidate, available: false, intervalIds: ["interval_busy"] }
        : candidate)
    };
    expect(selectionActions(blocked, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-13",
      focusDate: "2026-08-14",
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-15"
    }, "2026-08-14")).toEqual([]);
    expect(selectionActions(unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-11",
      focusDate: "2026-08-12",
      arrivalDate: "2026-08-11",
      departureDate: "2026-08-13"
    }, "2026-08-14")).toEqual([]);
  });

  it("keeps a server-disabled backfill action visible but never treats it as authorization", () => {
    const disabledUnit = {
      ...unit!,
      allowedActions: [action("BACKFILL_ORDER", "unit_backfill", false)]
    };
    const selection = {
      unitId: "unit_backfill",
      anchorDate: "2026-08-12",
      focusDate: "2026-08-12",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-13"
    };
    expect(selectionActions(disabledUnit, selection, "2026-08-14")).toEqual([
      expect.objectContaining({
        code: "BACKFILL_ORDER",
        enabled: false,
        disabledReason: "服务端暂停该操作"
      })
    ]);
    expect(roomStatusQuoteTargetFromAction(
      disabledUnit.allowedActions[0]!,
      disabledUnit,
      selection,
      "2026-08-14"
    )).toBeUndefined();
  });

  it("keeps an empty child bed eligible when sibling beds occupy the parent room", () => {
    const blankBed = {
      ...unit!,
      id: "unit_room_104_bed_c",
      days: [
        day("2026-08-11", false),
        day("2026-08-12", false),
        day("2026-08-13", false),
        day("2026-08-14", false)
      ],
      children: []
    };
    const occupiedParent = {
      ...unit!,
      id: "unit_room_104",
      days: blankBed.days.map((candidate) => ({
        ...candidate,
        status: "IN_HOUSE" as const,
        intervalIds: ["stay_104_a", "order_104_b"]
      })),
      children: [blankBed]
    };
    const childSelection = {
      unitId: blankBed.id,
      anchorDate: "2026-08-11",
      focusDate: "2026-08-14",
      arrivalDate: "2026-08-11",
      departureDate: "2026-08-15"
    };

    const authorizedActions = selectionActions(occupiedParent.children[0]!, childSelection, "2026-08-15");
    expect(authorizedActions.map((candidate) => candidate.code)).toEqual(["BACKFILL_ORDER"]);
    expect(roomStatusActionsForPresentation(authorizedActions, roomStatusActionPresentationBlock({
      refreshFailed: false,
      accessLevel: "WRITE",
      projectionWritable: true,
      projectionExpired: false,
      projectionReady: true,
      recoveryBlocked: true,
      recoveryReady: true,
      recoveryError: undefined,
      hasRecoveryEntry: true
    }))).toEqual([expect.objectContaining({
      code: "BACKFILL_ORDER",
      enabled: false,
      disabledReason: expect.stringContaining("上一笔操作结果")
    })]);
    expect(selectionActions(occupiedParent, {
      ...childSelection,
      unitId: occupiedParent.id
    }, "2026-08-15")).toEqual([]);
  });

  it("prioritizes a failed projection refresh and refreshes an expired historical selection immediately", () => {
    expect(roomStatusActionPresentationBlock({
      refreshFailed: true,
      accessLevel: "WRITE",
      projectionWritable: false,
      projectionExpired: true,
      projectionReady: false,
      recoveryBlocked: true,
      recoveryReady: true,
      recoveryError: undefined,
      hasRecoveryEntry: true
    })).toMatchObject({
      kind: "REFRESH",
      actionLabel: "重试刷新",
      reason: expect.stringContaining("房态刷新失败")
    });
    const guard = new RoomStatusQueryAttemptGuard();
    const requestId = guard.begin();
    expect(roomStatusHistoricalSelectionNeedsRefresh({
      boardExpired: true,
      historicalSelectionOpen: true,
      queryInFlight: guard.isInFlight()
    })).toBe(false);
    expect(guard.finish(requestId)).toBe(true);
    expect(roomStatusHistoricalSelectionNeedsRefresh({
      boardExpired: true,
      historicalSelectionOpen: true,
      queryInFlight: guard.isInFlight()
    })).toBe(true);
    expect(roomStatusHistoricalSelectionNeedsRefresh({
      boardExpired: true,
      historicalSelectionOpen: false,
      queryInFlight: false
    })).toBe(false);
  });

  it("requires both board and current principal WRITE access", () => {
    const base = {
      projectionReady: true,
      projectionExpired: false,
      boardAccess: "WRITE",
      principalAccess: "WRITE"
    };
    expect(roomStatusProjectionWritable(base)).toBe(true);
    expect(roomStatusProjectionWritable({ ...base, principalAccess: "READ" })).toBe(false);
    expect(roomStatusProjectionWritable({ ...base, boardAccess: "READ" })).toBe(false);
    expect(roomStatusProjectionWritable({ ...base, projectionExpired: true })).toBe(false);
  });

  it("binds a quote target to the current enabled server action and rechecks every date edit", () => {
    const selection = {
      unitId: "unit_backfill",
      anchorDate: "2026-08-12",
      focusDate: "2026-08-13",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-14"
    };
    const backfillAction = action("BACKFILL_ORDER");
    const target = roomStatusQuoteTargetFromAction(backfillAction, unit, selection, "2026-08-14");
    expect(target).toEqual({
      unitId: "unit_backfill",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-14",
      initialStayType: "TRANSIENT",
      actionCode: "BACKFILL_ORDER",
      backfill: true
    });
    expect(roomStatusAuthorizedQuoteAction(unit, target, "2026-08-14")?.code).toBe("BACKFILL_ORDER");

    expect(updateRoomStatusQuoteTargetSelection(target, unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-12",
      focusDate: "2026-08-12",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-13"
    }, "2026-08-14")).toMatchObject({
      actionCode: "BACKFILL_ORDER",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-13"
    });
    expect(updateRoomStatusQuoteTargetSelection(undefined, unit, selection, "2026-08-14")).toBeUndefined();
    expect(updateRoomStatusQuoteTargetSelection(target, unit, {
      unitId: "unit_backfill",
      anchorDate: "2026-08-13",
      focusDate: "2026-08-14",
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-15"
    }, "2026-08-14")).toMatchObject({
      actionCode: "BACKFILL_ORDER",
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-15"
    });

    const occupied = {
      ...unit!,
      days: unit!.days.map((candidate) => candidate.serviceDate === "2026-08-13"
        ? { ...candidate, intervalIds: ["stay_new"] }
        : candidate)
    };
    expect(roomStatusAuthorizedQuoteAction(occupied, target, "2026-08-14")).toBeUndefined();
    expect(roomStatusQuoteActionCodeForUnit(action("BACKFILL_ORDER", "unit_other"), unit!.id)).toBeUndefined();
  });

  it("preserves a recovered quote's explicit intent and fails closed for legacy intent-less records", () => {
    expect(roomStatusQuoteRequiresBackfill("2026-08-13", "2026-08-14")).toBe(true);
    expect(roomStatusQuoteRequiresBackfill("2026-08-14", "2026-08-14")).toBe(false);
    expect(roomStatusQuoteTargetForBusinessDate({
      unitId: "unit_backfill",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-14",
      initialStayType: "TRANSIENT"
    }, "2026-08-14")).toBeUndefined();
    expect(roomStatusQuoteTargetForBusinessDate({
      unitId: "unit_backfill",
      arrivalDate: "2026-08-14",
      departureDate: "2026-08-16",
      initialStayType: "TRANSIENT",
      actionCode: "CREATE_ORDER"
    }, "2026-08-15")).toBeUndefined();

    const target = roomStatusQuoteTargetForBusinessDate({
      unitId: "unit_backfill",
      arrivalDate: "2026-08-12",
      departureDate: "2026-08-14",
      initialStayType: "TRANSIENT",
      actionCode: "BACKFILL_ORDER"
    }, "2026-08-14");
    expect(target).toMatchObject({ actionCode: "BACKFILL_ORDER", backfill: true });
    expect(roomStatusQuoteCommandMatchesTarget(
      completedStayBackfillCommandRequest({}, "前台漏录"),
      target
    )).toBe(true);
    expect(roomStatusQuoteCommandMatchesTarget({
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "普通创建",
      input: {}
    }, target)).toBe(false);
  });
});
