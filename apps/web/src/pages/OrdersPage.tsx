import { useEffect, useMemo, useState } from "react";
import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { OrderRowDto } from "../types";
import { businessStatusLabel, EmptyState, formatDate, guestName, guestSearchText, InlineError, LoadingBlock, StatusBadge } from "../ui";

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
      return order.id.toLowerCase().includes(needle) || guestSearchText(order.primary_guest_snapshot).toLowerCase().includes(needle);
    });
  }, [orders, query, status]);

  return (
    <div className="orders-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">订单管理</p><h1>订单</h1><p>查询住宿订单、收款与履约进度</p></div>
        <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={loading}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
      </header>
      <section className="list-toolbar" aria-label="订单筛选">
        <label className="search-control"><Search aria-hidden="true" size={17} /><span className="sr-only">搜索订单</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="订单 ID、昵称或姓名" /></label>
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部状态</option>{statusOptions.map((option) => <option key={option} value={option}>{businessStatusLabel(option)}</option>)}</select></label>
        <span className="result-count">{visibleOrders.length} / {orders.length}</span>
      </section>
      <InlineError error={error} title="无法载入订单" />
      {loading ? <LoadingBlock label="正在载入订单" /> : visibleOrders.length === 0 ? <EmptyState title="没有匹配订单" detail="调整筛选条件或从房态页创建新订单。" /> : (
        <div className="table-region orders-table-region" role="region" aria-label="订单列表" tabIndex={0}>
          <table className="data-table" data-testid="orders-table">
            <thead><tr><th scope="col">订单 / 住客</th><th scope="col">状态</th><th scope="col">住宿类型</th><th scope="col">住宿周期</th><th scope="col">政策版本</th><th scope="col"><span className="sr-only">查看</span></th></tr></thead>
            <tbody>{visibleOrders.map((order) => (
              <tr key={order.id}>
                <th scope="row"><Link className="primary-cell-link" to={`/orders/${encodeURIComponent(order.id)}`}><strong>{guestName(order.primary_guest_snapshot)}</strong><code>{order.id}</code></Link></th>
                <td><StatusBadge value={order.status} label={businessStatusLabel(order.status)} /></td>
                <td>{order.stay_type}</td>
                <td><span className="date-range">{formatDate(order.arrival_date)}<span>至</span>{formatDate(order.departure_date)}</span></td>
                <td><code>{order.pricing_policy_version_id}</code></td>
                <td><Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看订单 ${order.id}`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
