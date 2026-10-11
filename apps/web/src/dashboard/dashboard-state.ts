import { useEffect, useState } from "react";
import useSWR from "swr";
import type { DashboardMetric, DashboardSource } from "@qintopia/contracts";

export const sourceLabels: Record<DashboardSource, string> = { WECOM: "企业微信", YOUMUDAO: "游牧岛", CTRIP: "携程", MEITUAN: "美团", MEMBER: "会员权益", FREE: "免费住宿", UNKNOWN: "历史未记录" };
export const metricLabels: Record<DashboardMetric, string> = { PAID: "付费住宿单元夜", FREE: "免费占用单元夜", MONEY: "收退款登记", REVIEW: "待核对事实", DEBT: "住宿欠款", RETAINED: "客户留存待用", IN_HOUSE: "当前在住", ARRIVAL: "今日待到", DEPARTURE: "今日待离", OVERDUE: "逾期履约" };
export function money(value: string | null | undefined, currency = "CNY") {
  if (value == null) return "—";
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${currency === "CNY" ? "¥" : `${currency} `}${amount < 0n ? "−" : ""}${(absolute / 100n).toLocaleString("zh-CN")}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function createDashboardRequestScope() {
  const active = new Set<string>();
  const controllers = new Map<string, AbortController>();
  return {
    activate(key: string) {
      active.add(key);
      return () => {
        active.delete(key);
        // StrictMode remounts effects immediately; an old key must never abort the next key's request.
        queueMicrotask(() => {
          if (!active.has(key)) { controllers.get(key)?.abort(); controllers.delete(key); }
        });
      };
    },
    begin(key: string) {
      controllers.get(key)?.abort();
      const controller = new AbortController();
      controllers.set(key, controller);
      return controller.signal;
    }
  };
}
export function useDashboardRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, refreshInterval = 0) {
  const [requests] = useState(createDashboardRequestScope);
  useEffect(() => requests.activate(key), [key, requests]);
  return useSWR<T>(key, async () => {
    return read(AbortSignal.any([requests.begin(key), AbortSignal.timeout(30_000)]));
  }, { refreshInterval, refreshWhenHidden: false, refreshWhenOffline: false, revalidateOnFocus: true,
    keepPreviousData: false, shouldRetryOnError: false, dedupingInterval: 5_000 });
}
