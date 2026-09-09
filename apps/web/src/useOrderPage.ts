import { useEffect, useState } from "react";
import { api } from "./api";
import type { OrderRowDto } from "./types";

export function useOrderPage(propertyId: string, options: {
  status?: string;
  query?: string;
  funds?: "BALANCE_DUE" | "OVERPAID";
  beforeId?: string;
  pageSize?: number;
  refreshToken?: number;
}) {
  const { status, query, funds, beforeId, pageSize = 50, refreshToken = 0 } = options;
  const [state, setState] = useState<{ key: string; orders: OrderRowDto[]; nextCursor: string | null; loading: boolean; error?: unknown }>({ key: "", orders: [], nextCursor: null, loading: true });
  const key = JSON.stringify([propertyId, status, query, funds, beforeId, pageSize, refreshToken]);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(new Error("订单读取超时，请重试")), 12_000);
    setState({ key, orders: [], nextCursor: null, loading: true });
    api.orders(propertyId, status, {
      ...(query ? { query } : {}), ...(funds ? { funds } : {}), ...(beforeId ? { beforeId } : {}), pageSize, signal: controller.signal
    }).then((response) => {
      if (!current) return;
      if (!Array.isArray(response.orders) || response.orders.some((order) => order.property_id !== propertyId || status && order.status !== status)
        || !(response.nextCursor === null || typeof response.nextCursor === "string" && response.nextCursor.length > 0 && response.nextCursor !== beforeId)) {
        throw new Error("订单分页信息不完整，请重新载入");
      }
      setState({ key, orders: response.orders, nextCursor: response.nextCursor, loading: false });
    }).catch((error) => {
      if (current) setState({ key, orders: [], nextCursor: null, loading: false, error: controller.signal.aborted ? controller.signal.reason : error });
    }).finally(() => window.clearTimeout(timeout));
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [key, propertyId, status, query, funds, beforeId, pageSize, refreshToken]);
  // Never render another property's rows for the one render before effect cleanup.
  return state.key === key ? state : { orders: [], nextCursor: null, loading: true, error: undefined };
}
