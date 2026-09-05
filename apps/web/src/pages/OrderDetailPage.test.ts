import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { CollectionFactDto, CommandRequest, OrderViewDto } from "../types";
import { buildOrderOccupantCorrectionRequest, correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog, restoredOptionalCorrectionValue } from "../components/OrderOccupantCorrectionDialog";
import {
  enabledOrderActionCodes,
  effectiveArrangementTitle,
  fulfillmentResultLabel,
  initialRepriceTargetYuan,
  itemCountLabel,
  collectionDifferencePresentation,
  completeStayCorrectionRecords,
  formalMembershipAgreedPriceMinor,
  completeStayOperatorCopy,
  collectionFactTransactionReferenceLabel,
  CollectionFactNote,
  collectionFactTypeLabel,
  collectionMethodLabel,
  arrangementChangeLabel,
  collectionAmountMinorToYuanInput,
  collectionAmountYuanInputToMinor,
  collectionFactCanReverse,
  occupantSnapshotEntries,
  OrderAmountStrip,
  OrderActionButton,
  OrderActionNotice,
  FactActions,
  OverdueInHouseAlert,
  CompleteStayCorrectionHistory,
  TemporaryOtherRoomArrangementHistory,
  OrderLifecycleSections,
  OrderMembershipCoverageSection,
  pricingBasisLabel,
  orderDetailBackTarget,
  orderFulfillmentNotice,
  orderRefundUnavailableReason,
  orderActionDisabledReasonText,
  orderActionWithUpgradeGuard,
  orderActionHelpRequired,
  orderStatusIsTerminal,
  orderStayDateRequestIsCompatible,
  orderRefreshMustCloseEditor,
  orderViewPayloadChanged,
  wholeYuanAmountMinor,
  orderViewMatchesPrincipalScope,
  orderedOrderOccupants,
  overdueInHouseNotice,
  primaryOrderOccupant,
  remainingRefundableMinor,
  reverseFactHelpPosition,
  buildReverseFactRequest,
  requestedOrderAction,
  stayMembershipUpgradeAutoOpenBlockedNotice,
  stayMembershipUpgradeActionVisible,
  stayMembershipUpgradeEntry,
  stayMembershipUpgradeResumeAfterOccupantCorrection,
  upgradedStayActionDisabledReason,
  stayConversionEntitlementDisplay,
  stayConversionFundsState,
  terminalOrderActionCodes
} from "./OrderDetailPage";
import {
  clearCorruptPersistedCommandRecovery,
  clearPersistedCommandRecovery,
  commandRecoveryStorageKey,
  readPersistedCommandRecovery,
  recoveryCommandRequest,
  savePersistedCommandRecovery,
  transitionPersistedCommandRecovery,
  type CommandDialogProgress,
  type PersistedCommandRecovery
} from "../ui";

describe("completed-stay correction audit history", () => {
  function correctedOrderView(): OrderViewDto {
    const common = {
      order_id: "order_324",
      reason_code: "COMPLETE_STAY",
      reason_note: "客人实际入住并已离店，修复开发期间遗留的错误预订",
      command_id: "command_complete_324",
      actor: { subjectId: "subject_operator", displayName: "前台操作员" },
      created_at: "2026-08-25T02:30:00.000Z"
    };
    return {
      order: {
        id: "order_324",
        arrival_date: "2026-08-06",
        departure_date: "2026-08-12"
      },
      effectiveArrangement: {
        arrivalDate: "2026-08-06",
        departureDate: "2026-08-12"
      },
      amounts: {
        currentContractAmount: { currency: "CNY", minorUnits: 139_200 },
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        collectionDifference: { currency: "CNY", minorUnits: 139_200 },
        refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
      },
      amendments: [{
        ...common,
        id: "amend_check_in_324",
        sequence: 2,
        amendment_type: "CHECK_IN",
        prior_version: 1,
        new_version: 2,
        payload: { orderId: "order_324" }
      }, {
        ...common,
        id: "amend_check_out_324",
        sequence: 3,
        amendment_type: "CHECK_OUT",
        prior_version: 2,
        new_version: 3,
        payload: { orderId: "order_324" }
      }]
    } as unknown as OrderViewDto;
  }

  it("groups the immutable check-in and check-out pair into one operator-facing correction record", () => {
    const records = completeStayCorrectionRecords(correctedOrderView().amendments);
    expect(records).toEqual([{
      commandId: "command_complete_324",
      actor: { subjectId: "subject_operator", displayName: "前台操作员" },
      recordedAt: "2026-08-25T02:30:00.000Z",
      reasonNote: "客人实际入住并已离店，修复开发期间遗留的错误预订"
    }]);
  });

  it("shows the preserved dates and amount alongside the final arrears result", () => {
    const html = renderToStaticMarkup(createElement(CompleteStayCorrectionHistory, {
      view: correctedOrderView()
    }));
    expect(html).toContain("住宿补录记录");
    expect(html).toContain("1 条");
    expect(html).toContain("前台操作员");
    expect(html).toContain("客人实际入住并已离店，修复开发期间遗留的错误预订");
    expect(html).toContain("2026-08-06 至 2026-08-12");
    expect(html).toContain("¥1,392.00");
    expect(html).toContain("欠款");
  });

  it("does not invent a correction record for an incomplete or unrelated amendment set", () => {
    const view = correctedOrderView();
    expect(completeStayCorrectionRecords(view.amendments.slice(0, 1))).toEqual([]);
    expect(completeStayCorrectionRecords(view.amendments.map((amendment) => ({
      ...amendment,
      reason_code: "NORMAL_FULFILLMENT"
    })))).toEqual([]);
  });
});

describe("temporary other-room arrangement history", () => {
  const arrangement = {
    kind: "TEMPORARY_OTHER_ROOM",
    membershipOrderId: "membership_order_1",
    memberContractId: "contract_1",
    entitlementLotId: "lot_1",
    originalRoomTypeCode: "shared_bath_single",
    originalInventoryKind: "ROOM",
    entitlementUnitKind: "ROOM_NIGHT",
    actualInventoryUnitId: "room_private_101",
    actualRoomTypeCode: "private_bath_single",
    actualInventoryKind: "ROOM",
    arrivalDate: "2026-09-06",
    departureDate: "2026-09-08"
  } as const;

  function view(payload: unknown = { temporaryOtherRoomArrangement: arrangement }) {
    return {
      amendments: [{
        id: "amendment_create",
        order_id: "order_1",
        sequence: 1,
        amendment_type: "CREATE_ORDER",
        reason_code: "TEMPORARY_OTHER_ROOM",
        reason_note: "现场协调安排",
        prior_version: 0,
        new_version: 1,
        payload,
        command_id: "command_1",
        actor: { subjectId: "subject_front_desk", displayName: "前台甲" },
        created_at: "2026-09-05T08:30:00.000Z"
      }]
    } as unknown as OrderViewDto;
  }

  it("renders the immutable business record with Chinese room labels and readable room identity", () => {
    const html = renderToStaticMarkup(createElement(TemporaryOtherRoomArrangementHistory, {
      view: view(),
      inventoryUnits: [{ id: "room_private_101", code: "101", name: "101 独卫单人间", building_code: "1" }]
    }));
    expect(html).toContain("本次临时安排其他房型");
    expect(html).toContain("单人间（公卫）");
    expect(html).toContain("单人间（独卫）");
    expect(html).toContain("101 · 1栋 · 101 独卫单人间");
    expect(html).toContain("2026-09-06 至 2026-09-08");
    expect(html).toContain("现场协调安排");
    expect(html).toContain("前台甲");
    expect(html).not.toMatch(/membershipOrderId|entitlementLotId|temporaryOtherRoomArrangement/);
  });

  it("fails closed when the first creation record is incomplete or not a temporary arrangement", () => {
    expect(renderToStaticMarkup(createElement(TemporaryOtherRoomArrangementHistory, {
      view: view({ temporaryOtherRoomArrangement: { ...arrangement, actualInventoryKind: "BED" } }),
      inventoryUnits: []
    }))).toBe("");
    expect(renderToStaticMarkup(createElement(TemporaryOtherRoomArrangementHistory, {
      view: view({ temporaryOtherRoomArrangement: arrangement },),
      inventoryUnits: []
    }))).toContain("room_private_101");
    const ordinary = view();
    ordinary.amendments[0]!.reason_code = "CREATE_STANDARD_ORDER";
    expect(renderToStaticMarkup(createElement(TemporaryOtherRoomArrangementHistory, {
      view: ordinary,
      inventoryUnits: []
    }))).toBe("");
  });
});

describe("order detail background refresh", () => {
  it("keeps an identical order DTO stable while detecting real fact changes", () => {
    const previous = {
      order: { id: "order_poll", version: 3, current_revision_id: "revision_3" },
      effectiveArrangement: { arrivalDate: "2026-08-01", departureDate: "2026-08-04" }
    } as OrderViewDto;
    expect(orderViewPayloadChanged(previous, structuredClone(previous))).toBe(false);
    const changed = structuredClone(previous);
    changed.order.version = 4;
    expect(orderViewPayloadChanged(previous, changed)).toBe(true);
  });

  it("uses the latest editor state when an earlier poll response arrives", () => {
    const previous = {
      order: { id: "order_poll_race", version: 3, current_revision_id: "revision_3" },
      effectiveArrangement: { arrivalDate: "2026-08-01", departureDate: "2026-08-04" }
    } as OrderViewDto;
    const changed = structuredClone(previous);
    changed.order.version = 4;

    const editorState = { current: false };
    const pollResponseArrives = (response: OrderViewDto) => (
      orderRefreshMustCloseEditor(previous, response, editorState.current)
    );

    // The poll request started before the operator opened the move-unit drawer.
    editorState.current = true;
    expect(pollResponseArrives(changed)).toBe(true);
    expect(pollResponseArrives(structuredClone(previous))).toBe(false);
  });
});

describe("overdue in-house operational alert", () => {
  function overdueView(): OrderViewDto {
    return {
      order: { status: "CHECKED_IN" },
      stay: { status: "IN_HOUSE" },
      effectiveArrangement: {
        departureDate: "2026-08-19",
        businessDate: "2026-08-27"
      }
    } as OrderViewDto;
  }

  it("identifies only a checked-in in-house stay whose planned departure has passed", () => {
    const view = overdueView();
    expect(overdueInHouseNotice(view)).toEqual({
      title: "逾期在住，需确认实际状态",
      plannedDepartureDate: "2026-08-19",
      businessDate: "2026-08-27"
    });

    expect(overdueInHouseNotice({
      ...view,
      effectiveArrangement: { ...view.effectiveArrangement, departureDate: "2026-08-27" }
    })).toBeUndefined();
    expect(overdueInHouseNotice({
      ...view,
      order: { ...view.order, status: "CHECKED_OUT" }
    })).toBeUndefined();
    expect(overdueInHouseNotice({
      ...view,
      stay: { ...view.stay, status: "COMPLETED" }
    })).toBeUndefined();
  });

  it("renders the dates and both operator resolution paths without changing order state", () => {
    const html = renderToStaticMarkup(createElement(OverdueInHouseAlert, {
      notice: overdueInHouseNotice(overdueView())!
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("逾期在住，需确认实际状态");
    expect(html).toContain("2026-08-19");
    expect(html).toContain("2026-08-27");
    expect(html).toContain("仍在住，请先调整退房日期");
    expect(html).toContain("已离店，请办理迟录退房");
  });
});

describe("upgrade membership entitlement presentation", () => {
  function conversionOrderView(): OrderViewDto {
    return {
      order: {
        id: "order_conversion",
        property_id: "property_qintopia",
        arrival_date: "2026-07-26",
        departure_date: "2026-08-02"
      },
      amendments: [{
        id: "amendment_conversion",
        order_id: "order_conversion",
        sequence: 2,
        amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
        reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
        reason_note: "升级会员",
        prior_version: 1,
        new_version: 2,
        payload: {
          entitlement: {
            consumedUnits: 7,
            entitlementUnitKind: "ROOM_NIGHT",
            serviceDates: [
              "2026-07-26",
              "2026-07-27",
              "2026-07-28",
              "2026-07-29",
              "2026-07-30",
              "2026-07-31",
              "2026-08-01"
            ]
          },
          member: {
            memberId: "member_conversion",
            fullName: "住宿转会员匹配会员-manual-20260802"
          },
          product: { name: "公卫单人间会员" }
        },
        command_id: "command_conversion",
        actor: null,
        created_at: "2026-08-02T00:00:00.000Z"
      }],
      collectionFacts: [{
        fact_id: "collection_conversion",
        order_id: "order_conversion",
        fact_type: "COLLECTION",
        amount_minor: 59_000,
        net_effect_minor: 59_000,
        currency: "CNY",
        references_fact_id: null,
        reverses_fact_id: null,
        method: "WECOM",
        note: "",
        transaction_reference: "WX-STAGE13-manual-20260802-SOURCE",
        cash_collector: null,
        pricing_revision_id: "revision_conversion",
        command_id: "command_collection",
        created_at: "2026-08-01T15:59:00.000Z",
        transfer: {
          id: "transfer_conversion",
          membershipOrderId: "membership_order_conversion",
          memberId: "member_conversion",
          membershipPaymentFactId: "membership_payment_conversion",
          sourceReversalFactId: "source_reversal_conversion"
        }
      }],
      coverageSet: []
    } as unknown as OrderViewDto;
  }

  it("summarizes upgrade-member entitlement consumption even when normal coverage rows are empty", () => {
    const display = stayConversionEntitlementDisplay(conversionOrderView());
    expect(display).toEqual({
      serviceStart: "2026-07-26",
      serviceEnd: "2026-08-02",
      consumedUnits: 7,
      unitLabel: "间夜",
      memberName: "住宿转会员匹配会员-manual-20260802",
      productName: "公卫单人间会员",
      memberId: "member_conversion",
      membershipOrderId: "membership_order_conversion"
    });
  });

  it("keeps the rebuilt membership and consumed nights visible after an erroneous membership is voided", () => {
    const base = conversionOrderView();
    const view = {
      ...base,
      amendments: [{
        ...base.amendments[0],
        amendment_type: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        payload: {
          entitlement: {
            consumedUnits: 2,
            unitKind: "BED_NIGHT",
            serviceDates: ["2026-07-26", "2026-07-27"]
          },
          member: {
            memberId: "member_rebuilt",
            fullName: "重建会员"
          },
          newMembership: { productName: "公卫四人间会员" }
        }
      }],
      collectionFacts: [],
      membershipConversion: {
        membershipOrderId: "membership_order_rebuilt",
        memberId: "member_rebuilt",
        contractId: "contract_rebuilt",
        entitlementLotId: "lot_rebuilt",
        commandId: "command_conversion"
      }
    } as OrderViewDto;

    expect(stayConversionEntitlementDisplay(view)).toEqual({
      serviceStart: "2026-07-26",
      serviceEnd: "2026-07-28",
      consumedUnits: 2,
      unitLabel: "床夜",
      memberName: "重建会员",
      productName: "公卫四人间会员",
      memberId: "member_rebuilt",
      membershipOrderId: "membership_order_rebuilt"
    });
  });

  it("does not tell operators that an upgraded stay used no membership entitlement", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OrderMembershipCoverageSection, {
      view: conversionOrderView(),
      unitMap: new Map()
    })));
    expect(html).toContain("升级会员核销");
    expect(html).toContain("2026-07-26 至 2026-08-02");
    expect(html).toContain("7 间夜");
    expect(html).toContain("公卫单人间会员");
    expect(html).toContain("查看会员订单");
    expect(html).not.toContain("没有会员覆盖");
    expect(html).not.toContain("此订单未使用会员住宿权益");
  });

  it("keeps the membership-order trace visible when an in-house conversion has coverage and no lodging transfer", () => {
    const view = {
      ...conversionOrderView(),
      collectionFacts: [],
      membershipConversion: {
        membershipOrderId: "membership_order_zero_transfer",
        memberId: "member_zero_transfer",
        contractId: "contract_zero_transfer",
        entitlementLotId: "lot_zero_transfer",
        commandId: "command_conversion"
      },
      coverageSet: [{
        id: "coverage_conversion_1",
        order_id: "order_conversion",
        contract_id: "contract_zero_transfer",
        lot_id: "lot_zero_transfer",
        inventory_unit_id: "unit_room_d_gen_01",
        service_date: "2026-07-26",
        unit_kind: "ROOM_NIGHT",
        status: "CONSUMED",
        held_by_revision_id: "revision_conversion",
        created_at: "2026-08-01T16:00:00.000Z",
        updated_at: "2026-08-01T16:00:00.000Z"
      }]
    } as OrderViewDto;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OrderMembershipCoverageSection, {
      view,
      unitMap: new Map()
    })));
    expect(html).toContain("stay-membership-conversion-trace");
    expect(html).toContain("查看会员订单");
    expect(html).toContain("memberId=member_zero_transfer");
    expect(html).toContain("membershipOrderId=membership_order_zero_transfer");
  });
});

describe("fulfillment result presentation", () => {
  const base = {
    plannedBusinessDate: "2026-07-25",
    recordedBusinessDate: "2026-07-25",
    recordedAt: "2026-07-25T10:00:00.000Z",
    actor: { subjectId: "operator", displayName: "前台操作员" },
    reason: { code: "FRONT_DESK", note: "正常办理" }
  } as const;

  it("uses operator language for on-time and late-recorded fulfillment", () => {
    expect(fulfillmentResultLabel({ ...base, type: "CHECK_IN", recordingMode: "ON_SCHEDULE" })).toBe("按计划办理入住");
    expect(fulfillmentResultLabel({ ...base, type: "CHECK_OUT", recordingMode: "ON_SCHEDULE" })).toBe("按计划办理退房");
    expect(fulfillmentResultLabel({
      ...base,
      type: "CHECK_OUT",
      recordedBusinessDate: "2026-07-26",
      recordingMode: "LATE_RECORDED"
    })).toBe("迟录退房");
    expect(fulfillmentResultLabel({
      ...base,
      type: "CHECK_IN",
      recordedBusinessDate: "2026-07-26",
      recordingMode: "LATE_RECORDED"
    })).toBe("迟录入住");
  });

  it("does not pretend an incomplete historical record is on time", () => {
    expect(fulfillmentResultLabel({
      ...base,
      type: "CHECK_OUT",
      recordedBusinessDate: null,
      recordingMode: "LEGACY_UNCLASSIFIED"
    })).toBe("历史记录未分类");
  });

  it("explains why early check-out is unavailable without directing operators into a non-atomic shortcut", () => {
    const notice = orderFulfillmentNotice([{
      code: "CHECK_OUT",
      enabled: false,
      disabledReason: "DEPARTURE_DATE_NOT_REACHED"
    }]);
    expect(notice).toMatchObject({
      action: "CHECK_OUT",
      title: "暂不能办理退房"
    });
    expect(notice?.body).toContain("暂不能办理退房");
    expect(notice?.body).not.toContain("请先缩短");
    expect(orderFulfillmentNotice([{
      code: "CHECK_OUT",
      enabled: false,
      disabledReason: "DEPARTURE_DATE_NOT_REACHED"
    }, {
      code: "SHORTEN_STAY",
      enabled: true,
      disabledReason: null
    }])).toBeUndefined();
    expect(orderFulfillmentNotice([{
      code: "CHECK_OUT",
      enabled: true,
      disabledReason: null
    }])).toBeUndefined();
  });

  it("explains future and overdue check-in gates without implying either operation was completed", () => {
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: false,
      disabledReason: "ARRIVAL_DATE_NOT_REACHED"
    }])).toMatchObject({
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: expect.stringContaining("请在计划到店日办理")
    });
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: false,
      disabledReason: "ARRIVAL_DATE_PASSED"
    }])).toMatchObject({
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: expect.stringContaining("可办理改期或标记未到")
    });
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: true,
      disabledReason: "ARRIVAL_DATE_PASSED"
    }])).toMatchObject({
      action: "CHECK_IN",
      title: "已超过计划到店日",
      body: expect.stringContaining("可办理迟录入住")
    });
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: true,
      disabledReason: null
    }])).toBeUndefined();
  });

  it("does not invent an operator notice for unrelated disabled reasons", () => {
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: false,
      disabledReason: "ORDER_STATE_INVALID"
    }])).toBeUndefined();
  });
});

describe("operator-facing order lifecycle presentation", () => {
  it("places a complete wrapping explanation below an unavailable action notice", () => {
    const html = renderToStaticMarkup(createElement(OrderActionNotice, {
      title: "暂不能缩短住宿或提前退房",
      body: "入住当天暂不办理缩短住宿或提前退房；请在确认住客实际使用房间后再办理入住。",
      testId: "stay-date-action-notice"
    }));

    expect(html).toContain('class="action-notice-popover"');
    expect(html).toContain('class="action-notice"');
    expect(html).toContain('data-testid="stay-date-action-notice"');
    expect(html).toContain('class="action-notice-bubble"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("入住当天暂不办理缩短住宿或提前退房");
  });

  it("labels section totals as record counts", () => {
    expect(itemCountLabel(0)).toBe("0 条");
    expect(itemCountLabel(1)).toBe("1 条");
  });

  const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
  const originalArrangement = {
    arrivalDate: "2026-07-25",
    departureDate: "2026-07-27",
    intervals: [{ inventoryUnitId: "unit_d01", arrivalDate: "2026-07-25", departureDate: "2026-07-27" }]
  };
  const movedArrangement = {
    arrivalDate: "2026-07-25",
    departureDate: "2026-07-28",
    intervals: [
      { inventoryUnitId: "unit_d01", arrivalDate: "2026-07-25", departureDate: "2026-07-26" },
      { inventoryUnitId: "unit_d02", arrivalDate: "2026-07-26", departureDate: "2026-07-28" }
    ]
  };
  const lifecycle = {
    originalArrangement,
    effectiveArrangement: {
      ...movedArrangement,
      presentation: "LAST" as const,
      businessDate: "2026-07-28"
    },
    fulfillment: {
      state: "CHECKED_OUT" as const,
      checkIn: {
        type: "CHECK_IN" as const,
        plannedBusinessDate: "2026-07-25",
        recordedBusinessDate: "2026-07-25",
        recordingMode: "ON_SCHEDULE" as const,
        recordedAt: "2026-07-25T10:00:00.000Z",
        actor: { subjectId: "subject_internal_check_in", displayName: "前台甲" },
        reason: { code: "CHECK_IN_INTERNAL", note: "正常办理" }
      },
      checkOut: {
        type: "CHECK_OUT" as const,
        plannedBusinessDate: "2026-07-28",
        recordedBusinessDate: "2026-07-28",
        recordingMode: "ON_SCHEDULE" as const,
        recordedAt: "2026-07-28T09:00:00.000Z",
        actor: { subjectId: "subject_internal_check_out", displayName: "前台乙" },
        reason: { code: "CHECK_OUT_INTERNAL", note: "按计划离店" }
      },
      checkInRevocation: null
    },
    arrangementHistory: [{
      type: "INITIAL_BOOKING" as const,
      before: null,
      after: originalArrangement,
      reason: { code: "CREATE_ORDER_INTERNAL", note: "电话预订" },
      actor: { subjectId: "subject_internal_create", displayName: "前台甲" },
      recordedAt: "2026-07-24T08:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: money(20_000),
        currentContractAmount: money(18_000),
        differenceFromPolicy: money(-2_000)
      },
      fundsSummary: {
        netRecordedCollection: money(18_000),
        collectionDifference: money(0),
        refundReferenceAmount: money(0),
        factCount: 1
      }
    }, {
      type: "MOVE" as const,
      before: originalArrangement,
      after: movedArrangement,
      reason: { code: "MOVE_UNIT_INTERNAL", note: "住客申请更换房源" },
      actor: { subjectId: "subject_internal_move", displayName: "前台乙" },
      recordedAt: "2026-07-26T08:00:00.000Z",
      pricingSummary: {
        policyBaseAmount: money(30_000),
        currentContractAmount: money(28_000),
        differenceFromPolicy: money(-2_000)
      },
      fundsSummary: {
        netRecordedCollection: money(18_000),
        collectionDifference: money(10_000),
        refundReferenceAmount: money(0),
        factCount: 1
      }
    }]
  } satisfies Pick<OrderViewDto, "originalArrangement" | "effectiveArrangement" | "fulfillment" | "arrangementHistory">;

  it("renders the four server-projected business layers with terminal wording", () => {
    const html = renderToStaticMarkup(createElement(OrderLifecycleSections, {
      view: lifecycle,
      inventoryUnits: [
        { id: "unit_d01", code: "D01", name: "D01 · 单人间", building_code: "1" },
        { id: "unit_d02", code: "D02", name: "D02 · 标准间", building_code: "1" }
      ]
    }));

    expect(html).toContain("原始预订安排");
    expect(html).toContain("最后住宿安排");
    expect(html).toContain("入住与退房结果");
    expect(html).toContain('class="section-title-with-help"');
    expect(html).toContain("住宿安排变更历史");
    expect(html).toContain("创建预订");
    expect(html).toContain("更换房源");
    expect(html).toContain("D01 · 单人间");
    expect(html).toContain("D02 · 标准间");
    expect(html).toContain("与政策基础金额差额");
    expect(html).toContain("差额");
    expect(html).not.toMatch(/INITIAL_BOOKING|MOVE_UNIT_INTERNAL|subject_internal|Segment|Amendment|payload|Fact ID|Receipt ID|Command ID|Correlation ID|Claim|Revision/);
  });

  it("renders historical stay corrections as a receipt-backed group without calling unit-only changes a date adjustment", () => {
    const unitOnlyAfter = {
      arrivalDate: "2026-07-25",
      departureDate: "2026-07-27",
      intervals: [{ inventoryUnitId: "unit_d02", arrivalDate: "2026-07-25", departureDate: "2026-07-27" }]
    };
    const view = {
      ...lifecycle,
      effectiveArrangement: { ...unitOnlyAfter, presentation: "LAST" as const, businessDate: "2026-07-28" },
      arrangementHistory: [
        lifecycle.arrangementHistory[0]!,
        {
          type: "HISTORICAL_STAY_CORRECTION" as const,
          before: originalArrangement,
          after: unitOnlyAfter,
          reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "主管核对住宿凭据后更正" },
          actor: { subjectId: "admin_1", displayName: "主管甲" },
          recordedAt: "2026-07-29T08:00:00.000Z",
          pricingSummary: {
            policyBaseAmount: money(20_000),
            currentContractAmount: money(18_000),
            differenceFromPolicy: money(-2_000)
          },
          fundsSummary: {
            netRecordedCollection: money(18_000),
            collectionDifference: money(0),
            refundReferenceAmount: money(0),
            factCount: 1
          },
          correctionGroup: {
            correctionSetHash: "a".repeat(64),
            reason: { code: "HISTORICAL_STAY_ARRANGEMENT_CORRECTION", note: "主管核对住宿凭据后更正" },
            evidenceNote: "纸质交接表与房态记录一致",
            actor: { subjectId: "admin_1", displayName: "主管甲" },
            recordedAt: "2026-07-29T08:00:00.000Z",
            corrections: [{
              orderId: "order_hist_left",
              stayId: "stay_hist_left",
              correctionId: "correction_hist_left",
              amendmentId: "amendment_hist_left",
              staySegmentId: "segment_hist_left",
              pricingRevisionId: "revision_hist_left",
              before: {
                inventoryUnitId: "unit_d01",
                arrivalDate: "2026-07-25",
                departureDate: "2026-07-27",
                nights: 2,
                stayTimeline: [
                  { serviceDate: "2026-07-25", inventoryUnitId: "unit_d01" },
                  { serviceDate: "2026-07-26", inventoryUnitId: "unit_d01" }
                ]
              },
              after: {
                inventoryUnitId: "unit_d02",
                arrivalDate: "2026-07-25",
                departureDate: "2026-07-27",
                nights: 2,
                stayTimeline: [
                  { serviceDate: "2026-07-25", inventoryUnitId: "unit_d02" },
                  { serviceDate: "2026-07-26", inventoryUnitId: "unit_d02" }
                ]
              }
            }, {
              orderId: "order_hist_right",
              stayId: "stay_hist_right",
              correctionId: "correction_hist_right",
              amendmentId: "amendment_hist_right",
              staySegmentId: "segment_hist_right",
              pricingRevisionId: "revision_hist_right",
              before: {
                inventoryUnitId: "unit_d02",
                arrivalDate: "2026-07-28",
                departureDate: "2026-07-30",
                nights: 2,
                stayTimeline: [
                  { serviceDate: "2026-07-28", inventoryUnitId: "unit_d02" },
                  { serviceDate: "2026-07-29", inventoryUnitId: "unit_d02" }
                ]
              },
              after: {
                inventoryUnitId: "unit_d01",
                arrivalDate: "2026-07-28",
                departureDate: "2026-07-30",
                nights: 2,
                stayTimeline: [
                  { serviceDate: "2026-07-28", inventoryUnitId: "unit_d01" },
                  { serviceDate: "2026-07-29", inventoryUnitId: "unit_d01" }
                ]
              }
            }]
          }
        }
      ]
    } satisfies Pick<OrderViewDto, "originalArrangement" | "effectiveArrangement" | "fulfillment" | "arrangementHistory">;

    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OrderLifecycleSections, {
      view,
      inventoryUnits: [
        { id: "unit_d01", code: "D01", name: "D01 · 单人间", building_code: "1" },
        { id: "unit_d02", code: "D02", name: "D02 · 标准间", building_code: "1" }
      ]
    })));

    expect(html).toContain("历史住宿安排修改");
    expect(html).toContain("第 1 笔同批修改");
    expect(html).toContain("第 2 笔同批修改");
    expect(html).toContain('href="/orders/order_hist_left"');
    expect(html).toContain("查看第 1 笔关联订单");
    expect(html).toContain('href="/orders/order_hist_right"');
    expect(html).toContain("查看第 2 笔关联订单");
    expect(html).not.toContain("<code>order_hist_left</code>");
    expect(html).not.toContain("<code>order_hist_right</code>");
    expect(html).toContain("纸质交接表与房态记录一致");
    expect(html).toContain("主管甲");
    expect(html).not.toContain("调整住宿日期");
  });

  it("keeps the original check-in visible alongside the later revocation fact", () => {
    const html = renderToStaticMarkup(createElement(OrderLifecycleSections, {
      view: {
        ...lifecycle,
        effectiveArrangement: {
          ...lifecycle.effectiveArrangement,
          presentation: "BEFORE_CHECK_IN_REVOCATION"
        },
        fulfillment: {
          state: "CHECK_IN_REVOKED",
          checkIn: lifecycle.fulfillment.checkIn,
          checkOut: null,
          checkInRevocation: {
            type: "REVOKE_CHECK_IN",
            plannedBusinessDate: "2026-07-25",
            recordedBusinessDate: "2026-07-25",
            recordingMode: "ON_SCHEDULE",
            recordedAt: "2026-07-25T10:10:00.000Z",
            actor: { subjectId: "operator", displayName: "前台甲" },
            reason: { code: "REVOKE_CHECK_IN", note: "住客看房后未入住" }
          }
        }
      },
      inventoryUnits: [{ id: "unit_d01", code: "D01", name: "D01 · 单人间", building_code: "1" }]
    }));
    expect(html).toContain("撤销入住前安排");
    expect(html).toContain("入住结果");
    expect(html).toContain("撤销入住结果");
    expect(html).toContain("住客看房后未入住");
  });

  it("shows channel contract pricing without per-order collection language", () => {
    const channelAmounts = {
      currentContractAmount: money(81_600),
      netRecordedCollection: money(40_000),
      collectionDifference: money(41_600),
      refundReferenceAmount: money(2_000)
    };
    const channelRevision = {
      id: "revision_channel",
      order_id: "order_channel",
      revision_no: 2,
      amendment_id: "amendment_channel",
      policy_version_id: "policy_v1",
      arrival_date: "2026-08-01",
      departure_date: "2026-08-03",
      coverage_set: [],
      cash_lines: [],
      policy_base_amount_minor: 69_600,
      pricing_basis: "CHANNEL_CONTRACT" as const,
      manual_adjustment_minor: 0,
      current_contract_amount_minor: 81_600,
      difference_from_policy_minor: 12_000,
      reason: { code: "CHANNEL_PRICE_DIFFERENCE", note: "携程活动价格重新确认" },
      currency: "CNY",
      created_at: "2026-07-30T10:00:00.000Z"
    };
    const amountHtml = renderToStaticMarkup(createElement(OrderAmountStrip, {
      amounts: channelAmounts,
      pricingRevision: channelRevision
    }));
    const historyHtml = renderToStaticMarkup(createElement(OrderLifecycleSections, {
      view: lifecycle,
      inventoryUnits: [{ id: "unit_d01", code: "D01", name: "D01 · 单人间", building_code: "1" }],
      showPerOrderFunds: false,
      channelPriceDifferenceReason: "携程活动价格重新确认"
    }));
    const html = amountHtml + historyHtml;

    expect(html).toContain("政策基础金额");
    expect(html).toContain("本单渠道应结金额");
    expect(html).toContain("与政策基础金额差额");
    expect(html).toContain("渠道价格差异说明");
    expect(html).toContain("携程活动价格重新确认");
    expect(html).not.toMatch(/已记录净收款|待补收参考|多收差额|建议退款|退款参考/);
  });

  it.each(["POLICY", "MANUAL_ADJUSTMENT"] as const)("keeps external-channel semantics after a later %s repricing", (pricingBasis) => {
    const policyBaseAmount = 69_600;
    const currentContractAmount = pricingBasis === "POLICY" ? policyBaseAmount : 75_000;
    const html = renderToStaticMarkup(createElement(OrderAmountStrip, {
      amounts: {
        currentContractAmount: money(currentContractAmount),
        netRecordedCollection: money(90_000),
        collectionDifference: money(currentContractAmount - 90_000),
        refundReferenceAmount: money(90_000 - currentContractAmount)
      },
      bookingChannelCode: "CTRIP",
      pricingRevision: {
        id: "revision_reprice",
        pricing_basis: pricingBasis,
        policy_base_amount_minor: policyBaseAmount,
        current_contract_amount_minor: currentContractAmount,
        difference_from_policy_minor: currentContractAmount - policyBaseAmount,
        manual_adjustment_minor: pricingBasis === "MANUAL_ADJUSTMENT" ? currentContractAmount - policyBaseAmount : 0,
        reason: { code: "REPRICE_ORDER", note: pricingBasis === "POLICY" ? "恢复政策价" : "渠道重新协商" },
        currency: "CNY"
      } as never
    }));

    expect(html).toContain("政策基础金额");
    expect(html).toContain("本单渠道应结金额");
    expect(html).toContain("与政策基础金额差额");
    expect(html).toContain("渠道价格差异说明");
    expect(html).not.toMatch(/已记录净收款|待补收参考|多收差额|建议退款|退款参考/);
  });

  it("keeps an empty channel price note visually compact", () => {
    const html = renderToStaticMarkup(createElement(OrderAmountStrip, {
      amounts: {
        currentContractAmount: money(69_600),
        netRecordedCollection: money(0),
        collectionDifference: money(0),
        refundReferenceAmount: money(0)
      },
      bookingChannelCode: "CTRIP",
      pricingRevision: {
        id: "revision_channel_without_note",
        pricing_basis: "CHANNEL_CONTRACT",
        policy_base_amount_minor: 69_600,
        current_contract_amount_minor: 69_600,
        difference_from_policy_minor: 0,
        manual_adjustment_minor: 0,
        reason: { code: "CHANNEL_PRICE_DIFFERENCE", note: "" },
        currency: "CNY"
      } as never
    }));

    expect(html).toContain("渠道价格差异说明");
    expect(html).toContain("amount-strip-note");
    expect(html).toContain(">无</strong>");
    expect(html).not.toContain("无需额外说明");
  });

  it("keeps per-order collection language for non-channel pricing", () => {
    const html = renderToStaticMarkup(createElement(OrderAmountStrip, {
      amounts: {
        currentContractAmount: money(69_600),
        netRecordedCollection: money(40_000),
        collectionDifference: money(29_600),
        refundReferenceAmount: money(0)
      },
      pricingRevision: {
        id: "revision_policy",
        pricing_basis: "POLICY",
        policy_base_amount_minor: 69_600,
        current_contract_amount_minor: 69_600,
        difference_from_policy_minor: 0,
        reason: { code: "POLICY", note: "" },
        currency: "CNY"
      } as never
    }));

    expect(html).toContain("住宿金额");
    expect(html).toContain("已记录净收款");
    expect(html).toContain("差额");
  });

  it("fails closed to a business placeholder instead of exposing an unknown inventory id", () => {
    const damagedName = {
      ...lifecycle,
      effectiveArrangement: {
        ...lifecycle.effectiveArrangement,
        intervals: [{ inventoryUnitId: "unit_internal_missing", arrivalDate: "2026-07-25", departureDate: "2026-07-28" }]
      }
    };
    const html = renderToStaticMarkup(createElement(OrderLifecycleSections, { view: damagedName, inventoryUnits: [] }));
    expect(html).toContain("房源名称暂不可用");
    expect(html).not.toContain("unit_internal_missing");
  });

  it("maps every lifecycle, amount, fact, and payment label to operator language", () => {
    expect(["CURRENT", "LAST", "BEFORE_CANCELLATION", "NO_SHOW_ORDER"].map((value) => effectiveArrangementTitle(value as Parameters<typeof effectiveArrangementTitle>[0]))).toEqual([
      "当前住宿安排", "最后住宿安排", "取消前安排", "未到订单安排"
    ]);
    expect(["INITIAL_BOOKING", "RESCHEDULE", "EXTENSION", "SHORTENING", "MOVE", "EARLY_CHECK_OUT"].map((value) => arrangementChangeLabel(value as Parameters<typeof arrangementChangeLabel>[0]))).toEqual([
      "创建预订", "调整住宿日期", "延长住宿", "缩短住宿", "更换房源", "提前退房"
    ]);
    expect(arrangementChangeLabel("HISTORICAL_STAY_CORRECTION")).toBe("历史住宿安排修改");
    expect(["COLLECTION", "REFUND", "REVERSAL"].map((value) => collectionFactTypeLabel(value as CollectionFactDto["fact_type"]))).toEqual(["收款", "退款", "冲销"]);
    expect(["CASH", "BANK_TRANSFER", "CARD", "WECOM", "OTHER", "LEGACY_UNKNOWN"].map(collectionMethodLabel)).toEqual(["现金", "银行转账", "银行卡", "企业微信", "其他方式", "其他方式"]);
    expect(["POLICY", "CHANNEL_CONTRACT", "MANUAL_ADJUSTMENT", "MEMBER_ENTITLEMENT", "FREE"].map((value) => pricingBasisLabel(value as Parameters<typeof pricingBasisLabel>[0]))).toEqual([
      "政策价", "本单渠道应结金额", "人工调价", "会员权益计价", "免费入住"
    ]);
    expect(collectionDifferencePresentation(money(200))).toEqual({ label: "差额", amount: money(200) });
    expect(collectionDifferencePresentation(money(-300))).toEqual({ label: "差额", amount: money(-300) });
    expect(collectionDifferencePresentation(money(0))).toEqual({ label: "差额", amount: money(0) });
  });
});

describe("complete-stay operator presentation", () => {
  it("uses a concise business explanation without implementation terminology", () => {
    expect(completeStayOperatorCopy.contextTitle).toBe("请确认实际住宿情况");
    expect(completeStayOperatorCopy.contextDetail).toContain("客人已经实际入住并离店");
    expect(completeStayOperatorCopy.contextDetail).toContain("已收清显示“已结单”");
    expect(completeStayOperatorCopy.contextDetail).toContain("未收清显示“欠款”");
    expect(completeStayOperatorCopy.confirmationLabel).toBe("我已确认客人实际入住，且现在已经离店");
    expect(completeStayOperatorCopy.reviewDescription).not.toMatch(/原子|补记|库存/);
  });
});

describe("reprice form defaults", () => {
  it("starts from the current order amount unless an exact draft value is restored", () => {
    expect(initialRepriceTargetYuan(13_000, undefined)).toBe("130");
    expect(initialRepriceTargetYuan(13_000, 11_000)).toBe("110");
    expect(initialRepriceTargetYuan(13_000, Number.NaN)).toBe("130");
    expect(initialRepriceTargetYuan(13_000, -100)).toBe("130");
    expect(initialRepriceTargetYuan(13_000, 11_050)).toBe("130");
  });

  it("accepts only non-negative whole-yuan values", () => {
    expect(wholeYuanAmountMinor("110")).toBe(11_000);
    expect(wholeYuanAmountMinor("0")).toBe(0);
    expect(wholeYuanAmountMinor("110.5")).toBeUndefined();
    expect(wholeYuanAmountMinor("-1")).toBeUndefined();
    expect(wholeYuanAmountMinor("not-a-number")).toBeUndefined();
  });
});

describe("lodging collection amount input", () => {
  it("parses yuan, jiao, and fen exactly for lodging funds", () => {
    expect(collectionAmountYuanInputToMinor("1")).toBe(100);
    expect(collectionAmountYuanInputToMinor("1.2")).toBe(120);
    expect(collectionAmountYuanInputToMinor("1.20")).toBe(120);
    expect(collectionAmountYuanInputToMinor("0.01")).toBe(1);
    expect(collectionAmountYuanInputToMinor("1280.50")).toBe(128_050);
  });

  it("rejects ambiguous or unsupported lodging fund amounts", () => {
    expect(collectionAmountYuanInputToMinor("")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("0")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("-1")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("1.234")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("1e3")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("1,280")).toBeUndefined();
    expect(collectionAmountYuanInputToMinor("21474836.48")).toBeUndefined();
  });

  it("formats minor units back to a yuan input value", () => {
    expect(collectionAmountMinorToYuanInput(100)).toBe("1");
    expect(collectionAmountMinorToYuanInput(120)).toBe("1.20");
    expect(collectionAmountMinorToYuanInput(1)).toBe("0.01");
    expect(collectionAmountMinorToYuanInput(0)).toBe("");
  });

});

describe("order stay date command routing", () => {
  it("lets the unified departure drawer resolve to extension, shortening, or early checkout", () => {
    expect(orderStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "EXTEND_STAY")).toBe(true);
    expect(orderStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "SHORTEN_STAY")).toBe(true);
    expect(orderStayDateRequestIsCompatible("SHORTEN_STAY", "ADJUST_DEPARTURE", "EXTEND_STAY")).toBe(true);
    expect(orderStayDateRequestIsCompatible("EXTEND_STAY", "ADJUST_DEPARTURE", "RESCHEDULE_STAY")).toBe(false);
  });

  it("keeps non-unified date drawers bound to their concrete command", () => {
    expect(orderStayDateRequestIsCompatible("RESCHEDULE_STAY", "DATE_CHANGE", "RESCHEDULE_STAY")).toBe(true);
    expect(orderStayDateRequestIsCompatible("RESCHEDULE_STAY", "DATE_CHANGE", "SHORTEN_STAY")).toBe(false);
    expect(orderStayDateRequestIsCompatible("SHORTEN_STAY", "EARLY_CHECK_OUT", "SHORTEN_STAY")).toBe(true);
    expect(orderStayDateRequestIsCompatible("SHORTEN_STAY", "EARLY_CHECK_OUT", "EXTEND_STAY")).toBe(false);
  });
});

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

describe("order occupant presentation", () => {
  const occupants = [{
    id: "occupant_additional",
    orderId: "order_occupants",
    ordinal: 2,
    role: "ADDITIONAL" as const,
    fullName: "同行人姓名",
    nickname: "同名住客",
    phone: null,
    documentNumber: "DOC-2",
    createdAt: "2026-07-24T09:00:00.000Z"
  }, {
    id: "occupant_primary",
    orderId: "order_occupants",
    ordinal: 1,
    role: "PRIMARY" as const,
    fullName: "主要人姓名",
    nickname: "同名住客",
    phone: "13800000000",
    documentNumber: null,
    createdAt: "2026-07-24T09:00:00.000Z"
  }];

  it("keeps stable ordinal order without deduplicating equal nicknames", () => {
    expect(orderedOrderOccupants(occupants).map((occupant) => [occupant.id, occupant.nickname])).toEqual([
      ["occupant_primary", "同名住客"],
      ["occupant_additional", "同名住客"]
    ]);
    expect(primaryOrderOccupant(occupants)?.id).toBe("occupant_primary");
  });

  it("shows the complete authorized snapshot and marks a historical missing nickname", () => {
    expect(occupantSnapshotEntries({ ...occupants[1]!, nickname: null })).toEqual([
      ["昵称", "历史未记录"],
      ["姓名", "主要人姓名"],
      ["联系电话", "13800000000"],
      ["证件号码", "-"]
    ]);
  });

  it("builds an append-only occupant correction request with a required reason", () => {
    const view = {
      order: { id: "order_occupants", property_id: "property_qintopia" }
    } as OrderViewDto;
    expect(buildOrderOccupantCorrectionRequest(view, occupants[0]!, {
      nickname: " 小满 ",
      fullName: " 满小满 ",
      phone: " ",
      documentNumber: " DOC-NEW ",
      reason: " 前台录入错误 "
    })).toEqual({
      commandType: "CORRECT_ORDER_OCCUPANT",
      title: "更正住宿人资料",
      description: "服务端将校验订单、住宿人与当前资料版本，并追加不可变更正记录。",
      input: {
        propertyId: "property_qintopia",
        orderId: "order_occupants",
        occupantId: "occupant_additional",
        expectedPriorSnapshot: {
          nickname: "同名住客",
          fullName: "同行人姓名",
          phone: null,
          documentNumber: "DOC-2"
        },
        correctedSnapshot: {
          nickname: "小满",
          fullName: "满小满",
          phone: null,
          documentNumber: "DOC-NEW"
        }
      },
      initialReason: { code: "CORRECT_ORDER_OCCUPANT", note: "前台录入错误" }
    });

    expect(() => buildOrderOccupantCorrectionRequest(view, occupants[0]!, {
      nickname: "小满",
      fullName: "满小满",
      phone: "",
      documentNumber: "",
      reason: "  "
    })).toThrow("必须填写更正原因");
  });

  it("requires the primary occupant phone only when correction resumes a membership upgrade", () => {
    const view = {
      order: { id: "order_occupants", property_id: "property_qintopia" }
    } as OrderViewDto;
    const values = {
      nickname: "同名住客",
      fullName: "同行人姓名",
      phone: " ",
      documentNumber: "DOC-2",
      reason: "升级会员前补录手机号"
    };

    expect(() => buildOrderOccupantCorrectionRequest(view, occupants[0]!, values, {
      phoneRequiredForStayMembershipUpgrade: true
    })).toThrow("升级会员前必须填写主要住宿人手机号");

    const html = renderToStaticMarkup(createElement(OrderOccupantCorrectionDialog, {
      view,
      occupant: occupants[0]!,
      phoneRequiredForStayMembershipUpgrade: true,
      onClose: () => undefined,
      onSubmit: () => undefined
    }));
    expect(html).toContain("升级会员前必须填写主要住宿人手机号");
    expect(html).toMatch(/data-testid="occupant-correction-phone"[^>]*required=""/);
  });

  it("still permits an ordinary occupant correction to clear a phone", () => {
    const view = {
      order: { id: "order_occupants", property_id: "property_qintopia" }
    } as OrderViewDto;
    const request = buildOrderOccupantCorrectionRequest(view, occupants[1]!, {
      nickname: "主要住宿人（无电话）",
      fullName: "主要人姓名",
      phone: " ",
      documentNumber: "",
      reason: "客人确认原电话错误"
    });
    expect(request.input.correctedSnapshot).toMatchObject({
      nickname: "主要住宿人（无电话）",
      phone: null
    });
  });

  it("keeps explicit null fields empty and binds a draft to the exact order occupant", () => {
    expect(restoredOptionalCorrectionValue(null, "13800000000")).toBe("");
    expect(restoredOptionalCorrectionValue(undefined, "13800000000")).toBe("13800000000");
    const draft = {
      commandType: "CORRECT_ORDER_OCCUPANT",
      title: "更正住宿人资料",
      description: "test",
      input: {
        propertyId: "property_qintopia",
        orderId: "order_occupants",
        occupantId: "occupant_primary"
      }
    } satisfies CommandRequest;
    expect(correctionDraftMatchesOccupant(draft, "order_occupants", "occupant_primary")).toBe(true);
    expect(correctionDraftMatchesOccupant(draft, "order_other", "occupant_primary")).toBe(false);
    expect(correctionDraftMatchesOccupant(draft, "order_occupants", "occupant_additional")).toBe(false);
  });
});

describe("in-house stay membership upgrade entry", () => {
  const primaryOccupant = {
    id: "occupant_primary_upgrade",
    orderId: "order_in_house_upgrade",
    ordinal: 1,
    role: "PRIMARY" as const,
    fullName: "主要住宿人",
    nickname: "小住",
    phone: " 138 0000 0000 ",
    documentNumber: "DOC-UPGRADE",
    createdAt: "2026-08-26T09:00:00.000Z"
  };

  function inHouseView(overrides: Record<string, unknown> = {}): OrderViewDto {
    return {
      order: {
        id: "order_in_house_upgrade",
        property_id: "property_qintopia",
        status: "CHECKED_IN",
        arrival_date: "2026-08-24",
        departure_date: "2026-08-29"
      },
      effectiveArrangement: {
        intervals: [{ inventoryUnitId: "unit_upgrade_eligible" }]
      },
      occupants: [primaryOccupant],
      collectionFacts: [],
      amendments: [],
      allowedActions: [{ code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", enabled: true, disabledReason: null }],
      ...overrides
    } as unknown as OrderViewDto;
  }

  const matchingMember = {
    id: "member_phone_match",
    full_name: "同手机号会员",
    nickname: "会员小住",
    phone: "13800000000"
  };
  const matchingProduct = {
    id: "product_upgrade_eligible",
    allowed_inventory_kind: "BED",
    allowed_room_type_code: "SHARED_BATH_QUAD",
    entitlement_unit_kind: "BED_NIGHT"
  };
  const unitMap = new Map([["unit_upgrade_eligible", {
    id: "unit_upgrade_eligible",
    kind: "BED",
    room_type_code: "SHARED_BATH_QUAD"
  }]]);

  it("keeps the upgrade entry ready for an in-house zero-collection stay without inventing a lodging receipt", () => {
    expect(stayMembershipUpgradeEntry(inHouseView(), [matchingMember] as never, [matchingProduct] as never, unitMap as never)).toEqual({
      state: "READY",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      phone: "13800000000",
      memberId: "member_phone_match",
      transferableCollectionFactIds: []
    });
  });

  it("keeps a partially refunded WECOM source in the ready upgrade intent at its remaining balance", () => {
    const source = {
      fact_id: "collection_partially_refunded_upgrade",
      order_id: "order_in_house_upgrade",
      fact_type: "COLLECTION",
      amount_minor: 59_000,
      net_effect_minor: 59_000,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      note: "",
      transaction_reference: "WX-UPGRADE-PARTIAL-SOURCE",
      cash_collector: null,
      pricing_revision_id: "revision_upgrade",
      command_id: "command_collection_partial",
      created_at: "2026-08-26T09:00:00.000Z",
      transfer: null
    } as CollectionFactDto;
    const entry = stayMembershipUpgradeEntry(inHouseView({
      collectionFacts: [
        source,
        {
          ...source,
          fact_id: "refund_partially_refunded_upgrade",
          fact_type: "REFUND",
          amount_minor: 1_000,
          net_effect_minor: -1_000,
          references_fact_id: source.fact_id,
          transaction_reference: null
        }
      ]
    }), [matchingMember] as never, [matchingProduct] as never, unitMap as never);

    expect(entry).toMatchObject({
      state: "READY",
      transferableCollectionFactIds: [source.fact_id]
    });
  });

  it("requires a positive whole-yuan agreed price for a formal membership", () => {
    expect(formalMembershipAgreedPriceMinor("1620")).toBe(162_000);
    expect(formalMembershipAgreedPriceMinor("0")).toBeUndefined();
    expect(formalMembershipAgreedPriceMinor("1.5")).toBeUndefined();
    expect(formalMembershipAgreedPriceMinor("21474836")).toBe(2_147_483_600);
    expect(formalMembershipAgreedPriceMinor("21474837")).toBeUndefined();
  });

  it("transfers only the remaining WECOM balance while keeping invalid fund graphs closed", () => {
    expect(stayConversionFundsState([], 0)).toEqual({
      transferableCollections: [],
      transferTotalMinor: 0,
      zeroCollectionOrder: true,
      refundedToZero: false
    });
    const valid = {
      fact_id: "collection_upgrade",
      order_id: "order_in_house_upgrade",
      fact_type: "COLLECTION",
      amount_minor: 59_000,
      net_effect_minor: 59_000,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      note: "",
      transaction_reference: "WX-UPGRADE-SOURCE",
      cash_collector: null,
      pricing_revision_id: "revision_upgrade",
      command_id: "command_collection",
      created_at: "2026-08-26T09:00:00.000Z",
      transfer: null
    } as CollectionFactDto;
    expect(stayConversionFundsState([valid], valid.amount_minor).disabledReason).toBeUndefined();
    const fullyRefunded = stayConversionFundsState([
      valid,
      {
        ...valid,
        fact_id: "refund_conversion",
        fact_type: "REFUND",
        amount_minor: 59_000,
        net_effect_minor: -59_000,
        references_fact_id: valid.fact_id,
        transaction_reference: null
      }
    ], 0);
    expect(fullyRefunded).toMatchObject({
      transferableCollections: [],
      transferTotalMinor: 0,
      zeroCollectionOrder: false,
      refundedToZero: true
    });
    const partiallyRefunded = stayConversionFundsState([
      valid,
      {
        ...valid,
        fact_id: "partial_refund_conversion",
        fact_type: "REFUND",
        amount_minor: 1_000,
        net_effect_minor: -1_000,
        references_fact_id: valid.fact_id,
        transaction_reference: null
      }
    ], 58_000);
    expect(partiallyRefunded).toMatchObject({
      transferTotalMinor: 58_000,
      zeroCollectionOrder: false,
      refundedToZero: false
    });
    expect(partiallyRefunded.transferableCollections).toHaveLength(1);
    expect(partiallyRefunded.transferableCollections[0]?.transferAmountMinor).toBe(58_000);
    const recollected = stayConversionFundsState([
      valid,
      {
        ...valid,
        fact_id: "refund_before_recollection",
        fact_type: "REFUND",
        amount_minor: 59_000,
        net_effect_minor: -59_000,
        references_fact_id: valid.fact_id,
        transaction_reference: null
      },
      {
        ...valid,
        fact_id: "collection_after_refund",
        amount_minor: 30_000,
        net_effect_minor: 30_000,
        transaction_reference: "WX-UPGRADE-RECOLLECTION"
      }
    ], 30_000);
    expect(recollected).toMatchObject({
      transferTotalMinor: 30_000,
      zeroCollectionOrder: false,
      refundedToZero: false
    });
    expect(recollected.transferableCollections).toHaveLength(1);
    expect(recollected.transferableCollections[0]?.fact_id).toBe("collection_after_refund");
    expect(stayConversionFundsState([
      valid,
      {
        ...valid,
        fact_id: "refund_with_illegal_new_reference",
        fact_type: "REFUND",
        amount_minor: 1_000,
        net_effect_minor: -1_000,
        references_fact_id: valid.fact_id,
        transaction_reference: "WX-REFUND-MUST-BE-NULL"
      }
    ], 58_000).disabledReason).toContain("无法核对");
    expect(stayConversionFundsState([{ ...valid, fact_id: "cash_collection", method: "CASH", transaction_reference: null }], valid.amount_minor).disabledReason).toContain("非企微");
    expect(stayConversionFundsState([{ ...valid, currency: "USD" }], valid.amount_minor, "CNY").disabledReason).toContain("无法核对");
  });

  it("requires correction of the primary occupant before matching when their phone is absent", () => {
    const entry = stayMembershipUpgradeEntry(inHouseView({
      occupants: [{ ...primaryOccupant, phone: null }]
    }), [matchingMember] as never, [matchingProduct] as never, unitMap as never);

    expect(entry).toEqual({
      state: "CORRECT_PRIMARY_OCCUPANT",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      reason: "PRIMARY_PHONE_REQUIRED"
    });
  });

  it("fails closed instead of matching a companion when the primary occupant is missing", () => {
    expect(stayMembershipUpgradeEntry(inHouseView({
      occupants: [{ ...primaryOccupant, role: "ADDITIONAL", ordinal: 2 }]
    }), [matchingMember] as never, [matchingProduct] as never, unitMap as never)).toEqual({
      state: "UNAVAILABLE",
      reason: "PRIMARY_OCCUPANT_REQUIRED"
    });
  });

  it("rejects a stay with no applicable formal product before correcting an occupant or creating a member", () => {
    expect(stayMembershipUpgradeEntry(inHouseView({
      occupants: [{ ...primaryOccupant, phone: null }]
    }), [], [], unitMap as never)).toEqual({
      state: "UNAVAILABLE",
      reason: "MEMBERSHIP_PRODUCT_NOT_APPLICABLE"
    });
  });

  it("resumes only the exact interrupted upgrade after a primary-occupant correction supplies a phone", () => {
    const interrupted = {
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      action: "STAY_MEMBERSHIP_UPGRADE" as const
    };

    expect(stayMembershipUpgradeResumeAfterOccupantCorrection(interrupted, {
      ...primaryOccupant,
      phone: "13800000000"
    })).toEqual({
      ...interrupted,
      phone: "13800000000"
    });
    expect(stayMembershipUpgradeResumeAfterOccupantCorrection(interrupted, {
      ...primaryOccupant,
      id: "occupant_other",
      phone: "13800000000"
    })).toBeUndefined();
    expect(stayMembershipUpgradeResumeAfterOccupantCorrection(interrupted, {
      ...primaryOccupant,
      phone: ""
    })).toBeUndefined();
  });

  it("routes a phone with no member match into member creation using the primary guest only", () => {
    expect(stayMembershipUpgradeEntry(inHouseView(), [{
      ...matchingMember,
      id: "member_same_name_wrong_phone",
      full_name: primaryOccupant.fullName,
      nickname: primaryOccupant.nickname,
      phone: "13900000000"
    }] as never, [matchingProduct] as never, unitMap as never)).toEqual({
      state: "CREATE_MEMBER",
      orderId: "order_in_house_upgrade",
      primaryOccupantId: "occupant_primary_upgrade",
      prefill: {
        fullName: "主要住宿人",
        nickname: "小住",
        phone: "13800000000"
      },
      returnTo: {
        action: "STAY_MEMBERSHIP_UPGRADE",
        orderId: "order_in_house_upgrade",
        primaryOccupantId: "occupant_primary_upgrade",
        phone: "13800000000"
      }
    });
  });

  it("fails closed for ordinary reprice and check-in revocation once a stay was upgraded, including a zero-transfer upgrade", () => {
    const upgraded = inHouseView({
      amendments: [{
        id: "amendment_zero_transfer_upgrade",
        amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
        reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
        payload: {
          member: { memberId: "member_phone_match" },
          transferredCollectionFactIds: []
        }
      }]
    });

    expect(upgradedStayActionDisabledReason(upgraded, "REPRICE_ORDER")).toBe("STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED");
    expect(upgradedStayActionDisabledReason(upgraded, "REVOKE_CHECK_IN")).toBe("STAY_MEMBERSHIP_UPGRADE_REVOKE_CHECK_IN_CLOSED");
    expect(upgradedStayActionDisabledReason(upgraded, "EXTEND_STAY")).toBeUndefined();
    expect(upgradedStayActionDisabledReason(inHouseView(), "REPRICE_ORDER")).toBeUndefined();

    const guardedReprice = orderActionWithUpgradeGuard(upgraded, {
      code: "REPRICE_ORDER",
      enabled: true,
      disabledReason: null
    });
    expect(guardedReprice).toMatchObject({
      code: "REPRICE_ORDER",
      enabled: false,
      disabledReason: "STAY_MEMBERSHIP_UPGRADE_REPRICE_CLOSED"
    });
    const html = renderToStaticMarkup(createElement(OrderActionButton, {
      action: guardedReprice,
      blocked: false,
      showWhenDisabled: true,
      children: "调整金额"
    }));
    expect(html).toContain("disabled");
    expect(html).toContain("升级会员后的住宿金额已冻结");
  });

  it("closes an open ordinary editor when refresh observes a zero-transfer upgrade", () => {
    const beforeUpgrade = inHouseView({
      pricingRevisions: [{ id: "revision_before_upgrade" }]
    });
    const afterUpgrade = inHouseView({
      pricingRevisions: [{ id: "revision_after_upgrade" }],
      amendments: [{
        id: "amendment_zero_transfer_upgrade_refresh",
        amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
        reason_code: "STAY_COLLECTION_TO_MEMBERSHIP",
        payload: { transferredCollectionFactIds: [] }
      }]
    });

    expect(orderRefreshMustCloseEditor(beforeUpgrade, afterUpgrade, true)).toBe(true);
    expect(orderRefreshMustCloseEditor(beforeUpgrade, afterUpgrade, false)).toBe(false);
  });
});

describe("server-authoritative order actions", () => {
  const actions = [{ code: "CHECK_IN" as const, enabled: true, disabledReason: null }, {
    code: "CANCEL_ORDER" as const,
    enabled: false,
    disabledReason: "ORDER_STATE_NOT_ALLOWED"
  }, { code: "CORRECT_ORDER_OCCUPANT" as const, enabled: true, disabledReason: null }];

  it("exposes only enabled server-provided actions and leaves READ with no writes", () => {
    expect(enabledOrderActionCodes(actions)).toEqual(["CHECK_IN", "CORRECT_ORDER_OCCUPANT"]);
    expect(enabledOrderActionCodes([])).toEqual([]);
  });

  it("accepts an action query only when that exact action is enabled", () => {
    expect(requestedOrderAction("?action=CHECK_IN", actions)).toBe("CHECK_IN");
    expect(requestedOrderAction("?action=CANCEL_ORDER", actions)).toBeUndefined();
    expect(requestedOrderAction("?action=REPRICE_ORDER", actions)).toBeUndefined();
  });

  it("keeps URL-requested stay-upgrade editors closed behind a command-recovery gate", () => {
    expect(stayMembershipUpgradeAutoOpenBlockedNotice("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", true))
      .toContain("已暂停自动打开升级会员流程");
    expect(stayMembershipUpgradeAutoOpenBlockedNotice("CORRECT_ORDER_OCCUPANT", true))
      .toContain("已暂停自动打开升级会员流程");
    expect(stayMembershipUpgradeAutoOpenBlockedNotice("CHECK_IN", true)).toBeUndefined();
    expect(stayMembershipUpgradeAutoOpenBlockedNotice("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", false)).toBeUndefined();
  });

  it("keeps every unconverted transient in-house WRITE upgrade entry visible with the server reason", () => {
    const disabled = { code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" as const, enabled: false, disabledReason: "NO_TRANSFERABLE_COLLECTION" };
    const base = {
      accessLevel: "WRITE",
      order: { status: "CHECKED_IN", booking_channel_code: "WECOM", stay_type: "TRANSIENT", member_id: null, member_contract_id: null },
      stay: { status: "IN_HOUSE" },
      amendments: []
    } as unknown as OrderViewDto;
    expect(stayMembershipUpgradeActionVisible(base, disabled)).toBe(true);
    expect(stayMembershipUpgradeActionVisible({ ...base, amendments: [{ amendment_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" }] } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible({ ...base, order: { ...base.order, booking_channel_code: null } } as unknown as OrderViewDto, disabled)).toBe(true);
    expect(stayMembershipUpgradeActionVisible({ ...base, order: { ...base.order, booking_channel_code: "MEITUAN" } } as unknown as OrderViewDto, disabled)).toBe(true);
    expect(stayMembershipUpgradeActionVisible({ ...base, order: { ...base.order, stay_type: "FREE" } } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible({ ...base, order: { ...base.order, member_id: "member_existing" } } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible({ ...base, order: { ...base.order, status: "RESERVED" } } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible({
      ...base,
      order: { ...base.order, status: "CHECKED_OUT" },
      stay: { ...base.stay, status: "COMPLETED" }
    } as unknown as OrderViewDto, disabled)).toBe(true);
    expect(stayMembershipUpgradeActionVisible({
      ...base,
      order: { ...base.order, status: "CHECKED_OUT" }
    } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible({ ...base, accessLevel: "READ" } as unknown as OrderViewDto, disabled)).toBe(false);
    expect(stayMembershipUpgradeActionVisible(base, {
      code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", enabled: true, disabledReason: null
    })).toBe(true);
  });

  it("keeps a disabled refund action explainable when there is no refundable collection", () => {
    expect(orderRefundUnavailableReason([
      { code: "RECORD_REFUND", enabled: false, disabledReason: "NO_REFUNDABLE_COLLECTION" }
    ])).toContain("当前没有可退款的收款记录");
    expect(orderRefundUnavailableReason([
      { code: "RECORD_REFUND", enabled: true, disabledReason: null }
    ])).toBeUndefined();
    expect(orderRefundUnavailableReason([
      { code: "RECORD_REFUND", enabled: false, disabledReason: "ORDER_STATE_NOT_ALLOWED" }
    ])).toBeUndefined();
  });

  it("keeps terminal order actions visible as disabled command affordances", () => {
    expect(orderStatusIsTerminal("CANCELLED")).toBe(true);
    expect(orderStatusIsTerminal("RESERVED")).toBe(false);
    expect(terminalOrderActionCodes("CANCELLED")).toEqual([
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "RESCHEDULE_STAY",
      "MOVE_UNIT",
      "REPRICE_ORDER",
      "CHECK_IN",
      "CANCEL_ORDER",
      "MARK_NO_SHOW"
    ]);
    expect(terminalOrderActionCodes("CANCELLED")).not.toContain("CHECK_OUT");
    expect(terminalOrderActionCodes("CHECKED_OUT")).toEqual([
      "RECORD_COLLECTION",
      "RECORD_REFUND",
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      "EXTEND_STAY",
      "SHORTEN_STAY",
      "MOVE_UNIT",
      "REPRICE_ORDER",
      "CHECK_OUT",
      "REVOKE_CHECK_IN"
    ]);
  });

  it("translates disabled action reasons into operator-facing copy", () => {
    expect(orderActionDisabledReasonText({
      code: "CANCEL_ORDER",
      enabled: false,
      disabledReason: "ORDER_STATE_NOT_ALLOWED"
    })).toBe("当前订单状态不允许执行此操作。");
    expect(orderActionDisabledReasonText({
      code: "RECORD_REFUND",
      enabled: false,
      disabledReason: "NO_REFUNDABLE_COLLECTION"
    })).toContain("当前没有可退款的收款记录");
    expect(orderActionDisabledReasonText({
      code: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      enabled: false,
      disabledReason: "NO_TRANSFERABLE_COLLECTION"
    })).toContain("非企微、冲销或无法核对");
    expect(orderActionDisabledReasonText({
      code: "CHECK_IN",
      enabled: true,
      disabledReason: null
    })).toBeUndefined();
  });

  it("uses one shared help affordance for visible disabled actions", () => {
    expect(orderActionHelpRequired([
      { code: "RECORD_COLLECTION", enabled: false, disabledReason: "ORDER_STATE_NOT_ALLOWED" },
      { code: "CHECK_IN", enabled: true, disabledReason: null }
    ], ["RECORD_COLLECTION", "CHECK_IN"])).toBe(true);
    expect(orderActionHelpRequired([
      { code: "RECORD_COLLECTION", enabled: false, disabledReason: "ORDER_STATE_NOT_ALLOWED" }
    ], ["CHECK_IN"])).toBe(false);
  });

  it("returns to room status only for explicit room-status navigation state", () => {
    expect(orderDetailBackTarget({ fromRoomStatus: true })).toBe("/");
    expect(orderDetailBackTarget({ source: "room-status" })).toBe("/");
    expect(orderDetailBackTarget({ returnTo: "/" })).toBe("/");
    expect(orderDetailBackTarget(undefined)).toBe("/orders");
    expect(orderDetailBackTarget({ returnTo: "/members" })).toBe("/orders");
  });

  it("fails closed while the loaded order belongs to an earlier principal scope", () => {
    expect(orderViewMatchesPrincipalScope("operator:SESSION:WRITE", "viewer:TOKEN:READ")).toBe(false);
    expect(orderViewMatchesPrincipalScope("viewer:TOKEN:READ", "viewer:TOKEN:READ")).toBe(true);
  });

  it("offers per-fact refund only for an active collection with remaining value", () => {
    const fact = (values: Partial<CollectionFactDto> & Pick<CollectionFactDto, "fact_id" | "fact_type" | "amount_minor">): CollectionFactDto => ({
      order_id: "order_refund",
      net_effect_minor: values.amount_minor,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      cash_collector: null,
      note: "",
      transaction_reference: "REF",
      pricing_revision_id: "revision_refund",
      command_id: `command_${values.fact_id}`,
      created_at: "2026-07-25T00:00:00.000Z",
      ...values
    });
    const collection = fact({ fact_id: "collection", fact_type: "COLLECTION", amount_minor: 10_000 });
    const partialRefund = fact({ fact_id: "refund_partial", fact_type: "REFUND", amount_minor: 4_000, references_fact_id: collection.fact_id });
    expect(remainingRefundableMinor([collection, partialRefund], collection)).toBe(6_000);

    const finalRefund = fact({ fact_id: "refund_final", fact_type: "REFUND", amount_minor: 6_000, references_fact_id: collection.fact_id });
    expect(remainingRefundableMinor([collection, partialRefund, finalRefund], collection)).toBe(0);

    const reversal = fact({ fact_id: "reversal", fact_type: "REVERSAL", amount_minor: 4_000, reverses_fact_id: partialRefund.fact_id });
    expect(remainingRefundableMinor([collection, partialRefund, finalRefund, reversal], collection)).toBe(4_000);
  });

  it("offers per-fact reversal only for server-enabled facts that can be safely reversed", () => {
    const fact = (values: Partial<CollectionFactDto> & Pick<CollectionFactDto, "fact_id" | "fact_type" | "amount_minor">): CollectionFactDto => ({
      order_id: "order_reverse",
      net_effect_minor: values.fact_type === "COLLECTION" ? values.amount_minor : -values.amount_minor,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      cash_collector: null,
      note: "",
      transaction_reference: "WX-REVERSE-001",
      pricing_revision_id: "revision_reverse",
      command_id: `command_${values.fact_id}`,
      created_at: "2026-07-25T00:00:00.000Z",
      ...values
    });
    const collection = fact({ fact_id: "collection_reverse", fact_type: "COLLECTION", amount_minor: 10_000 });
    const refund = fact({
      fact_id: "refund_reverse",
      fact_type: "REFUND",
      amount_minor: 4_000,
      references_fact_id: collection.fact_id,
      transaction_reference: null
    });
    const refundReversal = fact({
      fact_id: "reversal_refund",
      fact_type: "REVERSAL",
      amount_minor: 4_000,
      reverses_fact_id: refund.fact_id,
      method: "REVERSAL",
      transaction_reference: null
    });

    expect(collectionFactCanReverse([collection], collection, true)).toBe(true);
    expect(collectionFactCanReverse([collection, refund], collection, true)).toBe(false);
    expect(collectionFactCanReverse([collection, refund, refundReversal], collection, true)).toBe(true);
    expect(collectionFactCanReverse([collection, refund, refundReversal], refund, true)).toBe(false);
    expect(collectionFactCanReverse([collection], collection, false)).toBe(false);
    expect(collectionFactCanReverse([collection, refund, refundReversal], refundReversal, true)).toBe(false);

    const html = renderToStaticMarkup(createElement(FactActions, {
      fact: refund,
      facts: [collection, refund],
      canRefund: false,
      canReverse: true,
      disabled: false,
      onRefund: () => undefined,
      onReverse: () => undefined
    }));
    expect(html).toContain('data-order-action="REVERSE_FACT"');
    expect(html).toContain("冲销");
    expect(html).toContain('class="fact-reverse-action"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("仅用于撤销录错的收款或退款");
    expect(html).toContain("如果确实把钱退给客人，请使用“退款”");
    expect(html).not.toContain(refund.fact_id);
    expect(html).not.toContain(collection.fact_id);

    const pairedActionsHtml = renderToStaticMarkup(createElement(FactActions, {
      fact: collection,
      facts: [collection],
      canRefund: true,
      canReverse: true,
      disabled: false,
      onRefund: () => undefined,
      onReverse: () => undefined
    }));
    expect(pairedActionsHtml.match(/fact-action-button/g)).toHaveLength(2);
    expect(pairedActionsHtml).toContain("fact-refund-button");
    expect(pairedActionsHtml).toContain("fact-reverse-button");
  });

  it("positions the reverse-fact explanation above the button within the viewport", () => {
    expect(reverseFactHelpPosition({ right: 727, top: 2_803 }, 743, 3_055)).toEqual({
      left: 443,
      bottom: 260,
      width: 280
    });
    expect(reverseFactHelpPosition({ right: 50, top: 100 }, 240, 500)).toEqual({
      left: 12,
      bottom: 408,
      width: 216
    });
  });

  it("builds a controlled reverse-fact command request from one selected fact", () => {
    const fact: CollectionFactDto = {
      fact_id: "refund_reverse_request",
      order_id: "order_reverse_request",
      fact_type: "REFUND",
      amount_minor: 3_000,
      net_effect_minor: -3_000,
      currency: "CNY",
      references_fact_id: "collection_reverse_request",
      reverses_fact_id: null,
      method: "WECOM",
      cash_collector: null,
      note: "原退款登记错单",
      transaction_reference: null,
      pricing_revision_id: "revision_reverse_request",
      command_id: "command_refund_reverse_request",
      created_at: "2026-07-25T00:00:00.000Z"
    };
    const request = buildReverseFactRequest({
      order: { id: "order_reverse_request", property_id: "property_qintopia" }
    } as OrderViewDto, fact, "  退款登记错单，需冲销  ");

    expect(request).toMatchObject({
      commandType: "REVERSE_FACT",
      title: "登记冲销",
      input: {
        propertyId: "property_qintopia",
        orderId: "order_reverse_request",
        reversesFactId: fact.fact_id,
        note: "退款登记错单，需冲销"
      },
      initialReason: {
        code: "REVERSE_FACT",
        note: "退款登记错单，需冲销"
      }
    });
    expect(request.description).toContain("追加一条反向冲销记录");
    expect(request.description).not.toContain(fact.fact_id);
  });

  it("shows WECOM refunds as original-route references when no new transaction number is recorded", () => {
    const fact = (values: Partial<CollectionFactDto> & Pick<CollectionFactDto, "fact_id" | "fact_type" | "amount_minor">): CollectionFactDto => ({
      order_id: "order_refund_label",
      net_effect_minor: values.fact_type === "REFUND" ? -values.amount_minor : values.amount_minor,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "WECOM",
      cash_collector: null,
      note: "",
      transaction_reference: null,
      pricing_revision_id: "revision_refund_label",
      command_id: `command_${values.fact_id}`,
      created_at: "2026-07-25T00:00:00.000Z",
      ...values
    });
    const collection = fact({ fact_id: "collection_wecom", fact_type: "COLLECTION", amount_minor: 10_000, transaction_reference: "WX-COLLECTION-001" });
    const refund = fact({ fact_id: "refund_wecom", fact_type: "REFUND", amount_minor: 1_000, references_fact_id: collection.fact_id });
    expect(collectionFactTransactionReferenceLabel([collection, refund], refund)).toBe("WX-COLLECTION-001（原路退回）");
  });

  it("shows both the collector and note for a historical cash collection", () => {
    const fact: CollectionFactDto = {
      fact_id: "collection_backfill_cash",
      order_id: "order_backfill_cash",
      fact_type: "COLLECTION",
      amount_minor: 8_450,
      net_effect_minor: 8_450,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      cash_collector: "前台甲",
      note: "现金已核对",
      transaction_reference: null,
      pricing_revision_id: "revision_backfill_cash",
      command_id: "command_backfill_cash",
      created_at: "2026-08-14T09:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CollectionFactNote, { fact })));
    expect(html).toContain("收款人");
    expect(html).toContain("前台甲");
    expect(html).toContain("备注");
    expect(html).toContain("现金已核对");
  });

  it("keeps an ordinary cash collection note displayed as its collector", () => {
    const fact: CollectionFactDto = {
      fact_id: "collection_ordinary_cash",
      order_id: "order_ordinary_cash",
      fact_type: "COLLECTION",
      amount_minor: 3_000,
      net_effect_minor: 3_000,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      cash_collector: null,
      note: "前台乙",
      transaction_reference: null,
      pricing_revision_id: "revision_ordinary_cash",
      command_id: "command_ordinary_cash",
      created_at: "2026-08-14T10:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CollectionFactNote, { fact })));
    expect(html).toContain("收款人");
    expect(html).toContain("前台乙");
    expect(html).not.toContain("历史未记录");
    expect(html).not.toContain("备注：前台乙");
  });
});

const context = {
  subjectId: "subject_operator",
  scopeId: "property:property_qintopia",
  request: {
    commandType: "RECORD_COLLECTION",
    title: "登记收款",
    description: "test",
    input: {
      propertyId: "property_qintopia",
      orderId: "order_recovery",
      amountMinor: 5800,
      transactionReference: "WX-BUSINESS-REFERENCE-001",
      tokenSecret: "must-never-be-retained"
    }
  } satisfies CommandRequest
};

const confirming: CommandDialogProgress = {
  state: "CONFIRMING",
  previewId: "preview_recovery",
  confirmationKey: "web-confirm-record-collection-original"
};

const receipt = {
  receiptId: "receipt_recovery",
  commandId: "command_recovery",
  executionStatus: "EXECUTED" as const,
  businessCommitted: true,
  correlationId: "correlation_recovery",
  result: { factId: "fact_recovery", transactionReference: "WX-BUSINESS-REFERENCE-001" },
  resourceRefs: ["order_recovery"],
  factRefs: ["fact_recovery"],
  committedAt: "2026-07-19T10:00:00.000Z"
};

describe("shared Web command recovery persistence", () => {
  it("retains only recovery identity before resolution and survives a fresh load", () => {
    const storage = new MemoryStorage();
    const transition = transitionPersistedCommandRecovery(undefined, context, confirming, "2026-07-19T09:00:00.000Z");

    expect(transition.accepted).toBe(true);
    expect(transition.recovery).toMatchObject({
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "RECORD_COLLECTION",
      confirmationKey: confirming.confirmationKey,
      state: "CONFIRMING"
    });
    expect(transition.recovery?.targetRefs).toEqual(["orderId=order_recovery"]);
    expect(savePersistedCommandRecovery(storage, transition.recovery!)).toBe(true);

    const serialized = storage.getItem(commandRecoveryStorageKey(context.subjectId, context.scopeId));
    expect(serialized).not.toContain("must-never-be-retained");
    expect(serialized).not.toContain("tokenSecret");
    expect(serialized).not.toContain("amountMinor");
    expect(serialized).not.toContain("transactionReference");
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "VALID", recovery: transition.recovery });
  });

  it("keeps the original key through UNKNOWN and persists terminal identity without the Receipt", () => {
    const storage = new MemoryStorage();
    const started = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    const unknown = transitionPersistedCommandRecovery(started, context, {
      state: "UNKNOWN",
      confirmationKey: confirming.confirmationKey
    }, "2026-07-19T09:01:00.000Z").recovery!;
    const resolved = transitionPersistedCommandRecovery(unknown, context, {
      state: "RESOLVED",
      confirmationKey: confirming.confirmationKey,
      receipt
    }, "2026-07-19T09:02:00.000Z").recovery!;

    expect(unknown).toMatchObject({ state: "UNKNOWN", confirmationKey: confirming.confirmationKey });
    expect(resolved).toMatchObject({
      state: "EXECUTED",
      confirmationKey: confirming.confirmationKey
    });
    expect(savePersistedCommandRecovery(storage, resolved)).toBe(true);
    const serialized = storage.getItem(commandRecoveryStorageKey(context.subjectId, context.scopeId));
    expect(serialized).not.toContain("receipt");
    expect(serialized).not.toContain("transactionReference");
    expect(serialized).not.toContain("WX-BUSINESS-REFERENCE-001");
    expect(serialized).not.toContain("result");
    expect(serialized).not.toContain("resourceRefs");
    expect(serialized).not.toContain("factRefs");
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "VALID", recovery: resolved });
  });

  it("clears a retained confirmation after a definitive non-retryable failure", () => {
    const started = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    const failed = transitionPersistedCommandRecovery(started, context, {
      state: "FAILED_NOT_EXECUTED",
      confirmationKey: confirming.confirmationKey
    });

    expect(failed).toEqual({ accepted: true, recovery: undefined });
  });

  it("does not regress a terminal result or resurrect a cleared attempt from delayed callbacks", () => {
    const terminal = transitionPersistedCommandRecovery(
      transitionPersistedCommandRecovery(undefined, context, confirming).recovery,
      context,
      { state: "RESOLVED", confirmationKey: confirming.confirmationKey, receipt }
    ).recovery!;

    expect(transitionPersistedCommandRecovery(terminal, context, {
      state: "UNKNOWN",
      confirmationKey: confirming.confirmationKey
    }).recovery).toBe(terminal);
    expect(transitionPersistedCommandRecovery(undefined, context, {
      state: "RESOLVED",
      confirmationKey: confirming.confirmationKey,
      receipt
    }).recovery).toBeUndefined();
  });

  it("rejects a second confirmation key until the retained command is explicitly cleared", () => {
    const storage = new MemoryStorage();
    const retained = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    expect(savePersistedCommandRecovery(storage, retained)).toBe(true);

    const conflicting = transitionPersistedCommandRecovery(retained, context, {
      ...confirming,
      confirmationKey: "web-confirm-record-collection-new-key"
    });
    expect(conflicting).toEqual({ accepted: false, recovery: retained });

    expect(clearPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "ABSENT" });
  });

  it("uses the same property scope for entitlement commands while excluding Token secrets", () => {
    const entitlementRequest = {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      title: "调整会员权益",
      description: "test",
      input: {
        propertyId: "property_qintopia",
        entitlementLotId: "lot_member_room",
        quantityDelta: 1,
        adjustmentReason: "manual correction"
      }
    } satisfies CommandRequest;
    const entitlement = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: entitlementRequest
    }, { ...confirming, confirmationKey: "web-confirm-entitlement" }).recovery;
    expect(entitlement).toMatchObject({
      scopeId: "property:property_qintopia",
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      targetRefs: ["entitlementLotId=lot_member_room"]
    });

    const tokenRequest = {
      commandType: "ISSUE_TOKEN",
      title: "Issue Token",
      description: "test",
      input: { propertyId: "property_qintopia", tokenSecret: "qtp_do-not-persist" }
    } satisfies CommandRequest;
    expect(transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: tokenRequest
    }, { ...confirming, confirmationKey: "web-confirm-token" })).toEqual({ accepted: false, recovery: undefined });
  });

  it("retains the member-stay presentation without retaining guest or quote input", () => {
    const memberStayRequest = {
      commandType: "CREATE_ORDER",
      title: "创建订单",
      description: "核对会员住宿",
      presentation: "MEMBER_STAY",
      input: {
        propertyId: "property_qintopia",
        quoteId: "quote_member_stay",
        primaryGuest: { fullName: "不应持久化", nickname: "不应持久化" }
      }
    } satisfies CommandRequest;
    const recovery = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: memberStayRequest
    }, { ...confirming, confirmationKey: "web-confirm-member-stay", effectHash: "a".repeat(64) }).recovery!;

    expect(recovery).toMatchObject({ commandType: "CREATE_ORDER", presentation: "MEMBER_STAY", effectHash: "a".repeat(64) });
    expect(recoveryCommandRequest(recovery)).toMatchObject({ commandType: "CREATE_ORDER", presentation: "MEMBER_STAY", input: { propertyId: "property_qintopia" } });
    expect(JSON.stringify(recovery)).not.toContain("不应持久化");
  });

  it("retains fulfillment presentation while hiding the order target from the recovery dialog", () => {
    const request = {
      commandType: "CHECK_OUT",
      title: "办理退房",
      description: "核对后办理退房",
      presentation: "FULFILLMENT",
      input: { propertyId: "property_qintopia", orderId: "order_internal_target" }
    } satisfies CommandRequest;
    const recovery = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request
    }, { ...confirming, confirmationKey: "web-confirm-check-out", effectHash: "b".repeat(64) }).recovery!;

    expect(recovery).toMatchObject({ commandType: "CHECK_OUT", presentation: "FULFILLMENT", effectHash: "b".repeat(64) });
    expect(recoveryCommandRequest(recovery)).toMatchObject({
      commandType: "CHECK_OUT",
      presentation: "FULFILLMENT",
      title: "恢复办理退房结果",
      input: { propertyId: "property_qintopia" }
    });
    expect(JSON.stringify(recoveryCommandRequest(recovery))).not.toMatch(/order_internal_target|Receipt|Command|CHECKED_OUT/);
  });

  it("retains SHORTEN_STAY as a date-change recovery without persisting its order draft", () => {
    const request = {
      commandType: "SHORTEN_STAY",
      title: "提前退房",
      description: "核对提前退房",
      presentation: "STAY_DATES",
      input: { propertyId: "property_qintopia", orderId: "order_internal_target", newDepartureDate: "2026-07-29" }
    } satisfies CommandRequest;
    const recovery = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request
    }, {
      ...confirming,
      confirmationKey: "web-confirm-shorten-stay",
      effectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }).recovery!;

    expect(recovery).toMatchObject({ commandType: "SHORTEN_STAY", presentation: "STAY_DATES" });
    expect(recoveryCommandRequest(recovery)).toMatchObject({
      commandType: "SHORTEN_STAY",
      presentation: "STAY_DATES",
      title: "恢复缩短住宿或提前退房结果",
      recoveryEffectHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      input: { propertyId: "property_qintopia" }
    });
    expect(recovery).not.toHaveProperty("newDepartureDate");
    expect(recoveryCommandRequest(recovery).input).not.toHaveProperty("newDepartureDate");
  });

  it("retains MOVE_UNIT as a business recovery without persisting its room or pricing draft", () => {
    const request = {
      commandType: "MOVE_UNIT",
      title: "换房",
      description: "核对换房",
      presentation: "MOVE_UNIT",
      input: {
        propertyId: "property_qintopia",
        orderId: "order_internal_target",
        newInventoryUnitId: "room_internal_target",
        effectiveDate: "2026-07-29",
        targetCurrentContractAmountMinor: 20_000
      }
    } satisfies CommandRequest;
    const recovery = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request
    }, {
      ...confirming,
      confirmationKey: "web-confirm-move-unit",
      effectHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }).recovery!;

    expect(recovery).toMatchObject({ commandType: "MOVE_UNIT", presentation: "MOVE_UNIT" });
    expect(recoveryCommandRequest(recovery)).toMatchObject({
      commandType: "MOVE_UNIT",
      presentation: "MOVE_UNIT",
      title: "恢复办理换房结果",
      recoveryEffectHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      input: { propertyId: "property_qintopia" }
    });
    expect(JSON.stringify(recovery)).not.toMatch(/room_internal_target|2026-07-29|20000/);
  });

  it("retains lifecycle recovery identity and acknowledgement without persisting the operator reason", () => {
    const request = {
      commandType: "REVOKE_CHECK_IN",
      title: "撤销入住",
      description: "核对撤销入住",
      presentation: "ORDER_LIFECYCLE",
      initialReason: { code: "REVOKE_CHECK_IN", note: "住客看房后未入住" },
      input: {
        propertyId: "property_qintopia",
        orderId: "order_revoke_target",
        unusedRoomConfirmed: true
      }
    } satisfies CommandRequest;
    const recovery = transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request
    }, {
      ...confirming,
      confirmationKey: "web-confirm-revoke-check-in",
      effectHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }).recovery!;

    expect(recovery).toMatchObject({
      commandType: "REVOKE_CHECK_IN",
      presentation: "ORDER_LIFECYCLE",
      targetRefs: ["orderId=order_revoke_target"]
    });
    expect(JSON.stringify(recovery)).not.toContain("住客看房后未入住");
    expect(recoveryCommandRequest(recovery)).toMatchObject({
      commandType: "REVOKE_CHECK_IN",
      presentation: "ORDER_LIFECYCLE",
      title: "恢复撤销入住结果",
      recoveryEffectHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      input: {
        propertyId: "property_qintopia",
        orderId: "order_revoke_target",
        unusedRoomConfirmed: true
      }
    });
  });

  it("fails closed when a stay-date, move or lifecycle recovery loses its bound effect hash", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    const strictRecovery = {
      version: 1,
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "SHORTEN_STAY",
      confirmationKey: "web-confirm-strict-recovery",
      targetRefs: ["orderId=order_internal_target"],
      presentation: "STAY_DATES",
      state: "UNKNOWN",
      updatedAt: "2026-07-30T10:00:00.000Z"
    };

    storage.setItem(key, JSON.stringify(strictRecovery));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    storage.setItem(key, JSON.stringify({ ...strictRecovery, effectHash: "not-a-sha256" }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    storage.setItem(key, JSON.stringify({
      ...strictRecovery,
      commandType: "REVOKE_CHECK_IN",
      presentation: "ORDER_LIFECYCLE"
    }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    expect(transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: {
        commandType: "MOVE_UNIT",
        title: "换房",
        description: "核对换房",
        presentation: "MOVE_UNIT",
        input: { propertyId: "property_qintopia", orderId: "order_internal_target" }
      }
    }, {
      state: "CONFIRMING",
      previewId: confirming.previewId,
      confirmationKey: "web-confirm-move-without-hash"
    })).toEqual({
      accepted: false,
      recovery: undefined
    });
  });

  it("rejects a damaged recovery record that pairs fulfillment presentation with another command", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    storage.setItem(key, JSON.stringify({
      version: 1,
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "CANCEL_ORDER",
      confirmationKey: "web-confirm-damaged-fulfillment",
      targetRefs: ["orderId=order_internal_target"],
      presentation: "FULFILLMENT",
      state: "UNKNOWN",
      updatedAt: "2026-07-25T10:00:00.000Z"
    }));

    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toMatchObject({ kind: "CORRUPT" });
  });

  it("rejects any recovery record that embeds a terminal Receipt", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    const base = {
      version: 1,
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "LOCK_MAINTENANCE",
      confirmationKey: "web-confirm-lock",
      targetRefs: ["inventoryUnitId=unit_101"],
      updatedAt: "2026-07-27T10:00:00.000Z"
    };
    storage.setItem(key, JSON.stringify({
      ...base,
      state: "EXECUTED",
      receipt
    }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    storage.setItem(key, JSON.stringify({
      ...base,
      state: "NOT_EXECUTED",
      receipt: { ...receipt, executionStatus: "NOT_EXECUTED", businessCommitted: false }
    }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");
  });

  it("reads a pre-upgrade deferred recovery only as an original-result query", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    const historicalRecovery = {
      version: 1,
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      propertyId: "property_qintopia",
      commandType: "PLACE_INTERNAL_USE",
      confirmationKey: "web-confirm-historical-internal",
      targetRefs: ["internalUseBlockId=block_historical"],
      state: "UNKNOWN",
      updatedAt: "2026-07-19T09:00:00.000Z"
    } satisfies PersistedCommandRecovery;
    storage.setItem(key, JSON.stringify(historicalRecovery));

    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({
      kind: "VALID",
      recovery: historicalRecovery
    });
    expect(recoveryCommandRequest(historicalRecovery)).toMatchObject({
      commandType: "PLACE_INTERNAL_USE",
      input: { propertyId: "property_qintopia" }
    });
    expect(transitionPersistedCommandRecovery(undefined, {
      subjectId: context.subjectId,
      scopeId: context.scopeId,
      request: recoveryCommandRequest(historicalRecovery)
    }, { ...confirming, confirmationKey: historicalRecovery.confirmationKey })).toEqual({
      accepted: false,
      recovery: undefined
    });
  });

  it("reports storage failure so Confirm can fail closed before sending", () => {
    const recovery = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    const unavailableStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("session storage unavailable"); },
      removeItem: () => { throw new Error("session storage unavailable"); }
    };

    expect(savePersistedCommandRecovery(unavailableStorage, recovery)).toBe(false);
    expect(clearPersistedCommandRecovery(unavailableStorage, context.subjectId, context.scopeId)).toBe(false);
  });

  it("distinguishes truncated JSON, wrong versions, and read failures from an absent record", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);
    storage.setItem(key, "{\"version\":1");
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    storage.setItem(key, JSON.stringify({ version: 2 }));
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId).kind).toBe("CORRUPT");

    const unreadableStorage = {
      getItem: () => { throw new Error("read denied"); },
      setItem: () => undefined,
      removeItem: () => undefined
    };
    expect(readPersistedCommandRecovery(unreadableStorage, context.subjectId, context.scopeId).kind).toBe("READ_ERROR");
  });

  it("only clears a damaged record after the caller has entered the controlled recovery path", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(context.subjectId, context.scopeId);

    expect(clearCorruptPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toBe(false);
    const valid = transitionPersistedCommandRecovery(undefined, context, confirming).recovery!;
    expect(savePersistedCommandRecovery(storage, valid)).toBe(true);
    expect(clearCorruptPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toBe(false);
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toMatchObject({ kind: "VALID" });

    storage.setItem(key, "{\"version\":1");
    expect(clearCorruptPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(storage, context.subjectId, context.scopeId)).toEqual({ kind: "ABSENT" });
  });
});
