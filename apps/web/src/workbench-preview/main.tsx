import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { WorkbenchExceptionItem, WorkbenchExceptionsResponse } from "@qintopia/contracts";
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
function Preview() {
  const [activeScenario, setActiveScenario] = useState<Scenario>("complete");
  const { propertyId, setPropertyId } = useWorkspace();
  return <main className="workbench-preview-main">
    <aside className="workbench-preview-banner"><strong>虚构样本 · 只读预览</strong><span>无登录、无生产连接；展示真实工作台组件。</span>
      <label>门店<select aria-label="样本门店" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>{meta.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>场景<select aria-label="样本场景" value={activeScenario} onChange={(event) => { scenario = event.target.value as Scenario; setActiveScenario(scenario); }}>
        <option value="complete">完整异常 · 51 笔分页</option><option value="empty">正常取消 · 零异常</option><option value="error">请求失败</option><option value="page-error">第二页失败</option><option value="slow">超时请求</option>
      </select></label>
    </aside>
    <Routes><Route path="/" element={<TodayPage key={activeScenario} />} /><Route path="/orders/:orderId" element={<SampleOrder />} /></Routes>
  </main>;
}
function SampleOrder() {
  const { orderId } = useParams();
  return <section className="today-queue workbench-preview-record"><h1>虚构订单入口</h1><p>{orderId}</p><p>正式界面会进入已有订单详情和经过权限校验的处理入口。</p><Link className="button button-secondary" to="/">返回工作台</Link></section>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><MemoryRouter><WorkspaceProvider principal={principal}><Preview /></WorkspaceProvider></MemoryRouter></StrictMode>);
