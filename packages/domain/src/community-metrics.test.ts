import { describe, expect, it } from "vitest";
import { communityMetrics, type CommunityStay } from "./community-metrics";
const stay=(values:Partial<CommunityStay>={}):CommunityStay=>({orderId:"one",personKey:"person",arrival:"2026-01-01",departure:"2026-01-21",current:false,free:false,category:null,...values});
const range={from:"2026-01-01",to:"2026-02-10"};
describe("community residence metrics",()=>{
 it("chains 20 nights and a 20 night next order into 40 actual nights",()=>{
  const c=communityMetrics([stay(),stay({orderId:"two",arrival:"2026-01-21",departure:"2026-02-10"})],[],range,"2026-02-11");
  expect(c.visitors).toBe(1);expect(c.duration).toEqual([{nights:40,current:0,all:1}]);expect(c.counts.RENEWAL).toBe(1);expect(c.counts.RETURN).toBe(0);
 });
 it("does not count a room move inside the same order as renewal",()=>{
  const c=communityMetrics([stay({departure:"2026-01-10"}),stay({arrival:"2026-01-10"})],[],range,"2026-02-11");expect(c.counts.RENEWAL).toBe(0);expect(c.duration[0]?.nights).toBe(20);
 });
 it("separates return stays after an empty night and deduplicates unique visitors",()=>{
  const c=communityMetrics([stay(),stay({orderId:"two",arrival:"2026-01-22",departure:"2026-02-10"})],[],range,"2026-02-11");expect(c.counts.RETURN).toBe(1);expect(c.visitors).toBe(1);expect(c.duration.map(x=>x.nights)).toEqual([19,20]);
 });
 it("does not count future booked nights as lived nights",()=>{
  const c=communityMetrics([stay({current:true,departure:"2026-04-01"})],[],{from:"2026-01-01",to:"2026-01-05"},"2026-01-06");expect(c.duration).toEqual([{nights:4,current:0,all:1},{nights:5,current:1,all:0}]);expect(c.current.total).toBe(1);
 });
 it("counts a person once per date across overlapping records",()=>{
  const c=communityMetrics([stay(),stay({orderId:"two"})],[],range,"2026-02-11");expect(c.trend[0]?.total).toBe(1);
 });
 it("does not infer identity or fabricate zero totals for unlinked guests",()=>{
  const c=communityMetrics([stay({personKey:null})],[],range,"2026-02-11");expect(c.visitors).toBeNull();expect(c.dailyAverage).toBeNull();expect(c.trend[0]?.total).toBeNull();expect(c.reasons.length).toBeGreaterThan(0);
 });
 it("separates volunteer and reception without calling them paid",()=>{
  const c=communityMetrics([stay({current:true,free:true,category:"VOLUNTEER"}),stay({personKey:"other",current:true,free:true,category:"RECEPTION"})],[],range,"2026-01-02");expect(c.current).toMatchObject({total:2,paid:0,volunteer:1,reception:1});
 });
 it("flags contradictory same-day payment categories instead of guessing",()=>{
  const c=communityMetrics([stay(),stay({free:true,category:"VOLUNTEER"})],[],range,"2026-02-11");expect(c.trend[0]).toMatchObject({ total: 1, paid: 0, volunteer: 0, unclassified: 1 });
 });
 it("excludes a move to a successor order from community early departures",()=>{
  const c=communityMetrics([stay(),stay({orderId:"two",arrival:"2026-01-21",departure:"2026-02-10"})],[{orderId:"one",date:"2026-01-21",nights:2,reason:"换房",kind:"EARLY"}],range,"2026-02-11");expect(c.counts.EARLY).toBe(0);
 });
 it("retains recorded departure reason without deriving dissatisfaction",()=>{
  const c=communityMetrics([stay()],[{orderId:"one",date:"2026-01-21",nights:2,reason:"工作出差",kind:"EARLY"}],range,"2026-02-11");expect(c.counts.EARLY).toBe(1);expect(c.records.find(x=>x.kind==="EARLY")?.reason).toContain("工作出差");
 });
});

describe("current and selected-period residence perspectives", () => {
 it("includes departed and ongoing stays, clipping both to the historical cutoff", () => {
  const stays = [
   stay({ arrival: "2026-08-20", departure: "2026-09-10" }),
   stay({ personKey: "later-checkout", arrival: "2026-09-20", departure: "2026-10-05" }),
   stay({ personKey: "ongoing", arrival: "2026-08-31", departure: "2026-11-01", current: true })
  ];
  const c = communityMetrics(stays, [], { from: "2026-09-01", to: "2026-09-30" }, "2026-10-12");
  expect(c.duration).toEqual([
   { nights: 10, current: 0, all: 1 },
   { nights: 21, current: 0, all: 1 },
   { nights: 30, current: 0, all: 1 },
   { nights: 42, current: 1, all: 0 }
  ]);
 });
 it("excludes checkout on the first day and arrival after the cutoff, retaining zero-night arrivals on the cutoff", () => {
  const c = communityMetrics([
   stay({ departure: "2026-01-10" }),
   stay({ personKey: "after", arrival: "2026-01-21", departure: "2026-02-01" }),
   stay({ personKey: "last-day", arrival: "2026-01-20", departure: "2026-02-01" })
  ], [], { from: "2026-01-10", to: "2026-01-20" }, "2026-02-02");
  expect(c.duration).toEqual([{ nights: 0, current: 0, all: 1 }]);
 });
 it("counts overlapping room moves once and separated return stays separately", () => {
  const c = communityMetrics([
   stay({ departure: "2026-01-10" }),
   stay({ orderId: "move", arrival: "2026-01-05", departure: "2026-01-15" }),
   stay({ orderId: "return", arrival: "2026-01-20", departure: "2026-02-05", current: true })
  ], [], { from: "2026-01-01", to: "2026-01-25" }, "2026-01-30");
  expect(c.duration).toEqual([{ nights: 5, current: 0, all: 1 }, { nights: 10, current: 1, all: 0 }, { nights: 14, current: 0, all: 1 }]);
 });
 it("keeps current independent of the selected dates and does not include nonoverlapping current stays in all", () => {
  const stays = [stay({ arrival: "2026-01-20", current: true, departure: "2026-02-20" })];
  const historical = communityMetrics(stays, [], { from: "2026-01-01", to: "2026-01-10" }, "2026-02-01");
  const recent = communityMetrics(stays, [], { from: "2026-01-25", to: "2026-01-31" }, "2026-02-01");
  expect(historical.duration).toEqual([{ nights: 12, current: 1, all: 0 }]);
  expect(recent.duration).toEqual([{ nights: 11, current: 0, all: 1 }, { nights: 12, current: 1, all: 0 }]);
 });
 it("caps future ranges at today, excludes reservations, and includes actual arrivals today", () => {
  const stays = [stay({ current: true, departure: "2026-04-01" }), stay({ personKey: "arrived-today", arrival: "2026-01-10", current: true, departure: "2026-02-01" })];
  const planned = [stay({ personKey: "reserved", arrival: "2026-01-12", departure: "2026-02-01" })];
  const c = communityMetrics(stays, [], { from: "2026-01-10", to: "2026-02-01" }, "2026-01-10", [], planned);
  expect(c.duration).toEqual([{ nights: 0, current: 1, all: 1 }, { nights: 9, current: 1, all: 1 }]);
  const future = communityMetrics(stays, [], { from: "2026-01-11", to: "2026-02-01" }, "2026-01-10", [], planned);
  expect(future.duration.every(row => row.all === 0)).toBe(true);
 });
 it("keeps historical counts unchanged when an ongoing stay later checks out", () => {
  const period = { from: "2026-09-01", to: "2026-09-30" };
  const ongoing = communityMetrics([stay({ arrival: "2026-09-20", departure: "2026-10-05", current: true })], [], period, "2026-10-01");
  const departed = communityMetrics([stay({ arrival: "2026-09-20", departure: "2026-10-05" })], [], period, "2026-10-12");
  expect(ongoing.duration.filter(row => row.all)).toEqual(departed.duration);
  expect(departed.duration).toEqual([{ nights: 10, current: 0, all: 1 }]);
 });
});

describe("confirmed future renewals",()=>{
 it("does not mark an already continued reservation due and never counts booked nights as actual",()=>{
  const current=stay({current:true,departure:"2026-01-05"});
  const planned=stay({orderId:"reserved",arrival:"2026-01-05",departure:"2026-02-05"});
  const c=communityMetrics([current],[],{from:"2026-01-01",to:"2026-01-02"},"2026-01-03",[],[planned]);
  expect(c.counts.DUE).toBe(0);expect(c.duration).toEqual([{nights:1,current:0,all:1},{nights:2,current:1,all:0}]);
 });
});


describe("acceptance evidence edge cases",()=>{
 it("keeps an early checkout record if only one of several guests continues in another order",()=>{
  const c=communityMetrics([stay(),stay({personKey:"second"}),stay({orderId:"next",arrival:"2026-01-21",departure:"2026-02-10"})],[{orderId:"one",date:"2026-01-21",nights:2,reason:"部分住客离开",kind:"EARLY"}],range,"2026-02-11");
  expect(c.counts.EARLY).toBe(1);
 });
 it("explains historical category conflicts even after those guests have left",()=>{
  const c=communityMetrics([stay(),stay({orderId:"conflict",free:true,category:"VOLUNTEER"})],[],range,"2026-02-11");
  expect(c.trend[0]!.total).toBe(1);expect(c.trend[0]!.unclassified).toBe(1);expect(c.reasons.some(r=>r.includes("归属冲突"))).toBe(true);expect(c.current.total).toBe(0);
 });
});

describe("registration counts without identity documents", () => {
  it("preserves current registration facts while leaving cross-order identity unknown", () => {
    const a = { ...stay({personKey:null,current:true}), registrationKey:"registration-a" };
    const b = { ...stay({personKey:null,current:true,free:true,category:"VOLUNTEER"}), registrationKey:"registration-b" };
    const c = communityMetrics([a,b],[],range,"2026-01-02");
    expect(c.current.total).toBeNull();
    expect(c.current.registered).toEqual({total:2,paid:1,volunteer:1,reception:0,otherFree:0});
    expect(c.visitors).toBeNull();
  });
});

describe("registration evidence boundaries",()=>{
 it("counts the same registration once across room segments and keeps distinct registrations",()=>{
  const first={...stay({personKey:null,current:true}),registrationKey:"guest-a"};
  const c=communityMetrics([first,{...first},{...first,registrationKey:"guest-b",free:true,category:"RECEPTION"}],[],range,"2026-01-02");
  expect(c.current.registered).toMatchObject({total:2,paid:1,reception:1});
 });
 it("does not turn an unknown guest roster into one person",()=>{
  const c=communityMetrics([stay({personKey:null,current:true})],[],range,"2026-01-02");expect(c.current.registered?.total).toBeNull();
 });
 it("distinguishes one identity in two orders from two registrations",()=>{
  const c=communityMetrics([{...stay({current:true}),registrationKey:"a"},{...stay({orderId:"two",current:true}),registrationKey:"b"}],[],range,"2026-01-02");
  expect(c.current.total).toBe(1);expect(c.current.registered?.total).toBe(2);
 });
});


describe("optional complete continuity for scoped operating contributions", () => {
  const period = { from: "2026-10-01", to: "2026-10-09" };
  const a = stay({ arrival: "2026-10-01", departure: "2026-10-03" });
  const dorm = stay({ arrival: "2026-10-03", departure: "2026-10-06" });
  const b = stay({ arrival: "2026-10-06", departure: "2026-10-10", current: true });
  it("keeps the default unchanged and classifies events using supplied complete evidence", () => {
    const legacy = communityMetrics([a, b], [], period, "2026-10-07");
    expect(legacy.counts.RETURN).toBe(1);
    const scoped = communityMetrics([a, b], [], period, "2026-10-07", [], [], {
      stays: [a, dorm, b], planned: [], includesEvent: () => true
    });
    expect(scoped.counts.RETURN).toBe(0);
    expect(scoped.counts.NEW).toBe(1);
    expect(scoped.current).toEqual(legacy.current);
    expect(scoped.trend).toEqual(legacy.trend);
    expect(scoped.visitors).toEqual(legacy.visitors);
    expect(scoped.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
  });
  it("uses excluded planned continuity before deciding that a resident is due", () => {
    const current = stay({ arrival: "2026-10-01", departure: "2026-10-08", current: true });
    const next = stay({ orderId: "dorm-reservation", arrival: "2026-10-08", departure: "2026-11-01" });
    const scoped = communityMetrics([current], [], period, "2026-10-07", [], [], {
      stays: [current], planned: [next], includesEvent: () => true
    });
    expect(scoped.counts.DUE).toBe(0);
    expect(scoped.current.total).toBe(1);
  });
});


describe("operating duration within complete residence chains", () => {
  const period = { from: "2026-10-01", to: "2026-10-09" };
  const a = stay({ arrival: "2026-10-01", departure: "2026-10-03" });
  const dorm = stay({ arrival: "2026-10-03", departure: "2026-10-06" });
  const b = stay({ arrival: "2026-10-06", departure: "2026-10-10", current: true });
  const project = (included: CommunityStay[], complete: CommunityStay[], today = "2026-10-07", selected = period) =>
    communityMetrics(included, [], selected, today, [], [], { stays: complete, planned: [], includesEvent: () => true });

  it("counts A two nights plus B one night as one continuous residence on October 7", () => {
    const result = project([a, b], [a, dorm, b]);
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
    expect(result.current.total).toBe(1);
    expect(result.counts.RETURN).toBe(0);
  });
  it("counts the two historical A nights once and no current residence while in F on October 5", () => {
    const futureB = { ...b, current: false };
    const result = project([a, futureB], [a, { ...dorm, current: true }, futureB], "2026-10-05");
    expect(result.duration).toEqual([{ nights: 2, current: 0, all: 1 }]);
    expect(result.current.total).toBe(0);
    expect(result.counts.RETURN).toBe(0);
  });
  it("unions repeated and overlapping included dates across registrations/orders of one identity", () => {
    const overlapping = { ...b, orderId: "parallel-order", departure: "2026-10-09" };
    const result = project([a, { ...a }, b, overlapping], [a, dorm, b, overlapping]);
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
  });
  it("retains separate visits after an actual empty-night gap", () => {
    const result = project([a, b], [a, b]);
    expect(result.duration).toEqual([{ nights: 1, current: 1, all: 1 }, { nights: 2, current: 0, all: 1 }]);
    expect(result.counts.RETURN).toBe(1);
  });
  it("counts no operating residence when the selected historical window only overlaps dorm nights", () => {
    const result = project([a, b], [a, dorm, b], "2026-10-07", { from: "2026-10-03", to: "2026-10-05" });
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 0 }]);
  });
  it("retains cumulative earlier operating nights when a later window intersects the same residence", () => {
    const result = project([a, b], [a, dorm, b], "2026-10-07", { from: "2026-10-06", to: "2026-10-09" });
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
  });
  it("keeps an entirely excluded chain out of the distribution", () => {
    expect(project([], [a, dorm, b]).duration).toEqual([]);
  });
  it("preserves registration-local continuity without inventing a cross-order identity", () => {
    const local = [a, dorm, b].map(stay => ({ ...stay, personKey: null, registrationKey: "registration-one" }));
    const result = project([local[0]!, local[2]!], local);
    expect(result.duration).toEqual([{ nights: 3, current: 1, all: 1 }]);
    expect(result.counts.NEW).toBe(0);
    expect(result.counts.RETURN).toBe(0);
  });
  it("keeps the unscoped default distribution unchanged when continuity is omitted", () => {
    expect(communityMetrics([a, b], [], period, "2026-10-07").duration)
      .toEqual([{ nights: 1, current: 1, all: 1 }, { nights: 2, current: 0, all: 1 }]);
  });
});

describe("resident metric", () => {
  const residentRange = { from: "2026-10-01", to: "2026-10-08" };
  it("enters the long-stay population only after seven completed nights", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-01", departure: "2026-10-12", current: true })], [], residentRange, "2026-10-09");
    expect(result.residentTrend?.find(row => row.date === "2026-10-07")?.longStay).toBe(0);
    expect(result.residentTrend?.find(row => row.date === "2026-10-08")?.longStay).toBe(1);
  });
  it("counts a confirmed member after one night and deduplicates overlap", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-01", departure: "2026-10-12", current: true, memberStatus: "CONFIRMED" })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 1, longStay: 1, member: 1, memberReview: 0 });
  });
  it("excludes free long stays from residents while retaining them in community totals", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-01", departure: "2026-10-12", current: true, free: true, category: "VOLUNTEER" })], [], residentRange, "2026-10-09");
    expect(result.current).toMatchObject({ total: 1, paid: 0, volunteer: 1 });
    expect(result.residentCurrent).toMatchObject({ total: 0, longStay: 0, member: 0, memberReview: 0 });
  });
  it("counts paid long stays as residents while excluding a free long stay", () => {
    const result = communityMetrics([
      stay({ orderId: "paid", arrival: "2026-10-01", departure: "2026-10-12", current: true }),
      stay({ orderId: "free", personKey: "free-person", arrival: "2026-10-01", departure: "2026-10-12", current: true, free: true, category: "RECEPTION" })
    ], [], residentRange, "2026-10-09");
    expect(result.current).toMatchObject({ total: 2, paid: 1, reception: 1 });
    expect(result.residentCurrent).toMatchObject({ total: 1, longStay: 1, member: 0 });
  });
  it("does not count a free stay's member evidence as a resident membership share", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-01", departure: "2026-10-12", current: true, free: true, category: "VOLUNTEER", membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member", basis: "MEMBER_ENTITLEMENT" } } })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 0, longStay: 0, member: 0, memberReview: 0 });
  });
  it("keeps an unbound member order out of the person count and marks the gap", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-08", departure: "2026-10-12", current: true, memberStatus: "UNKNOWN" })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, longStay: 0, member: null, memberReview: 1 });
  });
  it("does not inherit seven-night qualification from a previous visit after an empty night", () => {
    const result = communityMetrics([
      stay({ arrival: "2026-09-01", departure: "2026-09-20" }),
      stay({ orderId: "return", arrival: "2026-10-20", departure: "2026-10-30", current: true })
    ], [], { from: "2026-10-20", to: "2026-10-20" }, "2026-10-21");
    expect(result.residentCurrent).toMatchObject({ total: 0, longStay: 0 });
    expect(result.residentTrend?.[0]).toMatchObject({ total: 0, longStay: 0 });
  });
  it("keeps uninterrupted room moves qualified only before the final departure date", () => {
    const result = communityMetrics([
      stay({ arrival: "2026-10-01", departure: "2026-10-05" }),
      stay({ orderId: "move", arrival: "2026-10-05", departure: "2026-10-12", current: true })
    ], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 1, longStay: 1 });
  });
  it("preserves the resident union when every unknown member already qualifies as long-stay", () => {
    const result = communityMetrics([stay({ arrival: "2026-10-01", departure: "2026-10-12", current: true, memberStatus: "UNKNOWN" })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 1, knownTotal: 1, longStay: 1, member: null, knownMember: 0, memberReview: 1, residentReview: 0 });
  });
  it("preserves known residents and member counts alongside only unresolved additions", () => {
    const result = communityMetrics([
      stay({ personKey: "long", arrival: "2026-10-01", departure: "2026-10-12", current: true, memberStatus: "UNKNOWN" }),
      stay({ personKey: "member", orderId: "ordinary", arrival: "2026-10-09", departure: "2026-10-12", current: true,
        membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "exact-member" } } }),
      stay({ personKey: "short", orderId: "short", arrival: "2026-10-09", departure: "2026-10-12", current: true,
        membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", reason: "缺少有效权益核销依据" } } })
    ], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 2, knownMember: 1, member: null, residentReview: 1, memberReview: 2 });
    expect(result.residentCurrent?.reviewItems).toContainEqual(expect.objectContaining({ orderId: "short", memberId: "payer", reason: "缺少有效权益核销依据" }));
  });
  it("uses daily benefit facts without passing usage between different registrations", () => {
    const result = communityMetrics([
      stay({ arrival: "2026-10-01", departure: "2026-10-02", membershipByDate: { "2026-10-01": { status: "CONFIRMED", memberId: "exact-member" } } }),
      stay({ orderId: "name-only-return", arrival: "2026-10-09", departure: "2026-10-12", current: true,
        membershipByDate: { "2026-10-09": { status: "NOT_MEMBER", memberId: null } } })
    ], [], residentRange, "2026-10-09");
    expect(result.residentTrend?.[0]).toMatchObject({ member: 1, total: 1 });
    expect(result.residentCurrent).toMatchObject({ member: 0, total: 0 });
  });
  it("does not let a confirmed member resolve a different uncertain registration through approximate names", () => {
    const result = communityMetrics([
      stay({ orderId: "verified", registrationKey: "verified-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true,
        membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "exact-member" } } }),
      stay({ orderId: "approximate", registrationKey: "approximate-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true,
        membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "exact-member", reason: "权益核销依据缺失" } } })
    ], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 1, knownMember: 1, residentReview: 1, memberReview: 1 });
  });
  it("does not publish a complete resident count for a late-added guest without actual arrival evidence", () => {
    const result = communityMetrics([stay({ registrationKey: "added", historical: false, durationReviewReason: "追加住宿人实际入住日期待核对", arrival: "2026-10-01", departure: "2026-10-12", current: true })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 0, residentReview: 1 });
    expect(result.residentCurrent?.reviewItems).toContainEqual(expect.objectContaining({ orderId: "one", memberId: null, reason: "追加住宿人实际入住日期待核对" }));
  });
  it("requires confirmed attendance in addition to benefit usage, without relying on reason text", () => {
    const membershipByDate = Object.fromEntries(["2026-10-01", "2026-10-08", "2026-10-09"].map(date => [date, { status: "CONFIRMED" as const, memberId: "member-one" }]));
    const result = communityMetrics([
      stay({ registrationKey: "appended", arrival: "2026-10-01", departure: "2026-10-09", attendanceConfirmed: false, membershipByDate }),
      stay({ registrationKey: "appended", arrival: "2026-10-01", departure: "2026-10-12", current: true, historical: false, attendanceConfirmed: true,
        durationReviewReason: "Independent arrival has not been recorded", membershipByDate })
    ], [], residentRange, "2026-10-09");
    for (const date of ["2026-10-01", "2026-10-08"]) {
      expect(result.residentTrend?.find(row => row.date === date)).toMatchObject({ total: null, member: null, knownTotal: 0, knownMember: 0, longStay: 0, memberReview: 1, residentReview: 1 });
    }
    expect(result.residentCurrent).toMatchObject({ total: 1, member: 1, knownTotal: 1, knownMember: 1, longStay: 0, memberReview: 0, residentReview: 0 });
  });
  it("keeps a withdrawn member registration's unproven historical dates unresolved", () => {
    const result = communityMetrics([stay({ registrationKey: "withdrawn", arrival: "2026-10-01", departure: "2026-10-08", attendanceConfirmed: false,
      durationReviewReason: "Withdrawal is not proof of arrival or departure", membershipByDate: { "2026-10-01": { status: "CONFIRMED", memberId: "member-one" } } })], [], residentRange, "2026-10-09");
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, member: null, knownTotal: 0, knownMember: 0, memberReview: 1, residentReview: 1 });
    expect(result.residentCurrent).toMatchObject({ total: 0, member: 0, memberReview: 0 });
  });
  it("does not turn proven nonmembership into a membership gap when only attendance is unconfirmed", () => {
    const result = communityMetrics([stay({ registrationKey: "unconfirmed", arrival: "2026-10-01", departure: "2026-10-12", attendanceConfirmed: false,
      membershipByDate: { "2026-10-01": { status: "NOT_MEMBER", memberId: "expired-member" } } })], [], residentRange, "2026-10-09");
    expect(result.residentTrend?.[0]).toMatchObject({ total: null, knownTotal: 0, longStay: 0, residentReview: 1, member: 0, knownMember: 0, memberReview: 0 });
  });
  it("keeps every actual registration in review even when names, payer and reasons are shared", () => {
    const shared = stay({ arrival: "2026-10-09", departure: "2026-10-12", current: true, personKey: "same-approximate-name",
      roomCode: "201", arrivalDate: "2026-10-09", departureDate: "2026-10-12",
      membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", memberName: "会员甲", reason: "会员权益核销链不完整。", reasonLabel: "权益使用记录待核对" } } });
    const a = { ...shared, registrationKey: "guest-a", occupantName: "住客甲" };
    const b = { ...shared, registrationKey: "guest-b", occupantName: "住客乙" };
    const result = communityMetrics([a, a, b], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ memberReview: 2, residentReview: 2, knownMember: 0 });
    expect(result.residentCurrent?.reviewItems).toHaveLength(2);
    expect(result.residentCurrent?.reviewItems).toEqual([
      expect.objectContaining({ occupantId: "guest-a", occupantName: "住客甲", memberName: "会员甲", roomCode: "201", arrivalDate: "2026-10-09", reasonLabel: "权益使用记录待核对" }),
      expect.objectContaining({ occupantId: "guest-b", occupantName: "住客乙" })
    ]);
  });
  it("merges independent review reasons for one registration without merging roommates", () => {
    const value = stay({ registrationKey: "late-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      durationReviewReason: "追加住客缺少实际入住日期。", membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", reason: "权益核销依据未记录。", reasonLabel: "权益使用记录待核对" } } });
    const current = communityMetrics([value, value], [], residentRange, "2026-10-09").residentCurrent!;
    expect(current.memberReview).toBe(1); expect(current.residentReview).toBe(1);
    expect(current.reviewItems).toHaveLength(1);
    expect(current.reviewItems?.[0]?.reason).toBe("权益核销依据未记录。；追加住客缺少实际入住日期。");
  });
  it("preserves each order link while counting the same actual guest only once", () => {
    const value = stay({ registrationKey: "guest-a", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      occupantName: "阿青（青女士）", roomCode: "201", arrivalDate: "2026-10-09", departureDate: "2026-10-12",
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member", memberName: "阿青（青女士）", basis: "MEMBER_ENTITLEMENT" } } });
    const result = communityMetrics([value, value, { ...value, orderId: "another", registrationKey: "guest-b" }], [], { from: "2026-10-09", to: "2026-10-09" }, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ member: 1, knownMember: 1, memberReview: 0 });
    expect(result.residentCurrent?.memberItems).toHaveLength(2);
    expect(result.residentCurrent?.memberItems?.[0]).toMatchObject({ occupantId: "guest-a", occupantName: "阿青（青女士）", memberName: "阿青（青女士）", roomCode: "201", basis: "MEMBER_ENTITLEMENT" });
    expect(result.residentTrend?.[0]?.memberItems).toBeUndefined();
    expect(JSON.stringify(result.residentTrend)).not.toContain("阿青");
    expect(JSON.stringify(result.residentCurrent)).not.toContain("personKey");
  });
  it("counts different actual guests using the same member account separately, without splitting one guest across orders", () => {
    const usage = { "2026-10-09": { status: "CONFIRMED" as const, memberId: "shared-account", basis: "MEMBER_ENTITLEMENT" as const } };
    const first = stay({ personKey: "guest-a", orderId: "first", registrationKey: "first-primary", arrival: "2026-10-09", departure: "2026-10-12", current: true, membershipByDate: usage });
    const second = { ...first, orderId: "second", registrationKey: "second-primary", personKey: "guest-b" };
    const different = communityMetrics([first, second], [], residentRange, "2026-10-09");
    expect(different.current.total).toBe(2); expect(different.residentCurrent).toMatchObject({ member: 2, total: 2 });
    const same = communityMetrics([first, { ...second, personKey: "guest-a" }], [], residentRange, "2026-10-09");
    expect(same.current.total).toBe(1); expect(same.residentCurrent).toMatchObject({ member: 1, total: 1 });
    expect(same.residentCurrent?.memberItems).toHaveLength(2);
  });
  it("never joins different guests' long-stay chains merely because they use the same member account", () => {
    const usage = { "2026-10-09": { status: "CONFIRMED" as const, memberId: "shared", basis: "MEMBER_ENTITLEMENT" as const } };
    const old = stay({ personKey: "guest-old", orderId: "old", registrationKey: "old-primary", arrival: "2026-10-01", departure: "2026-10-07", membershipByDate: usage });
    const recent = stay({ personKey: "guest-new", orderId: "new", registrationKey: "new-primary", arrival: "2026-10-07", departure: "2026-10-12", current: true, membershipByDate: usage });
    expect(communityMetrics([old, recent], [], residentRange, "2026-10-09").residentCurrent).toMatchObject({ member: 1, total: 1, longStay: 0 });
  });
  it.each(["2026-10-09", "2026-10-08"])("excludes departure %s from current people, residents, member lists and duration even without checkout", departure => {
    const value = stay({ registrationKey: "primary", arrival: "2026-10-01", departure, current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: null, memberName: "历史会员权益", basis: "MEMBER_ENTITLEMENT" } } });
    const result = communityMetrics([value], [], residentRange, "2026-10-09");
    expect(result.current).toMatchObject({ total: 0, paid: 0, unlinked: 0 });
    expect(result.residentCurrent).toMatchObject({ total: 0, longStay: 0, member: 0, memberReview: 0, memberItems: [], reviewItems: [] });
    expect(result.duration.every(row => row.current === 0)).toBe(true);
    expect(result.durationCoverage?.current).toMatchObject({ pendingRegistrations: 0, pendingOrders: 0 });
  });
  it("keeps the new room and same-day renewed order active without an empty night", () => {
    const old = stay({ orderId: "old", registrationKey: "old-primary", arrival: "2026-10-01", departure: "2026-10-09", current: true });
    const next = stay({ orderId: "renewed", registrationKey: "next-primary", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "account", basis: "MEMBER_ENTITLEMENT" } } });
    const result = communityMetrics([old, next], [], residentRange, "2026-10-09");
    expect(result.current.total).toBe(1); expect(result.residentCurrent).toMatchObject({ total: 1, longStay: 1, member: 1 });
    expect(result.residentCurrent?.memberItems?.map(item => item.orderId)).toEqual(["renewed"]);
    expect(result.duration).toContainEqual({ nights: 8, current: 1, all: 0 });
  });
  it("keeps duplicate interval usage to one primary and rejects multiple confirmed representatives on one order", () => {
    const primary = stay({ orderId: "shared", registrationKey: "one", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: null, basis: "MEMBER_ENTITLEMENT" } } });
    expect(communityMetrics([primary, primary], [], residentRange, "2026-10-09").residentCurrent).toMatchObject({ total: 1, member: 1 });
    const invalid = communityMetrics([primary, { ...primary, registrationKey: "two", personKey: "other" }], [], residentRange, "2026-10-09").residentCurrent;
    expect(invalid).toMatchObject({ total: null, knownTotal: 0, knownMember: 0, memberReview: 2, memberItems: [] });
  });
});
