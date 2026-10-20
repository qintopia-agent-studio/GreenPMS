import type { DashboardDetail, DashboardDetailClaimStatus, DashboardDetailEvidenceStatus, DashboardDetailSource, DashboardDetailSyncStatus, DashboardFutureDay, DashboardResponse } from "@qintopia/contracts";
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
  const bands = durationBands.map(band => ({ ...band, current: 0, all: 0 }));
  for (const row of duration) {
    const band = bands.find(item => row.nights <= item.maxNights)!;
    band.current += row.current;
    band.all += row.all;
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

const detailSourceLabels: Record<DashboardDetailSource, string> = { LODGING: "住宿事实", MEMBERSHIP: "会员事实", CHANNEL: "渠道事实", INVENTORY: "房态事实", ORDER: "订单事实", UNKNOWN: "来源待核对" };
const detailClaimLabels: Record<DashboardDetailClaimStatus, string> = { CONFIRMED: "已认领", PENDING_REVIEW: "待核对", UNCLAIMED: "未认领", INTERNAL: "内部归属" };
const detailSyncLabels: Record<DashboardDetailSyncStatus, string> = { WORKER_SYNCED: "worker 已同步", MANUAL_ENTRY: "人工登记", NOT_APPLICABLE: "不适用", UNKNOWN: "同步状态待核对" };
const detailEvidenceLabels: Record<DashboardDetailEvidenceStatus, string> = { COMPLETE: "凭据完整", PARTIAL: "凭据部分完整", MISSING: "缺少凭据" };

/** 统一把可选的事实追踪字段压成明细表可读的短标签；缺字段时不制造默认结论。 */
export function dashboardDetailEvidence(item: Pick<DashboardDetail, "sourceType" | "claimStatus" | "sourceFactId" | "referencesFactId" | "reversesFactId" | "correctsFactId" | "syncStatus" | "evidenceStatus">): string[] {
  const rows: string[] = [];
  if (item.sourceType) rows.push(`来源：${detailSourceLabels[item.sourceType]}`);
  if (item.claimStatus) rows.push(`认领：${detailClaimLabels[item.claimStatus]}`);
  if (item.syncStatus) rows.push(`同步：${detailSyncLabels[item.syncStatus]}`);
  if (item.evidenceStatus) rows.push(`凭据：${detailEvidenceLabels[item.evidenceStatus]}`);
  if (item.sourceFactId) rows.push(`事实：${item.sourceFactId}`);
  if (item.referencesFactId) rows.push(`引用：${item.referencesFactId}`);
  if (item.reversesFactId) rows.push(`冲销：${item.reversesFactId}`);
  if (item.correctsFactId) rows.push(`更正：${item.correctsFactId}`);
  return rows;
}

export function dashboardAvailability(day: Pick<DashboardFutureDay, "availableRooms" | "availableBeds">) {
  const unknown = day.availableRooms === null || day.availableBeds === null;
  return {
    unknown,
    total: unknown ? "待核对" : String(day.availableRooms! + day.availableBeds!),
    breakdown: `${day.availableRooms === null ? "整房待核对" : `${day.availableRooms}间`} / ${day.availableBeds === null ? "床位待核对" : `${day.availableBeds}床`}`
  };
}
