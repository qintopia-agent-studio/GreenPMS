import type { ConfirmedInventoryAvailability } from "./confirmed-inventory-availability.ts";
import { parseLocalDate, enumerateServiceDates } from "@qintopia/domain";

export interface CapacityUnit {
  id: string; kind: "ROOM" | "BED"; parent_room_id: string | null; active: boolean;
  building_code: string | null; room_type_code: string | null; created_at: Date;
}
export interface CapacityChange { created_at: Date; effect: unknown }
type Selection = { building?: string; roomType?: string };
/** Replay inventory lifecycle, never infer a historical opening date from today's active flag. */
export function dailySalesCapacity(units: readonly CapacityUnit[], changes: readonly CapacityChange[], localDate: (date: Date) => string, confirmations: readonly ConfirmedInventoryAvailability[] = [], includesUnit: (unitId: string) => boolean = () => true) {
  const start = new Map<string, string>(), end = new Map<string, string>();
  const unsupported = new Set<string>();
  const knownIds = new Set(units.map(unit => unit.id));
  for (const change of changes) {
    const effect = change.effect as { insertUnits?: Array<{ id: string }>; retireUnitIds?: string[]; action?: string; roomRename?: unknown } | null;
    if (!effect || !Array.isArray(effect.insertUnits) || !Array.isArray(effect.retireUnitIds)) {
      unsupported.add(localDate(change.created_at)); continue;
    }
    const day = localDate(change.created_at);
    const rename = effect.roomRename as { roomId?: string; beforeCode?: string; afterCode?: string } | undefined;
    const pureRename = effect.action === "SAVE_ROOM" && typeof rename?.roomId === "string" && typeof rename.beforeCode === "string" && typeof rename.afterCode === "string";
    if (effect.insertUnits.some(unit => !knownIds.has(unit.id)) || effect.retireUnitIds.some(id => !knownIds.has(id))
      || (["SAVE_ROOM", "SET_ROOM_ACTIVE"].includes(effect.action ?? "") && !effect.insertUnits.length && !effect.retireUnitIds.length && !pureRename)) {
      unsupported.add(day); continue;
    }
    for (const unit of effect.insertUnits) start.set(unit.id, day);
    for (const id of effect.retireUnitIds) end.set(id, day);
  }
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const evidenceStart = new Map<string, string>();
  for (const evidence of confirmations) {
    const unit = byId.get(evidence.unitId);
    if (!unit || unit.kind !== "ROOM" || unit.parent_room_id !== null
      || units.some(child => child.parent_room_id === unit.id)
      || unit.created_at.toISOString() !== evidence.recordedAt) continue;
    parseLocalDate(evidence.availableFrom);
    parseLocalDate(evidence.confirmedOn);
    const registeredDay = localDate(unit.created_at);
    if (!evidence.source || evidence.availableFrom >= registeredDay
      || (start.has(unit.id) && start.get(unit.id) !== registeredDay)) continue;
    start.set(unit.id, evidence.availableFrom);
    evidenceStart.set(unit.id, evidence.availableFrom);
  }
  const active = (unit: CapacityUnit, date: string) => date >= (start.get(unit.id) ?? localDate(unit.created_at))
    && (end.has(unit.id) ? date < end.get(unit.id)! : unit.active);
  function matches(unit: CapacityUnit, selection: Selection) {
    const room = unit.kind === "ROOM" ? unit : byId.get(unit.parent_room_id!);
    return includesUnit(unit.id) && (!selection.building || (room?.building_code ?? "未分配") === selection.building)
      && (!selection.roomType || (unit.room_type_code ?? room?.room_type_code ?? "未分配") === selection.roomType);
  }
  function on(date: string, selection: Selection = {}) {
    const selected = units.filter(unit => matches(unit, selection));
    const beforeEvidence = selected.filter(unit => evidenceStart.has(unit.id) && date < evidenceStart.get(unit.id)!);
    const issues = selected.filter(unit => !start.has(unit.id) && date < localDate(unit.created_at));
    const missingRetirement = selected.some(unit => !unit.active && !end.has(unit.id));
    const affectedChange = [...unsupported].some(day => day >= date);
    const reason = beforeEvidence.length ? `${date}：${beforeEvidence.length}间补录房源早于已确认使用日期，尚无更早启用依据`
      : issues.length ? `${date}：${issues.length}条房源记录早于系统登记日期，缺少启用日期依据`
      : missingRetirement ? `${date}：停用房源缺少有效变更记录` : affectedChange ? `${date}：房源变更记录不完整` : "按每日有效销售单元累计；维修、免费和占用不扣分母";
    const atoms = selected.filter(unit => active(unit, date) && (unit.kind === "BED"
      ? Boolean(byId.get(unit.parent_room_id!) && active(byId.get(unit.parent_room_id!)!, date))
      : !units.some(bed => bed.parent_room_id === unit.id && active(bed, date))));
    return { value: beforeEvidence.length || issues.length || missingRetirement || affectedChange ? null : atoms.length, reason, atoms };
  }
  function weight(id: string, date: string) {
    const unit = byId.get(id);
    if (!unit) return null;
    if (!includesUnit(id)) return 0;
    if ((start.has(id) && date < start.get(id)!) || (end.has(id) && date >= end.get(id)!)) return null;
    // A validated order interval proves use of an independent room/bed even when imported later.
    // It does not prove the whole property's opening capacity or historical split-bed weight.
    if (!start.has(id) && date < localDate(unit.created_at)) {
      return unit.kind === "BED" || !units.some(bed => bed.parent_room_id === id) ? 1 : null;
    }
    if (!active(unit, date)) return null;
    const children = units.filter(bed => bed.parent_room_id === id && active(bed, date));
    return unit.kind === "ROOM" && children.length ? children.length : 1;
  }
  function period(from: string, until: string, selection: Selection = {}) {
    let total = 0;
    for (const date of enumerateServiceDates(from, until)) {
      const day = on(date, selection);
      if (day.value === null) return { value: null, reason: day.reason };
      total += day.value;
    }
    return { value: total, reason: "逐日销售单元合计；维修、免费和占用不扣分母" };
  }
  return { on, weight, period };
}
