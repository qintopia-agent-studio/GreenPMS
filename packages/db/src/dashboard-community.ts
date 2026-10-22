import type { OperatingStatisticsScope } from "./operating-statistics.ts";
import { dashboardDate, enumerateServiceDates } from "@qintopia/domain";
import type { Transaction, Selectable } from "kysely";
import type { DashboardRange } from "@qintopia/contracts";
import type { Database } from "./schema.ts";
import { communityMetrics, type CommunityStay, type CommunityEvent } from "../../domain/src/community-metrics.ts";
import { resolveCommunityIdentities } from "../../domain/src/community-identity.ts";
import { propertyLocalClockAt } from "./members.ts";
import { projectCurrentOrderOccupants } from "./current-order-guests.ts";
import { loadDashboardStays } from "./dashboard-stays.ts";
import { loadDashboardMembership } from "./dashboard-membership.ts";

export async function loadDashboardCommunity(trx: Transaction<Database>, propertyId: string, range: DashboardRange, today: string, timezone: string, scope?: OperatingStatisticsScope) {
  const orders = await trx.selectFrom("orders as o").innerJoin("stays as s","s.order_id","o.id")
    .select(["o.id","o.arrival_date","o.departure_date","o.status","o.stay_type","o.free_stay_category_code","o.member_id","o.member_contract_id"])
    .where("o.property_id","=",propertyId).where("o.status","in",["CHECKED_IN","CHECKED_OUT","RESERVED"]).execute();
  if(!orders.length)return communityMetrics([],[],range,today);
  const ids=orders.map(o=>o.id);
  const [occupants,corrections,amendments,removals]=await Promise.all([
    trx.selectFrom("order_occupants").selectAll().where("order_id","in",ids).execute(),
    trx.selectFrom("order_occupant_corrections").selectAll().where("order_id","in",ids).execute(),
    trx.selectFrom("amendments").selectAll().where("order_id","in",ids).orderBy("sequence").execute(),
    trx.selectFrom("order_occupant_removals").selectAll().where("order_id","in",ids).execute()
  ]);
  const projected=projectCurrentOrderOccupants(occupants,corrections);
  const occupantName = (person: typeof projected[number]) => {
    const nickname = person.nickname?.trim(), fullName = person.fullName?.trim();
    return nickname && fullName && nickname !== fullName ? `${nickname}（${fullName}）` : nickname || fullName || `第 ${person.ordinal} 位住客`;
  };
  const membership = await loadDashboardMembership(trx, propertyId,
    [...new Set([...enumerateServiceDates(range.from, dashboardDate(range.to, 1)), today])], today);
  const local=(date:Date|string)=>propertyLocalClockAt(timezone,new Date(date)).date;
  const evidenceIssues:string[]=[];
  const removedByPerson = new Map(removals.map(row => [row.occupant_id, local(row.created_at)]));
  const peopleByOrder = new Map<string, typeof projected>();
  for (const person of projected) { const group = peopleByOrder.get(person.orderId) ?? []; group.push(person); peopleByOrder.set(person.orderId, group); }
  const rawById = new Map(occupants.map(person => [person.id, person]));
  const initialCommands = new Map(amendments.filter(row => ["CREATE_ORDER", "BACKFILL_COMPLETED_STAY", "CREATE"].includes(row.amendment_type)).map(row => [row.order_id, row.command_id]));
  const oldest=orders.reduce((d,o)=>o.arrival_date<d?o.arrival_date:d,range.from);
  // Load authoritative final arrangements over the complete observed history, not just the chart window.
  const lodging=await loadDashboardStays(trx,propertyId,today,{from:oldest,to:range.to},orders.reduce((until, order) => order.departure_date > until ? order.departure_date : until, dashboardDate(today,1)),timezone,scope);
  const roomCodes = new Map((lodging.units ?? []).map(unit => [unit.id, unit.code]));
  const orderById = new Map(orders.map(order => [order.id, order]));
  const identityCandidates = projected.filter(person => !removedByPerson.has(person.id)
    && (orderById.get(person.orderId)?.status === "RESERVED" || lodging.arrangements.has(person.orderId)));
  const identities = resolveCommunityIdentities(
    identityCandidates.filter(person => orderById.get(person.orderId)?.status !== "RESERVED"),
    identityCandidates.filter(person => orderById.get(person.orderId)?.status === "RESERVED")
  );
  const stays:CommunityStay[]=[];
  const planned:CommunityStay[]=[];
  const continuityStays: CommunityStay[] = [];
  const continuityPlanned: CommunityStay[] = [];
  for(const order of orders){
    const intervals = lodging.arrangements.get(order.id);
    const whollyExcluded = Boolean(intervals?.length && intervals.every(interval => lodging.statistics.classifyUnit(interval.inventoryUnitId) === false));
    const currentInterval = intervals?.find(interval => interval.arrivalDate <= today && today < interval.departureDate)
      ?? (intervals?.at(-1)?.departureDate && intervals.at(-1)!.departureDate <= today ? intervals.at(-1) : undefined);
    const pushInterval = (stay: CommunityStay, inventoryUnitId: string, interval?: { arrivalDate: string; departureDate: string }) => {
      const roomCode = roomCodes.get(inventoryUnitId);
      const locatedStay = { ...stay, ...(roomCode ? { roomCode } : {}),
        arrivalDate: interval?.arrivalDate ?? stay.arrival, departureDate: interval?.departureDate ?? stay.departure };
      continuityStays.push(locatedStay);
      if (lodging.statistics.includesUnit(inventoryUnitId)) stays.push(locatedStay);
    };
    const addStay = (stay: CommunityStay) => {
      if (!intervals?.length) { stays.push(stay); continuityStays.push(stay); return; }
      for (const interval of intervals) {
        const arrival = stay.arrival > interval.arrivalDate ? stay.arrival : interval.arrivalDate;
        const departure = stay.departure < interval.departureDate ? stay.departure : interval.departureDate;
        if (arrival < departure) pushInterval({ ...stay, arrival, departure,
          current: stay.current && interval === currentInterval }, interval.inventoryUnitId, interval);
      }
    };
    if (order.status !== "RESERVED") for (const interval of intervals ?? []) {
      if (lodging.statistics.classifyUnit(interval.inventoryUnitId) !== null) continue;
      evidenceIssues.push(`订单 ${order.id} 的住宿资产无法定位，经营统计范围待核对`);
      stays.push({ orderId: order.id, personKey: null, arrival: interval.arrivalDate, departure: interval.departureDate,
        current: order.status === "CHECKED_IN" && interval === currentInterval, free: order.stay_type === "FREE",
        category: order.free_stay_category_code ?? null, attendanceConfirmed: false, durationReviewReason: "住宿资产无法定位，经营统计范围待核对。" });
    }
    if(order.status==="RESERVED") {
      for (const person of peopleByOrder.get(order.id) ?? []) {
        const identity = identities.get(person.id);
        if (identity?.personKey) for (const interval of intervals ?? []) {
          const stay = { orderId: order.id, personKey: identity.personKey,
            identityApproximate: identity.approximate, arrival: interval.arrivalDate, departure: interval.departureDate,
            current: false, free: order.stay_type === "FREE", category: order.free_stay_category_code ?? null };
          continuityPlanned.push(stay);
          if (lodging.statistics.includesUnit(interval.inventoryUnitId)) planned.push(stay);
        }
      }
      continue;
    }
    const people = peopleByOrder.get(order.id) ?? [];
    const missingPerson = (durationReviewReason: string) => {
      const available = people.filter(person => !removedByPerson.has(person.id));
      for (const person of available.length ? available : [null]) addStay({durationReviewReason,attendanceConfirmed:false,orderId:order.id,personKey:null,
        ...(person ? { registrationKey: person.id, occupantName: occupantName(person) } : {}),
        arrival:order.arrival_date,departure:order.departure_date,current:order.status==="CHECKED_IN",free:order.stay_type==="FREE",category:order.free_stay_category_code??null,membershipByDate:membership(person, order)});
    };
    if(!intervals?.length){evidenceIssues.push(`订单 ${order.id} 的有效住宿时间线缺失，未推算人数或居住时长`);missingPerson("有效住宿时间线缺失，连续入住起点与人数待核对。");continue;}
    if (!people.length) { if (!whollyExcluded) evidenceIssues.push(`订单 ${order.id} 未登记实际住宿人`); missingPerson("实际住宿人名单缺失，人数与连续时长待核对。"); continue; }
    for (const person of people) {
      const raw = rawById.get(person.id)!;
      const removed = removedByPerson.get(person.id);
      const later = person.role !== "PRIMARY" && raw.created_by_command_id && raw.created_by_command_id !== initialCommands.get(order.id) && local(raw.created_at) > order.arrival_date;
      const common = { attendanceConfirmed: true, occupantName: occupantName(person), identityApproximate: identities.get(person.id)?.approximate ?? false, ...(later ? { durationReviewReason: "入住后追加住宿登记，缺少该住客实际入住日期，不能沿用订单起点。" } : {}), orderId: order.id, registrationKey: person.id, free: order.stay_type === "FREE", category: order.free_stay_category_code ?? null, membershipByDate: membership(person, order) };
      // Registration withdrawal is not an actual departure event; it cannot supply a guest checkout date.
      if (removed) {
        if (removed > order.arrival_date) {
          if (!whollyExcluded) evidenceIssues.push(`订单 ${order.id}：第 ${person.ordinal} 位住宿人于 ${removed} 撤销登记，之前的实际住宿日期待核对；未影响同单其他住客或当前名单`);
          addStay({ ...common, attendanceConfirmed: false, personKey: null, arrival: order.arrival_date, departure: removed < order.departure_date ? removed : order.departure_date, current: false, durationReviewReason: "住宿登记已撤销，撤销时间不是实际离店日期，历史住宿时长待核对。" });
        }
        continue;
      }
      // User-approved operating estimate: nickname first, name as supporting evidence.
      // This read-only association is never a member/permission/payment identity.
      const personKey = identities.get(person.id)?.personKey ?? null;
      if (later) {
        if (!whollyExcluded) evidenceIssues.push(`订单 ${order.id}：第 ${person.ordinal} 位住宿人于 ${local(raw.created_at)} 追加登记，未记录独立入住日期；历史人数待核对，当前登记仍保留`);
        addStay({ ...common, attendanceConfirmed: false, personKey: null, arrival: order.arrival_date, departure: order.departure_date < today ? order.departure_date : today, current: false });
        if (order.status === "CHECKED_IN") addStay({ ...common, personKey, arrival: order.arrival_date, departure: order.departure_date, current: true, historical: false });
        continue;
      }
      for (const interval of intervals) pushInterval({ ...common, personKey, arrival: interval.arrivalDate, departure: interval.departureDate, current: order.status === "CHECKED_IN" && interval.arrivalDate <= today && (today < interval.departureDate || interval === intervals.at(-1)) }, interval.inventoryUnitId, interval);
    }
  }
  const events=communityEvents(orders,amendments,local);
  return communityMetrics(stays,events,range,today,[...new Set(evidenceIssues)],planned, {
    stays: continuityStays, planned: continuityPlanned,
    includesEvent: event => {
      const intervals = lodging.arrangements.get(event.orderId);
      // Arrival/renewal belongs to the new segment; checkout belongs to the segment just ended.
      const departing = event.kind === "EARLY" || event.kind === "DUE";
      return !intervals?.length || intervals.some(interval => lodging.statistics.includesUnit(interval.inventoryUnitId)
        && (departing ? interval.arrivalDate < event.date && event.date <= interval.departureDate
          : interval.arrivalDate <= event.date && event.date < interval.departureDate));
    }
  });
}

export function communityEvents(
  orders: Array<{ id: string; status: string; departure_date: string; arrival_date?: string }>,
  amendments: Array<Pick<Selectable<Database["amendments"]>, "id" | "order_id" | "amendment_type" | "payload" | "command_id" | "sequence" | "reason_note" | "created_at">>,
  local: (date: Date) => string
): CommunityEvent[] {
  const events:CommunityEvent[]=[];
  for(const amendment of amendments){
    const payload=amendment.payload as Record<string,any>;
    if(!payload||typeof payload!=="object")continue;
    const order=orders.find(o=>o.id===amendment.order_id);
    if(!order)continue;
    if(amendment.amendment_type==="SHORTEN_STAY" && payload.completionMode==="EARLY_CHECK_OUT" && order.status==="CHECKED_OUT"){
      const checkout=amendments.find(a=>a.order_id===order.id&&a.amendment_type==="CHECK_OUT"&&a.command_id===amendment.command_id&&a.sequence===amendment.sequence+1);
      if(!checkout || amendments.some(a=>a.order_id===order.id&&a.amendment_type==="REVOKE_CHECK_OUT"&&(a.payload as Record<string,unknown>)?.checkoutAmendmentId===checkout.id))continue;
      const date=payload.after?.departureDate;const before=payload.before?.departureDate;
      if(typeof date!=="string"||typeof before!=="string"||date!==order.departure_date)continue;
      const nights=Math.round((Date.parse(before)-Date.parse(date))/86400000);
      if(!Number.isFinite(nights)||nights<=0)continue;
      events.push({orderId:order.id,date,nights,reason:amendment.reason_note||"原记录未填写原因",kind:"EARLY"});
    }
    if(amendment.amendment_type==="EXTEND_STAY" && ["CHECKED_IN", "CHECKED_OUT"].includes(order.status) && (!order.arrival_date || local(amendment.created_at) >= order.arrival_date) && local(amendment.created_at) <= order.departure_date)events.push({orderId:order.id,date:local(amendment.created_at),nights:0,reason:"原订单已确认延长住宿",kind:"RENEWAL"});
  }
  return events;
}
