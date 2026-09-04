import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { PreviewDto, ReceiptDto } from "@qintopia/contracts";
import { ApiError } from "./api.ts";
import { administratorMembershipPreviewHasEvidence, businessErrorMessage, businessStatusLabel, clearCorruptPersistedCommandRecovery, clearPersistedCommandRecovery, clearPersistedCommandRecoveryIfMatches, clearTerminalPersistedCommandRecoveryIfPresent, CommandRecoveryBar, commandDialogBusinessErrorMessage, commandPreviewFailureCanReload, commandRecoveryConflictStorageKeys, commandRecoverySnapshotIsBlocked, commandRecoveryStorageHasConflict, commandRecoveryStorageKey, completedStayBackfillPreviewHasEvidence, completedStayBackfillReceiptHasEvidence, conversionPreviewHasEvidence, conversionReceiptHasEvidence, createSharedCommandRecoveryStorage, EffectSummary, formatDateTime, fulfillmentAuditNote, fulfillmentReceiptCopy, fulfillmentTransitionIsExpected, guestNicknameLabel, historicalStayCorrectionPreviewHasEvidence, knownCommittedCommandMessage, lodgingReceiptCopy, notifyKnownCommittedCommand, occupantSummaryItems, planBDateChangeTimeline, propertyRecoveryCoordinationScope, QuoteRecoveryConflictNotice, quoteRecoveryStorageKey, readCommandRecoveryConflict, readPersistedCommandRecovery, ReceiptPanel, receiptExecutionSemanticsAreCoherent, receiptHasCommandEvidence, receiptTransactionReferenceLabel, recoveryCommandRequest, recoveryStorageEventMatchesScope, recoveryStorageSyncEventMatchesScope, runRecoveryCheckedPreview, savePersistedCommandRecovery, sharedRecoveryMarkerKey, stayDateFundsAreOperatorFacing, stayDatePreviewPricingSummary, transitionPersistedCommandRecovery, u1PreviewHasBusinessEvidence } from "./ui.tsx";

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

  it("presents a property Quote conflict with an actionable route back to room status", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(QuoteRecoveryConflictNotice, {
      conflict: { kind: "PRESENT", storageKey: quoteRecoveryStorageKey(subjectId, "property_green") },
      testId: "quote-conflict"
    })));

    expect(html).toContain('data-testid="quote-conflict"');
    expect(html).toContain("报价结果尚未收口");
    expect(html).toContain('href="/"');
    expect(html).toContain("返回房态处理");
    expect(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(QuoteRecoveryConflictNotice, {
      conflict: { kind: "ABSENT" }
    })))).toBe("");
  });

  it("automatically clears only a strictly valid terminal command recovery", () => {
    const storage = new MemoryStorage();
    for (const state of ["EXECUTED", "NOT_EXECUTED"] as const) {
      const terminal = { ...recovery, state };
      expect(savePersistedCommandRecovery(storage, terminal)).toBe(true);
      expect(clearTerminalPersistedCommandRecoveryIfPresent(storage, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
      expect(readPersistedCommandRecovery(storage, subjectId, scopeId)).toEqual({ kind: "ABSENT" });
    }

    expect(savePersistedCommandRecovery(storage, recovery)).toBe(true);
    expect(clearTerminalPersistedCommandRecoveryIfPresent(storage, subjectId, scopeId)).toEqual({
      kind: "VALID",
      recovery
    });
    expect(readPersistedCommandRecovery(storage, subjectId, scopeId)).toEqual({ kind: "VALID", recovery });

    storage.setItem(commandRecoveryStorageKey(subjectId, scopeId), "{\"version\":1");
    expect(clearTerminalPersistedCommandRecoveryIfPresent(storage, subjectId, scopeId)).toMatchObject({ kind: "CORRUPT" });
    expect(storage.getItem(commandRecoveryStorageKey(subjectId, scopeId))).not.toBeNull();
  });

  it("does not delete a new recovery claim that replaces the terminal orphan during cleanup", () => {
    const key = commandRecoveryStorageKey(subjectId, scopeId);
    const terminal = JSON.stringify({ ...recovery, state: "EXECUTED" as const });
    const replacement = JSON.stringify({
      ...recovery,
      confirmationKey: "confirm_replacement",
      updatedAt: "2026-08-03T08:01:00.000Z"
    });
    let reads = 0;
    let removed = false;
    const racingStorage = {
      getItem: (candidate: string) => {
        if (candidate !== key) return null;
        reads += 1;
        return reads === 1 ? terminal : replacement;
      },
      setItem: () => undefined,
      removeItem: () => { removed = true; }
    };

    expect(clearTerminalPersistedCommandRecoveryIfPresent(racingStorage, subjectId, scopeId)).toMatchObject({
      kind: "VALID",
      recovery: { confirmationKey: "confirm_replacement", state: "UNKNOWN" }
    });
    expect(removed).toBe(false);
  });

  it("keeps the property blocked when a Quote recovery remains after terminal command cleanup", () => {
    const storage = new MemoryStorage();
    expect(savePersistedCommandRecovery(storage, { ...recovery, state: "EXECUTED" })).toBe(true);
    storage.setItem(quoteRecoveryStorageKey(subjectId, "property_green"), "pending-quote");

    const commandRead = clearTerminalPersistedCommandRecoveryIfPresent(storage, subjectId, scopeId);
    const conflict = readCommandRecoveryConflict(storage, subjectId, scopeId);
    expect(commandRead).toEqual({ kind: "ABSENT" });
    expect(conflict.kind).toBe("PRESENT");
    expect(commandRecoverySnapshotIsBlocked(commandRead, conflict)).toBe(true);
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
  it("distinguishes a mismatched page origin from a read-only account", () => {
    expect(businessErrorMessage(new ApiError(403, {
      code: "RESOURCE_SCOPE_DENIED",
      message: "Cross-origin session write is not allowed",
      correlationId: "correlation_origin_mismatch"
    }))).toBe("当前页面地址与系统登录地址不一致，本次没有写入。请从系统提供的地址重新打开并登录。");
    expect(businessErrorMessage(new ApiError(403, {
      code: "INSUFFICIENT_ACCESS",
      message: "WRITE access is required",
      correlationId: "correlation_read_only"
    }))).toBe("当前账号无权完成这项操作，本次没有写入。");
  });

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

  it("returns deterministic occupant validation failures to editing instead of retrying the same preview", () => {
    const validationError = new ApiError(400, {
      code: "VALIDATION_ERROR",
      message: "At least one corrected occupant field must change",
      correlationId: "correlation_occupant_validation"
    });
    expect(commandDialogBusinessErrorMessage("CORRECT_ORDER_OCCUPANT", validationError))
      .toBe("住宿人资料未通过校验。请返回修改，并确认至少更正一项资料。");
    expect(commandPreviewFailureCanReload(validationError)).toBe(false);
    expect(commandPreviewFailureCanReload(new ApiError(503, {
      code: "SERVICE_UNAVAILABLE",
      message: "temporarily unavailable",
      correlationId: "correlation_retryable"
    }))).toBe(true);
  });

  it("explains an existing membership in operator language when historical backfill is no longer eligible", () => {
    const conflict = new ApiError(409, {
      code: "ENTITLEMENT_CONFLICT",
      message: "该会员已有未作废会员订单、有效会员链或 legacy ACTIVE 投影，不能使用历史办卡补录",
      correlationId: "correlation_existing_membership_backfill"
    });
    const message = commandDialogBusinessErrorMessage("BACKFILL_HISTORICAL_MEMBERSHIP", conflict);
    expect(message).toBe("系统发现这位会员已有未作废的办卡订单、仍在生效的合同或可用权益。为避免重复生成合同和权益，本次补录没有写入。");
    expect(message).not.toMatch(/legacy|ACTIVE|投影|会员链/i);
    expect(commandPreviewFailureCanReload(conflict)).toBe(false);
  });

  it("uses business labels for membership lifecycle states", () => {
    expect(businessStatusLabel("DRAFT")).toBe("待生效");
    expect(businessStatusLabel("ACTIVE")).toBe("有效");
    expect(businessStatusLabel("EXPIRED")).toBe("已过期");
    expect(businessStatusLabel("VOIDED")).toBe("已作废");
  });
});

describe("membership payment presentation and evidence", () => {
  const money = (minorUnits: number, currency = "CNY") => ({ currency, minorUnits });
  const input = {
    propertyId: "property_green",
    membershipOrderId: "membership_order_underpaid",
    amountMinor: 10_000,
    transactionReference: "WX-MEMBER-PAYMENT-SECOND"
  };
  const effect = {
    operation: "RECORD_MEMBERSHIP_PAYMENT",
    membershipOrderId: input.membershipOrderId,
    memberName: "会员收款核对",
    productName: "公卫四人间会员",
    payment: {
      amount: money(input.amountMinor),
      businessDate: "2026-09-04",
      transactionReference: input.transactionReference,
      note: ""
    },
    totals: {
      agreedPrice: money(93_600),
      previouslyCollected: money(80_000),
      currentCollection: money(input.amountMinor),
      differenceAfter: money(-3_600)
    },
    status: "ACTIVE"
  };

  it("shows one clear collection review for an underpaid active membership", () => {
    const preview: PreviewDto = {
      previewId: "preview_membership_payment",
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      effectHash: "a".repeat(64),
      effect,
      expiresAt: "2026-09-04T10:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "RECORD_MEMBERSHIP_PAYMENT"
    }));

    expect(html).toContain("请核对收款");
    expect(html).toContain("成交价");
    expect(html).toContain("此前实收");
    expect(html).toContain("本次收款");
    expect(html).toContain("收款后差额");
    expect(html).toContain("尚差 ¥36.00");
    expect(html).toContain("2026-09-04");
    expect(html).not.toContain("继续收款");
    expect(html).not.toContain("更正/登记前有效收款");
  });

  it("accepts exact underpaid and overpaid totals but rejects inconsistent payment evidence", () => {
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", effect, input)).toBe(true);

    const overpaidInput = { ...input, amountMinor: 20_000 };
    const overpaid = {
      ...effect,
      payment: { ...effect.payment, amount: money(20_000) },
      totals: {
        ...effect.totals,
        currentCollection: money(20_000),
        differenceAfter: money(6_400)
      }
    };
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", overpaid, overpaidInput)).toBe(true);
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", {
      ...effect,
      totals: { ...effect.totals, differenceAfter: money(-3_599) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", {
      ...effect,
      totals: { ...effect.totals, currentCollection: money(10_000, "USD") }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", {
      ...effect,
      payment: { ...effect.payment, amount: money(9_999) }
    }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("RECORD_MEMBERSHIP_PAYMENT", {
      ...effect,
      unexpected: true
    }, input)).toBe(false);
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

  it("states that a zero-net conversion creates no lodging transfer fact", () => {
    const preview: PreviewDto = {
      previewId: "preview_zero_conversion",
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      effectHash: "b".repeat(64),
      effect: {
        ...conversionEffect,
        transfer: { total: { currency: "CNY", minorUnits: 0 }, collections: [] },
        remainingPayment: {
          amount: { currency: "CNY", minorUnits: 162_000 },
          transactionReference: "WX-STAGE13-ZERO-REMAINING"
        }
      },
      expiresAt: "2026-08-02T00:00:00.000Z"
    };
    const previewHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    }));
    expect(previewHtml).toContain("当前住宿净收款为 ¥0.00");
    expect(previewHtml).toContain("不创建住宿收款转入或 0 元收款事实");
    expect(previewHtml).not.toContain("作为会员订单已收款来源");

    const receipt: ReceiptDto = {
      receiptId: "receipt_zero_conversion",
      commandId: "command_zero_conversion",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_zero_conversion",
      result: {
        orderId: "order_zero_conversion",
        memberId: "member_conversion",
        membershipOrderId: "membership_order_zero_conversion",
        transferredAmount: { currency: "CNY", minorUnits: 0 },
        membershipAgreedPrice: { currency: "CNY", minorUnits: 162_000 },
        remainingPaymentAmount: { currency: "CNY", minorUnits: 162_000 },
        entitlementUnitKind: "ROOM_NIGHT",
        convertedUnits: 7,
        remainingUnits: 23
      },
      resourceRefs: ["order_zero_conversion", "membership_order_zero_conversion"],
      factRefs: [],
      committedAt: "2026-08-02T00:00:00.000Z"
    };
    const receiptHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReceiptPanel, {
      receipt,
      businessCommand: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    })));
    expect(receiptHtml).toContain("住宿净收款为 0，未创建转入事实");
    expect(receiptHtml).not.toContain("住宿收款已转入会员订单");
  });
});

describe("historical stay arrangement correction presentation", () => {
  const input = {
    propertyId: "property_green",
    correctionSet: [{
      orderId: "order_peng",
      expectedVersion: 4,
      target: {
        inventoryUnitId: "unit_108_b",
        arrivalDate: "2026-08-27",
        departureDate: "2026-08-30"
      }
    }],
    evidenceNote: "纸质入住记录和房号安排已复核"
  };
  const effect = {
    operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
    corrections: [{
      orderId: "order_peng",
      stayId: "stay_peng",
      expectedVersion: 4,
      before: {
        inventoryUnitId: "unit_108_a",
        arrivalDate: "2026-08-28",
        departureDate: "2026-08-31",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-08-28", inventoryUnitId: "unit_108_a" },
          { serviceDate: "2026-08-29", inventoryUnitId: "unit_108_a" },
          { serviceDate: "2026-08-30", inventoryUnitId: "unit_108_a" }
        ]
      },
      after: {
        inventoryUnitId: "unit_108_b",
        arrivalDate: "2026-08-27",
        departureDate: "2026-08-30",
        nights: 3,
        stayTimeline: [
          { serviceDate: "2026-08-27", inventoryUnitId: "unit_108_b" },
          { serviceDate: "2026-08-28", inventoryUnitId: "unit_108_b" },
          { serviceDate: "2026-08-29", inventoryUnitId: "unit_108_b" }
        ]
      },
      unchanged: {
        orderStatus: "CHECKED_OUT",
        stayStatus: "COMPLETED",
        stayType: "TRANSIENT",
        currentRevisionId: "revision_peng",
        currentContractAmountMinor: 10_000,
        currency: "CNY",
        occupantCount: 2,
        occupants: [
          { ordinal: 1, role: "PRIMARY", fullName: "鹏哥", nickname: "鹏哥" },
          { ordinal: 2, role: "ADDITIONAL", fullName: "尚鹏", nickname: "小尚" }
        ],
        collectionFactCount: 1,
        netRecordedCollectionMinor: 10_000,
        collectionDifferenceMinor: 0
      }
    }]
  };

  it("accepts only an exact Preview that matches the administrator's correction set", () => {
    expect(historicalStayCorrectionPreviewHasEvidence(effect, input)).toBe(true);

    const mismatchedTarget = structuredClone(effect);
    mismatchedTarget.corrections[0]!.after.departureDate = "2026-08-29";
    expect(historicalStayCorrectionPreviewHasEvidence(mismatchedTarget, input)).toBe(false);

    const inconsistentFunds = structuredClone(effect);
    inconsistentFunds.corrections[0]!.unchanged.collectionDifferenceMinor = 100;
    expect(historicalStayCorrectionPreviewHasEvidence(inconsistentFunds, input)).toBe(false);

    const malformedTimeline = structuredClone(effect);
    malformedTimeline.corrections[0]!.after.stayTimeline[1]!.inventoryUnitId = "unit_108_a";
    expect(historicalStayCorrectionPreviewHasEvidence(malformedTimeline, input)).toBe(false);
  });

  it("shows each order's before and after arrangement plus the facts that remain unchanged", () => {
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_historical_stay",
        commandType: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
        effectHash: "f".repeat(64),
        effect,
        expiresAt: "2026-09-02T09:00:00.000Z"
      },
      businessCommand: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      commandInput: input,
      reasonNote: input.evidenceNote,
      inventoryUnitLabels: { unit_108_a: "108A · 单人间", unit_108_b: "108B · 单人间" },
      historicalStayCorrectionContexts: { order_peng: { guestName: "鹏哥" } }
    }));
    expect(html).toContain("鹏哥");
    expect(html).toContain("小尚（尚鹏）");
    expect(html).toContain("108A · 单人间");
    expect(html).toContain("108B · 单人间");
    expect(html).toContain("2026-08-27");
    expect(html).toContain("住宿人");
    expect(html).toContain("订单金额");
    expect(html).toContain("已有收款");
    expect(html).toContain("保持不变");
    expect(html).not.toContain("order_peng");
    expect(html).not.toContain("stay_peng");
  });

  it("uses a business receipt after the atomic correction commits", () => {
    const html = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: {
        receiptId: "receipt_historical_stay",
        commandId: "command_historical_stay",
        executionStatus: "EXECUTED",
        businessCommitted: true,
        correlationId: "correlation_historical_stay",
        result: { operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS", corrections: [{}] },
        resourceRefs: [],
        factRefs: [],
        committedAt: "2026-09-02T08:00:00.000Z"
      },
      businessCommand: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS"
    }));
    expect(html).toContain("历史住宿安排修改已完成");
    expect(html).toContain("1 笔住宿");
    expect(html).not.toContain("CORRECT_HISTORICAL_STAY_ARRANGEMENTS");
  });

  it("accepts recovery only when the historical target, facts, resources, and effect hash are exact", () => {
    const effectHash = "6".repeat(64);
    const result = {
      operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      correctionSetHash: "7".repeat(64),
      corrections: [{
        orderId: "order_peng",
        stayId: "stay_peng",
        correctionId: "correction_peng",
        amendmentId: "amendment_peng",
        staySegmentId: "segment_peng",
        pricingRevisionId: "revision_new_peng",
        claimIds: ["claim_peng_1", "claim_peng_2", "claim_peng_3"],
        before: effect.corrections[0]!.before,
        after: effect.corrections[0]!.after,
        unchanged: effect.corrections[0]!.unchanged
      }],
      reason: { code: "DATA_ENTRY_CORRECTION", note: "历史安排录入错误" },
      evidenceNote: input.evidenceNote,
      actor: { subjectId: "subject_admin", displayName: "运营管理员" },
      recordedAt: "2026-09-02T08:00:00.000Z",
      effectHash
    };
    const receipt: ReceiptDto = {
      receiptId: "receipt_historical_exact",
      commandId: "command_historical_exact",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_historical_exact",
      result,
      resourceRefs: ["order_peng", "stay_peng", "amendment_peng", "segment_peng", "revision_new_peng", "claim_peng_1", "claim_peng_2", "claim_peng_3"],
      factRefs: ["correction_peng"],
      committedAt: "2026-09-02T08:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("CORRECT_HISTORICAL_STAY_ARRANGEMENTS", receipt, input, effect, effectHash)).toBe(true);
    const attacks: ReceiptDto[] = [
      { ...receipt, result: { ...result, effectHash: undefined } },
      { ...receipt, result: { ...result, effectHash: "8".repeat(64) } },
      { ...receipt, factRefs: [] },
      { ...receipt, resourceRefs: receipt.resourceRefs.slice(1) },
      { ...receipt, result: { ...result, corrections: [{ ...result.corrections[0]!, orderId: "order_other" }] } }
    ];
    for (const attack of attacks) {
      expect(receiptHasCommandEvidence("CORRECT_HISTORICAL_STAY_ARRANGEMENTS", attack, input, effect, effectHash)).toBe(false);
    }
  });
});

describe("administrator membership correction presentation", () => {
  const money = (minorUnits: number) => ({ currency: "CNY", minorUnits });
  const evidenceNote = "已核对纸质合同与企微交易记录";
  const profileInput = {
    propertyId: "property_green",
    memberId: "member_cathy",
    expectedPriorProfile: {
      fullName: "Cathy",
      nickname: "Cathy",
      identityCardNumber: null,
      phone: "13800000000",
      wechat: "cathy-old"
    },
    correctedProfile: {
      fullName: "Cathy Chen",
      nickname: "Cathy",
      identityCardNumber: null,
      phone: "13800000000",
      wechat: "cathy-new"
    },
    evidenceNote
  };
  const profileEffect = {
    operation: "CORRECT_MEMBER_PROFILE",
    memberId: "member_cathy",
    before: profileInput.expectedPriorProfile,
    after: profileInput.correctedProfile,
    changedFields: ["fullName", "wechat"],
    evidenceNote
  };
  const effectiveDateInput = {
    propertyId: "property_green",
    membershipOrderId: "membership_order_cathy",
    actualMembershipDate: "2026-07-15",
    evidenceNote
  };
  const effectiveDateEffect = {
    operation: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
    propertyToday: "2026-09-02",
    memberId: "member_cathy",
    membershipOrderId: "membership_order_cathy",
    contractId: "contract_cathy",
    entitlementLotId: "lot_cathy",
    evidenceNote,
    before: { validFrom: "2026-08-01", validUntil: "2027-08-01", status: "ACTIVE" },
    after: { validFrom: "2026-07-15", validUntil: "2027-07-15", status: "ACTIVE" },
    unchanged: {
      memberId: "member_cathy",
      productName: "公卫四人间会员",
      agreedPrice: money(93_600),
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      usedUnits: 2,
      availableBalance: { ROOM_NIGHT: 28, BED_NIGHT: 0 },
      paymentFactCount: 1,
      lifecycleStatus: "ACTIVE"
    }
  };
  const backfillInput = {
    propertyId: "property_green",
    memberId: "member_jingjing",
    membershipProductId: "product_shared_room",
    actualMembershipDate: "2026-06-20",
    payment: {
      amountMinor: 93_600,
      businessDate: "2026-06-18",
      transactionReference: "WX-JINGJING-20260620",
      note: "历史会员收款"
    },
    evidenceNote
  };
  const backfillEffect = {
    operation: "BACKFILL_HISTORICAL_MEMBERSHIP",
    evidenceNote,
    member: { memberId: "member_jingjing", fullName: "晶晶" },
    product: {
      productId: "product_shared_room",
      code: "MEMBER-SHARED-30",
      version: 1,
      name: "公卫四人间会员",
      listedPrice: money(93_600),
      agreedPrice: money(93_600),
      entitlementUnitKind: "ROOM_NIGHT",
      entitlementUnits: 30,
      validityPeriod: "P1Y",
      allowedRoomTypeCode: "SHARED",
      allowedInventoryKind: "ROOM"
    },
    payment: {
      amount: money(93_600),
      businessDate: "2026-06-18",
      transactionReference: "WX-JINGJING-20260620",
      note: "历史会员收款"
    },
    validFrom: "2026-06-20",
    validUntil: "2027-06-20",
    entitlementUnitKind: "ROOM_NIGHT",
    entitlementUnits: 30,
    status: "ACTIVE"
  };
  const rebuildInput = {
    propertyId: "property_green",
    erroneousMembershipOrderId: "membership_order_wrong",
    sourceStayOrderId: "order_108",
    actualMembershipDate: "2026-08-10",
    replacementDirectPayment: {
      businessDate: "2026-08-12",
      transactionReference: "WX-REPLACEMENT-736"
    },
    evidenceNote
  };
  const rebuildEffect = {
    operation: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
    evidenceNote,
    member: { memberId: "member_cathy", fullName: "Cathy" },
    oldMembership: {
      membershipOrderId: "membership_order_wrong",
      contractId: "contract_wrong",
      entitlementLotId: "lot_wrong",
      productId: "product_shared_room",
      status: "ACTIVE",
      directCollections: [{
        factId: "fact_wrong_collection",
        amount: money(93_600),
        transactionReference: "WX-WRONG-936",
        businessDate: "2026-08-09"
      }]
    },
    sourceStay: {
      orderId: "order_108",
      stayId: "stay_108",
      arrivalDate: "2026-08-10",
      departureDate: "2026-08-12",
      serviceDates: ["2026-08-10", "2026-08-11"],
      identityEvidence: { phoneMatched: true, documentMatched: false }
    },
    funds: {
      oldDirectCollectionTotal: money(93_600),
      oldReversalTotal: money(93_600),
      stayTransferTotal: money(20_000),
      replacementDirectPayment: {
        amount: money(73_600),
        businessDate: "2026-08-12",
        transactionReference: "WX-REPLACEMENT-736"
      },
      membershipAgreedPrice: money(93_600),
      reclassificationOnly: true
    },
    newMembership: {
      productId: "product_shared_room",
      productName: "公卫四人间会员",
      validFrom: "2026-08-10",
      validUntil: "2027-08-10"
    },
    entitlement: {
      unitKind: "ROOM_NIGHT",
      totalUnits: 30,
      consumedUnits: 2,
      remainingUnits: 28,
      serviceDates: ["2026-08-10", "2026-08-11"]
    }
  };

  it("accepts only the four complete, typed Preview evidence shapes", () => {
    expect(administratorMembershipPreviewHasEvidence("CORRECT_MEMBER_PROFILE", profileEffect, profileInput)).toBe(true);
    expect(administratorMembershipPreviewHasEvidence("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", effectiveDateEffect, effectiveDateInput)).toBe(true);
    expect(administratorMembershipPreviewHasEvidence("BACKFILL_HISTORICAL_MEMBERSHIP", backfillEffect, backfillInput)).toBe(true);

    const backfillWithoutOptionalNote = structuredClone(backfillInput);
    delete (backfillWithoutOptionalNote.payment as { note?: string }).note;
    const backfillEffectWithNormalizedEmptyNote = structuredClone(backfillEffect);
    backfillEffectWithNormalizedEmptyNote.payment.note = "";
    expect(administratorMembershipPreviewHasEvidence(
      "BACKFILL_HISTORICAL_MEMBERSHIP",
      backfillEffectWithNormalizedEmptyNote,
      backfillWithoutOptionalNote
    )).toBe(true);
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", rebuildEffect, rebuildInput)).toBe(true);

    const duplicateProfileField = { ...profileEffect, changedFields: ["fullName", "fullName"] };
    expect(administratorMembershipPreviewHasEvidence("CORRECT_MEMBER_PROFILE", duplicateProfileField, profileInput)).toBe(false);

    const missingRecalculatedExpiry = structuredClone(effectiveDateEffect) as Record<string, unknown>;
    delete (missingRecalculatedExpiry.after as Record<string, unknown>).validUntil;
    expect(administratorMembershipPreviewHasEvidence("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", missingRecalculatedExpiry, effectiveDateInput)).toBe(false);

    const invalidBalance = structuredClone(effectiveDateEffect);
    invalidBalance.unchanged.availableBalance.ROOM_NIGHT = -1;
    expect(administratorMembershipPreviewHasEvidence("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", invalidBalance, effectiveDateInput)).toBe(false);

    const missingPayment = structuredClone(backfillEffect) as Record<string, unknown>;
    delete missingPayment.payment;
    expect(administratorMembershipPreviewHasEvidence("BACKFILL_HISTORICAL_MEMBERSHIP", missingPayment, backfillInput)).toBe(false);

    const mismatchedBackfillDate = structuredClone(backfillEffect);
    mismatchedBackfillDate.payment.businessDate = "2026-06-19";
    expect(administratorMembershipPreviewHasEvidence("BACKFILL_HISTORICAL_MEMBERSHIP", mismatchedBackfillDate, backfillInput)).toBe(false);

    for (const paymentAmountMinor of [50_000, 93_600, 100_000]) {
      const paymentInput = structuredClone(backfillInput);
      const paymentEffect = structuredClone(backfillEffect);
      paymentInput.payment.amountMinor = paymentAmountMinor;
      paymentEffect.payment.amount.minorUnits = paymentAmountMinor;
      expect(administratorMembershipPreviewHasEvidence(
        "BACKFILL_HISTORICAL_MEMBERSHIP",
        paymentEffect,
        paymentInput
      )).toBe(true);
    }

    const backfillWithAdministratorPrice = structuredClone(backfillEffect);
    backfillWithAdministratorPrice.product.agreedPrice.minorUnits = 50_000;
    backfillWithAdministratorPrice.payment.amount.minorUnits = 50_000;
    expect(administratorMembershipPreviewHasEvidence(
      "BACKFILL_HISTORICAL_MEMBERSHIP",
      backfillWithAdministratorPrice,
      { ...backfillInput, payment: { ...backfillInput.payment, amountMinor: 50_000 } }
    )).toBe(false);

    const refundLikeRebuild = structuredClone(rebuildEffect);
    refundLikeRebuild.funds.reclassificationOnly = false;
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", refundLikeRebuild, rebuildInput)).toBe(false);

    const legacyFlatReplacementPayment = structuredClone(rebuildEffect);
    (legacyFlatReplacementPayment.funds as Record<string, unknown>).replacementDirectPayment = money(73_600);
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", legacyFlatReplacementPayment, rebuildInput)).toBe(false);

    const mismatchedReplacementDate = structuredClone(rebuildEffect);
    mismatchedReplacementDate.funds.replacementDirectPayment.businessDate = "2026-08-13";
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", mismatchedReplacementDate, rebuildInput)).toBe(false);

    const mismatchedReplacementReference = structuredClone(rebuildEffect);
    mismatchedReplacementReference.funds.replacementDirectPayment.transactionReference = "WX-REPLACEMENT-OTHER";
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", mismatchedReplacementReference, rebuildInput)).toBe(false);

    const mismatchedReplacementAmount = structuredClone(rebuildEffect);
    mismatchedReplacementAmount.funds.replacementDirectPayment.amount.minorUnits = 73_700;
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", mismatchedReplacementAmount, rebuildInput)).toBe(false);

    const inconsistentRebuild = structuredClone(rebuildEffect);
    inconsistentRebuild.entitlement.remainingUnits = 27;
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", inconsistentRebuild, rebuildInput)).toBe(false);

    const missingHistoricalNight = structuredClone(rebuildEffect);
    missingHistoricalNight.sourceStay.serviceDates = ["2026-08-10"];
    missingHistoricalNight.entitlement.serviceDates = ["2026-08-10"];
    missingHistoricalNight.entitlement.consumedUnits = 1;
    missingHistoricalNight.entitlement.remainingUnits = 29;
    expect(administratorMembershipPreviewHasEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", missingHistoricalNight, rebuildInput)).toBe(false);
  });

  it("separates administrator facts from system-calculated dates, funds, and entitlements", () => {
    const dateHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_effective_date",
        commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
        effectHash: "d".repeat(64),
        effect: effectiveDateEffect,
        expiresAt: "2026-09-02T09:00:00.000Z"
      },
      businessCommand: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      commandInput: effectiveDateInput
    }));
    expect(dateHtml).toContain("主管核实的事实");
    expect(dateHtml).toContain("系统重新计算");
    expect(dateHtml).toContain("历史已核销");
    expect(dateHtml).toContain("2 间夜");
    expect(dateHtml).toContain("当前剩余权益");
    expect(dateHtml).toContain("28 间夜");
    expect(dateHtml).toContain("保持不变");

    const backfillHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_backfill",
        commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
        effectHash: "f".repeat(64),
        effect: backfillEffect,
        expiresAt: "2026-09-02T09:00:00.000Z"
      },
      businessCommand: "BACKFILL_HISTORICAL_MEMBERSHIP",
      commandInput: backfillInput
    }));
    expect(backfillHtml).toContain("你核实的办卡与收款信息");
    expect(backfillHtml).toContain("企业微信实收");
    expect(backfillHtml).toContain("¥936.00");
    expect(backfillHtml).toContain("企业微信收款日期");
    expect(backfillHtml).toContain("2026-06-18");
    expect(backfillHtml).toContain("企微交易单号");
    expect(backfillHtml).toContain("WX-JINGJING-20260620");
    expect(backfillHtml).toContain("实收与办卡价格差额");
    expect(backfillHtml).toContain("无差额");
    expect(backfillHtml).toContain("有效期规则");
    expect(backfillHtml).toContain("1 年");
    expect(backfillHtml).toContain("系统只提示差额，不会自动改价");
    expect(backfillHtml).not.toMatch(/主管核实的历史事实|系统创建与计算|历史成交价|收款事实|原子|legacy|ACTIVE|投影|会员链/i);

    const underpaidBackfillEffect = structuredClone(backfillEffect);
    underpaidBackfillEffect.payment.amount.minorUnits = 50_000;
    const underpaidBackfillHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_underpaid_backfill",
        commandType: "BACKFILL_HISTORICAL_MEMBERSHIP",
        effectHash: "b".repeat(64),
        effect: underpaidBackfillEffect,
        expiresAt: "2026-09-02T09:00:00.000Z"
      },
      businessCommand: "BACKFILL_HISTORICAL_MEMBERSHIP",
      commandInput: { ...backfillInput, payment: { ...backfillInput.payment, amountMinor: 50_000 } }
    }));
    expect(underpaidBackfillHtml).toContain("收款比成交价少");
    expect(underpaidBackfillHtml).toContain("¥436.00");

    const rebuildHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview: {
        previewId: "preview_rebuild",
        commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
        effectHash: "e".repeat(64),
        effect: rebuildEffect,
        expiresAt: "2026-09-02T09:00:00.000Z"
      },
      businessCommand: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
      commandInput: rebuildInput
    }));
    expect(rebuildHtml).toContain("这不是退款");
    expect(rebuildHtml).toContain("不会向会员退回实际资金");
    expect(rebuildHtml).toContain("历史住宿核销");
    expect(rebuildHtml).toContain("剩余权益");
    expect(rebuildHtml).toContain("会员档案");
    expect(rebuildHtml).toContain("保持不变");
    expect(rebuildHtml).toContain("真实会员差额收款");
    expect(rebuildHtml).toContain("¥736.00");
    expect(rebuildHtml).toContain("原错误收款明细");
    expect(rebuildHtml).toContain("WX-WRONG-936");
    expect(rebuildHtml).toContain("2026-08-09");
    expect(rebuildHtml).toContain("企业微信差额收款日期");
    expect(rebuildHtml).toContain("2026-08-12");
    expect(rebuildHtml).toContain("差额企微交易单号");
    expect(rebuildHtml).toContain("WX-REPLACEMENT-736");
  });

  it("renders replayable historical-stay, membership-backfill, and void-rebuild Receipt results without inventing omitted details", () => {
    const historicalReceipt: ReceiptDto = {
      receiptId: "receipt_historical_stay",
      commandId: "command_historical_stay",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_historical_stay",
      result: {
        operation: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
        correctionSetHash: "a".repeat(64),
        reason: { code: "HISTORICAL_ARRANGEMENT_CORRECTION", note: "复核了原始入住登记" },
        evidenceNote: "已核对纸质登记与房态记录",
        actor: { subjectId: "subject_manager", displayName: "值班主管" },
        recordedAt: "2026-09-02T09:00:00.000Z",
        corrections: [{
          orderId: "order_108",
          stayId: "stay_108",
          correctionId: "fact_historical_108",
          amendmentId: "amendment_historical_108",
          staySegmentId: "segment_historical_108",
          pricingRevisionId: "revision_historical_108",
          claimIds: ["claim_historical_108"],
          before: {
            inventoryUnitId: "unit_d01",
            arrivalDate: "2026-08-01",
            departureDate: "2026-08-03",
            nights: 2,
            stayTimeline: [
              { serviceDate: "2026-08-01", inventoryUnitId: "unit_d01" },
              { serviceDate: "2026-08-02", inventoryUnitId: "unit_d01" }
            ]
          },
          after: {
            inventoryUnitId: "unit_d02",
            arrivalDate: "2026-08-02",
            departureDate: "2026-08-04",
            nights: 2,
            stayTimeline: [
              { serviceDate: "2026-08-02", inventoryUnitId: "unit_d02" },
              { serviceDate: "2026-08-03", inventoryUnitId: "unit_d02" }
            ]
          },
          unchanged: {
            orderStatus: "CHECKED_OUT",
            stayStatus: "COMPLETED",
            stayType: "TRANSIENT",
            currentRevisionId: "revision_prior_108",
            currentContractAmountMinor: 69_600,
            currency: "CNY",
            occupantCount: 2,
            occupants: [
              { ordinal: 1, role: "PRIMARY", fullName: "鹏哥", nickname: "鹏哥" },
              { ordinal: 2, role: "ADDITIONAL", fullName: "尚鹏", nickname: "小尚" }
            ],
            collectionFactCount: 1,
            netRecordedCollectionMinor: 20_000,
            collectionDifferenceMinor: 49_600
          }
        }]
      },
      resourceRefs: ["order_108", "stay_108", "amendment_historical_108", "segment_historical_108", "revision_historical_108"],
      factRefs: ["fact_historical_108"],
      committedAt: "2026-09-02T09:00:00.000Z"
    };
    const historicalHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: historicalReceipt,
      businessCommand: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS"
    }));
    expect(historicalHtml).toContain("第 1 笔住宿");
    expect(historicalHtml).toContain("修改前安排");
    expect(historicalHtml).toContain("修改后安排");
    expect(historicalHtml).toContain("鹏哥、小尚（尚鹏）");
    for (const internalId of ["order_108", "revision_prior_108"]) {
      expect(historicalHtml).not.toContain(internalId);
    }
    expect(historicalHtml).toContain("修改前房源编号");
    expect(historicalHtml).toContain("unit_d01");
    expect(historicalHtml).toContain("修改后房源编号");
    expect(historicalHtml).toContain("unit_d02");
    expect(historicalHtml).toContain("amendment_historical_108");
    expect(historicalHtml).toContain("segment_historical_108");
    expect(historicalHtml).toContain("revision_historical_108");
    expect(historicalHtml).toContain("住宿人");
    expect(historicalHtml).toContain("订单金额");
    expect(historicalHtml).toContain("已记录净收款");
    expect(historicalHtml).toContain("复核了原始入住登记");
    expect(historicalHtml).toContain("已核对纸质登记与房态记录");
    expect(historicalHtml).toContain("值班主管");
    expect(historicalHtml).toContain(formatDateTime("2026-09-02T09:00:00.000Z"));

    const backfillReceipt: ReceiptDto = {
      receiptId: "receipt_membership_backfill_detail",
      commandId: "command_membership_backfill_detail",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_membership_backfill_detail",
      result: {
        memberId: "member_jingjing",
        membershipOrderId: "membership_order_backfilled",
        paymentFactId: "membership_payment_backfilled",
        contractId: "contract_backfilled",
        entitlementLotId: "lot_backfilled",
        backfillId: "fact_backfilled",
        status: "ACTIVE",
        validFrom: "2026-06-20",
        validUntil: "2027-06-20",
        entitlementUnitKind: "ROOM_NIGHT",
        entitlementUnits: 30,
        member: backfillEffect.member,
        product: backfillEffect.product,
        payment: { ...backfillEffect.payment, amount: money(50_000) },
        reason: { code: "HISTORICAL_MEMBERSHIP_BACKFILL", note: "补录真实历史办卡" },
        evidenceNote,
        actor: { subjectId: "subject_manager", displayName: "值班主管" },
        recordedAt: "2026-09-02T09:03:00.000Z"
      },
      resourceRefs: ["member_jingjing", "membership_order_backfilled", "contract_backfilled", "lot_backfilled"],
      factRefs: ["membership_payment_backfilled", "fact_backfilled"],
      committedAt: "2026-09-02T09:03:00.000Z"
    };
    const backfillReceiptHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: backfillReceipt,
      businessCommand: "BACKFILL_HISTORICAL_MEMBERSHIP"
    }));
    expect(backfillReceiptHtml).toContain("产品标价 / 成交价");
    expect(backfillReceiptHtml).toContain("¥936.00 / ¥936.00");
    expect(backfillReceiptHtml).toContain("有效期规则");
    expect(backfillReceiptHtml).toContain("1 年");
    expect(backfillReceiptHtml).toContain("收款与成交价差额");
    expect(backfillReceiptHtml).toContain("收款比成交价少");
    expect(backfillReceiptHtml).toContain("¥436.00");
    expect(backfillReceiptHtml).not.toContain("membership_payment_backfilled");
    expect(backfillReceiptHtml).not.toContain("fact_backfilled");

    const rebuildReceipt: ReceiptDto = {
      receiptId: "receipt_rebuild_detail",
      commandId: "command_rebuild_detail",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_rebuild_detail",
      result: {
        memberId: "member_cathy",
        voidReconversionId: "fact_void_rebuild",
        member: { memberId: "member_cathy", fullName: "Cathy" },
        oldMembershipOrderId: "membership_order_wrong",
        oldContractId: "contract_wrong",
        oldEntitlementLotId: "lot_wrong",
        oldStatus: "VOIDED",
        sourceStayOrderId: "order_108",
        sourceStayId: "stay_108",
        amendmentId: "amendment_rebuild",
        pricingRevisionId: "revision_rebuild",
        membershipOrderId: "membership_order_rebuilt",
        status: "ACTIVE",
        contractId: "contract_rebuilt",
        entitlementLotId: "lot_rebuilt",
        oldDirectCollectionTotal: money(93_600),
        transferredAmount: money(20_000),
        replacementDirectPaymentAmount: money(73_600),
        membershipAgreedPrice: money(93_600),
        validFrom: "2026-08-10",
        validUntil: "2027-08-10",
        entitlementUnitKind: "ROOM_NIGHT",
        convertedUnits: 2,
        remainingUnits: 28,
        serviceDates: ["2026-08-10", "2026-08-11"],
        sourceCollectionFactIds: ["fact_stay_collection"],
        oldPaymentReversalFactIds: ["fact_old_payment_reversal"],
        sourceReversalFactIds: ["fact_stay_reversal"],
        transferPaymentFactIds: ["fact_transfer_payment"],
        replacementPaymentFactId: "fact_replacement_payment",
        transferIds: ["transfer_stay_collection"],
        voidLedgerFactId: "fact_void_ledger",
        conversionLedgerFactIds: ["fact_conversion_1", "fact_conversion_2"],
        reason: { code: "VOID_ERRONEOUS_MEMBERSHIP", note: "原会员办卡误记为直接收款" },
        evidenceNote: "已核对住宿收款与错误会员收款凭证",
        actor: { subjectId: "subject_manager", displayName: "运营主管" },
        recordedAt: "2026-09-02T09:05:00.000Z",
        oldMembership: {
          membershipOrderId: "membership_order_wrong",
          contractId: "contract_wrong",
          entitlementLotId: "lot_wrong",
          productId: "product_shared_room",
          status: "ACTIVE",
          directCollections: [{
            factId: "fact_old_payment",
            amount: money(93_600),
            transactionReference: "WX-WRONG-936",
            businessDate: "2026-08-09"
          }]
        },
        sourceStay: {
          orderId: "order_108",
          stayId: "stay_108",
          arrivalDate: "2026-08-10",
          departureDate: "2026-08-12",
          serviceDates: ["2026-08-10", "2026-08-11"],
          identityEvidence: { phoneMatched: true, documentMatched: false }
        },
        funds: {
          oldDirectCollectionTotal: money(93_600),
          oldReversalTotal: money(93_600),
          stayTransferTotal: money(20_000),
          replacementDirectPayment: {
            amount: money(73_600),
            businessDate: "2026-08-12",
            transactionReference: "WX-REPLACEMENT-736"
          },
          membershipAgreedPrice: money(93_600),
          reclassificationOnly: true
        },
        newMembership: {
          productId: "product_shared_room",
          productName: "公卫四人间会员",
          membershipOrderId: "membership_order_rebuilt",
          contractId: "contract_rebuilt",
          entitlementLotId: "lot_rebuilt",
          validFrom: "2026-08-10",
          validUntil: "2027-08-10"
        },
        entitlement: { unitKind: "ROOM_NIGHT", totalUnits: 30, consumedUnits: 2, remainingUnits: 28, serviceDates: ["2026-08-10", "2026-08-11"] }
      },
      resourceRefs: ["membership_order_wrong", "order_108", "amendment_rebuild", "revision_rebuild", "membership_order_rebuilt", "contract_rebuilt", "lot_rebuilt"],
      factRefs: ["fact_void_rebuild"],
      committedAt: "2026-09-02T09:05:00.000Z"
    };
    const rebuildHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: rebuildReceipt,
      businessCommand: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
    }));
    for (const internalId of ["membership_order_wrong", "membership_order_rebuilt", "contract_rebuilt", "lot_rebuilt", "fact_old_payment", "fact_stay_collection", "fact_old_payment_reversal", "stay_108", "fact_void_rebuild"]) {
      expect(rebuildHtml).not.toContain(internalId);
    }
    expect(rebuildHtml).toContain("¥200.00");
    expect(rebuildHtml).toContain("¥736.00");
    expect(rebuildHtml).toContain("原错误收款明细");
    expect(rebuildHtml).toContain("WX-WRONG-936");
    expect(rebuildHtml).toContain("2026-08-09");
    expect(rebuildHtml).toContain("差额企微交易单号");
    expect(rebuildHtml).toContain("WX-REPLACEMENT-736");
    expect(rebuildHtml).toContain("历史住宿已核销");
    expect(rebuildHtml).toContain("剩余权益");
    expect(rebuildHtml).toContain("原会员办卡误记为直接收款");
    expect(rebuildHtml).toContain("已核对住宿收款与错误会员收款凭证");
    expect(rebuildHtml).toContain("运营主管");
    expect(rebuildHtml).toContain(formatDateTime("2026-09-02T09:05:00.000Z"));

    const incompleteProfileReplay: ReceiptDto = {
      receiptId: "receipt_profile_minimal",
      commandId: "command_profile_minimal",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_profile_minimal",
      result: { memberId: "member_cathy", correctionId: "fact_profile", changedFields: ["phone", "wechat"] },
      resourceRefs: ["member_cathy"],
      factRefs: ["fact_profile"],
      committedAt: "2026-09-02T09:10:00.000Z"
    };
    const profileHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: incompleteProfileReplay,
      businessCommand: "CORRECT_MEMBER_PROFILE"
    }));
    expect(profileHtml).toContain("手机号码、微信号");
    expect(profileHtml).toContain("资料前后值、事实依据和操作人未随本次回放结果提供");
    expect(profileHtml).toContain(formatDateTime("2026-09-02T09:10:00.000Z"));

    const detailedProfileReplay: ReceiptDto = {
      receiptId: "receipt_profile_detail",
      commandId: "command_profile_detail",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_profile_detail",
      result: {
        memberId: "member_cathy",
        correctionId: "fact_profile_detail",
        changedFields: ["identityCardNumber", "phone", "wechat"],
        before: {
          fullName: "陈晓雨",
          nickname: "小雨",
          identityCardNumber: "110101199001011234",
          phone: "13800000000",
          wechat: "xiaoyu-old"
        },
        after: {
          fullName: "陈晓雨",
          nickname: "小雨",
          identityCardNumber: "110101199001015678",
          phone: "13911112222",
          wechat: "xiaoyu-new"
        },
        reason: { code: "PROFILE_CORRECTION", note: "更正录入时的联系方式" },
        evidenceNote: "已核对会员本人提供的资料",
        actor: { subjectId: "subject_manager", displayName: "运营主管" },
        recordedAt: "2026-09-02T09:15:00.000Z"
      },
      resourceRefs: ["member_cathy"],
      factRefs: ["fact_profile_detail"],
      committedAt: "2026-09-02T09:15:00.000Z"
    };
    const detailedProfileHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt: detailedProfileReplay,
      businessCommand: "CORRECT_MEMBER_PROFILE"
    }));
    expect(detailedProfileHtml).toContain("11**************34");
    expect(detailedProfileHtml).toContain("11**************78");
    expect(detailedProfileHtml).toContain("138****0000");
    expect(detailedProfileHtml).toContain("139****2222");
    expect(detailedProfileHtml).toContain("x********d");
    expect(detailedProfileHtml).toContain("x********w");
    expect(detailedProfileHtml).not.toContain("110101199001011234");
    expect(detailedProfileHtml).not.toContain("110101199001015678");
    expect(detailedProfileHtml).not.toContain("13800000000");
    expect(detailedProfileHtml).not.toContain("13911112222");
    expect(detailedProfileHtml).not.toContain("xiaoyu-old");
    expect(detailedProfileHtml).not.toContain("xiaoyu-new");
    expect(detailedProfileHtml).toContain("更正录入时的联系方式");
    expect(detailedProfileHtml).toContain("已核对会员本人提供的资料");
    expect(detailedProfileHtml).toContain("运营主管");
  });

  it("uses business wording in receipts and recovery instead of internal command names", () => {
    const receipt: ReceiptDto = {
      receiptId: "receipt_rebuild",
      commandId: "command_rebuild",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_rebuild",
      result: {},
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-09-02T08:55:00.000Z"
    };
    const receiptHtml = renderToStaticMarkup(createElement(ReceiptPanel, {
      receipt,
      businessCommand: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
    }));
    expect(receiptHtml).toContain("撤销错误办卡并重新升级已完成");
    expect(receiptHtml).toContain("这不是退款");
    expect(receiptHtml).not.toContain("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY");

    const recoveryHtml = renderToStaticMarkup(createElement(CommandRecoveryBar, {
      recovery: {
        version: 1,
        subjectId: "subject_admin",
        scopeId: "property:property_green",
        propertyId: "property_green",
        commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
        confirmationKey: "confirmation_internal",
        targetRefs: ["membershipOrderId=membership_order_cathy"],
        state: "UNKNOWN",
        updatedAt: "2026-09-02T08:55:00.000Z"
      },
      onOpen: () => undefined
    }));
    expect(recoveryHtml).toContain("修改会员生效日结果需要恢复查询");
    expect(recoveryHtml).not.toContain("CORRECT_MEMBERSHIP_EFFECTIVE_DATE");
    expect(recoveryHtml).not.toContain("confirmation_internal");
    expect(recoveryHtml).not.toContain("membership_order_cathy");
  });

  it("fails closed when any administrator membership recovery changes its target, facts, or effect hash", () => {
    const effectHash = "9".repeat(64);
    const audit = {
      reason: { code: "DATA_ENTRY_CORRECTION", note: "已复核原始凭证" },
      evidenceNote,
      actor: { subjectId: "subject_admin", displayName: "运营管理员" },
      recordedAt: "2026-09-02T08:00:00.000Z",
      effectHash
    };
    const profileReceipt: ReceiptDto = {
      receiptId: "receipt_profile_exact", commandId: "command_profile_exact", executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_profile_exact",
      result: {
        memberId: profileEffect.memberId,
        correctionId: "correction_profile",
        changedFields: profileEffect.changedFields,
        before: { ...profileEffect.before, phone: "138****0000", wechat: "c***ld" },
        after: { ...profileEffect.after, phone: "138****0000", wechat: "c***ew" },
        ...audit
      },
      resourceRefs: [profileEffect.memberId], factRefs: ["correction_profile"], committedAt: audit.recordedAt
    };
    const effectiveReceipt: ReceiptDto = {
      receiptId: "receipt_effective_exact", commandId: "command_effective_exact", executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_effective_exact",
      result: {
        memberId: effectiveDateEffect.memberId,
        membershipOrderId: effectiveDateEffect.membershipOrderId,
        contractId: effectiveDateEffect.contractId,
        entitlementLotId: effectiveDateEffect.entitlementLotId,
        correctionId: "correction_effective",
        validFrom: effectiveDateEffect.after.validFrom,
        validUntil: effectiveDateEffect.after.validUntil,
        status: "ACTIVE",
        before: effectiveDateEffect.before,
        after: effectiveDateEffect.after,
        unchanged: effectiveDateEffect.unchanged,
        ...audit
      },
      resourceRefs: [effectiveDateEffect.memberId, effectiveDateEffect.membershipOrderId, effectiveDateEffect.contractId, effectiveDateEffect.entitlementLotId],
      factRefs: ["correction_effective"], committedAt: audit.recordedAt
    };
    const backfillReceipt: ReceiptDto = {
      receiptId: "receipt_backfill_exact", commandId: "command_backfill_exact", executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_backfill_exact",
      result: {
        memberId: backfillEffect.member.memberId,
        membershipOrderId: "membership_order_backfill",
        paymentFactId: "payment_backfill",
        contractId: "contract_backfill",
        entitlementLotId: "lot_backfill",
        backfillId: "backfill_fact",
        status: "ACTIVE",
        validFrom: backfillEffect.validFrom,
        validUntil: backfillEffect.validUntil,
        entitlementUnitKind: backfillEffect.entitlementUnitKind,
        entitlementUnits: backfillEffect.entitlementUnits,
        member: backfillEffect.member,
        product: backfillEffect.product,
        payment: backfillEffect.payment,
        ...audit
      },
      resourceRefs: [backfillEffect.member.memberId, "membership_order_backfill", "contract_backfill", "lot_backfill"],
      factRefs: ["payment_backfill", "backfill_fact"], committedAt: audit.recordedAt
    };
    const rebuildReceipt: ReceiptDto = {
      receiptId: "receipt_rebuild_exact", commandId: "command_rebuild_exact", executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_rebuild_exact",
      result: {
        memberId: rebuildEffect.member.memberId,
        voidReconversionId: "void_reconversion_fact",
        member: rebuildEffect.member,
        oldMembership: rebuildEffect.oldMembership,
        oldMembershipOrderId: rebuildEffect.oldMembership.membershipOrderId,
        oldContractId: rebuildEffect.oldMembership.contractId,
        oldEntitlementLotId: rebuildEffect.oldMembership.entitlementLotId,
        oldStatus: "VOIDED",
        sourceStayOrderId: rebuildEffect.sourceStay.orderId,
        sourceStayId: rebuildEffect.sourceStay.stayId,
        sourceStay: rebuildEffect.sourceStay,
        amendmentId: "amendment_rebuild_exact",
        pricingRevisionId: "revision_rebuild_exact",
        membershipOrderId: "membership_order_rebuild_exact",
        status: "ACTIVE",
        contractId: "contract_rebuild_exact",
        entitlementLotId: "lot_rebuild_exact",
        oldDirectCollectionTotal: rebuildEffect.funds.oldDirectCollectionTotal,
        transferredAmount: rebuildEffect.funds.stayTransferTotal,
        replacementDirectPaymentAmount: rebuildEffect.funds.replacementDirectPayment.amount,
        membershipAgreedPrice: rebuildEffect.funds.membershipAgreedPrice,
        funds: rebuildEffect.funds,
        validFrom: rebuildEffect.newMembership.validFrom,
        validUntil: rebuildEffect.newMembership.validUntil,
        newMembership: {
          ...rebuildEffect.newMembership,
          membershipOrderId: "membership_order_rebuild_exact",
          contractId: "contract_rebuild_exact",
          entitlementLotId: "lot_rebuild_exact"
        },
        entitlementUnitKind: rebuildEffect.entitlement.unitKind,
        convertedUnits: rebuildEffect.entitlement.consumedUnits,
        remainingUnits: rebuildEffect.entitlement.remainingUnits,
        entitlement: rebuildEffect.entitlement,
        serviceDates: rebuildEffect.entitlement.serviceDates,
        sourceCollectionFactIds: ["source_collection"],
        oldPaymentReversalFactIds: ["old_reversal"],
        paymentReclassificationFactIds: ["payment_reclassification"],
        sourceReversalFactIds: ["source_reversal"],
        transferPaymentFactIds: ["transfer_payment"],
        replacementPaymentFactId: "replacement_payment",
        transferIds: ["stay_transfer"],
        voidLedgerFactId: "void_ledger",
        conversionLedgerFactIds: ["conversion_1", "conversion_2"],
        ...audit
      },
      resourceRefs: [rebuildEffect.member.memberId, rebuildEffect.oldMembership.membershipOrderId, rebuildEffect.oldMembership.contractId, rebuildEffect.oldMembership.entitlementLotId, rebuildEffect.sourceStay.orderId, "amendment_rebuild_exact", "revision_rebuild_exact", "membership_order_rebuild_exact", "contract_rebuild_exact", "lot_rebuild_exact", "stay_transfer"],
      factRefs: ["void_reconversion_fact", "old_reversal", "payment_reclassification", "void_ledger", "source_reversal", "transfer_payment", "replacement_payment", "conversion_1", "conversion_2"],
      committedAt: audit.recordedAt
    };
    const cases = [
      { commandType: "CORRECT_MEMBER_PROFILE" as const, receipt: profileReceipt, input: profileInput, effect: profileEffect },
      { commandType: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE" as const, receipt: effectiveReceipt, input: effectiveDateInput, effect: effectiveDateEffect },
      { commandType: "BACKFILL_HISTORICAL_MEMBERSHIP" as const, receipt: backfillReceipt, input: backfillInput, effect: backfillEffect },
      { commandType: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY" as const, receipt: rebuildReceipt, input: rebuildInput, effect: rebuildEffect }
    ];
    for (const candidate of cases) {
      expect(receiptHasCommandEvidence(candidate.commandType, candidate.receipt, candidate.input, candidate.effect, effectHash), candidate.commandType).toBe(true);
      expect(receiptHasCommandEvidence(candidate.commandType, { ...candidate.receipt, factRefs: [] }, candidate.input, candidate.effect, effectHash), `${candidate.commandType}: facts`).toBe(false);
      expect(receiptHasCommandEvidence(candidate.commandType, { ...candidate.receipt, resourceRefs: [] }, candidate.input, candidate.effect, effectHash), `${candidate.commandType}: resources`).toBe(false);
      expect(receiptHasCommandEvidence(candidate.commandType, { ...candidate.receipt, result: { ...candidate.receipt.result, effectHash: undefined } }, candidate.input, candidate.effect, effectHash), `${candidate.commandType}: missing hash`).toBe(false);
      expect(receiptHasCommandEvidence(candidate.commandType, { ...candidate.receipt, result: { ...candidate.receipt.result, effectHash: "0".repeat(64) } }, candidate.input, candidate.effect, effectHash), `${candidate.commandType}: changed hash`).toBe(false);
    }
    const changedProjectedProfileReceipt = structuredClone(profileReceipt);
    ((changedProjectedProfileReceipt.result as Record<string, unknown>).after as Record<string, unknown>).wechat = "c***xx";
    expect(receiptHasCommandEvidence(
      "CORRECT_MEMBER_PROFILE",
      changedProjectedProfileReceipt,
      profileInput,
      profileEffect,
      effectHash
    )).toBe(false);
    expect(receiptHasCommandEvidence(
      "CORRECT_MEMBER_PROFILE",
      profileReceipt,
      { propertyId: "property_green", memberId: profileEffect.memberId },
      undefined,
      effectHash
    )).toBe(true);
    const malformedRecoveredProfileReceipt = structuredClone(profileReceipt);
    ((malformedRecoveredProfileReceipt.result as Record<string, unknown>).after as Record<string, unknown>).phone = "13800000009";
    expect(receiptHasCommandEvidence(
      "CORRECT_MEMBER_PROFILE",
      malformedRecoveredProfileReceipt,
      { propertyId: "property_green", memberId: profileEffect.memberId },
      undefined,
      effectHash
    )).toBe(false);
    const forgedRecoveredChangedFields = structuredClone(profileReceipt);
    (forgedRecoveredChangedFields.result as Record<string, unknown>).changedFields = ["fullName", "unknownField"];
    expect(receiptHasCommandEvidence(
      "CORRECT_MEMBER_PROFILE",
      forgedRecoveredChangedFields,
      { propertyId: "property_green", memberId: profileEffect.memberId },
      undefined,
      effectHash
    )).toBe(false);
    const unprojectedProfileReceipt = structuredClone(profileReceipt);
    Object.assign(unprojectedProfileReceipt.result!, { before: profileEffect.before, after: profileEffect.after });
    expect(receiptHasCommandEvidence(
      "CORRECT_MEMBER_PROFILE",
      unprojectedProfileReceipt,
      profileInput,
      profileEffect,
      effectHash
    )).toBe(false);
    expect(receiptHasCommandEvidence("CORRECT_MEMBER_PROFILE", profileReceipt, { ...profileInput, memberId: "member_other" }, profileEffect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", effectiveReceipt, { ...effectiveDateInput, membershipOrderId: "membership_order_other" }, effectiveDateEffect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("BACKFILL_HISTORICAL_MEMBERSHIP", backfillReceipt, { ...backfillInput, memberId: "member_other" }, backfillEffect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", rebuildReceipt, { ...rebuildInput, sourceStayOrderId: "order_other" }, rebuildEffect, effectHash)).toBe(false);
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
        subjectDisplayName: "自动化接入账号",
        label: "外部客户端",
        accessCeiling: "READ",
        commandCeiling: [],
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
    expect(html).toContain("目标主体");
    expect(html).toContain("自动化接入账号");
    expect(html).toContain("只读");
    expect(html).toContain("无写入能力");
    expect(html).toContain("保持不变");
    expect(html).toContain("权限或主体状态发生变化时，本次确认会失败且不会写入");
    expect(html).not.toContain("qtp_must_not_render");
    expect(html).not.toContain("subject_agent");
    expect(html).not.toContain("Preview");
    expect(html).not.toContain("命令类型");
    expect(html).not.toContain("原因代码");
  });

  it("shows the authoritative before/after rotation scope without protocol names or internal IDs", () => {
    const preview: PreviewDto = {
      previewId: "preview_rotation",
      commandType: "ROTATE_TOKEN",
      effectHash: "c".repeat(64),
      effect: {
        tokenId: "token_internal_current",
        subjectId: "subject_internal_target",
        subjectDisplayName: "渠道同步账号",
        label: "房态同步",
        accessCeiling: "WRITE",
        previousCommandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION"],
        commandCeiling: ["CREATE_ORDER"],
        previousPersistedCommandCeiling: ["CREATE_ORDER", "RECORD_COLLECTION", "PLACE_INTERNAL_USE"],
        persistedCommandCeiling: ["CREATE_ORDER", "PLACE_INTERNAL_USE"],
        previousExpiresAt: "2026-10-01T08:00:00.000Z",
        expiresAt: "2026-12-01T08:00:00.000Z",
        historicalReadCeilingPreserved: true,
        operation: "ROTATE"
      },
      expiresAt: "2026-08-03T08:49:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "ROTATE_TOKEN",
      commandInput: {
        propertyId: "prop_internal",
        tokenId: "token_internal_current",
        commandCeiling: ["CREATE_ORDER"],
        expiresAt: "2026-12-01T08:00:00.000Z",
        tokenSecret: "qtp_must_not_render"
      }
    }));

    expect(html).toContain("渠道同步账号");
    expect(html).toContain("原权限范围");
    expect(html).toContain("新权限范围");
    expect(html).toContain("创建住宿订单");
    expect(html).toContain("登记住宿收款");
    expect(html).toContain("系统自动保留历史结果查询与恢复范围");
    expect(html).not.toContain("token_internal_current");
    expect(html).not.toContain("subject_internal_target");
    expect(html).not.toContain("CREATE_ORDER");
    expect(html).not.toContain("RECORD_COLLECTION");
    expect(html).not.toContain("PLACE_INTERNAL_USE");
    expect(html).not.toContain("qtp_must_not_render");
  });

  it("states that revocation removes both execution and historical-result access", () => {
    const preview: PreviewDto = {
      previewId: "preview_revoke",
      commandType: "REVOKE_TOKEN",
      effectHash: "d".repeat(64),
      effect: {
        tokenId: "token_internal_current",
        subjectId: "subject_internal_target",
        subjectDisplayName: "渠道同步账号",
        label: "房态同步",
        accessCeiling: "WRITE",
        commandCeiling: ["CREATE_ORDER"],
        expiresAt: "2026-10-01T08:00:00.000Z",
        historicalReadCeilingPreserved: false,
        operation: "REVOKE"
      },
      expiresAt: "2026-08-03T08:49:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      businessCommand: "REVOKE_TOKEN",
      commandInput: { propertyId: "prop_internal", tokenId: "token_internal_current" }
    }));

    expect(html).toContain("渠道同步账号");
    expect(html).toContain("创建住宿订单");
    expect(html).toContain("已撤销；无访问权限");
    expect(html).toContain("撤销后不保留该 Token 的历史结果查询与恢复范围");
    expect(html).not.toContain("token_internal_current");
    expect(html).not.toContain("subject_internal_target");
    expect(html).not.toContain("CREATE_ORDER");
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

describe("completed-stay backfill presentation and recovery", () => {
  const effectHash = "8".repeat(64);
  const input = {
    propertyId: "property_green",
    quoteId: "quote_backfill_completed",
    primaryGuest: { fullName: "测试住客", nickname: "测试" },
    additionalGuests: [],
    bookingChannelCode: "WECOM",
    channelOrderReference: null,
    targetCurrentContractAmountMinor: 10_000,
    backfill: true,
    backfillReason: "前台漏录",
    backfillCollection: {
      amountMinor: 8_450,
      method: "CASH",
      cashCollector: "前台甲",
      note: "现金已核对"
    }
  };
  const effect = {
    quoteId: input.quoteId,
    primaryGuest: input.primaryGuest,
    occupants: [{ id: "occupant_backfill_primary", ...input.primaryGuest, role: "PRIMARY", ordinal: 1 }],
    inventoryUnit: { id: "unit_102_b", code: "102-B", name: "102 · 床位 B" },
    stayType: "TRANSIENT",
    bookingChannelCode: "WECOM",
    channelOrderReference: null,
    freeStayReason: null,
    freeStayCategoryCode: null,
    arrivalDate: "2026-08-06",
    departureDate: "2026-08-11",
    pricingPolicyVersionId: "policy_backfill_completed",
    pricingDecision: {
      pricingBasis: "POLICY",
      policyBaseAmount: { currency: "CNY", minorUnits: 10_000 },
      targetCurrentContractAmount: { currency: "CNY", minorUnits: 10_000 },
      differenceFromPolicy: { currency: "CNY", minorUnits: 0 },
      manualAdjustmentMinor: 0,
      reason: null
    },
    pricing: {
      coverageSet: [],
      cashLines: [],
      cashRemainder: { currency: "CNY", minorUnits: 10_000 },
      currentContractAmount: { currency: "CNY", minorUnits: 10_000 }
    },
    backfill: {
      reason: "前台漏录",
      businessDate: "2026-08-14",
      resultingOrderStatus: "CHECKED_OUT",
      resultingStayStatus: "COMPLETED",
      collection: {
        amountMinor: 8_450,
        method: "CASH",
        cashCollector: "前台甲",
        note: "现金已核对"
      },
      externalChannel: false,
      settlementStatus: "ARREARS",
      collectedAmountMinor: 8_450,
      balanceDueMinor: 1_550
    }
  };

  it("accepts completed and cross-today in-house Previews and presents one Chinese business review", () => {
    const inHouseEffect = {
      ...effect,
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-16",
      backfill: {
        ...effect.backfill,
        resultingOrderStatus: "CHECKED_IN",
        resultingStayStatus: "IN_HOUSE"
      }
    };
    expect(completedStayBackfillPreviewHasEvidence(effect, input)).toBe(true);
    expect(completedStayBackfillPreviewHasEvidence(inHouseEffect, input)).toBe(true);
    expect(completedStayBackfillPreviewHasEvidence({ ...effect, quoteId: "quote_other" }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      primaryGuest: { ...effect.primaryGuest, nickname: "被替换的住客" }
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({ ...effect, bookingChannelCode: "CTRIP" }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({ ...effect, channelOrderReference: "CHANNEL-TAMPERED" }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      pricingDecision: {
        ...effect.pricingDecision,
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 9_900 }
      }
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      backfill: { ...effect.backfill, reason: "被替换的补录原因" }
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      backfill: { ...effect.backfill, resultingOrderStatus: "CHECKED_IN", resultingStayStatus: "IN_HOUSE" }
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...inHouseEffect,
      backfill: { ...inHouseEffect.backfill, resultingOrderStatus: "CHECKED_OUT", resultingStayStatus: "COMPLETED" }
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      departureDate: "2026-08-15"
    }, input)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...effect,
      backfill: {
        ...effect.backfill,
        collection: null,
        collectedAmountMinor: 0,
        balanceDueMinor: 10_000
      }
    }, {
      ...input,
      backfillCollection: { amountMinor: 0, method: "CASH" }
    })).toBe(false);

    const preview: PreviewDto = {
      previewId: "preview_backfill_completed",
      commandType: "CREATE_ORDER",
      effectHash,
      effect,
      expiresAt: "2026-08-14T10:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      commandInput: input,
      reasonNote: input.backfillReason
    }));
    expect(html).toContain("请核对已完成住宿补录");
    expect(html).toContain("收款人");
    expect(html).toContain("前台甲");
    expect(html).toContain("提交后直接成为欠款");
    expect(html).toContain("补录原因");
    expect(html).not.toContain("创建预订");
    expect(html).not.toContain("逐步办理入住");

    const inHousePreview: PreviewDto = {
      previewId: "preview_backfill_in_house",
      commandType: "CREATE_ORDER",
      effectHash,
      effect: inHouseEffect,
      expiresAt: "2026-08-14T10:00:00.000Z"
    };
    const inHouseHtml = renderToStaticMarkup(createElement(EffectSummary, {
      preview: inHousePreview,
      commandInput: input,
      reasonNote: input.backfillReason
    }));
    expect(inHouseHtml).toContain("请核对在住住宿补录");
    expect(inHouseHtml).toContain("提交后直接成为在住");
    expect(inHouseHtml).toContain("已发生实收");
    expect(inHouseHtml).not.toContain("历史退房");
  });

  it("fails closed when free or external-channel Preview evidence is changed", () => {
    const freeInput = {
      ...input,
      bookingChannelCode: undefined,
      channelOrderReference: undefined,
      targetCurrentContractAmountMinor: undefined,
      backfillCollection: undefined,
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "义工值班住宿"
    };
    const freeEffect = {
      ...effect,
      stayType: "FREE",
      bookingChannelCode: null,
      channelOrderReference: null,
      freeStayCategoryCode: "VOLUNTEER",
      freeStayReason: "义工值班住宿",
      pricingDecision: {
        ...effect.pricingDecision,
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 0 }
      },
      backfill: {
        ...effect.backfill,
        collection: null,
        settlementStatus: "SETTLED",
        collectedAmountMinor: 0,
        balanceDueMinor: 0
      }
    };
    expect(completedStayBackfillPreviewHasEvidence(freeEffect, freeInput)).toBe(true);
    expect(completedStayBackfillPreviewHasEvidence({ ...freeEffect, stayType: "TRANSIENT" }, freeInput)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence(freeEffect, { ...freeInput, freeStayCategoryCode: "INTERNAL" })).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({ ...freeEffect, freeStayCategoryCode: "RECEPTION" }, freeInput)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({ ...freeEffect, freeStayReason: "被替换的免费原因" }, freeInput)).toBe(false);

    const channelInput = {
      ...input,
      bookingChannelCode: "CTRIP",
      channelOrderReference: "CTRIP-20260806",
      targetCurrentContractAmountMinor: 12_300,
      backfillCollection: undefined
    };
    const channelEffect = {
      ...effect,
      bookingChannelCode: "CTRIP",
      channelOrderReference: "CTRIP-20260806",
      pricingDecision: {
        ...effect.pricingDecision,
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 12_300 }
      },
      backfill: {
        ...effect.backfill,
        collection: null,
        externalChannel: true,
        settlementStatus: "SETTLED",
        collectedAmountMinor: 0,
        balanceDueMinor: 0
      }
    };
    expect(completedStayBackfillPreviewHasEvidence(channelEffect, channelInput)).toBe(true);
    expect(completedStayBackfillPreviewHasEvidence({ ...channelEffect, channelOrderReference: "CTRIP-TAMPERED" }, channelInput)).toBe(false);
    expect(completedStayBackfillPreviewHasEvidence({
      ...channelEffect,
      pricingDecision: {
        ...channelEffect.pricingDecision,
        targetCurrentContractAmount: { currency: "CNY", minorUnits: 12_301 }
      }
    }, channelInput)).toBe(false);
  });

  it("persists a dedicated backfill recovery with the Preview effect hash", () => {
    const transition = transitionPersistedCommandRecovery(undefined, {
      subjectId: "subject_backfill",
      scopeId: "property:property_green",
      request: {
        commandType: "CREATE_ORDER",
        title: "补录住宿",
        description: "核对已完成住宿补录",
        presentation: "BACKFILL_STAY",
        input
      }
    }, {
      state: "CONFIRMING",
      previewId: "preview_backfill_completed",
      confirmationKey: "confirm_backfill_completed",
      effectHash
    }, "2026-08-14T09:00:00.000Z");
    expect(transition).toMatchObject({
      accepted: true,
      recovery: {
        commandType: "CREATE_ORDER",
        presentation: "BACKFILL_STAY",
        effectHash
      }
    });
    if (!transition.recovery) throw new Error("Expected backfill recovery");
    expect(recoveryCommandRequest(transition.recovery)).toMatchObject({
      commandType: "CREATE_ORDER",
      title: "恢复补录住宿结果",
      presentation: "BACKFILL_STAY",
      recoveryEffectHash: effectHash,
      input: { propertyId: "property_green", backfill: true }
    });
  });

  it("shows the completed backfill result and keeps a direct order-detail link", () => {
    const receipt: ReceiptDto = {
      receiptId: "receipt_backfill_completed",
      commandId: "command_backfill_completed",
      executionStatus: "EXECUTED",
      businessCommitted: true,
      correlationId: "correlation_backfill_completed",
      result: {
        orderId: "order_backfill_completed",
        stayId: "stay_backfill_completed",
        segmentId: "segment_backfill_completed",
        pricingRevisionId: "revision_backfill_completed",
        pricingPolicyVersionId: "policy_backfill_completed",
        primaryGuest: input.primaryGuest,
        occupants: [{
          id: "occupant_backfill_primary",
          orderId: "order_backfill_completed",
          ordinal: 1,
          role: "PRIMARY",
          ...input.primaryGuest,
          phone: null,
          documentNumber: null,
          createdAt: "2026-08-14T09:00:00.000Z"
        }],
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        freeStayReason: null,
        freeStayCategoryCode: null,
        pricingDecision: effect.pricingDecision,
        status: "CHECKED_OUT",
        effectHash,
        backfill: {
          businessDate: "2026-08-14",
          checkInAmendmentId: "amend_backfill_check_in",
          checkOutAmendmentId: "amend_backfill_check_out",
          settlementStatus: "ARREARS",
          collectedAmountMinor: 8_450,
          balanceDueMinor: 1_550,
          collectionFactId: "fact_backfill_collection"
        }
      },
      resourceRefs: [
        "order_backfill_completed",
        "stay_backfill_completed",
        "segment_backfill_completed",
        "revision_backfill_completed",
        "amend_backfill_check_in",
        "amend_backfill_check_out",
        "occupant_backfill_primary"
      ],
      factRefs: ["fact_backfill_collection"],
      committedAt: "2026-08-14T09:00:00.000Z"
    };
    expect(completedStayBackfillReceiptHasEvidence(receipt, input, effect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("CREATE_ORDER", receipt, input, effect, effectHash)).toBe(true);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      result: {
        ...receipt.result,
        occupants: [{
          ...((receipt.result?.occupants as Array<Record<string, unknown>>)[0]),
          documentNumber: "unexpected-document"
        }]
      }
    }, input, effect, effectHash)).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence(receipt, {
      propertyId: "property_green",
      backfill: true
    }, undefined, effectHash)).toBe(true);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      resourceRefs: receipt.resourceRefs.filter((reference) => reference !== "amend_backfill_check_out")
    }, input, effect, effectHash)).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      resourceRefs: [...receipt.resourceRefs, "unexpected_resource"]
    }, input, effect, effectHash)).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      factRefs: []
    }, input, effect, effectHash)).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      result: {
        ...receipt.result,
        backfill: {
          ...(receipt.result?.backfill as Record<string, unknown>),
          settlementStatus: "SETTLED"
        }
      }
    }, input, effect, effectHash)).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence(receipt, input, effect, "invalid-effect-hash")).toBe(false);
    expect(completedStayBackfillReceiptHasEvidence({
      ...receipt,
      result: { ...receipt.result, effectHash: "7".repeat(64) }
    }, input, effect, effectHash)).toBe(false);
    const rejected: ReceiptDto = {
      receiptId: "receipt_backfill_rejected",
      commandId: "command_backfill_rejected",
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      correlationId: "correlation_backfill_rejected",
      error: {
        code: "PREVIEW_STALE",
        message: "Preview stale",
        correlationId: "correlation_backfill_rejected",
        commandId: "command_backfill_rejected",
        receiptId: "receipt_backfill_rejected",
        retryable: false
      },
      resourceRefs: [],
      factRefs: [],
      committedAt: "2026-08-14T09:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("CREATE_ORDER", rejected, input, effect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("CREATE_ORDER", {
      ...rejected,
      resourceRefs: ["unexpected_partial_write"]
    }, input, effect, effectHash)).toBe(false);
    expect(receiptHasCommandEvidence("CREATE_ORDER", {
      receiptId: "",
      commandId: "",
      executionStatus: "UNKNOWN",
      businessCommitted: false,
      correlationId: "",
      resourceRefs: [],
      factRefs: []
    }, input, effect, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("CREATE_ORDER", {
      receiptId: "",
      commandId: "",
      executionStatus: "UNKNOWN",
      businessCommitted: false,
      correlationId: "",
      result: { orderId: "unexpected_partial_write" },
      resourceRefs: [],
      factRefs: []
    }, input, effect, effectHash)).toBe(false);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReceiptPanel, {
      receipt,
      commandType: "CREATE_ORDER",
      backfillStay: true
    })));
    expect(html).toContain("住宿补录已完成");
    expect(html).toContain("欠款");
    expect(html).toContain("查看订单");

    const inHouseEffect = {
      ...effect,
      arrivalDate: "2026-08-13",
      departureDate: "2026-08-16",
      backfill: {
        ...effect.backfill,
        resultingOrderStatus: "CHECKED_IN",
        resultingStayStatus: "IN_HOUSE"
      }
    };
    const inHouseReceipt: ReceiptDto = {
      ...receipt,
      result: {
        ...(receipt.result as Record<string, unknown>),
        status: "CHECKED_IN",
        backfill: {
          businessDate: "2026-08-14",
          checkInAmendmentId: "amend_backfill_check_in",
          checkOutAmendmentId: null,
          settlementStatus: "ARREARS",
          collectedAmountMinor: 8_450,
          balanceDueMinor: 1_550,
          collectionFactId: "fact_backfill_collection"
        }
      },
      resourceRefs: [
        "order_backfill_completed",
        "stay_backfill_completed",
        "segment_backfill_completed",
        "revision_backfill_completed",
        "amend_backfill_check_in",
        "occupant_backfill_primary"
      ]
    };
    expect(completedStayBackfillReceiptHasEvidence(inHouseReceipt, input, inHouseEffect, effectHash)).toBe(true);
    expect(completedStayBackfillReceiptHasEvidence({
      ...inHouseReceipt,
      resourceRefs: [...inHouseReceipt.resourceRefs, "unexpected_check_out"]
    }, input, inHouseEffect, effectHash)).toBe(false);
    const inHouseHtml = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReceiptPanel, {
      receipt: inHouseReceipt,
      commandType: "CREATE_ORDER",
      backfillStay: true
    })));
    expect(inHouseHtml).toContain("住宿补录已完成");
    expect(inHouseHtml).toContain("订单已在住");
    expect(inHouseHtml).not.toContain("退房已经记录");
  });
});

describe("complete-stay presentation and recovery", () => {
  const effectHash = "c".repeat(64);
  const input = {
    propertyId: "property_green",
    orderId: "order_complete_stay",
    actualStayCompletedConfirmed: true,
    reasonNote: "客人已经实际入住并离店"
  };
  const effect = {
    operation: "COMPLETE_STAY",
    arrivalDate: "2026-07-20",
    departureDate: "2026-07-27",
    businessDate: "2026-08-25",
    settlementStatus: "SETTLED",
    reasonNote: input.reasonNote,
    amounts: {
      currentContractAmount: { currency: "CNY", minorUnits: 123_200 },
      netRecordedCollection: { currency: "CNY", minorUnits: 123_200 },
      collectionDifference: { currency: "CNY", minorUnits: 0 }
    },
    collection: null,
    checkOut: {
      effectiveDate: "2026-07-27",
      businessDate: "2026-08-25",
      recordingMode: "LATE_RECORDED"
    }
  };
  const receipt: ReceiptDto = {
    receiptId: "receipt_complete_stay",
    commandId: "command_complete_stay",
    executionStatus: "EXECUTED",
    businessCommitted: true,
    correlationId: "correlation_complete_stay",
    result: {
      orderId: input.orderId,
      stayId: "stay_complete_stay",
      checkInAmendmentId: "amendment_complete_stay_check_in",
      checkOutAmendmentId: "amendment_complete_stay_check_out",
      status: "CHECKED_OUT",
      settlementStatus: "SETTLED",
      collectionFactId: null,
      fulfillmentTiming: {
        effectiveDate: "2026-07-27",
        recordedBusinessDate: "2026-08-25",
        recordingMode: "LATE_RECORDED"
      },
      effectHash
    },
    resourceRefs: [
      input.orderId,
      "stay_complete_stay",
      "amendment_complete_stay_check_in",
      "amendment_complete_stay_check_out"
    ],
    factRefs: [],
    committedAt: "2026-08-25T09:00:00.000Z"
  };

  function confirmingRecovery(requestInput: Record<string, unknown> = input) {
    const request = {
      commandType: "COMPLETE_STAY" as const,
      title: "完成住宿",
      description: "确认实际住宿情况后，订单将直接完成",
      presentation: "COMPLETE_STAY" as const,
      input: requestInput
    };
    const transition = transitionPersistedCommandRecovery(undefined, {
      subjectId: "subject_complete_stay",
      scopeId: "property:property_green",
      request
    }, {
      state: "CONFIRMING",
      previewId: "preview_complete_stay",
      confirmationKey: "confirm_complete_stay",
      effectHash
    }, "2026-08-25T08:59:00.000Z");
    if (!transition.recovery) throw new Error("Expected complete-stay recovery");
    return { request, recovery: transition.recovery };
  }

  it("keeps a successful completion queryable instead of classifying its saved recovery as corrupt", () => {
    const { recovery } = confirmingRecovery();
    const authoritative = new MemoryStorage();
    const compatibility = new MemoryStorage();
    const storage = createSharedCommandRecoveryStorage(authoritative, compatibility);

    expect(recovery.targetRefs).toEqual([`orderId=${input.orderId}`]);
    expect(savePersistedCommandRecovery(storage, recovery)).toBe(true);
    expect(readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId)).toEqual({
      kind: "VALID",
      recovery
    });

    const recoveryRequest = recoveryCommandRequest(recovery);
    expect(recoveryRequest).toMatchObject({
      commandType: "COMPLETE_STAY",
      presentation: "COMPLETE_STAY",
      recoveryEffectHash: effectHash,
      input: {
        propertyId: input.propertyId,
        orderId: input.orderId,
        actualStayCompletedConfirmed: true
      }
    });
    expect(recoveryRequest.description).toBe("系统只查询刚才的办理结果，不会重复完成订单或重复登记收款。");
    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      receipt,
      recoveryRequest.input,
      undefined,
      recoveryRequest.recoveryEffectHash
    )).toBe(true);

    const resolved = transitionPersistedCommandRecovery(recovery, {
      subjectId: recovery.subjectId,
      scopeId: recovery.scopeId,
      request: recoveryRequest
    }, {
      state: "RESOLVED",
      confirmationKey: recovery.confirmationKey,
      receipt
    }, "2026-08-25T09:00:01.000Z");
    expect(resolved).toMatchObject({ accepted: true, recovery: { state: "EXECUTED" } });
    expect(savePersistedCommandRecovery(storage, resolved.recovery!)).toBe(true);
    expect(readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId)).toMatchObject({
      kind: "VALID",
      recovery: { confirmationKey: recovery.confirmationKey, state: "EXECUTED", effectHash }
    });
  });

  it("uses the persisted effect hash to verify a recovered completion that recorded a new collection", () => {
    const collectionInput = {
      ...input,
      collection: {
        amountMinor: 10_000,
        method: "WECOM",
        transactionReference: "WX-COMPLETE-STAY"
      }
    };
    const { recovery } = confirmingRecovery(collectionInput);
    const recoveryRequest = recoveryCommandRequest(recovery);
    const receiptWithCollection: ReceiptDto = {
      ...receipt,
      receiptId: "receipt_complete_stay_collection",
      commandId: "command_complete_stay_collection",
      correlationId: "correlation_complete_stay_collection",
      result: {
        ...receipt.result,
        collectionFactId: "collection_complete_stay"
      },
      factRefs: ["collection_complete_stay"]
    };

    expect(recoveryRequest.input).not.toHaveProperty("collection");
    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      receiptWithCollection,
      recoveryRequest.input,
      undefined,
      effectHash
    )).toBe(true);
    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      receiptWithCollection,
      recoveryRequest.input,
      undefined
    )).toBe(false);
    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      { ...receiptWithCollection, factRefs: [] },
      recoveryRequest.input,
      undefined,
      effectHash
    )).toBe(false);
  });

  it("still rejects incomplete or mismatched completion recovery identities", () => {
    const { recovery } = confirmingRecovery();
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(recovery.subjectId, recovery.scopeId);
    const { effectHash: _effectHash, ...withoutEffectHash } = recovery;
    storage.setItem(key, JSON.stringify(withoutEffectHash));
    expect(readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId)).toMatchObject({ kind: "CORRUPT" });

    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      receipt,
      { ...recoveryCommandRequest(recovery).input, orderId: "order_other" },
      undefined,
      effectHash
    )).toBe(false);

    for (const missingResourceRef of receipt.resourceRefs) {
      expect(receiptHasCommandEvidence(
        "COMPLETE_STAY",
        { ...receipt, resourceRefs: receipt.resourceRefs.filter((reference) => reference !== missingResourceRef) },
        recoveryCommandRequest(recovery).input,
        undefined,
        effectHash
      ), missingResourceRef).toBe(false);
    }
    expect(receiptHasCommandEvidence(
      "COMPLETE_STAY",
      { ...receipt, result: { ...receipt.result, effectHash: undefined } },
      recoveryCommandRequest(recovery).input,
      undefined,
      effectHash
    )).toBe(false);
  });

  it("fails closed unless a saved completion has exactly one nonblank order target", () => {
    const { request, recovery } = confirmingRecovery();
    const storage = new MemoryStorage();
    const key = commandRecoveryStorageKey(recovery.subjectId, recovery.scopeId);
    const invalidTargetRefs = [
      [],
      ["inventoryUnitId=unit_room_202"],
      ["orderId="],
      [`orderId=${input.orderId}`, "inventoryUnitId=unit_room_202"]
    ];

    for (const targetRefs of invalidTargetRefs) {
      storage.setItem(key, JSON.stringify({ ...recovery, targetRefs }));
      expect(readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId), JSON.stringify(targetRefs))
        .toMatchObject({ kind: "CORRUPT" });
      expect(savePersistedCommandRecovery(storage, { ...recovery, targetRefs })).toBe(false);
    }

    const missingOrderTransition = transitionPersistedCommandRecovery(undefined, {
      subjectId: recovery.subjectId,
      scopeId: recovery.scopeId,
      request: { ...request, input: { propertyId: input.propertyId, actualStayCompletedConfirmed: true } }
    }, {
      state: "CONFIRMING",
      previewId: "preview_complete_stay_missing_order",
      confirmationKey: "confirm_complete_stay_missing_order",
      effectHash
    });
    expect(missingOrderTransition).toEqual({ accepted: false, recovery: undefined });
  });

  it("shows the agreed operator language without internal transaction terminology", () => {
    const preview: PreviewDto = {
      previewId: "preview_complete_stay",
      commandType: "COMPLETE_STAY",
      effectHash,
      effect,
      expiresAt: "2026-08-25T09:10:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(EffectSummary, {
      preview,
      commandInput: input,
      reasonNote: input.reasonNote
    }));

    expect(html).toContain("确认后，订单将直接完成");
    expect(html).toContain("已有收款不会重复登记");
    expect(html).not.toContain("原子写入历史入住");
    expect(html).not.toContain("库存释放");
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
      phone: " 13800006666 "
    },
    member: {
      memberId: input.memberId,
      fullName: "住宿转会员会员",
      phone: "13800006666"
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
    conversionMode: "IN_HOUSE",
    conversionCoverageIds: ["coverage_1", "coverage_2", "coverage_3", "coverage_4", "coverage_5", "coverage_6", "coverage_7"],
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
      ...conversionResult.transferIds,
      ...conversionResult.conversionCoverageIds
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
      { propertyId: input.propertyId, orderId: input.orderId },
      undefined,
      effectHash
    )).toBe(false);
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

  it("accepts and recovers a committed zero-lodging-collection upgrade with a positive membership payment", () => {
    const zeroCollectionInput = {
      ...input,
      collectionFactIds: [],
      agreedPriceMinor: 93_600
    };
    const zeroCollectionResult = {
      ...conversionResult,
      transferredCollectionFactIds: [],
      lodgingReversalFactIds: [],
      membershipPaymentFactIds: ["membership_payment_remaining"],
      transferIds: [],
      transferredAmount: money(0),
      membershipAgreedPrice: money(zeroCollectionInput.agreedPriceMinor),
      remainingPaymentAmount: money(zeroCollectionInput.agreedPriceMinor)
    };
    const zeroCollectionReceipt = {
      ...receipt,
      result: zeroCollectionResult,
      resourceRefs: [
        zeroCollectionResult.orderId,
        zeroCollectionResult.amendmentId,
        zeroCollectionResult.pricingRevisionId,
        zeroCollectionResult.membershipOrderId,
        zeroCollectionResult.contractId,
        zeroCollectionResult.entitlementLotId,
        ...zeroCollectionResult.conversionCoverageIds
      ],
      factRefs: [
        ...zeroCollectionResult.membershipPaymentFactIds,
        ...zeroCollectionResult.conversionLedgerFactIds
      ]
    };
    const recoveryInput = {
      propertyId: zeroCollectionInput.propertyId,
      orderId: zeroCollectionInput.orderId,
      memberId: zeroCollectionInput.memberId
    };

    expect(conversionReceiptHasEvidence(
      zeroCollectionReceipt,
      zeroCollectionInput,
      undefined,
      effectHash
    )).toBe(true);
    expect(conversionReceiptHasEvidence(
      zeroCollectionReceipt,
      recoveryInput,
      undefined,
      effectHash
    )).toBe(true);
  });

  it("accepts only server-validated historical completed coverage and rejects missing or partial current coverage", () => {
    const historicalResult = { ...conversionResult, conversionMode: "COMPLETED", conversionCoverageIds: [] };
    const historicalReceipt = {
      ...receipt,
      result: historicalResult,
      resourceRefs: receipt.resourceRefs.filter((reference) => !conversionResult.conversionCoverageIds.includes(reference)),
      protocolVersion: "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT",
      recoveryMode: "HISTORICAL_READ_ONLY"
    };
    const partialResult = { ...conversionResult, conversionCoverageIds: [conversionResult.conversionCoverageIds[0]] };
    const partialReceipt = {
      ...receipt,
      result: partialResult,
      resourceRefs: receipt.resourceRefs.filter((reference) => (
        !conversionResult.conversionCoverageIds.includes(reference)
        || reference === conversionResult.conversionCoverageIds[0]
      ))
    };
    const missingCurrentCoverageReceipt = {
      ...receipt,
      result: { ...conversionResult, conversionCoverageIds: [] },
      resourceRefs: receipt.resourceRefs.filter((reference) => !conversionResult.conversionCoverageIds.includes(reference))
    };

    expect(conversionReceiptHasEvidence(historicalReceipt, input, previewEffect, effectHash)).toBe(true);
    expect(conversionReceiptHasEvidence(
      historicalReceipt,
      { propertyId: input.propertyId, orderId: input.orderId },
      undefined,
      effectHash
    )).toBe(true);
    const { conversionMode: _conversionMode, ...oldHistoricalResult } = historicalResult;
    const { protocolVersion: _protocolVersion, recoveryMode: _recoveryMode, ...unmarkedHistoricalReceipt } = historicalReceipt;
    expect(conversionReceiptHasEvidence({
      ...unmarkedHistoricalReceipt,
      result: oldHistoricalResult
    }, input, previewEffect, effectHash)).toBe(false);
    expect(conversionReceiptHasEvidence({ ...historicalReceipt, recoveryMode: undefined }, input, previewEffect, effectHash)).toBe(false);
    expect(conversionReceiptHasEvidence(missingCurrentCoverageReceipt, input, previewEffect, effectHash)).toBe(false);
    expect(conversionReceiptHasEvidence(partialReceipt, input, previewEffect, effectHash)).toBe(false);
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
      { result: { ...conversionResult, conversionCoverageIds: conversionResult.conversionCoverageIds.slice(0, -1) } },
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
      entitlementSummary: { currentConsumedCoverageDates: [], retainedHistoricalConsumedCoverageDates: [], restoredFutureCoverageDates: [], ledgerWriteCount: 0 },
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
        restoredFutureCoverageDates: [],
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

    const converted = structuredClone(effect);
    converted.entitlementSummary = {
      ...converted.entitlementSummary,
      restoredFutureCoverageDates: ["2026-08-03", "2026-08-04"],
      ledgerWriteCount: 2
    } as typeof converted.entitlementSummary;
    expect(u1PreviewHasBusinessEvidence("SHORTEN_STAY", converted, input)).toBe(true);
    const effectHash = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const convertedReceipt = {
      receiptId: "receipt_converted_shorten",
      commandId: "command_converted_shorten",
      executionStatus: "EXECUTED" as const,
      businessCommitted: true,
      correlationId: "correlation_converted_shorten",
      result: {
        orderId: "order_member",
        stayId: "stay_member",
        arrangementAmendmentId: "amendment_converted_shorten",
        checkoutAmendmentId: null,
        staySegmentId: "segment_converted_shorten",
        pricingRevisionId: "revision_converted_shorten",
        completionMode: "SHORTEN_IN_HOUSE",
        businessDate: "2026-08-02",
        arrivalDate: "2026-08-01",
        departureDate: "2026-08-03",
        before: converted.before,
        after: converted.after,
        pricingDecision: converted.pricingDecision,
        inventoryChange: converted.inventoryChange,
        entitlementSummary: converted.entitlementSummary,
        fundsSummary: converted.fundsSummary,
        refundReferenceAmount: converted.refundReferenceAmount,
        fulfillmentTiming: null,
        effectHash
      },
      resourceRefs: ["order_member", "stay_member", "amendment_converted_shorten", "segment_converted_shorten", "revision_converted_shorten"],
      factRefs: ["ledger_restore_03", "ledger_restore_04"],
      committedAt: "2026-08-02T10:00:00.000Z"
    };
    expect(receiptHasCommandEvidence("SHORTEN_STAY", convertedReceipt, input, converted, effectHash)).toBe(true);
    expect(receiptHasCommandEvidence("SHORTEN_STAY", { ...convertedReceipt, factRefs: ["ledger_restore_03"] }, input, converted, effectHash)).toBe(false);
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
