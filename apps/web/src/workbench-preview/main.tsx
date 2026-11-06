import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { workbenchExceptionGroupFor, type PaymentReconciliationItem, type PaymentReconciliationResponse, type PaymentReconciliationTotals, type WorkbenchExceptionItem, type WorkbenchExceptionsResponse } from "@qintopia/contracts";
import { api } from "../api";
import { TodayPage } from "../pages/TodayPage";
import { useWorkspace, WorkspaceProvider } from "../session";
import { localDateInTimeZone } from "../dates";
import type { MetaDto, OrderRowDto, PrincipalDto } from "../types";
import "@fontsource-variable/noto-sans-sc";
import "../styles.css";
import "./preview.css";

// This standalone Vite development entry never calls a backend or enables writes.
if (!import.meta.env.DEV) throw new Error("虚构样本仅用于本地开发预览");
type Scenario = "complete" | "empty" | "error" | "page-error" | "slow" | "payment-error";
let scenario: Scenario = "complete";
const businessDate = localDateInTimeZone("Asia/Shanghai");
function dayFromToday(offset: number) {
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
const meta: MetaDto = {
  properties: ["a", "b"].map((id) => ({ id: `sample-${id}`, code: `SAMPLE-${id}`, name: id === "a" ? "青禾社区 · 虚构" : "溪谷社区 · 虚构", timezone: "Asia/Shanghai", currency: "CNY" })),
  inventoryUnits: [], pricingPolicyVersions: [], members: [], memberContracts: [], membershipProducts: []
};
const principal: PrincipalDto = {
  subjectId: "workbench-preview-reader", displayName: "虚构只读验收", credentialType: "SESSION",
  propertyAccess: { "sample-a": "READ", "sample-b": "READ" }, propertyCommandGrants: {}, allowedActions: {}
};
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal?.reason); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function ordinaryOrder(id: string, status: string): OrderRowDto {
  return {
    id, status, property_id: "sample-a", stay_status: status === "RESERVED" ? "PLANNED" : status === "CHECKED_IN" ? "IN_HOUSE" : "CANCELLED", stay_type: "TRANSIENT",
    arrival_date: businessDate, departure_date: businessDate, primary_guest_snapshot: { nickname: `虚构住客 ${id}` }, booking_channel_code: "WECOM", channel_order_reference: null, free_stay_reason: null, free_stay_category_code: null,
    pricing_policy_version_id: "sample-policy", member_id: null, member_contract_id: null, current_revision_id: "sample-revision", current_contract_amount_minor: 0, currency: "CNY", version: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z"
  };
}
function sampleItem(index: number, propertyId: string): WorkbenchExceptionItem {
  const id = `sample-order-${String(index).padStart(3, "0")}`;
  const names = ["林同学", "陈同学", "周同学", "许同学", "赵同学", "唐同学"];
  const base = {
    orderId: id, orderStatus: "CANCELLED", stayStatus: "CANCELLED", guestName: `示例·${names[index] ?? `住客${index + 1}`}${propertyId === "sample-b" ? "（溪谷）" : ""}`, arrivalDate: dayFromToday(-3), departureDate: dayFromToday(-1), unitLabel: `演示 A${String(index + 1).padStart(2, "0")}`, orderHref: `/orders/${id}`
  };
  if (index === 0) return { ...base, reasons: [
    { code: "REFUND_DUE", category: "FUNDS", message: "订单里还有款项待退，请先确认是否已经退款", amount: { currency: "CNY", minorUnits: 40000 } },
    { code: "INVENTORY_NOT_RELEASED", category: "INVENTORY", message: "订单已取消，房间或床位仍被这张订单占用", amount: null }
  ] };
  if (index === 1) return { ...base, orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE", reasons: [
    { code: "OVERDUE_DEPARTURE", category: "FULFILLMENT", message: `${dayFromToday(-1)} 应离店，仍显示在住，请确认退房或续住`, amount: null },
    { code: "BALANCE_DUE", category: "FUNDS", message: "订单里还有住宿款未收齐", amount: { currency: "CNY", minorUnits: 12000 } }
  ] };
  if (index === 2) return { ...base, orderStatus: "RESERVED", stayStatus: "PLANNED", arrivalDate: dayFromToday(-1), departureDate: dayFromToday(2), reasons: [
    { code: "OVERDUE_ARRIVAL", category: "FULFILLMENT", message: `${dayFromToday(-1)} 应到店，还没办理入住，请确认客人是否到店`, amount: null }
  ] };
  if (index === 3) return { ...base, orderStatus: "CHECKED_OUT", stayStatus: "IN_HOUSE", reasons: [
    { code: "LIFECYCLE_INCONSISTENT", category: "DATA", message: "订单显示的入住或退房情况，与住宿记录对不上", amount: null }
  ] };
  if (index === 4) return { ...base, reasons: [{ code: "CHANNEL_DATA_REVIEW", category: "DATA", message: "平台订单的成交、退款或历史账资料不完整，请先核实这些记录", amount: null }] };
  if (index === 5) return { ...base, reasons: [{ code: "COVERAGE_NOT_RELEASED", category: "INVENTORY", message: "订单已取消，仍占着会员可用的住宿额度", amount: null }] };
  return { ...base, reasons: [{ code: "REFUND_DUE", category: "FUNDS", message: "订单里还有款项待退，请先确认是否已经退款", amount: { currency: "CNY", minorUnits: 8000 } }] };
}
api.meta = async () => meta;
api.orders = async (propertyId, _status, options) => {
  await delay(150, options?.signal);
  return { businessDate, orders: [ordinaryOrder("到店样本", "RESERVED"), ordinaryOrder("离店样本", "CHECKED_IN"), ordinaryOrder("正常取消样本", "CANCELLED")].map((order) => ({ ...order, property_id: propertyId })) };
};
api.workbenchExceptions = async (query, signal): Promise<WorkbenchExceptionsResponse> => {
  const requestedScenario = scenario;
  await delay(requestedScenario === "slow" ? 16000 : 250, signal);
  if (requestedScenario === "error" || requestedScenario === "page-error" && query.afterId) throw new Error("虚构失败场景：异常查询暂不可用");
  const count = requestedScenario === "empty" ? 0 : query.propertyId === "sample-b" ? 1 : requestedScenario === "page-error" ? 55 : 6;
  const all = Array.from({ length: count }, (_, i) => sampleItem(i, query.propertyId));
  const selected = query.group ? all.map(item => ({ ...item, reasons: item.reasons.filter(reason => workbenchExceptionGroupFor(reason.code) === query.group) })).filter(item => item.reasons.length) : all;
  const remaining = query.afterId ? selected.filter(item => item.orderId > query.afterId!) : selected;
  const items = remaining.slice(0, query.limit ?? 50);
  return { propertyId: query.propertyId, businessDate, asOf: new Date().toISOString(), totalOrders: selected.length, groupCounts: { BUSINESS: all.filter(item => item.reasons.some(reason => workbenchExceptionGroupFor(reason.code) === "BUSINESS")).length, FINANCIAL: all.filter(item => item.reasons.some(reason => workbenchExceptionGroupFor(reason.code) === "FINANCIAL")).length }, items, nextCursor: remaining.length > items.length ? items.at(-1)!.orderId : null };
};
function samplePayments(propertyId: string): PaymentReconciliationItem[] {
  const pairReference = "SAMPLE-COLLECTION-20261105-LOCAL-PREVIEW-000000000000000001";
  const base = {
    factId: null, membershipOrderId: null, currency: "CNY", excessMinor: "0",
    occurredAt: `${dayFromToday(-1)}T06:30:00Z`, discoveredAt: `${dayFromToday(-1)}T06:35:00Z`
  };
  const items: PaymentReconciliationItem[] = [
    { ...base, id: "sample-payment-001", billId: "sample-bill-001", kind: "COLLECTION", reference: pairReference,
      originalTransactionReference: null, nickname: "示例·小秦", orderId: null, orderIds: [],
      amountMinor: 90000, allocatedMinor: "0", businessMinor: "0", unassignedMinor: "90000",
      issues: [{ code: "UNASSIGNED", message: "企微已经收款，订单里还没记全这笔收款。" }] },
    { ...base, id: "sample-payment-002", billId: "sample-bill-002", kind: "REFUND",
      reference: "SAMPLE-REFUND-20261105-LOCAL-PREVIEW-ORIGINAL-COLLECTION-000000000000000001",
      originalTransactionReference: pairReference, nickname: "示例·小秦", orderId: null, orderIds: [],
      amountMinor: 90000, allocatedMinor: "0", businessMinor: "0", unassignedMinor: "90000",
      occurredAt: `${dayFromToday(-1)}T07:10:00Z`, discoveredAt: `${dayFromToday(-1)}T07:15:00Z`,
      issues: [{ code: "UNASSIGNED", message: "企微已经退款，订单里还没记全这笔退款。" }] },
    { ...base, id: "sample-payment-003", billId: "sample-bill-003", kind: "COLLECTION",
      reference: "SAMPLE-COLLECTION-20261105-LOCAL-PREVIEW-PARTIAL-000000000000000003",
      originalTransactionReference: null, nickname: "示例·小程", orderId: "sample-order-001", orderIds: ["sample-order-001"],
      amountMinor: 128000, allocatedMinor: "80000", businessMinor: "80000", unassignedMinor: "48000",
      issues: [{ code: "UNASSIGNED", message: "企微已经收款，订单里还没记全这笔收款。" }] },
    { ...base, id: "sample-payment-004", billId: "sample-bill-004", kind: "REFUND",
      reference: "SAMPLE-REFUND-20261105-LOCAL-PREVIEW-PARTIAL-000000000000000004",
      originalTransactionReference: "SAMPLE-COLLECTION-20261101-LOCAL-PREVIEW-000000000000000004",
      nickname: "示例·小木", orderId: "sample-order-000", orderIds: ["sample-order-000"],
      amountMinor: 24000, allocatedMinor: "8000", businessMinor: "8000", unassignedMinor: "16000",
      issues: [{ code: "UNASSIGNED", message: "企微已经退款，订单里还没记全这笔退款。" }] }
  ];
  return propertyId === "sample-b" ? items.slice(-1) : items;
}
function samplePaymentTotals(items: PaymentReconciliationItem[], kind: PaymentReconciliationItem["kind"]): PaymentReconciliationTotals {
  const selected = items.filter((item) => item.kind === kind);
  const sum = (value: (item: PaymentReconciliationItem) => string) => selected.reduce((total, item) => total + BigInt(value(item)), 0n).toString();
  return {
    externalMinor: sum((item) => String(item.amountMinor ?? 0)), businessMinor: sum((item) => item.businessMinor),
    unassignedMinor: sum((item) => item.unassignedMinor ?? "0"), excessMinor: "0", unbackedMinor: "0", unknownCount: 0
  };
}
api.paymentReconciliation = async (query, signal): Promise<PaymentReconciliationResponse> => {
  const requestedScenario = scenario;
  await delay(requestedScenario === "slow" ? 16000 : 250, signal);
  if (requestedScenario === "error" || requestedScenario === "payment-error" || requestedScenario === "page-error" && query.afterId) throw new Error("演示：暂时取不到企微收退款记录");
  const all = (requestedScenario === "empty" ? [] : samplePayments(query.propertyId))
    .filter((item) => (!query.kind || query.kind === "ALL" || item.kind === query.kind) && (!query.orderId || item.orderIds.includes(query.orderId)));
  const remaining = query.afterId ? all.filter((item) => item.id > query.afterId!) : all;
  const items = remaining.slice(0, query.limit ?? 50);
  const asOf = new Date().toISOString();
  return {
    propertyId: query.propertyId, asOf, sync: { enabled: true, lastSyncedAt: asOf, hasError: false },
    summary: { collections: samplePaymentTotals(all, "COLLECTION"), refunds: samplePaymentTotals(all, "REFUND") },
    totalItems: all.length, totalOpenItems: requestedScenario === "empty" ? 0 : samplePayments(query.propertyId).filter(item => item.issues.length > 0).length, items, nextCursor: remaining.length > items.length ? items.at(-1)!.id : null
  };
};
function Preview() {
  const [activeScenario, setActiveScenario] = useState<Scenario>("complete");
  const { propertyId, setPropertyId } = useWorkspace();
  return <main className="workbench-preview-main">
    <aside className="workbench-preview-banner"><strong>演示页面</strong><span>这里都是示例，不会改动真实订单。</span>
      <label>门店<select aria-label="样本门店" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>{meta.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>场景<select aria-label="样本场景" value={activeScenario} onChange={(event) => { scenario = event.target.value as Scenario; setActiveScenario(scenario); }}>
        <option value="complete">业务与财务都有待办</option><option value="empty">没有待办</option><option value="error">暂时打不开清单</option><option value="payment-error">暂时取不到企微记录</option><option value="page-error">财务订单第二页打不开</option><option value="slow">长时间没有响应</option>
      </select></label>
    </aside>
    <Routes><Route path="/" element={<TodayPage key={activeScenario} />} /><Route path="/orders" element={<SampleOrderSearch />} /><Route path="/orders/:orderId" element={<SampleOrder />} /></Routes>
  </main>;
}
function SampleOrderSearch() {
  return <section className="today-queue workbench-preview-record"><h1>查找订单 · 演示</h1><p>请先确认客人、住宿日期和付款记录，再选择这笔钱对应的订单。这里不会登记真实收款或退款。</p><Link className="button button-secondary" to="/orders/sample-order-000">查看示例订单</Link><Link className="button button-secondary" to="/">返回工作台</Link></section>;
}
function SampleOrder() {
  const { orderId } = useParams();
  const index = Number(orderId?.split("-").at(-1) ?? 0);
  const item = sampleItem(Number.isFinite(index) ? index : 0, "sample-a");
  return <section className="today-queue workbench-preview-record"><h1>{item.guestName}的订单 · 演示</h1><p>{item.unitLabel} · {item.arrivalDate} 至 {item.departureDate}</p><p>正式使用时，可在订单里查看记录并办理入住、退房或收退款。这里不会改动真实订单。</p><Link className="button button-secondary" to="/">返回工作台</Link></section>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter><WorkspaceProvider principal={principal}><Preview /></WorkspaceProvider></MemoryRouter></StrictMode>);
