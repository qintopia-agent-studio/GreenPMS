import type { CommunityDay, CommunityRecord, DashboardCommunity, DashboardRange } from "@qintopia/contracts";
import { dashboardDate } from "./dashboard-metrics.ts";
import { enumerateServiceDates } from "./dates.ts";

export interface CommunityStay {
  orderId: string;
  personKey: string | null;
  arrival: string;
  departure: string;
  current: boolean;
  free: boolean;
  category: string | null;
  registrationKey?: string;
  historical?: boolean;
  durationReviewReason?: string;
}
export interface CommunityEvent { orderId: string; date: string; nights: number; reason: string; kind: "RENEWAL" | "EARLY" }
const nights = (from: string, until: string) => Math.max(0, Math.round((Date.parse(until) - Date.parse(from)) / 86400000));

/** Identity keys stay inside the server projection; responses contain counts and order links only. */
export function communityMetrics(stays: CommunityStay[], events: CommunityEvent[], range: DashboardRange, today: string, evidenceIssues: string[] = [], planned: CommunityStay[] = []): DashboardCommunity {
  const byPerson = new Map<string, CommunityStay[]>();
  const plannedByPerson = new Map<string, CommunityStay[]>();
  // A stable occupant registration already identifies the resident within their stay.
  // Document identity only adds cross-order linking; it is not a duration prerequisite.
  const residencePeople = new Map<string, CommunityStay[]>();
  const byOrder = new Map<string, CommunityStay[]>();
  for (const stay of stays) {
    const order = byOrder.get(stay.orderId) ?? [];
    order.push(stay); byOrder.set(stay.orderId, order);
    const residenceKey = stay.personKey ? `identity:${stay.personKey}`
      : stay.registrationKey ? `registration:${stay.orderId}:${stay.registrationKey}` : null;
    if (residenceKey && stay.historical !== false && !stay.durationReviewReason) {
      const list = residencePeople.get(residenceKey) ?? [];
      list.push(stay); residencePeople.set(residenceKey, list);
    }
    if (stay.personKey && stay.historical !== false && !stay.durationReviewReason) {
      const list = byPerson.get(stay.personKey) ?? [];
      list.push(stay); byPerson.set(stay.personKey, list);
    }
  }
  for (const stay of planned) if (stay.personKey) {
    const list = plannedByPerson.get(stay.personKey) ?? [];
    list.push(stay); plannedByPerson.set(stay.personKey, list);
  }
  const relevant = (stay: CommunityStay, date: string) => date === today
    ? stay.current && stay.arrival <= date
    : stay.historical !== false && stay.arrival <= date && date < stay.departure;
  function day(date: string): CommunityDay {
    const active = stays.filter(stay => relevant(stay, date));
    const unlinked = new Set(active.filter(stay => !stay.personKey).map((stay, i) => stay.registrationKey ?? `${stay.orderId}:${i}`)).size;
    const registrations = new Map<string, Set<string>>();
    let missingRegistration = false;
    for (const stay of active) {
      const key = stay.registrationKey ?? (stay.personKey ? `${stay.orderId}:${stay.personKey}` : null);
      if (!key) { missingRegistration = true; continue; }
      const categories = registrations.get(key) ?? new Set<string>();
      categories.add(stay.free ? (stay.category ?? "OTHER") : "PAID");
      registrations.set(key, categories);
    }
    const registered = { total: missingRegistration ? null : registrations.size, paid: 0, volunteer: 0, reception: 0, otherFree: 0 };
    for (const categories of registrations.values()) {
      if (categories.size !== 1) { registered.total = null; continue; }
      const category = [...categories][0];
      if (category === "PAID") registered.paid++;
      else if (category === "VOLUNTEER") registered.volunteer++;
      else if (category === "RECEPTION") registered.reception++;
      else registered.otherFree++;
    }
    const grouped = new Map<string, Set<string>>();
    for (const stay of active) if (stay.personKey) {
      const categories = grouped.get(stay.personKey) ?? new Set<string>();
      categories.add(stay.free ? (stay.category ?? "OTHER") : "PAID");
      grouped.set(stay.personKey, categories);
    }
    let paid = 0, volunteer = 0, reception = 0, otherFree = 0, unclassified = 0;
    for (const categories of grouped.values()) {
      if (categories.size > 1) { unclassified++; continue; }
      const category = [...categories][0];
      if (category === "PAID") paid++;
      else if (category === "VOLUNTEER") volunteer++;
      else if (category === "RECEPTION") reception++;
      else otherFree++;
    }
    return { date, total: unlinked ? null : grouped.size, paid, volunteer, reception, otherFree, unlinked, unclassified, registered };
  }
  const inRange = (date: string) => date >= range.from && date <= range.to;
  const records = new Map<string, { record: CommunityRecord; people: Set<string>; unknown: boolean }>();
  function add(record: CommunityRecord, people: Array<string | null>) {
    const key = `${record.kind}:${record.orderId}:${record.date}:${record.nights}`;
    const entry = records.get(key) ?? { record, people: new Set<string>(), unknown: false };
    for (const person of people) { if (person) entry.people.add(person); else entry.unknown = true; }
    records.set(key, entry);
  }
  const cutoff = range.to < today ? range.to : today;
  // Keep evidence gaps alongside the distribution instead of silently dropping registrations.
  // Pending counts are NOT people/trips: actual dates or rosters may still be unresolved.
  function durationCoverage(perspective: "current" | "all") {
    const registrations = new Set<string>();
    const registrationBased = new Set<string>();
    const orders = new Set<string>();
    const issues = new Map<string, Set<string>>();
    for (const stay of stays) {
      const occupiedUntil = stay.current ? dashboardDate(today, 1) : stay.departure;
      const included = perspective === "current" ? relevant(stay, today)
        : range.from <= cutoff && stay.arrival <= cutoff && occupiedUntil > range.from;
      if (!included) continue;
      if ((stay.personKey || stay.registrationKey) && stay.historical !== false && !stay.durationReviewReason) {
        if (!stay.personKey && stay.registrationKey) registrationBased.add(stay.registrationKey);
        continue;
      }
      if (stay.registrationKey) registrations.add(stay.registrationKey);
      else orders.add(stay.orderId);
      const reasons = issues.get(stay.orderId) ?? new Set<string>();
      reasons.add(stay.durationReviewReason ?? (stay.historical === false
        ? "实际入住日期待核对，不能以登记日期或订单日期替代。"
        : "住宿人名单或有效住宿时间线待核对，不能推算人数和时长。"));
      issues.set(stay.orderId, reasons);
    }
    return { registrationBased: registrationBased.size, pendingRegistrations: registrations.size, pendingOrders: orders.size,
      issues: [...issues].map(([orderId, reasons]) => ({ orderId, reason: [...reasons].join("；") })) };
  }
  const distribution = new Map<number, { nights: number; current: number; all: number }>();
  function countDuration(duration: number, perspective: "current" | "all") {
    const row = distribution.get(duration) ?? { nights: duration, current: 0, all: 0 };
    row[perspective]++;
    distribution.set(duration, row);
  }
  for (const list of residencePeople.values()) {
    const personKey = list[0]!.personKey;
    list.sort((a, b) => a.arrival.localeCompare(b.arrival) || a.departure.localeCompare(b.departure));
    let chain: CommunityStay[] = [], until = "", previous = false;
    function finish() {
      if (!chain.length) return;
      const start = chain[0]!.arrival;
      const live = chain.some(stay => stay.current && stay.arrival <= today);
      const observedEnd = live || until > today ? today : until;
      const duration = nights(start, observedEnd);
      if (live) countDuration(duration, "current");
      const occupiedUntil = live ? dashboardDate(today, 1) : until;
      if (range.from <= cutoff && start <= cutoff && occupiedUntil > range.from) {
        countDuration(nights(start, observedEnd < cutoff ? observedEnd : cutoff), "all");
      }
      // Registration-local durations do not establish NEW/RETURN/RENEWAL identities.
      if (!personKey) return;
      if (inRange(start)) add({ orderId: chain[0]!.orderId, date: start, nights: duration, reason: previous ? "同一住客间隔后再次入住" : "首次可核实的入住记录", kind: previous ? "RETURN" : "NEW" }, [personKey]);
      let confirmedEnd = until;
      let dueOrder = chain.find(stay => stay.departure === until)!.orderId;
      for (const next of (plannedByPerson.get(personKey) ?? []).sort((a, b) => a.arrival.localeCompare(b.arrival))) {
        if (next.arrival <= confirmedEnd && next.departure > confirmedEnd) { confirmedEnd = next.departure; dueOrder = next.orderId; }
      }
      if (live && confirmedEnd >= today && confirmedEnd < dashboardDate(today, 7)) {
        add({ orderId: dueOrder, date: confirmedEnd, nights: duration, reason: "未来7天内已确认离店；连续居住末端没有已确认接续", kind: "DUE" }, [personKey]);
      }
      previous = true;
    }
    for (const stay of list) {
      if (chain.length && stay.arrival > until) { finish(); chain = []; until = ""; }
      if (personKey && chain.length && chain.at(-1)!.orderId !== stay.orderId && stay.arrival === until && inRange(stay.arrival)) {
        add({ orderId: stay.orderId, date: stay.arrival, nights: 0, reason: "同一住客无空夜接续订单，换房不打断连续居住", kind: "RENEWAL" }, [personKey]);
      }
      chain.push(stay);
      if (stay.departure > until) until = stay.departure;
    }
    finish();
  }
  for (const event of events) {
    if (!inRange(event.date)) continue;
    const occupants = byOrder.get(event.orderId) ?? [];
    const people = occupants.filter(stay => stay.historical !== false && stay.arrival <= event.date && stay.departure >= event.date);
    if (event.kind === "EARLY") {
      const leaving = people.filter(person => !person.personKey || !(byPerson.get(person.personKey) ?? []).some(other => other.orderId !== person.orderId && other.arrival <= event.date && other.departure > event.date));
      if (people.length && !leaving.length) continue;
      add({ ...event, reason: `${event.reason}；按住客核对接续，不推断满意度` }, leaving.length ? leaving.map(person => person.personKey) : [null]);
    } else add(event, people.length ? people.map(person => person.personKey) : [null]);
  }
  const resultRecords = [...records.values()].map(({ record, people, unknown }) => ({ ...record, people: unknown ? null : people.size })).sort((a, b) => b.date.localeCompare(a.date) || a.orderId.localeCompare(b.orderId));
  const trend = enumerateServiceDates(range.from, dashboardDate(range.to, 1)).map(day);
  const unknown = trend.some(row => row.unlinked > 0);
  const current = day(today);
  const reasons = [...evidenceIssues];
  if (trend.some(row => row.unclassified) || current.unclassified) reasons.push("同一住客同日存在付费/免费归属冲突：总人数仍按身份去重保留，冲突住客不猜测分类，请核对关联订单归属。");
  if (unknown || current.unlinked) reasons.push("部分住宿人缺少跨订单身份或实际日期依据；不按同名、共用手机或下单会员猜测。缺项只影响对应日期，已核对分类保留。");
  return {
    current, trend,
    visitors: unknown ? null : [...byPerson.values()].filter(list => list.some(stay => stay.arrival <= range.to && stay.departure > range.from)).length,
    dailyAverage: unknown ? null : trend.reduce((sum, row) => sum + row.total!, 0) / Math.max(trend.length, 1),
    duration: [...distribution.values()].sort((a, b) => a.nights - b.nights),
    durationCoverage: { current: durationCoverage("current"), all: durationCoverage("all") }, records: resultRecords,
    counts: { NEW: resultRecords.filter(row => row.kind === "NEW").length, RETURN: resultRecords.filter(row => row.kind === "RETURN").length, RENEWAL: resultRecords.filter(row => row.kind === "RENEWAL").length, DUE: resultRecords.filter(row => row.kind === "DUE").length, EARLY: resultRecords.filter(row => row.kind === "EARLY").length },
    reasons
  };
}
