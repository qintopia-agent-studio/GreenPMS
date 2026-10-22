import type { CommunityDay, CommunityRecord, CommunityResidentDay, CommunityResidentMemberItem, CommunityResidentReviewItem, DashboardCommunity, DashboardRange } from "@qintopia/contracts";
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
  occupantName?: string;
  roomCode?: string;
  /** Dates of the effective room arrangement, not an inferred guest arrival. */
  arrivalDate?: string;
  departureDate?: string;
  historical?: boolean;
  /** False for an interval retained only as an attendance gap, not proven occupancy. */
  attendanceConfirmed?: boolean;
  durationReviewReason?: string;
  identityApproximate?: boolean;
  memberStatus?: "CONFIRMED" | "UNKNOWN" | "NOT_MEMBER";
  /** Actual membership-benefit usage, projected onto the order's sole primary guest. */
  membershipByDate?: Readonly<Record<string, CommunityMembershipEvidence>>;
}
export interface CommunityMembershipEvidence {
  status: "CONFIRMED" | "UNKNOWN" | "NOT_MEMBER";
  memberId: string | null;
  memberName?: string;
  reason?: string;
  reasonLabel?: string;
  basis?: "MEMBER_ENTITLEMENT";
}
export interface CommunityEvent { orderId: string; date: string; nights: number; reason: string; kind: "RENEWAL" | "EARLY" }
/** Complete evidence defines residence/event boundaries; operating contributions still come from `stays`. */
export interface CommunityContinuity {
  stays: CommunityStay[];
  planned: CommunityStay[];
  includesEvent: (record: CommunityRecord) => boolean;
}
const residenceKey = (stay: CommunityStay) => stay.personKey ? `identity:${stay.personKey}`
  : stay.registrationKey ? `registration:${stay.orderId}:${stay.registrationKey}` : null;
const nights = (from: string, until: string) => Math.max(0, Math.round((Date.parse(until) - Date.parse(from)) / 86400000));

/** Identity keys stay inside the server projection; only current lists include safe display fields. */
export function communityMetrics(stays: CommunityStay[], events: CommunityEvent[], range: DashboardRange, today: string, evidenceIssues: string[] = [], planned: CommunityStay[] = [], continuity?: CommunityContinuity): DashboardCommunity {
  const byPerson = new Map<string, CommunityStay[]>();
  const plannedByPerson = new Map<string, CommunityStay[]>();
  // A stable occupant registration already identifies the resident within their stay.
  // Document identity only adds cross-order linking; it is not a duration prerequisite.
  const residencePeople = new Map<string, CommunityStay[]>();
  // Resident qualification is based on paid accommodation only. Keep this separate
  // from `residencePeople`, which still powers total visitors and operating duration
  // metrics for both paid and free stays.
  const residentResidencePeople = new Map<string, CommunityStay[]>();
  const byOrder = new Map<string, CommunityStay[]>();
  for (const stay of stays) {
    const order = byOrder.get(stay.orderId) ?? [];
    order.push(stay); byOrder.set(stay.orderId, order);
    const key = residenceKey(stay);
    if (key && stay.historical !== false && stay.attendanceConfirmed !== false && !stay.durationReviewReason) {
      const list = residencePeople.get(key) ?? [];
      list.push(stay); residencePeople.set(key, list);
      if (!stay.free) {
        const residentList = residentResidencePeople.get(key) ?? [];
        residentList.push(stay); residentResidencePeople.set(key, residentList);
      }
    }
    if (stay.personKey && stay.historical !== false && stay.attendanceConfirmed !== false && !stay.durationReviewReason) {
      const list = byPerson.get(stay.personKey) ?? [];
      list.push(stay); byPerson.set(stay.personKey, list);
    }
  }
  for (const stay of planned) if (stay.personKey) {
    const list = plannedByPerson.get(stay.personKey) ?? [];
    list.push(stay); plannedByPerson.set(stay.personKey, list);
  }
  const relevant = (stay: CommunityStay, date: string) => date === today
    ? stay.current && stay.arrival <= date && date < stay.departure
    : stay.historical !== false && stay.arrival <= date && date < stay.departure;
  function day(date: string): CommunityDay {
    const active = stays.filter(stay => relevant(stay, date));
    const unlinked = new Set(active.filter(stay => stay.attendanceConfirmed === false || !stay.personKey)
      .map((stay, i) => `${stay.orderId}:${stay.registrationKey ?? i}`)).size;
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
    for (const stay of active) {
      const identity = stay.attendanceConfirmed === false ? null : stay.personKey;
      if (!identity) continue;
      const categories = grouped.get(identity) ?? new Set<string>();
      categories.add(stay.free ? (stay.category ?? "OTHER") : "PAID");
      grouped.set(identity, categories);
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
      const occupiedUntil = stay.current && stay.departure > today ? dashboardDate(today, 1) : stay.departure;
      const included = perspective === "current" ? relevant(stay, today)
        : range.from <= cutoff && stay.arrival <= cutoff && occupiedUntil > range.from;
      if (!included) continue;
      if ((stay.personKey || stay.registrationKey) && stay.historical !== false && stay.attendanceConfirmed !== false && !stay.durationReviewReason) {
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
  const durationPeople = continuity ? new Map<string, CommunityStay[]>() : residencePeople;
  if (continuity) for (const stay of continuity.stays) {
    const key = residenceKey(stay);
    if (!key || stay.historical === false || stay.attendanceConfirmed === false || stay.durationReviewReason) continue;
    const list = durationPeople.get(key) ?? [];
    list.push(stay); durationPeople.set(key, list);
  }
  // The complete continuity input may include free rooms that bridge or overlap
  // paid rooms. They remain part of general residence history, but cannot create
  // paid seven-night resident eligibility or contribute paid nights themselves.
  const residentDurationPeople = continuity ? new Map<string, CommunityStay[]>() : residentResidencePeople;
  if (continuity) for (const stay of continuity.stays) {
    if (stay.free) continue;
    const key = residenceKey(stay);
    if (!key || stay.historical === false || stay.attendanceConfirmed === false || stay.durationReviewReason) continue;
    const list = residentDurationPeople.get(key) ?? [];
    list.push(stay); residentDurationPeople.set(key, list);
  }
  for (const [key, list] of durationPeople) {
    const personKey = list[0]!.personKey;
    list.sort((a, b) => a.arrival.localeCompare(b.arrival) || a.departure.localeCompare(b.departure));
    let chain: CommunityStay[] = [], until = "", previous = false;
    function finish() {
      if (!chain.length) return;
      const start = chain[0]!.arrival;
      const live = chain.some(stay => relevant(stay, today));
      const observedEnd = live || until > today ? today : until;
      const duration = nights(start, observedEnd);
      if (continuity) {
        const contributions = (residencePeople.get(key) ?? []).filter(stay => stay.arrival < until
          && (stay.current && stay.departure > today ? dashboardDate(today, 1) : stay.departure) > start);
        // Union included service dates inside this complete residence chain. An excluded
        // room bridges continuity, but contributes no nights and cannot make it current.
        const operatingNightsThrough = (through: string) => {
          const intervals = contributions.map(stay => ({
            from: stay.arrival > start ? stay.arrival : start,
            to: stay.departure > through ? through : stay.departure
          })).filter(interval => interval.from < interval.to).sort((a, b) => a.from.localeCompare(b.from));
          let total = 0, countedUntil = start;
          for (const interval of intervals) {
            const from = interval.from > countedUntil ? interval.from : countedUntil;
            if (interval.to > from) total += nights(from, interval.to);
            if (interval.to > countedUntil) countedUntil = interval.to;
          }
          return total;
        };
        if (contributions.some(stay => relevant(stay, today))) countDuration(operatingNightsThrough(today), "current");
        if (range.from <= cutoff && contributions.some(stay => stay.arrival <= cutoff
          && (stay.current && stay.departure > today ? dashboardDate(today, 1) : stay.departure) > range.from)) {
          countDuration(operatingNightsThrough(observedEnd < cutoff ? observedEnd : cutoff), "all");
        }
      } else {
        if (live) countDuration(duration, "current");
        const occupiedUntil = live ? dashboardDate(today, 1) : until;
        if (range.from <= cutoff && start <= cutoff && occupiedUntil > range.from) {
          countDuration(nights(start, observedEnd < cutoff ? observedEnd : cutoff), "all");
        }
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
  const scopedRecords = [...records.values()].map(({ record, people, unknown }) => ({ ...record, people: unknown ? null : people.size })).sort((a, b) => b.date.localeCompare(a.date) || a.orderId.localeCompare(b.orderId));
  // Event identity depends on the complete residence chain, including non-operating rooms.
  // Omitting the optional input preserves the original unscoped behavior and ends recursion.
  const resultRecords = continuity
    ? communityMetrics(continuity.stays, events, range, today, [], continuity.planned).records.filter(continuity.includesEvent)
    : scopedRecords;
  const trend = enumerateServiceDates(range.from, dashboardDate(range.to, 1)).map(day);
  const residentDates = [...new Set([...trend.map(row => row.date), today])];
  const longStayByDate = new Map<string, Set<string>>();
  const memberByDate = new Map<string, Set<string>>();
  const residentPeopleByDate = new Map<string, Map<string, { residenceKey: string; longStayEligible: boolean }>>();
  const memberReviewByDate = new Map<string, Set<string>>();
  const residentReviewByDate = new Map<string, Map<string, string>>();
  const reviewItemsByDate = new Map<string, Map<string, { item: CommunityResidentReviewItem; reasons: Set<string>; labels: Set<string> }>>();
  const currentMemberItems = new Map<string, CommunityResidentMemberItem>();
  const markResidentReview = (date: string, registration: string, identity: string) => {
    const items = residentReviewByDate.get(date) ?? new Map<string, string>();
    items.set(registration, identity); residentReviewByDate.set(date, items);
  };
  const ensure = (map: Map<string, Set<string>>, date: string) => {
    const existing = map.get(date);
    if (existing) return existing;
    const created = new Set<string>(); map.set(date, created); return created;
  };
  for (const [key, chainInput] of residentDurationPeople) {
    const chain = [...chainInput].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.departure.localeCompare(b.departure));
    const operating = residentResidencePeople.get(key) ?? [];
    let start = "", until = "";
    const flush = () => {
      if (!start || !until) return;
      for (const date of residentDates) {
        // Only this uninterrupted chain can establish its own seven-night start.
        // A prior visit must not qualify a later one after an empty night.
        if (date < start || date >= until) continue;
        const active = date === today
          ? operating.some(stay => relevant(stay, date) && stay.arrival < until && stay.departure > start)
          : operating.some(stay => stay.arrival <= date && date < stay.departure && stay.arrival < until && stay.departure > start);
        if (active && nights(start, date) >= 7) ensure(longStayByDate, date).add(key);
      }
    };
    for (const stay of chain) {
      if (start && stay.arrival > until) { flush(); start = ""; until = ""; }
      if (!start) start = stay.arrival;
      if (stay.departure > until) until = stay.departure;
    }
    flush();
  }
  for (const date of residentDates) {
    const representatives = new Map<string, Set<string>>();
    for (const stay of stays) {
      if (stay.free || !relevant(stay, date) || (stay.membershipByDate?.[date]?.status ?? stay.memberStatus) !== "CONFIRMED") continue;
      const ids = representatives.get(stay.orderId) ?? new Set<string>();
      ids.add(stay.registrationKey ?? stay.personKey ?? "unknown"); representatives.set(stay.orderId, ids);
    }
    for (const stay of stays) {
      // A free stay still contributes to current headcount and free categories,
      // but never to the paid resident population or its membership union.
      if (stay.free || !relevant(stay, date)) continue;
      const key = residenceKey(stay) ?? `order:${stay.orderId}:${stay.registrationKey ?? "unknown"}`;
      const registration = `${stay.orderId}:${stay.registrationKey ?? stay.personKey ?? "unknown"}`;
      const evidence = stay.membershipByDate?.[date];
      const display = {
        orderId: stay.orderId, memberId: evidence?.memberId ?? null,
        ...(stay.registrationKey ? { occupantId: stay.registrationKey } : {}),
        ...(date === today ? {
          occupantName: stay.occupantName ?? (stay.registrationKey ? "住客姓名未填写" : "未登记实际住客"),
          ...(evidence?.memberName ? { memberName: evidence.memberName } : {}),
          ...(stay.roomCode ? { roomCode: stay.roomCode } : {}),
          ...(stay.arrivalDate ? { arrivalDate: stay.arrivalDate } : {}),
          ...(stay.departureDate ? { departureDate: stay.departureDate } : {})
        } : {})
      };
      // Benefit usage does not prove attendance on dates with missing occupancy evidence.
      const attendanceUnknown = stay.attendanceConfirmed === false;
      const identityStatus = evidence?.status ?? stay.memberStatus;
      const ambiguousRepresentative = identityStatus === "CONFIRMED" && (representatives.get(stay.orderId)?.size ?? 0) > 1;
      const status = (attendanceUnknown && identityStatus !== "NOT_MEMBER") || ambiguousRepresentative ? "UNKNOWN" : identityStatus;
      const memberKey = status === "CONFIRMED" ? key : null;
      const people = residentPeopleByDate.get(date) ?? new Map();
      people.set(registration, { residenceKey: key,
        longStayEligible: !attendanceUnknown && stay.historical !== false && !stay.durationReviewReason });
      residentPeopleByDate.set(date, people);
      if (status === "CONFIRMED") {
        // One primary registration represents the order's usage. Count its existing
        // guest identity, never the member account that supplied the benefits.
        ensure(memberByDate, date).add(memberKey!);
        if (date === today) currentMemberItems.set(registration, { ...display,
          ...(evidence?.basis ? { basis: evidence.basis } : {}) });
      }
      const reasons: string[] = [];
      const labels: string[] = [];
      if (status === "UNKNOWN") {
        ensure(memberReviewByDate, date).add(registration);
        markResidentReview(date, registration, key);
        reasons.push(ambiguousRepresentative ? "同一订单存在多位权益统计代表，不能重复计数或随机选取。" : attendanceUnknown
          ? stay.durationReviewReason ?? "实际在住日期与人数依据待核对，不能仅凭权益使用认定当天在住。"
          : evidence?.reason ?? "订单当天会员权益使用依据待核对。");
        labels.push(ambiguousRepresentative ? "主要住客登记不唯一" : attendanceUnknown ? "实际在住日期待核对" : evidence?.reasonLabel ?? "会员权益使用待核对");
      }
      if (attendanceUnknown || stay.durationReviewReason || (!residenceKey(stay) && status !== "CONFIRMED")) {
        if (status !== "CONFIRMED") markResidentReview(date, registration, key);
        reasons.push(stay.durationReviewReason ?? "实际住客身份与连续住宿日期待核对。");
        labels.push(attendanceUnknown || stay.durationReviewReason ? "实际在住日期待核对" : "实际住客资料待补充");
      }
      if (reasons.length) {
        const items = reviewItemsByDate.get(date) ?? new Map();
        const existing = items.get(registration);
        const mergedReasons = new Set([...(existing?.reasons ?? []), ...reasons]);
        const mergedLabels = new Set([...(existing?.labels ?? []), ...labels]);
        items.set(registration, { item: { ...display, reason: [...mergedReasons].join("；"),
          ...(date === today ? { reasonLabel: [...mergedLabels].join("；") } : {}) }, reasons: mergedReasons, labels: mergedLabels });
        reviewItemsByDate.set(date, items);
      }
    }
  }
  const residentDay = (date: string, includeMembers = false): CommunityResidentDay => {
    const longStay = longStayByDate.get(date) ?? new Set<string>();
    const member = memberByDate.get(date) ?? new Set<string>();
    const review = memberReviewByDate.get(date) ?? new Set<string>();
    const longStayPeople = new Set<string>();
    const longStayRegistrations = new Set<string>();
    for (const [registration, person] of residentPeopleByDate.get(date) ?? []) {
      if (!person.longStayEligible || !longStay.has(person.residenceKey)) continue;
      longStayPeople.add(person.residenceKey);
      longStayRegistrations.add(registration);
    }
    const known = new Set([...longStayPeople, ...member]);
    // A different guest's confirmed usage must not resolve this registration.
    // Its own qualifying long-stay evidence can already establish residency.
    const residentReview = [...(residentReviewByDate.get(date)?.keys() ?? [])].filter(registration => !longStayRegistrations.has(registration)).length;
    return {
      date,
      longStay: longStayPeople.size,
      member: review.size ? null : member.size,
      total: residentReview ? null : known.size,
      memberReview: review.size,
      knownTotal: known.size,
      knownMember: member.size,
      residentReview,
      reviewItems: [...(reviewItemsByDate.get(date)?.values() ?? [])].map(({ item }) => includeMembers ? item : {
        orderId: item.orderId, memberId: item.memberId, reason: item.reason,
        ...(item.occupantId ? { occupantId: item.occupantId } : {})
      }),
      ...(includeMembers ? { memberItems: [...currentMemberItems.values()] } : {})
    };
  };
  const residentTrend = trend.map(row => residentDay(row.date));
  const residentCurrent = residentDay(today, true);
  const unknown = trend.some(row => row.unlinked > 0);
  const current = day(today);
  const reasons = [...evidenceIssues];
  if (trend.some(row => row.unclassified) || current.unclassified) reasons.push("同一住客同日存在付费/免费归属冲突：总人数仍按身份去重保留，冲突住客不猜测分类，请核对关联订单归属。");
  if (unknown || current.unlinked) reasons.push("部分住宿人缺少可识别昵称、姓名或实际日期依据；不以共用手机或下单会员代替住客。缺项只影响对应日期，已核对分类保留。");
  return {
    current, trend,
    identityApproximate: stays.some(stay => stay.identityApproximate) || planned.some(stay => stay.identityApproximate),
    visitors: unknown ? null : [...residencePeople.values()].filter(list => list.some(stay => stay.arrival <= range.to && stay.departure > range.from)).length,
    dailyAverage: unknown ? null : trend.reduce((sum, row) => sum + row.total!, 0) / Math.max(trend.length, 1),
    duration: [...distribution.values()].sort((a, b) => a.nights - b.nights),
    durationCoverage: { current: durationCoverage("current"), all: durationCoverage("all") }, records: resultRecords,
    counts: { NEW: resultRecords.filter(row => row.kind === "NEW").length, RETURN: resultRecords.filter(row => row.kind === "RETURN").length, RENEWAL: resultRecords.filter(row => row.kind === "RENEWAL").length, DUE: resultRecords.filter(row => row.kind === "DUE").length, EARLY: resultRecords.filter(row => row.kind === "EARLY").length },
    reasons,
    residentCurrent,
    residentTrend
  };
}
