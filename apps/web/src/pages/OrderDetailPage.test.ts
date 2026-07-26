import { describe, expect, it } from "vitest";
import type { CollectionFactDto, CommandRequest, OrderViewDto } from "../types";
import { buildOrderOccupantCorrectionRequest } from "../components/OrderOccupantCorrectionDialog";
import {
  enabledOrderActionCodes,
  fulfillmentResultLabel,
  occupantSnapshotEntries,
  orderDetailBackTarget,
  orderFulfillmentNotice,
  orderViewMatchesPrincipalScope,
  orderedOrderOccupants,
  primaryOrderOccupant,
  remainingRefundableMinor,
  requestedOrderAction
} from "./OrderDetailPage";
import {
  clearPersistedCommandRecovery,
  commandRecoveryStorageKey,
  readPersistedCommandRecovery,
  recoveryCommandRequest,
  savePersistedCommandRecovery,
  transitionPersistedCommandRecovery,
  type CommandDialogProgress,
  type PersistedCommandRecovery
} from "../ui";

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
    expect(notice?.body).toContain("当前版本暂不办理提前退房");
    expect(notice?.body).not.toContain("请先缩短");
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
      body: expect.stringContaining("不能提前办理入住")
    });
    expect(orderFulfillmentNotice([{
      code: "CHECK_IN",
      enabled: false,
      disabledReason: "ARRIVAL_DATE_PASSED"
    }])).toMatchObject({
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: expect.stringContaining("不能按普通入住补办")
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
});

const context = {
  subjectId: "subject_operator",
  scopeId: "property:property_qintopia",
  request: {
    commandType: "RECORD_COLLECTION",
    title: "记录收款事实",
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

  it("keeps the original key through UNKNOWN and persists the terminal Receipt", () => {
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
      confirmationKey: confirming.confirmationKey,
      receipt: { commandId: "command_recovery", receiptId: "receipt_recovery" }
    });
    expect(savePersistedCommandRecovery(storage, resolved)).toBe(true);
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
    }, { ...confirming, confirmationKey: "web-confirm-member-stay" }).recovery!;

    expect(recovery).toMatchObject({ commandType: "CREATE_ORDER", presentation: "MEMBER_STAY" });
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
    }, { ...confirming, confirmationKey: "web-confirm-check-out" }).recovery!;

    expect(recovery).toMatchObject({ commandType: "CHECK_OUT", presentation: "FULFILLMENT" });
    expect(recoveryCommandRequest(recovery)).toMatchObject({
      commandType: "CHECK_OUT",
      presentation: "FULFILLMENT",
      title: "恢复办理退房结果",
      input: { propertyId: "property_qintopia" }
    });
    expect(JSON.stringify(recoveryCommandRequest(recovery))).not.toMatch(/order_internal_target|Receipt|Command|CHECKED_OUT/);
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
});
