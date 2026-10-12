import type { DashboardDetail, DashboardFutureDay } from "@qintopia/contracts";
import { roomStatusRoomTypeLabel } from "../room-status/roomStatusPresentation";

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
