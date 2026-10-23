import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { DashboardDetail } from "@qintopia/contracts";
import { businessStatusLabel } from "../uiBasic";
import { money } from "./dashboard-state";

type FollowupMetric = "TODAY_ORDERS" | "DEBT" | "RETAINED";
type OrderSummary = DashboardDetail["orderSummary"];

function Guests({ summary }: { summary: OrderSummary }) {
  return summary?.occupants.length ? <>{summary.occupants.map((guest, index) => <div className="dashboard-reception-guest" key={index}><strong>{guest.name || "住客姓名待补充"}</strong><small>{guest.isPrimary ? "主住客" : "同行人"}</small></div>)}</> : <span className="dashboard-muted">住客登记待补充</span>;
}
function Rooms({ summary }: { summary: OrderSummary }) {
  return summary?.rooms.length ? <>{summary.rooms.map((room, index) => <div key={index}><strong>{room.roomCode || "房间待核对"}</strong>{room.buildingCode ? <small>{room.buildingCode}</small> : null}</div>)}</> : <span className="dashboard-muted">房间待核对</span>;
}
function OrderLink({ item, retained }: { item: DashboardDetail; retained: boolean }) {
  return <><span>{item.orderSummary ? businessStatusLabel(item.orderSummary.status) : "订单状态待核对"}</span>{item.orderId ? <Link className="dashboard-resident-link" to={`/orders/${encodeURIComponent(item.orderId)}`}>{retained ? "查看来源订单" : "查看订单"}<ArrowRight size={12} aria-hidden="true" /></Link> : <small>订单关联待核对</small>}</>;
}

export function FollowupPeopleTable({ items, metric, timezone }: { items: DashboardDetail[]; metric: FollowupMetric; timezone: string }) {
  const retained = metric === "RETAINED";
  const columns = retained ? ["资金归属客户", "当前可用留存", "来源订单住客 / 房间", "来源订单状态 / 入口"] : ["住客", "订单房间 / 住期", metric === "DEBT" ? "该订单欠款" : "订单创建时间", "当前状态 / 订单"];
  return <table className="dashboard-resident-table dashboard-followup-table">
    <thead><tr>{columns.map(label => <th key={label}>{label}</th>)}</tr></thead>
    <tbody>{items.map(item => <tr key={item.id}>
      {retained ? <>
        <td data-label={columns[0]}><strong>{item.retainedOwnerName || "资金归属待核对"}</strong></td>
        <td data-label={columns[1]}><strong className="dashboard-followup-amount">{money(item.amountMinor, item.currency ?? "CNY")}</strong></td>
        <td data-label={columns[2]}><Guests summary={item.orderSummary} /><div className="dashboard-followup-rooms"><Rooms summary={item.orderSummary} /></div></td>
      </> : <>
        <td data-label={columns[0]}><Guests summary={item.orderSummary} /></td>
        <td data-label={columns[1]}><Rooms summary={item.orderSummary} />{item.orderSummary ? <><small>入住 {item.orderSummary.arrivalDate}</small><small>离店 {item.orderSummary.departureDate}</small></> : <small>住宿日期待核对</small>}</td>
        <td data-label={columns[2]}>{metric === "DEBT" ? <strong className="dashboard-followup-amount">{money(item.amountMinor, item.currency ?? "CNY")}</strong> : item.registeredAt ? <><strong>{new Date(item.registeredAt).toLocaleDateString("zh-CN", { timeZone: timezone })}</strong><small>{new Date(item.registeredAt).toLocaleTimeString("zh-CN", { timeZone: timezone, hour12: false })}</small></> : <span className="dashboard-muted">创建时间待核对</span>}</td>
      </>}
      <td data-label={columns[3]}><OrderLink item={item} retained={retained} /></td>
    </tr>)}</tbody>
  </table>;
}
