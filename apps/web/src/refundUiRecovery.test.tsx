import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderViewDto, CollectionFactDto } from "./types";
import type { PaymentReconciliationResponse } from "@qintopia/contracts";

const hooks = vi.hoisted(() => ({ current: undefined as undefined | { cursor: number; slots: any[]; effects: (() => void)[] } }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
  return { ...actual,
    useState(initial: any) { const h = hooks.current; if (!h) return actual.useState(initial); const i = h.cursor++; h.slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [h.slots[i].value, (next: any) => { h.slots[i].value = typeof next === "function" ? next(h.slots[i].value) : next; }]; },
    useRef(initial: any) { const h = hooks.current; if (!h) return actual.useRef(initial); return h.slots[h.cursor++] ??= { current: initial }; },
    useId() { const h = hooks.current; if (!h) return actual.useId(); return `test-id-${h.cursor++}`; },
    useEffect(fn: () => any, deps?: unknown[]) { const h = hooks.current; if (!h) return actual.useEffect(fn, deps); const i = h.cursor++; if (same(h.slots[i]?.deps, deps)) return; const old = h.slots[i]; h.slots[i] = { deps }; h.effects.push(() => { old?.cleanup?.(); h.slots[i].cleanup = fn(); }); }
  };
});
import { api } from "./api";
import { ExternalPaymentPicker, type PaymentItem } from "./components/ExternalPaymentPicker";
import { OrderFundsFormDialog } from "./components/OrderFundsFormDialog";
import { usePaymentReconciliation } from "./paymentReconciliation";

const runtimes: Array<{ dispose: () => void }> = [];
function runtime<T>(renderComponent: () => T) {
  const h = { cursor: 0, slots: [] as any[], effects: [] as (() => void)[] };
  let output: T;
  const render = () => { h.cursor = 0; hooks.current = h; try { output = renderComponent(); } finally { hooks.current = undefined; } h.effects.splice(0).forEach(effect => effect()); return output; };
  const result = { render, settle: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } return output!; }, dispose: () => h.slots.forEach(slot => slot?.cleanup?.()) };
  runtimes.push(result); render(); return result;
}
function find(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<any>;
  return predicate(element) ? element : find(element.props.children, predicate) ?? find(element.props.footer, predicate);
}
function byId(node: ReactNode, id: string) { return find(node, element => element.props["data-testid"] === id)!; }
function button(node: ReactNode, label: string) { return find(node, element => element.type === "button" && renderToStaticMarkup(element).includes(label))!; }
function bill(id = "source", kind: "COLLECTION" | "REFUND" = "COLLECTION"): PaymentItem {
  return { id, kind, reference: id, amountMinor: 100000, remainingMinor: 60000, allocatedMinor: 40000, status: "PARTIALLY_MATCHED", nickname: "合成付款人", occurredAt: "2026-11-01T08:00:00Z", recommendationReasons: [], allocations: [] } as unknown as PaymentItem;
}
const list = (items: PaymentItem[] = []) => ({ enabled: true, items, hasMore: false, nextBeforeId: null, lastSyncedAt: "2026-11-01T08:00:00Z", synchronizationError: false });
function fact(id = "recorded", overrides: Partial<CollectionFactDto> = {}): CollectionFactDto {
  return { fact_id: id, fact_type: "COLLECTION", amount_minor: 40000, net_effect_minor: 40000, currency: "CNY", method: "WECOM", external_payment_bill_id: "source", transaction_reference: "source", references_fact_id: null, reverses_fact_id: null, created_at: "2026-11-01T08:00:00Z", ...overrides } as CollectionFactDto;
}
function order(facts = [fact()]): OrderViewDto { return { order: { id: "order_1", property_id: "property_1" }, collectionFacts: facts, refundReconciliationAvailable: true, amounts: { collectionDifference: { minorUnits: 0, currency: "CNY" }, refundReferenceAmount: { minorUnits: 40000, currency: "CNY" } } } as OrderViewDto; }
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout }); vi.spyOn(api, "retainedFunds").mockResolvedValue({ items: [], hasMore: false } as any); vi.spyOn(api, "paymentAllocations").mockResolvedValue(list() as any); });
afterEach(() => { runtimes.splice(0).forEach(r => r.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("retries a failed restored-bill lookup independently and ignores a late response after parent changes", async () => {
  let onResolve = vi.fn();
  let props = { propertyId: "property_1", kind: "REFUND" as const, value: "", billId: "refund", originalCollectionBillId: "source", allocationMode: true, onChange: vi.fn(), onResolve };
  let fail = true;
  const read = vi.mocked(api.paymentAllocations).mockImplementation(async query => {
    if (query.billId && fail) throw new Error("network interrupted");
    return list(query.billId ? [bill("refund", "REFUND")] : []) as any;
  });
  let picker = ExternalPaymentPicker(props) as ReactElement<any>;
  const r = runtime(() => (picker.type as (props: any) => ReactElement)(props));
  expect(renderToStaticMarkup(await r.settle())).toContain("重试原选流水");
  expect(onResolve).not.toHaveBeenCalledWith(expect.objectContaining({ id: "refund" }));
  fail = false;
  button(r.render(), "重试原选流水").props.onClick();
  await r.settle();
  expect(onResolve).toHaveBeenLastCalledWith(expect.objectContaining({ id: "refund" }));
  expect(renderToStaticMarkup(r.render())).not.toContain("重试原选流水");
  expect(read.mock.calls.filter(([query]) => query.billId).every(([query]) => query.originalCollectionBillId === "source")).toBe(true);
  r.dispose();
  let complete!: (value: any) => void;
  read.mockImplementation(async query => query.billId ? new Promise(resolve => { complete = resolve; }) : list() as any);
  props = { ...props, billId: "old-refund", onResolve: vi.fn() }; onResolve = props.onResolve;
  const stale = runtime(() => (picker.type as (props: any) => ReactElement)(props));
  await stale.settle(); stale.dispose();
  complete(list([bill("old-refund", "REFUND")])); await Promise.resolve(); await Promise.resolve();
  expect(onResolve).not.toHaveBeenCalledWith(expect.objectContaining({ id: "old-refund" }));
});

it("automatically retries a failed restored identity on the next cycle", async () => {
  let attempts = 0; const onResolve = vi.fn();
  vi.mocked(api.paymentAllocations).mockImplementation(async query => {
    if (query.billId && ++attempts === 1) throw new Error("transient");
    return list(query.billId ? [bill()] : []) as any;
  });
  const picker = ExternalPaymentPicker({ propertyId: "property_1", value: "", billId: "source", allocationMode: true, onChange: vi.fn(), onResolve }) as ReactElement<any>;
  const r = runtime(() => (picker.type as (props: any) => ReactElement)(picker.props));
  await r.settle(); await vi.advanceTimersByTimeAsync(15000); await r.settle();
  expect(attempts).toBe(2); expect(onResolve).toHaveBeenLastCalledWith(expect.objectContaining({ id: "source" }));
});

it.each(["available", "reversed", "refunded"])("routes %s existing source shares correctly before explicit grouped backfill", async status => {
  const facts = [fact()];
  if (status === "reversed") facts.push(fact("reversal", { fact_type: "REVERSAL", reverses_fact_id: "recorded", amount_minor: 40000 }));
  if (status === "refunded") facts.push(fact("refund", { fact_type: "REFUND", references_fact_id: "recorded", amount_minor: 40000 }));
  const root = runtime(() => OrderFundsFormDialog({ view: order(facts), action: "RECORD_COLLECTION", onClose: vi.fn(), onSubmit: vi.fn() }));
  let child = root.render() as ReactElement<any>;
  const form = runtime(() => (child.type as (props: any) => ReactElement)(child.props));
  const tree = await form.settle();
  const picker = find(tree, element => element.type === ExternalPaymentPicker)!;
  expect(picker.props.onReconcile).toBeTypeOf("function"); picker.props.onReconcile(bill());
  child = root.render() as ReactElement<any>;
  if (status === "available") { expect(child.props.action).toBe("RECORD_REFUND"); expect(child.props.initialFactId).toBe("recorded"); }
  else expect(child.props.initialSource.id).toBe("source");
});

it("preserves unsubmitted grouped rows and ordinary refund edits across mode changes", async () => {
  const root = runtime(() => OrderFundsFormDialog({ view: order(), action: "RECORD_REFUND", onClose: vi.fn(), onSubmit: vi.fn() }));
  let child = root.render() as ReactElement<any>;
  let form = runtime(() => (child.type as (props: any) => ReactElement)(child.props));
  await form.settle();
  byId(form.render(), "fact-amount-yuan").props.onChange({ target: { value: "123.45" } });
  byId(form.render(), "refund-reason").props.onChange({ target: { value: "已有原款的退款说明" } });
  button(form.render(), "还有漏记份额，一起补齐").props.onClick(); form.dispose();
  child = root.render() as ReactElement<any>; form = runtime(() => (child.type as (props: any) => ReactElement)(child.props));
  find(form.render(), element => element.type === ExternalPaymentPicker)!.props.onChange("source", bill());
  byId(form.render(), "reconciliation-source-amount").props.onChange({ target: { value: "500.25" } });
  byId(form.render(), "reconciliation-refund-amount-0").props.onChange({ target: { value: "200.10" } });
  button(form.render(), "添加另一笔关联退款").props.onClick();
  byId(form.render(), "reconciliation-refund-amount-1").props.onChange({ target: { value: "300.15" } });
  byId(form.render(), "reconciliation-note").props.onChange({ target: { value: "两笔漏记退款说明" } });
  button(form.render(), "返回选择已有原收款").props.onClick(); form.dispose();
  child = root.render() as ReactElement<any>; form = runtime(() => (child.type as (props: any) => ReactElement)(child.props));
  await form.settle();
  expect(byId(form.render(), "fact-amount-yuan").props.value).toBe("123.45");
  expect(byId(form.render(), "refund-reason").props.value).toBe("已有原款的退款说明");
  button(form.render(), "还有漏记份额，一起补齐").props.onClick(); form.dispose();
  child = root.render() as ReactElement<any>; form = runtime(() => (child.type as (props: any) => ReactElement)(child.props));
  expect(byId(form.render(), "reconciliation-source-amount").props.value).toBe("500.25");
  expect(byId(form.render(), "reconciliation-refund-amount-0").props.value).toBe("200.10");
  expect(byId(form.render(), "reconciliation-refund-amount-1").props.value).toBe("300.15");
  expect(byId(form.render(), "reconciliation-note").props.value).toBe("两笔漏记退款说明");
});

it("reads the initial count once and polls only the visible exceptions tab", async () => {
  const listeners = new Set<() => void>();
  const documentStub = { visibilityState: "visible", addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  vi.stubGlobal("document", documentStub);
  const totals = { externalMinor: "0", businessMinor: "0", unassignedMinor: "0", excessMinor: "0", unbackedMinor: "0", unknownCount: 0 };
  const response: PaymentReconciliationResponse = {
    propertyId: "property_1", asOf: "2026-11-06T08:00:00Z",
    sync: { enabled: true, lastSyncedAt: "2026-11-06T08:00:00Z", hasError: false },
    summary: { collections: { ...totals }, refunds: { ...totals } }, items: [], totalItems: 0, nextCursor: null
  };
  const read = vi.fn().mockResolvedValue(response);
  let active = false;
  const r = runtime(() => usePaymentReconciliation("property_1", 0, active, read));
  await r.settle(); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(45000); await r.settle(); expect(read).toHaveBeenCalledTimes(1);
  active = true; await r.settle(); expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000); await r.settle(); expect(read).toHaveBeenCalledTimes(3);
  documentStub.visibilityState = "hidden"; listeners.forEach(fn => fn()); await r.settle();
  await vi.advanceTimersByTimeAsync(45000); await r.settle(); expect(read).toHaveBeenCalledTimes(3);
  documentStub.visibilityState = "visible"; listeners.forEach(fn => fn()); await r.settle(); expect(read).toHaveBeenCalledTimes(4);
  active = false; await r.settle(); await vi.advanceTimersByTimeAsync(45000); await r.settle(); expect(read).toHaveBeenCalledTimes(4);
});
