import { useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { BookingChannelCode, OrderRowDto } from "../types";
import { businessStatusLabel, EmptyState, formatDate, formatMinor, guestName, guestSearchText, InlineError, LoadingBlock, StatusBadge } from "../ui";

const bookingChannelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

function orderStayTypeLabel(order: OrderRowDto): string {
  if (order.stay_type === "FREE") return "免费住宿";
  if (order.member_id || order.member_contract_id) return "会员住宿";
  return "普通住宿";
}

function orderSourceLabel(order: OrderRowDto): string {
  if (order.member_id || order.member_contract_id) return "会员权益";
  if (order.stay_type === "FREE") return "免费住宿";
  return order.booking_channel_code ? bookingChannelLabels[order.booking_channel_code] : "历史未记录";
}

function orderChannelReferenceLabel(order: OrderRowDto): string {
  if (order.member_id || order.member_contract_id || order.stay_type === "FREE") return "不适用";
  if (order.booking_channel_code === "WECOM") return "不适用";
  return order.channel_order_reference ?? "未填写";
}

function orderAmountLabel(order: OrderRowDto): string {
  return order.current_contract_amount_minor === null || !order.currency
    ? "历史未记录"
    : formatMinor(order.current_contract_amount_minor, order.currency);
}

export function orderRoomTypeLabel(order: OrderRowDto): string {
  const name = order.current_unit_name;
  if (!name) return "历史未记录";
  const separatorIndex = name.indexOf(" · ");
  return separatorIndex > 0 ? name.slice(separatorIndex + 3) : name;
}

export function OrdersPage() {
  const { propertyId } = useWorkspace();
  const [orders, setOrders] = useState<OrderRowDto[]>([]);
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    api.orders(propertyId)
      .then((response) => current && setOrders(response.orders))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  const statusOptions = useMemo(() => [...new Set(orders.map((order) => order.status))], [orders]);
  const visibleOrders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return orders.filter((order) => {
      if (status !== "ALL" && order.status !== status) return false;
      if (!needle) return true;
      return order.id.toLowerCase().includes(needle)
        || guestSearchText(order.primary_guest_snapshot).toLowerCase().includes(needle)
        || orderSourceLabel(order).toLowerCase().includes(needle)
        || orderChannelReferenceLabel(order).toLowerCase().includes(needle);
    });
  }, [orders, query, status]);

  return (
    <div className="orders-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">订单管理</p><h1>订单</h1><p>查询住宿订单、收款与履约进度</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
      </header>
      <section className="list-toolbar" aria-label="订单筛选">
        <label className="search-control"><Search aria-hidden="true" size={17} /><span className="sr-only">搜索订单</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="订单 ID、姓名、渠道或渠道订单号" /></label>
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部状态</option>{statusOptions.map((option) => <option key={option} value={option}>{businessStatusLabel(option)}</option>)}</select></label>
        <span className="result-count">{visibleOrders.length} / {orders.length}</span>
      </section>
      <InlineError error={error} title="无法载入订单" />
      {loading ? <LoadingBlock label="正在载入订单" /> : visibleOrders.length === 0 ? <EmptyState title="没有匹配订单" detail="调整筛选条件或从房态页创建新订单。" /> : (
        <div className="table-region orders-table-region" role="region" aria-label="订单列表" tabIndex={0}>
          <table className="data-table" data-testid="orders-table">
            <thead><tr><th scope="col">订单 / 住客</th><th scope="col">状态</th><th scope="col">住宿类型</th><th scope="col">房型</th><th scope="col">订单来源</th><th scope="col">渠道订单号</th><th scope="col">住宿周期</th><th scope="col">订单金额</th><th scope="col"><span className="sr-only">查看</span></th></tr></thead>
            <tbody>{visibleOrders.map((order) => (
              <tr key={order.id}>
                <th scope="row"><Link className="primary-cell-link" to={`/orders/${encodeURIComponent(order.id)}`}><strong>{guestName(order.primary_guest_snapshot)}</strong><code>{order.id}</code></Link></th>
                <td><StatusBadge value={order.status} label={businessStatusLabel(order.status)} /></td>
                <td>{orderStayTypeLabel(order)}</td>
                <td>{orderRoomTypeLabel(order)}</td>
                <td>{orderSourceLabel(order)}</td>
                <td>{orderChannelReferenceLabel(order)}</td>
                <td><span className="date-range">{formatDate(order.arrival_date)}<span>至</span>{formatDate(order.departure_date)}</span></td>
                <td><strong>{orderAmountLabel(order)}</strong></td>
                <td><Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看订单 ${order.id}`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
