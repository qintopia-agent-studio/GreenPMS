import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { PaymentReconciliationItem, PaymentReconciliationResponse, PaymentReconciliationTotals, WorkbenchExceptionItem, WorkbenchExceptionsResponse } from "@qintopia/contracts";
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
type Scenario = "complete" | "empty" | "error" | "page-error" | "slow";
let scenario: Scenario = "complete";
const businessDate = localDateInTimeZone("Asia/Shanghai");
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
  const base = {
    orderId: id, orderStatus: "CANCELLED", stayStatus: "CANCELLED", guestName: `${propertyId === "sample-a" ? "青禾" : "溪谷"}样本住客 ${index + 1}`, arrivalDate: "2026-09-01", departureDate: "2026-09-03", unitLabel: `样本房间 ${index + 1}`, orderHref: `/orders/${id}`
  };
  if (index === 0) return { ...base, reasons: [
    { code: "REFUND_DUE", category: "FUNDS", message: "应退未退（已扣除客户确认的剩余留存）", amount: { currency: "CNY", minorUnits: 40000 } },
    { code: "INVENTORY_NOT_RELEASED", category: "INVENTORY", message: "已取消订单仍有有效库存占用", amount: null }
  ] };
  if (index === 1) return { ...base, orderStatus: "CHECKED_IN", stayStatus: "IN_HOUSE", reasons: [
    { code: "OVERDUE_DEPARTURE", category: "FULFILLMENT", message: "计划离店日已过，需核对实际离店情况", amount: null },
    { code: "BALANCE_DUE", category: "FUNDS", message: "欠款待收", amount: { currency: "CNY", minorUnits: 12000 } }
  ] };
  if (index === 2) return { ...base, reasons: [{ code: "CHANNEL_DATA_REVIEW", category: "DATA", message: "渠道经营事实未初始化，请核对渠道应结与退款记录", amount: null }] };
  return { ...base, reasons: [{ code: "REFUND_DUE", category: "FUNDS", message: "应退未退", amount: { currency: "CNY", minorUnits: 8000 } }] };
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
  const totalOrders = requestedScenario === "empty" ? 0 : query.propertyId === "sample-b" ? 1 : 51;
  const start = query.afterId ? Number(query.afterId.split("-").at(-1)) + 1 : 0;
  const items = Array.from({ length: Math.min(query.limit ?? 50, Math.max(totalOrders - start, 0)) }, (_, i) => sampleItem(start + i, query.propertyId));
  return { propertyId: query.propertyId, businessDate, asOf: new Date().toISOString(), totalOrders, items, nextCursor: start + items.length < totalOrders ? items.at(-1)!.orderId : null };
};
function samplePayments(propertyId: string): PaymentReconciliationItem[] {
  const pairReference = "SAMPLE-COLLECTION-20261105-LOCAL-PREVIEW-000000000000000001";
  const base = {
    factId: null, membershipOrderId: null, currency: "CNY", excessMinor: "0",
    occurredAt: "2026-11-05T06:30:00Z", discoveredAt: "2026-11-05T06:35:00Z"
  };
  const items: PaymentReconciliationItem[] = [
    { ...base, id: "sample-payment-001", billId: "sample-bill-001", kind: "COLLECTION", reference: pairReference,
      originalTransactionReference: null, nickname: "样本付款人甲（收退均漏记）", orderId: null, orderIds: [],
      amountMinor: 90000, allocatedMinor: "0", businessMinor: "0", unassignedMinor: "90000",
      issues: [{ code: "UNASSIGNED", message: "该笔收款尚未关联业务，需核实所属订单并登记" }] },
    { ...base, id: "sample-payment-002", billId: "sample-bill-002", kind: "REFUND",
      reference: "SAMPLE-REFUND-20261105-LOCAL-PREVIEW-ORIGINAL-COLLECTION-000000000000000001",
      originalTransactionReference: pairReference, nickname: "样本付款人甲（收退均漏记）", orderId: null, orderIds: [],
      amountMinor: 90000, allocatedMinor: "0", businessMinor: "0", unassignedMinor: "90000",
      occurredAt: "2026-11-05T07:10:00Z", discoveredAt: "2026-11-05T07:15:00Z",
      issues: [{ code: "UNASSIGNED", message: "该笔退款尚未关联业务；收退净额为零仍须分别核对" }] },
    { ...base, id: "sample-payment-003", billId: "sample-bill-003", kind: "COLLECTION",
      reference: "SAMPLE-COLLECTION-20261105-LOCAL-PREVIEW-PARTIAL-000000000000000003",
      originalTransactionReference: null, nickname: "样本付款人乙", orderId: "sample-order-001", orderIds: ["sample-order-001"],
      amountMinor: 128000, allocatedMinor: "80000", businessMinor: "80000", unassignedMinor: "48000",
      issues: [{ code: "UNASSIGNED", message: "该笔收款已登记一部分，剩余份额仍待核实业务归属" }] },
    { ...base, id: "sample-payment-004", billId: "sample-bill-004", kind: "REFUND",
      reference: "SAMPLE-REFUND-20261105-LOCAL-PREVIEW-PARTIAL-000000000000000004",
      originalTransactionReference: "SAMPLE-COLLECTION-20261101-LOCAL-PREVIEW-000000000000000004",
      nickname: "样本付款人丙", orderId: "sample-order-000", orderIds: ["sample-order-000"],
      amountMinor: 24000, allocatedMinor: "8000", businessMinor: "8000", unassignedMinor: "16000",
      issues: [{ code: "UNASSIGNED", message: "该笔退款已登记一部分，请核对原收款及本单退款份额" }] }
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
  if (requestedScenario === "error" || requestedScenario === "page-error" && query.afterId) throw new Error("虚构失败场景：收退款核对暂不可用");
  const all = (requestedScenario === "empty" ? [] : samplePayments(query.propertyId))
    .filter((item) => (!query.kind || query.kind === "ALL" || item.kind === query.kind) && (!query.orderId || item.orderIds.includes(query.orderId)));
  const remaining = query.afterId ? all.filter((item) => item.id > query.afterId!) : all;
  const items = remaining.slice(0, query.limit ?? 50);
  const asOf = new Date().toISOString();
  return {
    propertyId: query.propertyId, asOf, sync: { enabled: true, lastSyncedAt: asOf, hasError: false },
    summary: { collections: samplePaymentTotals(all, "COLLECTION"), refunds: samplePaymentTotals(all, "REFUND") },
    totalItems: all.length, items, nextCursor: remaining.length > items.length ? items.at(-1)!.id : null
  };
};
function Preview() {
  const [activeScenario, setActiveScenario] = useState<Scenario>("complete");
  const { propertyId, setPropertyId } = useWorkspace();
  return <main className="workbench-preview-main">
    <aside className="workbench-preview-banner"><strong>虚构样本 · 只读预览</strong><span>无登录、无生产连接；展示真实工作台组件。</span>
      <label>门店<select aria-label="样本门店" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>{meta.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>场景<select aria-label="样本场景" value={activeScenario} onChange={(event) => { scenario = event.target.value as Scenario; setActiveScenario(scenario); }}>
        <option value="complete">完整异常 · 51 单分页 / 4 笔流水</option><option value="empty">正常取消 · 零异常</option><option value="error">请求失败</option><option value="page-error">订单第二页失败</option><option value="slow">超时请求</option>
      </select></label>
    </aside>
    <Routes><Route path="/" element={<TodayPage key={activeScenario} />} /><Route path="/orders" element={<SampleOrderSearch />} /><Route path="/orders/:orderId" element={<SampleOrder />} /></Routes>
  </main>;
}
function SampleOrderSearch() {
  return <section className="today-queue workbench-preview-record"><h1>查找所属订单 · 虚构只读示例</h1><p>此入口仅验证页面跳转，不自动认定流水归属，也不登记收款或退款。正式界面需核实客人、住期和付款依据后再选择订单。</p><Link className="button button-secondary" to="/orders/sample-order-000">查看虚构订单示例</Link><Link className="button button-secondary" to="/">返回工作台</Link></section>;
}
function SampleOrder() {
  const { orderId } = useParams();
  return <section className="today-queue workbench-preview-record"><h1>虚构订单入口</h1><p>{orderId}</p><p>正式界面会进入已有订单详情和经过权限校验的处理入口。</p><Link className="button button-secondary" to="/">返回工作台</Link></section>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter><WorkspaceProvider principal={principal}><Preview /></WorkspaceProvider></MemoryRouter></StrictMode>);
