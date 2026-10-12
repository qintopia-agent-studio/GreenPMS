import type { DashboardDetail, DashboardFutureDay, DashboardResponse } from "@qintopia/contracts";
import { roomStatusRoomTypeLabel } from "../room-status/roomStatusPresentation";

const durationBands = [
  { label: "不足 1 周", range: "≤6 晚", maxNights: 6 },
  { label: "1–2 周", range: "7–13 晚", maxNights: 13 },
  { label: "2–3 周", range: "14–20 晚", maxNights: 20 },
  { label: "3 周至 1 个月", range: "21–30 晚", maxNights: 30 },
  { label: "1–2 个月", range: "31–60 晚", maxNights: 60 },
  { label: "超过 2 个月", range: "≥61 晚", maxNights: Infinity }
] as const;

export function dashboardDurationBands(duration: DashboardResponse["community"]["duration"]) {
  const bands = durationBands.map(band => ({ ...band, current: 0, completed: 0 }));
  for (const row of duration) {
    const band = bands.find(item => row.nights <= item.maxNights)!;
    band.current += row.current;
    band.completed += row.completed;
  }
  return bands;
}

export function dashboardRoomTypeLabel(code: string, labels?: Record<string, string>): string {
  if (labels?.[code]?.trim()) return labels[code]!;
  const label = code === "未分配" ? "房型未分配" : roomStatusRoomTypeLabel(code);
  return label === "未命名房型" || /^[a-z0-9_-]+$/i.test(label) ? "房型名称待核对" : label;
}

export function dashboardDetailLabel(item: Pick<DashboardDetail, "metric" | "label">): string {
  if (item.metric !== "PAID" && item.metric !== "FREE") return item.label;
  const separator = item.label.indexOf(" / ");
  if (separator < 0) return item.label;
  return `${item.label.slice(0, separator)} / ${dashboardRoomTypeLabel(item.label.slice(separator + 3))}`;
}

export function dashboardAvailability(day: Pick<DashboardFutureDay, "availableRooms" | "availableBeds">) {
  const unknown = day.availableRooms === null || day.availableBeds === null;
  return {
    unknown,
    total: unknown ? "待核对" : String(day.availableRooms! + day.availableBeds!),
    breakdown: `${day.availableRooms === null ? "整房待核对" : `${day.availableRooms}间`} / ${day.availableBeds === null ? "床位待核对" : `${day.availableBeds}床`}`
  };
}
