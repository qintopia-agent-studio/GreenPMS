import { useEffect, useRef } from "react";
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
export function useDashboardRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, refreshInterval = 0) {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [key]);
  return useSWR<T>(key, async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return read(AbortSignal.any([next.signal, AbortSignal.timeout(30_000)]));
  }, { refreshInterval, refreshWhenHidden: false, refreshWhenOffline: false, revalidateOnFocus: true,
    keepPreviousData: false, shouldRetryOnError: false, dedupingInterval: 5_000 });
}
