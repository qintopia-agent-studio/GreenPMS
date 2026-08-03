import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { PreviewDto, ReceiptDto } from "@qintopia/contracts";
import { ApiError } from "./api.ts";
import { businessErrorMessage, businessStatusLabel, clearCorruptPersistedCommandRecovery, clearPersistedCommandRecovery, clearPersistedCommandRecoveryIfMatches, commandRecoveryConflictStorageKeys, commandRecoverySnapshotIsBlocked, commandRecoveryStorageHasConflict, commandRecoveryStorageKey, conversionPreviewHasEvidence, conversionReceiptHasEvidence, createSharedCommandRecoveryStorage, EffectSummary, fulfillmentAuditNote, fulfillmentReceiptCopy, fulfillmentTransitionIsExpected, guestNicknameLabel, knownCommittedCommandMessage, lodgingReceiptCopy, notifyKnownCommittedCommand, occupantSummaryItems, planBDateChangeTimeline, propertyRecoveryCoordinationScope, quoteRecoveryStorageKey, readCommandRecoveryConflict, readPersistedCommandRecovery, ReceiptPanel, receiptExecutionSemanticsAreCoherent, receiptHasCommandEvidence, receiptTransactionReferenceLabel, recoveryCommandRequest, recoveryStorageEventMatchesScope, recoveryStorageSyncEventMatchesScope, runRecoveryCheckedPreview, savePersistedCommandRecovery, sharedRecoveryMarkerKey, stayDateFundsAreOperatorFacing, stayDatePreviewPricingSummary, transitionPersistedCommandRecovery, u1PreviewHasBusinessEvidence } from "./ui.tsx";

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

describe("cross-tab command recovery storage", () => {
  const subjectId = "subject_operator";
  const scopeId = "property:property_green";
  const otherScopeId = "property:property_other";
  const recovery = {
    version: 1 as const,
    subjectId,
    scopeId,
    propertyId: "property_green",
    commandType: "LOCK_MAINTENANCE" as const,
    confirmationKey: "confirm_shared_recovery",
    targetRefs: ["inventoryUnitId=unit_104"],
    state: "UNKNOWN" as const,
    updatedAt: "2026-08-03T08:00:00.000Z"
  };

  it("automatically coordinates every property-scoped writer with the pending Quote record", () => {
    const quoteKey = quoteRecoveryStorageKey(subjectId, "property_green");
    const storage = new MemoryStorage();
    expect(commandRecoveryConflictStorageKeys(subjectId, scopeId)).toEqual([quoteKey]);
    expect(commandRecoveryConflictStorageKeys(subjectId, scopeId, [quoteKey, "custom-conflict-key"]))
      .toEqual([quoteKey, "custom-conflict-key"]);
    expect(commandRecoveryConflictStorageKeys(subjectId, "member:member_green", ["custom-conflict-key"]))
      .toEqual(["custom-conflict-key"]);
    storage.setItem(quoteKey, "pending-quote");
    expect(commandRecoveryStorageHasConflict(storage, subjectId, scopeId)).toBe(true);
    expect(commandRecoveryStorageHasConflict(storage, subjectId, otherScopeId)).toBe(false);
    const conflict = readCommandRecoveryConflict(storage, subjectId, scopeId);
    expect(conflict).toEqual({ kind: "PRESENT", storageKey: quoteKey });
    expect(commandRecoverySnapshotIsBlocked({ kind: "ABSENT" }, conflict)).toBe(true);
    expect(commandRecoverySnapshotIsBlocked({ kind: "ABSENT" }, { kind: "ABSENT" })).toBe(false);
  });

  it("enters the same blocked snapshot when another tab claims a quote before Preview", () => {
    const authoritative = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, new MemoryStorage());
    const secondTab = createSharedCommandRecoveryStorage(authoritative, new MemoryStorage());
    const quoteKey = quoteRecoveryStorageKey(subjectId, "property_green");

    firstTab.setItem(quoteKey, "pending-quote-from-first-tab");

    const conflict = readCommandRecoveryConflict(secondTab, subjectId, scopeId);
    expect(conflict).toEqual({ kind: "PRESENT", storageKey: quoteKey });
    expect(commandRecoverySnapshotIsBlocked({ kind: "ABSENT" }, conflict)).toBe(true);
  });

  it("holds the property recovery lock through the Preview request", async () => {
    const storage = new MemoryStorage();
    const events: string[] = [];
    let releasePreview!: () => void;
    let signalPreviewStarted!: () => void;
    const previewStarted = new Promise<void>((resolve) => { signalPreviewStarted = resolve; });
    const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
    let lockTail = Promise.resolve();
    const lock = async <T,>(storageScope: string, action: () => T | Promise<T>): Promise<T> => {
      expect(storageScope).toBe(propertyRecoveryCoordinationScope(subjectId, "property_green"));
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    };

    const preview = runRecoveryCheckedPreview({
      storage,
      subjectId,
      scopeId,
      lock,
      execute: async () => {
        events.push("preview-started");
        signalPreviewStarted();
        await previewGate;
        events.push("preview-finished");
        return "preview-result";
      }
    });
    await previewStarted;

    const quoteClaim = lock(propertyRecoveryCoordinationScope(subjectId, "property_green"), () => {
      events.push("quote-claimed");
      storage.setItem(quoteRecoveryStorageKey(subjectId, "property_green"), "pending-quote");
    });
    await Promise.resolve();
    expect(events).toEqual(["preview-started"]);

    releasePreview();
    await expect(preview).resolves.toMatchObject({ kind: "EXECUTED", value: "preview-result" });
    await quoteClaim;
    expect(events).toEqual(["preview-started", "preview-finished", "quote-claimed"]);
  });

  it("does not send a Preview when a pending Quote already exists", async () => {
    const storage = new MemoryStorage();
    storage.setItem(quoteRecoveryStorageKey(subjectId, "property_green"), "pending-quote");
    let previewCalls = 0;

    const result = await runRecoveryCheckedPreview({
      storage,
      subjectId,
      scopeId,
      lock: async (_scope, action) => action(),
      execute: async () => {
        previewCalls += 1;
        return "must-not-run";
      }
    });

    expect(result).toMatchObject({ kind: "BLOCKED", conflict: { kind: "PRESENT" } });
    expect(previewCalls).toBe(0);
  });

  it("migrates a legacy session record and keeps the session compatibility mirror", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const serialized = JSON.stringify(recovery);
    compatibility.setItem(key, serialized);

    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "VALID", recovery });
    expect(authoritative.getItem(key)).toBe(serialized);
    expect(compatibility.getItem(key)).toBe(serialized);
  });

  it("synchronizes only the current scope across tabs and propagates controlled deletion", () => {
    const authoritative = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, new MemoryStorage());
    const secondTabSession = new MemoryStorage();
    const secondTab = createSharedCommandRecoveryStorage(authoritative, secondTabSession);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const otherRecovery = { ...recovery, scopeId: otherScopeId, propertyId: "property_other", confirmationKey: "confirm_other" };

    expect(savePersistedCommandRecovery(firstTab, recovery)).toBe(true);
    expect(savePersistedCommandRecovery(firstTab, otherRecovery)).toBe(true);
    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "VALID", recovery });
    expect(secondTabSession.getItem(key)).toBe(JSON.stringify(recovery));

    expect(clearPersistedCommandRecovery(firstTab, subjectId, scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
    expect(secondTabSession.getItem(key)).toBeNull();
    expect(readPersistedCommandRecovery(secondTab, subjectId, otherScopeId)).toEqual({ kind: "VALID", recovery: otherRecovery });
  });

  it("refreshes a stale same-command session mirror from the authoritative cross-tab state", () => {
    const authoritative = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const secondSession = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, firstSession);
    const secondTab = createSharedCommandRecoveryStorage(authoritative, secondSession);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const confirming = { ...recovery, state: "CONFIRMING" as const, updatedAt: "2026-08-03T08:00:00.000Z" };
    const resolved = { ...recovery, state: "EXECUTED" as const, updatedAt: "2026-08-03T08:01:00.000Z" };

    expect(savePersistedCommandRecovery(firstTab, confirming)).toBe(true);
    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: confirming });
    expect(savePersistedCommandRecovery(firstTab, resolved)).toBe(true);

    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: resolved });
    expect(secondSession.getItem(key)).toBe(JSON.stringify(resolved));
  });

  it("still fails closed when the authoritative and session records use distinct confirmation keys", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    expect(savePersistedCommandRecovery(shared, recovery)).toBe(true);
    compatibility.setItem(key, JSON.stringify({ ...recovery, confirmationKey: "confirm_distinct_pending" }));

    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toMatchObject({ kind: "READ_ERROR" });
  });

  it("does not resurrect a cleared shared record from a stale session mirror", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const resolvedRecovery = { ...recovery, state: "EXECUTED" as const, updatedAt: "2026-08-03T08:01:00.000Z" };
    const serialized = JSON.stringify(resolvedRecovery);

    expect(savePersistedCommandRecovery(shared, resolvedRecovery)).toBe(true);
    expect(clearPersistedCommandRecovery(shared, subjectId, scopeId)).toBe(true);
    compatibility.setItem(key, serialized);

    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
    expect(compatibility.getItem(key)).toBeNull();
  });

  it("does not resurrect an older non-terminal mirror for the same confirmation key", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const confirmingRecovery = { ...recovery, state: "CONFIRMING" as const, updatedAt: "2026-08-03T08:00:30.000Z" };
    const resolvedRecovery = { ...recovery, state: "EXECUTED" as const, updatedAt: "2026-08-03T08:01:00.000Z" };

    expect(savePersistedCommandRecovery(shared, resolvedRecovery)).toBe(true);
    expect(clearPersistedCommandRecovery(shared, subjectId, scopeId)).toBe(true);
    compatibility.setItem(key, JSON.stringify(confirmingRecovery));

    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
    expect(compatibility.getItem(key)).toBeNull();
  });

  it("recovers distinct pending records sequentially instead of discarding the second session record", () => {
    const authoritative = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const secondSession = new MemoryStorage();
    const firstTab = createSharedCommandRecoveryStorage(authoritative, firstSession);
    const secondTab = createSharedCommandRecoveryStorage(authoritative, secondSession);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const firstRecovery = { ...recovery, state: "EXECUTED" as const, updatedAt: "2026-08-03T08:01:00.000Z" };
    const secondRecovery = {
      ...recovery,
      confirmationKey: "confirm_second_pending_recovery",
      state: "UNKNOWN" as const,
      updatedAt: "2026-08-03T08:02:00.000Z"
    };

    expect(savePersistedCommandRecovery(firstTab, firstRecovery)).toBe(true);
    secondSession.setItem(key, JSON.stringify(secondRecovery));
    expect(readPersistedCommandRecovery(firstTab, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: firstRecovery });

    expect(clearPersistedCommandRecovery(firstTab, subjectId, scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: secondRecovery });
    expect(authoritative.getItem(key)).toBe(JSON.stringify(secondRecovery));

    expect(clearPersistedCommandRecovery(secondTab, subjectId, scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(secondTab, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
  });

  it("does not conditionally clear a new claim that replaced the reviewed terminal record", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const terminalRecovery = { ...recovery, state: "EXECUTED" as const, updatedAt: "2026-08-03T08:01:00.000Z" };
    const newClaim = {
      ...recovery,
      confirmationKey: "confirm_new_claim",
      state: "CONFIRMING" as const,
      updatedAt: "2026-08-03T08:03:00.000Z"
    };

    expect(savePersistedCommandRecovery(shared, terminalRecovery)).toBe(true);
    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: terminalRecovery });
    expect(savePersistedCommandRecovery(shared, newClaim)).toBe(true);

    expect(clearPersistedCommandRecoveryIfMatches(shared, terminalRecovery)).toBe(false);
    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "VALID", recovery: newClaim });
  });

  it("filters storage events by both authoritative storage and exact subject scope key", () => {
    const authoritative = new MemoryStorage() as unknown as Storage;
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    expect(recoveryStorageEventMatchesScope({ key, storageArea: authoritative }, key, authoritative)).toBe(true);
    expect(recoveryStorageEventMatchesScope({ key: commandRecoveryStorageKey(subjectId, otherScopeId), storageArea: authoritative }, key, authoritative)).toBe(false);
    expect(recoveryStorageEventMatchesScope({ key, storageArea: new MemoryStorage() as unknown as Storage }, key, authoritative)).toBe(false);
  });

  it("matches same-document recovery synchronization for ordinary and quote recovery keys only", () => {
    const commandKey = commandRecoveryStorageKey(subjectId, scopeId);
    const quoteKey = quoteRecoveryStorageKey(subjectId, "property_green");
    const watched = [commandKey, quoteKey];

    expect(recoveryStorageSyncEventMatchesScope({ detail: { storageKey: quoteKey } }, watched)).toBe(true);
    expect(recoveryStorageSyncEventMatchesScope({ detail: { storageKey: commandKey } }, watched)).toBe(true);
    expect(recoveryStorageSyncEventMatchesScope({ detail: { storageKey: quoteRecoveryStorageKey(subjectId, "property_other") } }, watched)).toBe(false);
    expect(recoveryStorageSyncEventMatchesScope({ detail: { storageKey: quoteKey } }, quoteKey)).toBe(true);
    expect(recoveryStorageSyncEventMatchesScope({ detail: null }, watched)).toBe(false);
  });

  it("mirrors a damaged remote record without clearing it automatically", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    authoritative.setItem(key, "{damaged-json");

    expect(readPersistedCommandRecovery(shared, subjectId, scopeId).kind).toBe("CORRUPT");
    expect(authoritative.getItem(key)).toBe("{damaged-json");
    expect(compatibility.getItem(key)).toBe("{damaged-json");
  });

  it("classifies a damaged coordination marker as controlled corruption and can clear it after review", () => {
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const shared = createSharedCommandRecoveryStorage(authoritative, compatibility);
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    expect(savePersistedCommandRecovery(shared, recovery)).toBe(true);
    authoritative.setItem(sharedRecoveryMarkerKey(key), "damaged-marker");

    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toMatchObject({ kind: "CORRUPT" });
    expect(clearCorruptPersistedCommandRecovery(shared, subjectId, scopeId)).toBe(true);
    expect(readPersistedCommandRecovery(shared, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
  });

  it("fails closed when the recovery payload property differs from its storage scope", () => {
    const storage = new MemoryStorage();
    const mismatched = { ...recovery, propertyId: "property_other" };
    storage.setItem(commandRecoveryStorageKey(subjectId, scopeId), JSON.stringify(mismatched));

    expect(readPersistedCommandRecovery(storage, subjectId, scopeId)).toMatchObject({ kind: "CORRUPT" });
    expect(savePersistedCommandRecovery(storage, mismatched)).toBe(false);
  });

  it("treats unusable confirmation keys and unsupported target references as corrupt", () => {
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    for (const damaged of [
      { ...recovery, confirmationKey: "   " },
      { ...recovery, confirmationKey: "x".repeat(161) },
      { ...recovery, targetRefs: ["propertyId=property_other", "orderId=order_other"] },
      { ...recovery, targetRefs: ["orderId=order_one", "orderId=order_two"] }
    ]) {
      storage.setItem(key, JSON.stringify(damaged));
      expect(readPersistedCommandRecovery(storage, subjectId, scopeId)).toMatchObject({ kind: "CORRUPT" });
    }
  });

  it("keeps the scoped property authoritative while restoring validated target identities", () => {
    const persisted = {
      ...recovery,
      commandType: "CANCEL_ORDER" as const,
      presentation: "ORDER_LIFECYCLE" as const,
      effectHash: "a".repeat(64),
      targetRefs: ["orderId=order_green", "memberId=member_green"]
    };
    expect(recoveryCommandRequest(persisted).input).toEqual({
      orderId: "order_green",
      memberId: "member_green",
      propertyId: "property_green"
    });
  });
});

describe("operator-facing business errors", () => {
  it("does not misreport an inventory conflict as a generic state change", () => {
    expect(businessErrorMessage(new ApiError(409, {
      code: "INVENTORY_CONFLICT",
      message: "Destination inventory is unavailable",
      correlationId: "correlation_inventory_conflict"
    }))).toBe("所选房源在目标日期区间已有占用，请重新选择房源或日期。");
    expect(businessErrorMessage(new ApiError(409, {
      code: "INVENTORY_CONFLICT",
      message: "目标房源在所选换房日期内已有占用，请选择其他房源。",
      correlationId: "correlation_inventory_conflict_cn"
    }))).toBe("目标房源在所选换房日期内已有占用，请选择其他房源。");
  });

  it("describes refund amount limits instead of a generic state change", () => {
    expect(businessErrorMessage(new ApiError(409, {
      code: "REFUND_LIMIT_EXCEEDED",
      message: "Refund exceeds the remaining referenced collection",
      correlationId: "correlation_refund_limit"
    }))).toBe("退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。");
    expect(businessErrorMessage(new ApiError(409, {
      code: "PREVIEW_STALE",
      message: "Preview basis changed; request a new preview",
      correlationId: "correlation_refund_limit_preview_stale",
      details: { causeCode: "REFUND_LIMIT_EXCEEDED" }
    }))).toBe("退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。");
  });
});

describe("stay collection upgrade membership presentation", () => {
  const conversionEffect = {
    operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    primaryOccupant: { fullName: "住宿转会员-stage13-0完整姓名" },
    member: { memberId: "member_conversion", fullName: "住宿转会员匹配会员" },
    product: { name: "公卫单人间会员" },
    transfer: {
      total: { currency: "CNY", minorUnits: 59_000 },
      collections: [{
        factId: "fact_source",
        amount: { currency: "CNY", minorUnits: 59_000 },
        transactionReference: "WX-STAGE13-SOURCE"
      }]
    },
    membershipPricing: {
      listedPrice: { currency: "CNY", minorUnits: 162_000 },
      agreedPrice: { currency: "CNY", minorUnits: 162_000 }
    },
    remainingPayment: {
      amount: { currency: "CNY", minorUnits: 103_000 },
      transactionReference: "WX-STAGE13-REMAINING"
    },
    entitlement: {
      entitlementUnitKind: "ROOM_NIGHT",
      consumedUnits: 7,
      remainingUnits: 23,
      serviceDates: ["2026-07-26", "2026-08-01"]
    },
    pricing: {
      coverageSet: [],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 0 },
      currentContractAmount: { currency: "CNY", minorUnits: 0 }
    }
  };

  it("shows source collection detail on the upgrade-member review page", () => {
    const preview: PreviewDto = {
      previewId: "preview_conversion",
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      effectHash: "a".repeat(64),
      effect: conversionEffect,
      expiresAt: "2026-08-02T00:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    }));
    expect(html).toContain("住宿收款明细");
    expect(html).toContain("WX-STAGE13-SOURCE");
    expect(html).toContain("¥590.00");
    expect(html).toContain("本次住宿核销");
    expect(html).not.toContain("服务端预览");
    expect(html).not.toContain("命令类型");
  });

  it("summarizes the committed upgrade-member receipt with a member-order link", () => {
    const receipt: ReceiptDto = {
      receiptId: "receipt_conversion",
      commandId: "command_conversion",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_conversion",
      result: {
        orderId: "order_conversion",
        memberId: "member_conversion",
        membershipOrderId: "membership_order_conversion",
        transferredAmount: { currency: "CNY", minorUnits: 59_000 },
        membershipAgreedPrice: { currency: "CNY", minorUnits: 162_000 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 103_000 },
        entitlementUnitKind: "ROOM_NIGHT",
        convertedUnits: 7,
        remainingUnits: 23
      },
      resourceRefs: ["order_conversion", "membership_order_conversion"],
      factRefs: [],
      committedAt: "2026-08-02T00:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReceiptPanel, {
      receipt,
      businessCommand: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    })));
    expect(html).toContain("升级会员已完成");
    expect(html).toContain("用于升级的住宿收款");
    expect(html).toContain("¥590.00");
    expect(html).toContain("差额企微收款");
    expect(html).toContain("¥1,030.00");
    expect(html).toContain("本次住宿核销");
    expect(html).toContain("7 间夜");
    expect(html).toContain("查看会员订单");
    expect(html).not.toContain("操作已完成");
    expect(html).not.toContain("业务结果已经记录");
  });
});

describe("Token command presentation", () => {
  it("shows an operator-facing issue Token summary without the one-time secret", () => {
    const preview: PreviewDto = {
      previewId: "preview_token",
      commandType: "ISSUE_TOKEN",
      effectHash: "b".repeat(64),
      effect: {
        subjectId: "subject_agent",
        label: "外部客户端",
        accessCeiling: "READ",
        expiresAt: "2026-11-01T08:37:00.000Z"
      },
      expiresAt: "2026-08-03T08:49:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "ISSUE_TOKEN",
      commandInput: {
        propertyId: "prop_qintopia_demo",
        subjectId: "subject_agent",
        label: "外部客户端",
        accessCeiling: "READ",
        expiresAt: "2026-11-01T08:37:00.000Z",
        tokenSecret: "qtp_must_not_render"
      }
    }));

    expect(html).toContain("请核对签发 Token");
    expect(html).toContain("Token 标签");
    expect(html).toContain("只读");
    expect(html).not.toContain("qtp_must_not_render");
    expect(html).not.toContain("Preview");
    expect(html).not.toContain("命令类型");
    expect(html).not.toContain("原因代码");
  });

  it("summarizes a committed Token receipt in business copy", () => {
    const receipt: ReceiptDto = {
      receiptId: "receipt_token",
      commandId: "command_token",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_token",
      result: { tokenId: "token_external" },
      resourceRefs: ["token_external"],
      factRefs: [],
      committedAt: "2026-08-03T08:50:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt,
      businessCommand: "REVOKE_TOKEN"
    }));

    expect(html).toContain("撤销 Token 已完成");
    expect(html).toContain("外围客户端不能再使用它访问系统");
    expect(html).not.toContain("Receipt");
    expect(html).not.toContain("Confirm");
  });
});

describe("stay collection upgrade membership evidence", () => {
  const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
  const effectHash = "a".repeat(64);
  const input = {
    propertyId: "property_green",
    orderId: "order_conversion_evidence",
    memberId: "member_conversion_evidence",
    membershipProductId: "membership_product_single_v1",
    collectionFactIds: ["collection_source_first", "collection_source_second"],
    agreedPriceMinor: 162_000,
    priceAdjustmentReason: "会员升级优惠",
    remainingPaymentTransactionReference: "WX-CONVERSION-REMAINING",
    remainingPaymentNote: "补齐会员差额"
  };
  const previewEffect = {
    operation: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    orderId: input.orderId,
    stayId: "stay_conversion_evidence",
    primaryOccupant: {
      fullName: "住宿转会员住客",
      nickname: "住宿转会员住客",
      identityCardNumber: "STAGE15-CONVERSION-ID-001"
    },
    member: {
      memberId: input.memberId,
      fullName: "住宿转会员会员",
      identityCardNumber: "stage15-conversion-id-001"
    },
    product: {
      productId: input.membershipProductId,
      code: "SHARED_BATH_SINGLE",
      version: 1,
      name: "公卫单人间会员",
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      allowedRoomTypeCode: "SHARED_BATH_SINGLE",
      allowedInventoryKind: "ROOM"
    },
    transfer: {
      collections: [
        {
          factId: input.collectionFactIds[0],
          amount: money(34_000),
          transactionReference: "WX-CONVERSION-SOURCE-ONE",
          recordedAt: "2026-08-01T08:00:00.000Z"
        },
        {
          factId: input.collectionFactIds[1],
          amount: money(25_000),
          transactionReference: "WX-CONVERSION-SOURCE-TWO",
          recordedAt: "2026-08-01T09:00:00.000Z"
        }
      ],
      total: money(59_000)
    },
    membershipPricing: {
      listedPrice: money(180_000),
      agreedPrice: money(input.agreedPriceMinor),
      adjustment: money(-18_000),
      adjustmentReason: input.priceAdjustmentReason
    },
    remainingPayment: {
      amount: money(103_000),
      transactionReference: input.remainingPaymentTransactionReference,
      note: input.remainingPaymentNote
    },
    entitlement: {
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      consumedUnits: 7,
      remainingUnits: 23,
      serviceDates: ["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"],
      validFrom: "2026-08-02",
      validUntil: "2026-09-01"
    },
    before: {
      currentContractAmount: money(59_000),
      netRecordedCollection: money(59_000)
    },
    pricingDecision: {
      pricingBasis: "MEMBER_ENTITLEMENT",
      policyBaseAmount: money(0),
      targetCurrentContractAmount: money(0),
      differenceFromPolicy: money(0),
      manualAdjustmentMinor: 0,
      differenceExceedsThreshold: false,
      reason: {
        code: "STAY_COLLECTION_TO_MEMBERSHIP",
        note: "升级会员，住宿金额归零"
      }
    },
    pricing: {
      coverageSet: [],
      cashLines: [],
      cashRemainder: money(0),
      currentContractAmount: money(0)
    }
  };
  const conversionResult = {
    orderId: input.orderId,
    memberId: input.memberId,
    amendmentId: "amendment_conversion_evidence",
    pricingRevisionId: "revision_conversion_evidence",
    membershipOrderId: "membership_order_conversion_evidence",
    status: "ACTIVE",
    contractId: "membership_contract_conversion_evidence",
    entitlementLotId: "entitlement_lot_conversion_evidence",
    transferredCollectionFactIds: input.collectionFactIds,
    lodgingReversalFactIds: ["lodging_reversal_first", "lodging_reversal_second"],
    membershipPaymentFactIds: ["membership_payment_first", "membership_payment_second", "membership_payment_remaining"],
    transferIds: ["transfer_first", "transfer_second"],
    conversionLedgerFactIds: ["ledger_1", "ledger_2", "ledger_3", "ledger_4", "ledger_5", "ledger_6", "ledger_7"],
    transferredAmount: money(59_000),
    membershipAgreedPrice: money(162_000),
    remainingPaymentAmount: money(103_000),
    entitlementUnitKind: "ROOM_NIGHT",
    convertedUnits: 7,
    remainingUnits: 23,
    effectHash
  };
  const receipt = {
    receiptId: "receipt_conversion_evidence",
    commandId: "command_conversion_evidence",
    executionStatus: "EXECUTED" as const,
    businessCommitted: true,
    correlationId: "correlation_conversion_evidence",
    result: conversionResult,
    resourceRefs: [
      conversionResult.orderId,
      conversionResult.amendmentId,
      conversionResult.pricingRevisionId,
      conversionResult.membershipOrderId,
      conversionResult.contractId,
      conversionResult.entitlementLotId,
      ...conversionResult.transferIds
    ],
    factRefs: [
      ...conversionResult.lodgingReversalFactIds,
      ...conversionResult.membershipPaymentFactIds,
      ...conversionResult.conversionLedgerFactIds
    ],
    committedAt: "2026-08-02T10:00:00.000Z"
  };

  it("accepts only coherent Preview and committed Receipt evidence through both command-shell entry points", () => {
    expect(conversionPreviewHasEvidence(previewEffect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", previewEffect, input)).toBe(true);
    expect(conversionReceiptHasEvidence(receipt, input, previewEffect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence(
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      receipt,
      input,
      previewEffect,
      effectHash
    )).toBe(true);
  });

  it("recovers a committed upgrade using only the persisted Preview effect hash", () => {
    const subjectId = "subject_conversion_recovery";
    const scopeId = "property:property_green";
    const transition = transitionPersistedCommandRecovery(undefined, {
      subjectId,
      scopeId,
      request: {
        commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
        title: "升级会员",
        description: "核对升级会员结果",
        input
      }
    }, {
      state: "CONFIRMING",
      previewId: "preview_conversion_recovery",
      confirmationKey: "confirm_conversion_recovery",
      effectHash
    }, "2026-08-03T08:00:00.000Z");
    if (!transition.recovery) throw new Error("Expected conversion recovery evidence");

    expect(transition.accepted).toBe(true);
    expect(transition.recovery.effectHash).toBe(effectHash);
    const recoveryRequest = recoveryCommandRequest(transition.recovery);
    expect(recoveryRequest).toMatchObject({
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      recoveryEffectHash: effectHash,
      input: {
        propertyId: input.propertyId,
        orderId: input.orderId,
        memberId: input.memberId
      }
    });
    expect(conversionReceiptHasEvidence(
      receipt,
      recoveryRequest.input,
      undefined,
      effectHash
    )).toBe(true);
    expect(conversionReceiptHasEvidence(
      receipt,
      recoveryRequest.input,
      undefined
    )).toBe(false);
    expect(conversionReceiptHasEvidence(
      receipt,
      { ...recoveryRequest.input, orderId: "order_other" },
      undefined,
      effectHash
    )).toBe(false);
    expect(conversionReceiptHasEvidence(
      receipt,
      { ...recoveryRequest.input, memberId: "member_other" },
      undefined,
      effectHash
    )).toBe(false);

    const storage = new MemoryStorage();
    expect(savePersistedCommandRecovery(storage, transition.recovery)).toBe(true);
    expect(readPersistedCommandRecovery(storage, subjectId, scopeId)).toEqual({
      kind: "VALID",
      recovery: transition.recovery
    });
    const { effectHash: _effectHash, ...missingEffectHash } = transition.recovery;
    storage.setItem(commandRecoveryStorageKey(subjectId, scopeId), JSON.stringify(missingEffectHash));
    expect(readPersistedCommandRecovery(storage, subjectId, scopeId).kind).toBe("CORRUPT");
  });

  it("fails closed when a Preview changes the target identity, source money, pricing, or entitlement arithmetic", () => {
    const previewMutations = [
      { member: { ...previewEffect.member, memberId: "member_other" } },
      { product: { ...previewEffect.product, productId: "membership_product_other" } },
      { transfer: { ...previewEffect.transfer, collections: [{ ...previewEffect.transfer.collections[0], factId: "collection_other" }, previewEffect.transfer.collections[1]] } },
      { transfer: { ...previewEffect.transfer, total: money(59_001) } },
      { membershipPricing: { ...previewEffect.membershipPricing, agreedPrice: money(162_001) } },
      { remainingPayment: { ...previewEffect.remainingPayment, amount: money(103_001) } },
      { entitlement: { ...previewEffect.entitlement, consumedUnits: 6 } },
      { entitlement: { ...previewEffect.entitlement, remainingUnits: 24 } }
    ];
    for (const mutation of previewMutations) {
      const altered = { ...previewEffect, ...mutation };
      expect(conversionPreviewHasEvidence(altered, input)).toBe(false);
      expect(u1PreviewHasBusinessEvidence("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", altered, input)).toBe(false);
    }
  });

  it("fails closed when a committed Receipt changes the effect, facts, resources, money, or entitlement proof", () => {
    const receiptMutations = [
      { result: { ...conversionResult, memberId: "member_other" } },
      { result: { ...conversionResult, transferredCollectionFactIds: ["collection_other", input.collectionFactIds[1]] } },
      { result: { ...conversionResult, transferredAmount: money(59_001) } },
      { result: { ...conversionResult, membershipAgreedPrice: money(162_001) } },
      { result: { ...conversionResult, remainingPaymentAmount: money(103_001) } },
      { result: { ...conversionResult, convertedUnits: 6 } },
      { result: { ...conversionResult, remainingUnits: 24 } },
      { result: { ...conversionResult, effectHash: "b".repeat(64) } },
      { resourceRefs: receipt.resourceRefs.filter((reference) => reference !== conversionResult.contractId) },
      { factRefs: receipt.factRefs.filter((reference) => reference !== conversionResult.conversionLedgerFactIds[0]) }
    ];
    for (const mutation of receiptMutations) {
      const altered = { ...receipt, ...mutation };
      expect(conversionReceiptHasEvidence(altered, input, previewEffect, effectHash)).toBe(false);
      expect(receiptHasCommandEvidence(
        "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
        altered,
        input,
        previewEffect,
        effectHash
      )).toBe(false);
    }
  });

  it("rejects a Receipt that borrows valid money evidence from a mismatched Preview product", () => {
    const alteredPreview = {
      ...previewEffect,
      product: { ...previewEffect.product, productId: "membership_product_other" }
    };
    expect(conversionReceiptHasEvidence(receipt, input, alteredPreview, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence(
      "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      receipt,
      input,
      alteredPreview,
      effectHash
    )).toBe(false);
  });
});

describe("Fulfillment business presentation", () => {
  it("uses one Chinese lifecycle vocabulary without protocol or enum labels", () => {
    expect(["RESERVED", "PLANNED", "CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "COMPLETED"].map(businessStatusLabel))
      .toEqual(["已预订", "已预订", "在住", "在住", "已退房", "已完成"]);
  });

  it("summarizes current check-in and check-out results without promising a cleaning task", () => {
    expect(fulfillmentReceiptCopy("CHECK_IN", true)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次不涉及会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_IN", true, 2)).toEqual({
      heading: "办理入住已完成",
      description: "住宿状态已更新为在住；本次核销 2 晚已冻结的会员权益。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true)).toEqual({
      heading: "办理退房已完成",
      description: "住宿状态已更新为已退房，后续库存已按当前住宿事实释放。"
    });
    expect(fulfillmentReceiptCopy("CHECK_OUT", true).description).not.toContain("清洁");
    // Historical recovery records still need readable copy after the workflow is disabled.
    expect(fulfillmentReceiptCopy("COMPLETE_CLEANING", true)).toEqual({
      heading: "清洁已完成",
      description: "清洁任务已更新为已完成，住宿历史保持不变。"
    });
    expect(JSON.stringify(fulfillmentReceiptCopy("CHECK_OUT", false))).not.toMatch(/Preview|Confirm|Receipt|Command|CHECKED/);
  });

  it("only accepts the authoritative transition for each fulfillment command", () => {
    expect(fulfillmentTransitionIsExpected("CHECK_IN", {
      fromStatus: "RESERVED", toStatus: "CHECKED_IN",
      businessDate: "2026-07-25", effectiveDate: "2026-07-25", recordingMode: "ON_SCHEDULE"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_IN", {
      fromStatus: "RESERVED", toStatus: "CHECKED_IN",
      businessDate: "2026-07-26", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-26", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(true);
    expect(fulfillmentTransitionIsExpected("COMPLETE_CLEANING", { fromStatus: "PENDING", toStatus: "COMPLETED" })).toBe(true);
    expect(fulfillmentTransitionIsExpected("CHECK_IN", { fromStatus: "RESERVED", toStatus: "CHECKED_OUT" })).toBe(false);
    expect(fulfillmentTransitionIsExpected("CHECK_OUT", {
      fromStatus: "CHECKED_IN", toStatus: "CHECKED_OUT",
      businessDate: "2026-07-24", effectiveDate: "2026-07-25", recordingMode: "LATE_RECORDED"
    })).toBe(false);
  });

  it("explains a late-recorded check-out without treating the record date as the departure date", () => {
    expect(fulfillmentReceiptCopy("CHECK_OUT", true, 0, {
      effectiveDate: "2026-07-25",
      recordedBusinessDate: "2026-07-26",
      recordingMode: "LATE_RECORDED"
    })).toEqual({
      heading: "迟录退房已完成",
      description: "退房按原计划退房日 2026-07-25 生效，于 2026-07-26 营业日迟录；订单金额保持不变，住宿库存已释放。"
    });
  });

  it("uses stable audit notes when an operator leaves a lodging note empty", () => {
    expect(fulfillmentAuditNote("CHECK_IN", { recordingMode: "ON_SCHEDULE" }, "")).toBe("按计划办理入住");
    expect(fulfillmentAuditNote("CHECK_IN", { recordingMode: "LATE_RECORDED" }, "")).toBe("迟录计划入住");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "ON_SCHEDULE" }, "   ")).toBe("按计划办理退房");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "LATE_RECORDED" }, "\n")).toBe("迟录计划退房");
  });

  it("trims and preserves an operator-provided lodging note", () => {
    expect(fulfillmentAuditNote("CHECK_IN", { recordingMode: "ON_SCHEDULE" }, "  已核对证件  ")).toBe("已核对证件");
    expect(fulfillmentAuditNote("CHECK_OUT", { recordingMode: "LATE_RECORDED" }, "  客人昨晚已离店  ")).toBe("客人昨晚已离店");
  });
});

describe("Order lifecycle evidence", () => {
  const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
  const cancelEffect = {
    orderId: "order_cancel",
    fromStatus: "RESERVED",
    toStatus: "CANCELLED",
    inventoryUnitId: "room_101",
    businessDate: "2026-08-01",
    freeStayReason: null,
    freeStayCategoryCode: null,
    currentContractAmount: money(0),
    amounts: {
      currentContractAmount: money(0),
      netRecordedCollection: money(20_000),
      collectionDifference: money(-20_000),
      refundReferenceAmount: money(20_000)
    },
    entitlementTransition: { from: "HELD", to: "RELEASED", coverageCount: 2 },
    pricingRevision: { currentContractAmount: money(0), pricingBasis: "POLICY" }
  };

  it("accepts only the complete cancel preview and rejects damaged financial or entitlement evidence", () => {
    expect(u1PreviewHasBusinessEvidence("CANCEL_ORDER", cancelEffect, { orderId: "order_cancel" })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("CANCEL_ORDER", {
      ...cancelEffect,
      amounts: { ...cancelEffect.amounts, refundReferenceAmount: money(19_999) }
    }, { orderId: "order_cancel" })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("CANCEL_ORDER", {
      ...cancelEffect,
      entitlementTransition: { ...cancelEffect.entitlementTransition, to: "CONSUMED" }
    }, { orderId: "order_cancel" })).toBe(false);
  });

  it("requires the same-day unused-room acknowledgement for revoke check-in", () => {
    const effect = {
      ...cancelEffect,
      orderId: "order_revoke",
      fromStatus: "CHECKED_IN",
      toStatus: "CHECK_IN_REVOKED",
      effectiveDate: "2026-08-01",
      recordingMode: "ON_SCHEDULE",
      unusedRoomConfirmed: true,
      entitlementTransition: { from: "CONSUMED", to: "RESTORED", coverageCount: 2 }
    };
    delete (effect as Partial<typeof cancelEffect>).freeStayReason;
    delete (effect as Partial<typeof cancelEffect>).freeStayCategoryCode;
    expect(u1PreviewHasBusinessEvidence("REVOKE_CHECK_IN", effect, {
      orderId: "order_revoke", unusedRoomConfirmed: true
    })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("REVOKE_CHECK_IN", effect, {
      orderId: "order_revoke", unusedRoomConfirmed: false
    })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REVOKE_CHECK_IN", { ...effect, effectiveDate: "2026-07-31" }, {
      orderId: "order_revoke", unusedRoomConfirmed: true
    })).toBe(false);
  });

  it("fails closed for a committed lifecycle receipt without complete linked evidence", () => {
    const result = {
      orderId: "order_cancel",
      amendmentId: "amendment_cancel",
      status: "CANCELLED",
      pricingRevisionId: "revision_cancel",
      effectHash: "a".repeat(64),
      entitlementTransition: { from: "HELD", to: "RELEASED", coverageCount: 2 }
    };
    const receipt = {
      receiptId: "receipt_cancel",
      commandId: "command_cancel",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_cancel",
      result,
      resourceRefs: ["order_cancel", "amendment_cancel", "revision_cancel"],
      factRefs: [],
      committedAt: "2026-08-01T10:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("CANCEL_ORDER", receipt, { orderId: "order_cancel" }, cancelEffect)).toBe(true);
    expect(receiptHasCommandEvidence("CANCEL_ORDER", {
      ...receipt,
      resourceRefs: ["order_cancel", "amendment_cancel"]
    }, { orderId: "order_cancel" }, cancelEffect)).toBe(false);
    expect(receiptHasCommandEvidence("CANCEL_ORDER", {
      ...receipt,
      result: { ...result, status: "NO_SHOW" }
    }, { orderId: "order_cancel" }, cancelEffect)).toBe(false);
  });
});

describe("Stay-date financial presentation", () => {
  it("does not present an external channel contract as a per-order collection balance", () => {
    expect(stayDateFundsAreOperatorFacing("CTRIP", "CHANNEL_CONTRACT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("CTRIP", "POLICY")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("MEITUAN", "MANUAL_ADJUSTMENT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("YOUMUDAO", "POLICY")).toBe(false);
    expect(stayDateFundsAreOperatorFacing("WECOM", "POLICY")).toBe(true);
    expect(stayDateFundsAreOperatorFacing("WECOM", "MANUAL_ADJUSTMENT")).toBe(true);
    expect(stayDateFundsAreOperatorFacing(undefined, "CHANNEL_CONTRACT")).toBe(false);
    expect(stayDateFundsAreOperatorFacing(null, "MEMBER_ENTITLEMENT")).toBe(true);
    expect(stayDateFundsAreOperatorFacing(null, "FREE")).toBe(true);
  });
});

describe("Receipt transaction reference labels", () => {
  it("distinguishes reversal non-applicability from a historical missing collection or refund reference", () => {
    expect(receiptTransactionReferenceLabel({ factType: "REVERSAL", transactionReference: null })).toBe("不适用");
    expect(receiptTransactionReferenceLabel({ factType: "COLLECTION", transactionReference: null })).toBe("历史未记录");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", transactionReference: "TXN-REFUND-001" })).toBe("TXN-REFUND-001");
    expect(receiptTransactionReferenceLabel({ factType: "REFUND", method: "WECOM", transactionReference: null })).toBe("沿用原收款交易单号");
  });
});

describe("Guest nickname labels", () => {
  it("keeps a recorded nickname and derives an explicit historical compatibility label", () => {
    expect(guestNicknameLabel({ fullName: "Legal Name", nickname: "山风" })).toBe("山风");
    expect(guestNicknameLabel({ fullName: "Legacy Missing" })).toBe("历史未记录");
    expect(guestNicknameLabel({ fullName: "Legacy Null", nickname: null })).toBe("历史未记录");
  });
});

describe("Occupant command summaries", () => {
  it("keeps occupant order and excludes phone and document details from the compact summary", () => {
    const summary = occupantSummaryItems([{
      id: "occupant_primary",
      ordinal: 1,
      role: "PRIMARY",
      nickname: "山风",
      fullName: "主要姓名",
      phone: "13800000000",
      documentNumber: "PRIVATE-DOC"
    }, {
      id: "occupant_additional",
      ordinal: 2,
      role: "ADDITIONAL",
      nickname: "小满",
      fullName: "同行姓名"
    }]);

    expect(summary).toEqual([
      { key: "occupant_primary", roleLabel: "主要联系人", nickname: "山风", fullName: "主要姓名" },
      { key: "occupant_additional", roleLabel: "同行人 1", nickname: "小满", fullName: "同行姓名" }
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/13800000000|PRIVATE-DOC/);
  });

  it("keeps the accepted member-stay receipt copy while adding occupant summaries separately", () => {
    expect(lodgingReceiptCopy(true, true)).toEqual({
      heading: "会员住宿订单已创建",
      description: "住宿日期、库存和会员权益覆盖已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, true)).toEqual({
      heading: "会员住宿订单未创建",
      description: "本次操作没有写入住宿订单或会员权益变动。"
    });
    expect(lodgingReceiptCopy(true, false)).toEqual({
      heading: "住宿订单已创建",
      description: "住宿日期、库存和住宿人名单已按核对结果记录。"
    });
    expect(lodgingReceiptCopy(false, false)).toEqual({
      heading: "住宿订单未创建",
      description: "本次操作没有写入住宿订单。"
    });
  });
});

describe("Committed command projection refresh", () => {
  it("keeps a known committed result terminal when the page refresh callback fails", async () => {
    const committedReceipt = {
      receiptId: "receipt_committed",
      commandId: "command_committed",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_committed",
      result: { maintenanceLockId: "lock_committed" },
      resourceRefs: ["lock_committed"],
      factRefs: [],
      committedAt: "2026-07-27T10:00:00.000Z"
    };
    const notices: Array<{ message: string; receiptId: string }> = [];

    const outcome = await notifyKnownCommittedCommand({
      commandType: "LOCK_MAINTENANCE",
      receipt: committedReceipt,
      onCommitted: () => {
        throw new Error("projection refresh failed");
      },
      onBusinessSuccess: (message, receipt) => notices.push({ message, receiptId: receipt.receiptId })
    });

    expect(outcome).toBe("REFRESH_FAILED");
    expect(notices).toEqual([{
      message: "设置维修锁房已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。",
      receiptId: committedReceipt.receiptId
    }]);
    expect(notices[0]?.message).not.toMatch(/未写入|结果未知|重新提交/);
  });

  it("uses the SHORTEN_STAY Receipt completion mode for every shared success notice", async () => {
    const receipt = {
      receiptId: "receipt_shorten",
      commandId: "command_shorten",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_shorten",
      result: { completionMode: "EARLY_CHECK_OUT" },
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-07-29T10:00:00.000Z"
    };
    const notices: string[] = [];

    expect(knownCommittedCommandMessage("SHORTEN_STAY", receipt, "REFRESHED")).toBe("提前退房已完成，订单、住宿状态和房态已刷新。");
    expect(knownCommittedCommandMessage("SHORTEN_STAY", receipt, "REFRESH_FAILED")).toBe("提前退房已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。");
    expect(knownCommittedCommandMessage("SHORTEN_STAY", { ...receipt, result: { completionMode: "SHORTEN_IN_HOUSE" } }, "REFRESHED")).toBe("住宿已缩短，订单和房态已刷新。");

    await notifyKnownCommittedCommand({
      commandType: "SHORTEN_STAY",
      receipt,
      onCommitted: () => undefined,
      onBusinessSuccess: (message) => notices.push(message)
    });
    expect(notices).toEqual(["提前退房已完成，订单、住宿状态和房态已刷新。"]);
  });
});

describe("U1 confirmation evidence", () => {
  const money = (minorUnits: number) => ({ minorUnits, currency: "CNY" });

  it("fails closed for incomplete maintenance and fulfillment effects", () => {
    expect(u1PreviewHasBusinessEvidence("LOCK_MAINTENANCE", {
      inventoryUnit: { code: "101", name: "四人间" },
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28",
      reason: "维修"
    })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("LOCK_MAINTENANCE", {
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28",
      reason: "维修"
    })).toBe(false);
    const releaseEffect = {
      maintenanceLockId: "maintenance_lock_1",
      inventoryUnitId: "inventory_unit_1",
      arrivalDate: "2026-07-27",
      departureDate: "2026-07-28"
    };
    const releaseInput = { maintenanceLockId: "maintenance_lock_1" };
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", releaseEffect, releaseInput)).toBe(true);
    for (const key of Object.keys(releaseEffect)) {
      expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, [key]: undefined }, releaseInput), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", releaseEffect, { maintenanceLockId: "maintenance_lock_2" })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, departureDate: releaseEffect.arrivalDate }, releaseInput)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RELEASE_MAINTENANCE", { ...releaseEffect, arrivalDate: "2026-02-30" }, releaseInput)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("CHECK_OUT", {
      fromStatus: "CHECKED_IN",
      toStatus: "CHECKED_OUT",
      businessDate: "2026-07-27",
      effectiveDate: "2026-07-27",
      recordingMode: "ON_SCHEDULE"
    })).toBe(true);
    expect(u1PreviewHasBusinessEvidence("CHECK_OUT", {
      fromStatus: "CHECKED_IN",
      toStatus: "CHECKED_OUT"
    })).toBe(false);
  });

  it("requires the authoritative reprice identity, pricing, and amount evidence", () => {
    const effect = {
      orderId: "order_1",
      inventoryUnitId: "inventory_unit_1",
      stayTimeline: [{ serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_1" }],
      before: { currentContractAmount: money(13_000) },
      policyBaseAmount: money(13_000),
      targetCurrentContractAmount: money(11_000),
      manualAdjustmentMinor: -2_000,
      pricing: {
        coverageSet: [],
        cashLines: [{
          lineKind: "NIGHT",
          serviceDate: "2026-07-27",
          inventoryUnitId: "inventory_unit_1",
          description: "单人间住宿",
          amount: money(13_000)
        }],
        cashRemainder: money(13_000),
        currentContractAmount: money(11_000)
      }
    };
    const input = { orderId: "order_1", targetCurrentContractAmountMinor: 11_000 };
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, input)).toBe(true);
    for (const key of Object.keys(effect)) {
      expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, [key]: undefined }, input), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, { ...input, orderId: "order_2" })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", effect, { ...input, targetCurrentContractAmountMinor: 10_900 })).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      pricing: { ...effect.pricing, currentContractAmount: money(10_900) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, targetCurrentContractAmount: { minorUnits: 11_000, currency: "USD" } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, manualAdjustmentMinor: -1_900 }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", { ...effect, stayTimeline: [] }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      stayTimeline: [{ serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_2" }]
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      stayTimeline: [
        { serviceDate: "2026-07-27", inventoryUnitId: "inventory_unit_1" },
        { serviceDate: "2026-07-29", inventoryUnitId: "inventory_unit_1" }
      ]
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      targetCurrentContractAmount: money(11_050)
    }, { ...input, targetCurrentContractAmountMinor: 11_050 })).toBe(false);
    for (const key of Object.keys(effect.pricing)) {
      expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
        ...effect,
        pricing: { ...effect.pricing, [key]: undefined }
      }, input), `pricing.${key}`).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      ...effect,
      pricing: {
        ...effect.pricing,
        cashLines: [{ ...effect.pricing.cashLines[0], serviceDate: "2026-07-28" }]
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("REPRICE_ORDER", {
      pricingDecision: {
        policyBaseAmount: money(13_000),
        targetCurrentContractAmount: money(11_000)
      }
    }, input)).toBe(false);
  });

  it.each(["RESCHEDULE_STAY", "EXTEND_STAY"] as const)("requires coherent %s date, pricing, entitlement, inventory and funds evidence", (commandType) => {
    const beforeArrivalDate = "2026-08-02";
    const beforeDepartureDate = "2026-08-04";
    const afterArrivalDate = commandType === "RESCHEDULE_STAY" ? "2026-08-03" : beforeArrivalDate;
    const afterDepartureDate = "2026-08-05";
    const effect = {
      operation: commandType,
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      before: {
        arrivalDate: beforeArrivalDate,
        departureDate: beforeDepartureDate,
        nights: 2,
        stayTimeline: [
          { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-03", inventoryUnitId: "room_1" }
        ],
        currentContractAmount: money(20_000)
      },
      after: {
        arrivalDate: afterArrivalDate,
        departureDate: afterDepartureDate,
        nights: commandType === "RESCHEDULE_STAY" ? 2 : 3,
        stayTimeline: commandType === "RESCHEDULE_STAY"
          ? [
              { serviceDate: "2026-08-03", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-04", inventoryUnitId: "room_1" }
            ]
          : [
              { serviceDate: "2026-08-02", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-03", inventoryUnitId: "room_1" },
              { serviceDate: "2026-08-04", inventoryUnitId: "room_1" }
            ],
        pricing: {
          coverageSet: [],
          cashLines: [],
          cashRemainder: money(30_000),
          currentContractAmount: money(30_000)
        }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: money(30_000),
        targetCurrentContractAmount: money(30_000),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "POLICY", note: "" }
      },
      inventoryChange: commandType === "RESCHEDULE_STAY"
        ? { preservedDates: ["2026-08-03"], releasedDates: ["2026-08-02"], addedDates: ["2026-08-04"] }
        : { preservedDates: ["2026-08-02", "2026-08-03"], releasedDates: [], addedDates: ["2026-08-04"] },
      entitlementChange: {
        preservedCoverageDates: [],
        releasedCoverageDates: [],
        addedCoverageDates: [],
        consumedCoverageDates: []
      },
      fundsSummary: {
        netRecordedCollection: money(10_000),
        collectionDifference: money(20_000)
      }
    };
    const input = {
      orderId: "order_1",
      ...(commandType === "RESCHEDULE_STAY" ? { newArrivalDate: afterArrivalDate } : {}),
      newDepartureDate: afterDepartureDate
    };
    expect(u1PreviewHasBusinessEvidence(commandType, effect, input)).toBe(true);
    const preview = {
      previewId: "preview_1",
      commandType,
      effect,
      effectHash: "effect_hash_1",
      expiresAt: "2026-08-01T12:00:00.000Z"
    } as Parameters<typeof stayDatePreviewPricingSummary>[1];
    expect(stayDatePreviewPricingSummary(commandType, preview, input)).toEqual({
      beforeArrivalDate: "2026-08-02",
      beforeDepartureDate: "2026-08-04",
      beforeNights: 2,
      afterArrivalDate: commandType === "RESCHEDULE_STAY" ? "2026-08-03" : "2026-08-02",
      afterDepartureDate: "2026-08-05",
      afterNights: commandType === "RESCHEDULE_STAY" ? 2 : 3,
      afterTimeline: effect.after.stayTimeline,
      beforeAmount: money(20_000),
      policyBaseAmount: money(30_000),
      targetAmount: money(30_000),
      differenceFromPolicy: money(0),
      netRecordedCollection: money(10_000),
      collectionDifference: money(20_000),
      refundReferenceAmount: money(0),
      pricingBasis: "POLICY"
    });
    expect(stayDatePreviewPricingSummary(commandType, { ...preview, effect: { ...effect, fundsSummary: undefined } }, input)).toBeUndefined();
    for (const key of ["before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary"] as const) {
      expect(u1PreviewHasBusinessEvidence(commandType, { ...effect, [key]: undefined }, input), key).toBe(false);
    }
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      fundsSummary: { ...effect.fundsSummary, collectionDifference: money(19_900) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      after: { ...effect.after, nights: 99 }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      pricingDecision: { ...effect.pricingDecision, differenceFromPolicy: money(100) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      inventoryChange: { ...effect.inventoryChange, addedDates: ["2026-08-30"] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...effect,
      after: {
        ...effect.after,
        stayTimeline: effect.after.stayTimeline.map((item, index) => (
          index === effect.after.stayTimeline.length - 1 ? { ...item, inventoryUnitId: "room_2" } : item
        ))
      }
    }, input)).toBe(false);

    const memberCoverageDates = commandType === "RESCHEDULE_STAY"
      ? ["2026-08-03", "2026-08-04"]
      : ["2026-08-02", "2026-08-03", "2026-08-04"];
    const memberEffect = {
      ...effect,
      before: { ...effect.before, currentContractAmount: money(0) },
      after: {
        ...effect.after,
        pricing: {
          ...effect.after.pricing,
          coverageSet: memberCoverageDates.map((serviceDate) => ({
            serviceDate,
            inventoryUnitId: "room_1",
            unitKind: "ROOM_NIGHT",
            entitlementLotId: "lot_1"
          })),
          cashRemainder: money(0),
          currentContractAmount: money(0)
        }
      },
      pricingDecision: {
        ...effect.pricingDecision,
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: money(0),
        targetCurrentContractAmount: money(0),
        differenceFromPolicy: money(0)
      },
      entitlementChange: commandType === "RESCHEDULE_STAY"
        ? {
            preservedCoverageDates: ["2026-08-03"],
            releasedCoverageDates: ["2026-08-02"],
            addedCoverageDates: ["2026-08-04"],
            consumedCoverageDates: []
          }
        : {
            preservedCoverageDates: ["2026-08-02", "2026-08-03"],
            releasedCoverageDates: [],
            addedCoverageDates: ["2026-08-04"],
            consumedCoverageDates: ["2026-08-04"]
          },
      fundsSummary: {
        netRecordedCollection: money(0),
        collectionDifference: money(0)
      }
    };
    expect(u1PreviewHasBusinessEvidence(commandType, memberEffect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, preservedCoverageDates: [] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, addedCoverageDates: [] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: { ...memberEffect.entitlementChange, releasedCoverageDates: ["2026-08-30"] }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      entitlementChange: {
        ...memberEffect.entitlementChange,
        consumedCoverageDates: commandType === "RESCHEDULE_STAY" ? ["2026-08-04"] : []
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence(commandType, {
      ...memberEffect,
      pricingDecision: { ...memberEffect.pricingDecision, pricingBasis: "POLICY" }
    }, input)).toBe(false);
  });

  it("accepts only a complete SHORTEN_STAY effect and trusts its nonnegative refund reference", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_1",
      stayId: "stay_1",
      inventoryUnitId: "room_1",
      businessDate: "2026-08-03",
      completionMode: "EARLY_CHECK_OUT",
      before: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        nights: 4,
        currentContractAmount: money(40_000),
        stayTimeline: ["01", "02", "03", "04"].map((day) => ({ serviceDate: `2026-08-${day}`, inventoryUnitId: "room_1" }))
      },
      after: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03",
        nights: 2,
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_1" }
        ],
        pricing: { coverageSet: [], cashLines: [], cashRemainder: money(20_000), currentContractAmount: money(20_000) }
      },
      pricingDecision: {
        pricingBasis: "POLICY",
        policyBaseAmount: money(20_000),
        targetCurrentContractAmount: money(20_000),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "POLICY", note: "" }
      },
      inventoryChange: { preservedDates: ["2026-08-01", "2026-08-02"], releasedDates: ["2026-08-03", "2026-08-04"], addedDates: [] },
      entitlementSummary: { currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], ledgerWriteCount: 0 },
      fundsSummary: { netRecordedCollection: money(30_000), collectionDifference: money(-10_000), factCount: 2 },
      refundReferenceAmount: money(10_000)
    };
    const input = { orderId: "order_1", newDepartureDate: "2026-08-03" };
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", effect, input)).toBe(true);
    const preview = { previewId: "preview_1", commandType: "SHORTEN_STAY", effect, effectHash: "hash", expiresAt: "2026-08-03T12:00:00.000Z" } as Parameters<typeof stayDatePreviewPricingSummary>[1];
    expect(stayDatePreviewPricingSummary("SHORTEN_STAY", preview, input)?.refundReferenceAmount).toEqual(money(10_000));
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, refundReferenceAmount: money(9_999) }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: undefined }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: "2026-02-30" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, businessDate: "2026-08-02" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      before: { ...effect.before, stayTimeline: undefined }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      after: {
        ...effect.after,
        stayTimeline: effect.after.stayTimeline.map((item) => ({ ...item, inventoryUnitId: "room_forged" }))
      }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, completionMode: "SHORTEN_IN_HOUSE" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, completionMode: "UNKNOWN" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, entitlementSummary: { ...effect.entitlementSummary, ledgerWriteCount: 1 } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", { ...effect, fundsSummary: { ...effect.fundsSummary, factCount: -1 } }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      fundsSummary: {
        netRecordedCollection: money(2_147_503_648),
        collectionDifference: money(-2_147_483_648),
        factCount: 2
      },
      refundReferenceAmount: money(2_147_483_648)
    }, input)).toBe(false);

    const effectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = {
      orderId: "order_1",
      stayId: "stay_1",
      arrangementAmendmentId: "amendment_arrangement",
      checkoutAmendmentId: "amendment_checkout",
      staySegmentId: "segment_2",
      pricingRevisionId: "revision_2",
      completionMode: "EARLY_CHECK_OUT",
      businessDate: "2026-08-03",
      arrivalDate: "2026-08-01",
      departureDate: "2026-08-03",
      before: effect.before,
      after: effect.after,
      pricingDecision: effect.pricingDecision,
      inventoryChange: effect.inventoryChange,
      entitlementSummary: effect.entitlementSummary,
      fundsSummary: effect.fundsSummary,
      refundReferenceAmount: effect.refundReferenceAmount,
      fulfillmentTiming: {
        effectiveDate: "2026-08-03",
        recordedBusinessDate: "2026-08-03",
        recordingMode: "ON_SCHEDULE"
      },
      effectHash
    };
    const receipt = {
      receiptId: "receipt_shorten",
      commandId: "command_shorten",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_shorten",
      result,
      resourceRefs: [
        "order_1", "stay_1", "amendment_arrangement", "amendment_checkout", "segment_2", "revision_2"
      ],
      factRefs: [],
      committedAt: "2026-08-03T10:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("SHORTEN_STAY", receipt, input, effect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", {
      ...receipt,
      result: { ...result, businessDate: undefined }
    }, input, effect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", {
      ...receipt,
      result: { ...result, businessDate: "2026-08-02" }
    }, input, effect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", receipt, input, effect,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });

  it("accepts consumed member coverage that preserves its pre-move inventory fact", () => {
    const effect = {
      operation: "SHORTEN_STAY",
      orderId: "order_member",
      stayId: "stay_member",
      inventoryUnitId: "room_2",
      businessDate: "2026-08-02",
      completionMode: "SHORTEN_IN_HOUSE",
      before: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-05",
        nights: 4,
        currentContractAmount: money(0),
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_2" },
          { serviceDate: "2026-08-03", inventoryUnitId: "room_2" },
          { serviceDate: "2026-08-04", inventoryUnitId: "room_2" }
        ]
      },
      after: {
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03",
        nights: 2,
        stayTimeline: [
          { serviceDate: "2026-08-01", inventoryUnitId: "room_1" },
          { serviceDate: "2026-08-02", inventoryUnitId: "room_2" }
        ],
        pricing: {
          coverageSet: [
            { serviceDate: "2026-08-01", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1" },
            { serviceDate: "2026-08-02", inventoryUnitId: "room_1", unitKind: "ROOM_NIGHT", entitlementLotId: "lot_1" }
          ],
          cashLines: [],
          cashRemainder: money(0),
          currentContractAmount: money(0)
        }
      },
      pricingDecision: {
        pricingBasis: "MEMBER_ENTITLEMENT",
        policyBaseAmount: money(0),
        targetCurrentContractAmount: money(0),
        differenceFromPolicy: money(0),
        manualAdjustmentMinor: 0,
        differenceExceedsThreshold: false,
        reason: { code: "MEMBER_ENTITLEMENT", note: "" }
      },
      inventoryChange: {
        preservedDates: ["2026-08-01", "2026-08-02"],
        releasedDates: ["2026-08-03", "2026-08-04"],
        addedDates: []
      },
      entitlementSummary: {
        currentConsumedCoverageDates: ["2026-08-01", "2026-08-02"],
        retainedHistoricalConsumedCoverageDates: [],
        ledgerWriteCount: 0
      },
      fundsSummary: { netRecordedCollection: money(0), collectionDifference: money(0), factCount: 0 },
      refundReferenceAmount: money(0)
    };
    const input = { orderId: "order_member", newDepartureDate: "2026-08-03" };

    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", effect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      pricingDecision: { ...effect.pricingDecision, pricingBasis: "POLICY" }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", {
      ...effect,
      after: {
        ...effect.after,
        pricing: {
          ...effect.after.pricing,
          coverageSet: effect.after.pricing.coverageSet.map((item) => ({ ...item, serviceDate: "2026-08-30" }))
        }
      }
    }, input)).toBe(false);
  });

  it("rejects contradictory Receipt execution semantics", () => {
    const base = {
      receiptId: "receipt_1",
      commandId: "command_1",
      correlationId: "correlation_1",
      resourceRefs: [],
      factRefs: []
    };
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "EXECUTED", businessCommitted: true })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "NOT_EXECUTED", businessCommitted: false })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "UNKNOWN", businessCommitted: false })).toBe(true);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "NOT_EXECUTED", businessCommitted: true })).toBe(false);
    expect(receiptExecutionSemanticsAreCoherent({ ...base, executionStatus: "EXECUTED", businessCommitted: false })).toBe(false);
  });

  it("does not accept a bare NOT_EXECUTED response as a durable recovered receipt", () => {
    expect(receiptHasCommandEvidence("LOCK_MAINTENANCE", {
      receiptId: "",
      commandId: "",
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      correlationId: "",
      resourceRefs: [],
      factRefs: []
    }, { propertyId: "property_green" })).toBe(false);
  });

  it("recomputes the approved Plan B timeline instead of trusting a self-consistent server mapping", () => {
    const beforeTimeline = [
      { serviceDate: "2026-08-10", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-11", inventoryUnitId: "room_a" },
      { serviceDate: "2026-08-12", inventoryUnitId: "room_b" },
      { serviceDate: "2026-08-13", inventoryUnitId: "room_b" }
    ];

    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-12", "2026-08-16"))
      .toEqual([
        { serviceDate: "2026-08-12", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-13", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-14", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-15", inventoryUnitId: "room_b" }
      ]);
    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-09", "2026-08-15"))
      .toEqual([
        { serviceDate: "2026-08-09", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-10", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-11", inventoryUnitId: "room_a" },
        { serviceDate: "2026-08-12", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-13", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-14", inventoryUnitId: "room_b" }
      ]);
    expect(planBDateChangeTimeline(beforeTimeline, "2026-08-10", "2026-08-14", "2026-08-16", "2026-08-18"))
      .toEqual([
        { serviceDate: "2026-08-16", inventoryUnitId: "room_b" },
        { serviceDate: "2026-08-17", inventoryUnitId: "room_b" }
      ]);
  });

  it("fails closed for committed stay-date Receipts without complete command evidence", () => {
    const malformedReceipt = {
      receiptId: "receipt_date_change",
      commandId: "command_date_change",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_date_change",
      result: {},
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-08-01T10:00:00.000Z"
    };

    expect(receiptHasCommandEvidence("RESCHEDULE_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
    expect(receiptHasCommandEvidence("EXTEND_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", malformedReceipt, { orderId: "order_1" })).toBe(false);
  });
});
