import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReceiptDto } from "@qintopia/contracts";

// Run only CommandDialog's hooks; child rendering uses React's normal SSR dispatcher.
// This exercises its real effects and button handlers without installing a browser runtime.
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, slots: [] as any[], effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  return { ...actual,
    useState(initial: any) {
      if (!hooks.active) return actual.useState(initial);
      const i = hooks.cursor++;
      hooks.slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks.slots[i].value, (value: any) => { hooks.slots[i].value = typeof value === "function" ? value(hooks.slots[i].value) : value; }];
    },
    useRef(initial: any) {
      if (!hooks.active) return actual.useRef(initial);
      const i = hooks.cursor++;
      return hooks.slots[i] ??= { current: initial };
    },
    useMemo(fn: () => any, deps: readonly unknown[]) {
      if (!hooks.active) return actual.useMemo(fn, deps);
      const i = hooks.cursor++;
      if (!sameDeps(hooks.slots[i]?.deps, deps)) hooks.slots[i] = { deps, value: fn() };
      return hooks.slots[i].value;
    },
    useEffect(fn: () => any, deps?: readonly unknown[]) {
      if (!hooks.active) return actual.useEffect(fn, deps);
      const i = hooks.cursor++;
      if (sameDeps(hooks.slots[i]?.deps, deps)) return;
      const previous = hooks.slots[i];
      hooks.slots[i] = { deps };
      hooks.effects.push(() => { previous?.cleanup?.(); hooks.slots[i].cleanup = fn(); });
    }
  };
});
import { api } from "./api";
import {
  CommandDialog, clearTerminalPersistedCommandRecoveryIfPresent, commandRecoverySnapshotIsBlocked,
  readPersistedCommandRecovery, recoveryCommandRequest, savePersistedCommandRecovery, transitionPersistedCommandRecovery,
  type CommandRecoveryStorage, type PersistedCommandRecovery
} from "./ui";

const effectHash = "a".repeat(64);
const zero = { currency: "CNY", minorUnits: 0 };
const receipt: ReceiptDto = {
  receiptId: "receipt_extension", commandId: "command_extension", commandType: "EXTEND_STAY",
  executionStatus: "EXECUTED", businessCommitted: true, correlationId: "correlation_extension", committedAt: "2026-08-01T01:00:00Z",
  resourceRefs: ["order_extension", "stay_extension", "amendment_extension", "segment_extension", "revision_extension"], factRefs: [],
  result: {
    orderId: "order_extension", stayId: "stay_extension", amendmentId: "amendment_extension", staySegmentId: "segment_extension", pricingRevisionId: "revision_extension",
    arrivalDate: "2026-08-01", departureDate: "2026-08-03", effectHash,
    before: { arrivalDate: "2026-08-01", departureDate: "2026-08-02", nights: 1, currentContractAmount: zero,
      stayTimeline: [{ serviceDate: "2026-08-01", inventoryUnitId: "unit_extension" }] },
    after: { arrivalDate: "2026-08-01", departureDate: "2026-08-03", nights: 2,
      stayTimeline: ["2026-08-01", "2026-08-02"].map(serviceDate => ({ serviceDate, inventoryUnitId: "unit_extension" })),
      pricing: { coverageSet: [], cashLines: [], cashRemainder: zero, currentContractAmount: zero } },
    pricingDecision: { pricingBasis: "FREE", policyBaseAmount: zero, targetCurrentContractAmount: zero, differenceFromPolicy: zero,
      manualAdjustmentMinor: 0, differenceExceedsThreshold: false, reason: { code: "EXTEND_STAY_FREE", note: "" } },
    inventoryChange: { preservedDates: ["2026-08-01"], releasedDates: [], addedDates: ["2026-08-02"] },
    entitlementChange: { preservedCoverageDates: [], releasedCoverageDates: [], addedCoverageDates: [], consumedCoverageDates: [] },
    fundsSummary: { netRecordedCollection: zero, collectionDifference: zero }
  }
};
const recovery: PersistedCommandRecovery = {
  version: 1, subjectId: "subject_extension", scopeId: "property:property_extension", propertyId: "property_extension",
  commandType: "EXTEND_STAY", confirmationKey: "original_extension_confirmation", targetRefs: ["orderId=order_extension"],
  presentation: "STAY_DATES", effectHash, state: "UNKNOWN", updatedAt: "2026-08-01T01:00:00Z"
};
function walk(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(item => walk(item, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<any>;
  return predicate(element) ? element : walk(element.props.children, predicate) ?? walk(element.props.footer, predicate);
}
const markup = (tree: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, tree));
function mount(props: Parameters<typeof CommandDialog>[0]) {
  let tree: ReactElement;
  const render = () => {
    hooks.cursor = 0; hooks.active = true;
    try { tree = CommandDialog(props); } finally { hooks.active = false; }
    hooks.effects.splice(0).forEach(effect => effect());
    return tree;
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) { await Promise.resolve(); render(); }
    return tree!;
  };
  render();
  return { settle, clickQuery() {
    const button = walk(tree!, element => element.type === "button" && markup(element).includes("查询原操作结果"));
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBe(false);
    button!.props.onClick();
  } };
}
function memoryStorage(): CommandRecoveryStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { hooks.slots.forEach(slot => slot?.cleanup?.()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Current API receipt recovery through CommandDialog", () => {
  it.each(["PREVIEW:RECORD_COLLECTION", "RECORD_REFUND", undefined] as const)("never reports a cached %s preview or foreign receipt as successful collection", async commandType => {
    const initialReceipt: ReceiptDto = { ...receipt, ...(commandType ? { commandType } : {}),
      result: { preview: { previewId: "preview_collection", commandType: "RECORD_COLLECTION" } } };
    if (commandType === undefined) delete initialReceipt.commandType;
    const onCommitted = vi.fn();
    const onClose = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dialog = mount({ request: { commandType: "RECORD_COLLECTION", title: "登记收款", description: "核对结果", input: { propertyId: recovery.propertyId, orderId: "order_extension" } },
      initialConfirmationKey: "original_collection_key", initialReceipt, onCommitted, onClose });
    const html = markup(await dialog.settle());
    expect(html).not.toContain("收款已登记");
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finishes a cached current extension receipt once without another API write", async () => {
    const onCommitted = vi.fn();
    const onClose = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const dialog = mount({ request: recoveryCommandRequest(recovery), initialConfirmationKey: recovery.confirmationKey,
      initialReceipt: receipt, onCommitted, onClose });
    await dialog.settle();
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ receipt });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["preview identity", "another command", "legacy preview", "changed effect"])("keeps %s unresolved, then accepts the original business receipt and clears its write block", async (invalidKind) => {
    const invalid: ReceiptDto = invalidKind === "preview identity" ? { ...receipt, commandType: "PREVIEW:EXTEND_STAY" }
      : invalidKind === "another command" ? { ...receipt, commandType: "SHORTEN_STAY" }
        : invalidKind === "legacy preview" ? { ...receipt, result: { preview: { previewId: "preview_extension", commandType: "EXTEND_STAY" } } }
          : { ...receipt, result: { ...receipt.result, effectHash: "b".repeat(64) } };
    if (invalidKind === "legacy preview") delete invalid.commandType;
    const responses = [invalid, receipt];
    const fetch = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const preview = vi.spyOn(api, "preview");
    const confirm = vi.spyOn(api, "confirm");
    const storage = memoryStorage();
    expect(savePersistedCommandRecovery(storage, recovery)).toBe(true);
    const request = recoveryCommandRequest(recovery);
    const onCommitted = vi.fn();
    const onClose = vi.fn((context?: Parameters<Parameters<typeof CommandDialog>[0]["onClose"]>[0]) => {
      expect(context?.receipt.commandType).toBe("EXTEND_STAY");
      expect(clearTerminalPersistedCommandRecoveryIfPresent(storage, recovery.subjectId, recovery.scopeId).kind).toBe("ABSENT");
    });
    const dialog = mount({ request, initialConfirmationKey: recovery.confirmationKey, onCommitted, onClose,
      onProgress(progress) {
        const read = readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId);
        const next = transitionPersistedCommandRecovery(read.kind === "VALID" ? read.recovery : undefined,
          { subjectId: recovery.subjectId, scopeId: recovery.scopeId, request }, progress);
        return next.accepted && Boolean(next.recovery && savePersistedCommandRecovery(storage, next.recovery));
      }
    });
    const blocked = () => commandRecoverySnapshotIsBlocked(readPersistedCommandRecovery(storage, recovery.subjectId, recovery.scopeId), { kind: "ABSENT" });
    expect(blocked()).toBe(true);
    await dialog.settle();
    dialog.clickQuery();
    expect(markup(await dialog.settle())).toContain("服务端返回的操作结果无法核对");
    expect(blocked()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    dialog.clickQuery();
    await dialog.settle();
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ receipt });
    expect(blocked()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe("/api/v1/command-results/resolve");
      expect(JSON.parse(String(init.body))).toEqual({ propertyId: recovery.propertyId, commandType: "EXTEND_STAY", idempotencyKey: recovery.confirmationKey });
    }
    expect(preview).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
