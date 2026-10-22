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
  it("keeps uninterrupted room moves and overdue current stays qualified", () => {
    const result = communityMetrics([
      stay({ arrival: "2026-10-01", departure: "2026-10-05" }),
      stay({ orderId: "move", arrival: "2026-10-05", departure: "2026-10-08", current: true })
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
        membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", reason: "缺少实际住客的证件依据" } } })
    ], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 2, knownMember: 1, member: null, residentReview: 1, memberReview: 2 });
    expect(result.residentCurrent?.reviewItems).toContainEqual(expect.objectContaining({ orderId: "short", memberId: "payer", reason: "缺少实际住客的证件依据" }));
  });
  it("uses membership evidence for each day without passing it through an approximate person grouping", () => {
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
        membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "exact-member", reason: "住客证件缺失" } } })
    ], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 1, knownMember: 1, residentReview: 1, memberReview: 1 });
  });
  it("does not publish a complete resident count for a late-added guest without actual arrival evidence", () => {
    const result = communityMetrics([stay({ registrationKey: "added", historical: false, durationReviewReason: "追加住宿人实际入住日期待核对", arrival: "2026-10-01", departure: "2026-10-12", current: true })], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 0, residentReview: 1 });
    expect(result.residentCurrent?.reviewItems).toContainEqual(expect.objectContaining({ orderId: "one", memberId: null, reason: "追加住宿人实际入住日期待核对" }));
  });
  it("requires confirmed attendance in addition to exact membership, without relying on reason text", () => {
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
      membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", memberName: "会员甲", reason: "未记录实际住客与会员的本人关系。", reasonLabel: "未记录本人入住关系" } } });
    const a = { ...shared, registrationKey: "guest-a", occupantName: "住客甲" };
    const b = { ...shared, registrationKey: "guest-b", occupantName: "住客乙" };
    const result = communityMetrics([a, a, b], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ memberReview: 2, residentReview: 2, knownMember: 0 });
    expect(result.residentCurrent?.reviewItems).toHaveLength(2);
    expect(result.residentCurrent?.reviewItems).toEqual([
      expect.objectContaining({ occupantId: "guest-a", occupantName: "住客甲", memberName: "会员甲", roomCode: "201", arrivalDate: "2026-10-09", reasonLabel: "未记录本人入住关系" }),
      expect.objectContaining({ occupantId: "guest-b", occupantName: "住客乙" })
    ]);
  });
  it("merges independent review reasons for one registration without merging roommates", () => {
    const value = stay({ registrationKey: "late-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      durationReviewReason: "追加住客缺少实际入住日期。", membershipByDate: { "2026-10-09": { status: "UNKNOWN", memberId: "payer", reason: "本人关系未记录。", reasonLabel: "未记录本人入住关系" } } });
    const current = communityMetrics([value, value], [], residentRange, "2026-10-09").residentCurrent!;
    expect(current.memberReview).toBe(1); expect(current.residentReview).toBe(1);
    expect(current.reviewItems).toHaveLength(1);
    expect(current.reviewItems?.[0]?.reason).toBe("本人关系未记录。；追加住客缺少实际入住日期。");
  });
  it("preserves all current order links for one confirmed member without multiplying the member count", () => {
    const value = stay({ registrationKey: "guest-a", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      occupantName: "阿青（青女士）", roomCode: "201", arrivalDate: "2026-10-09", departureDate: "2026-10-12",
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member", memberName: "阿青（青女士）", identityBasis: "STAY_CONVERSION" } } });
    const result = communityMetrics([value, value, { ...value, orderId: "another", registrationKey: "guest-b" }], [], { from: "2026-10-09", to: "2026-10-09" }, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ member: 1, knownMember: 1, memberReview: 0 });
    expect(result.residentCurrent?.memberItems).toHaveLength(2);
    expect(result.residentCurrent?.memberItems?.[0]).toMatchObject({ occupantId: "guest-a", occupantName: "阿青（青女士）", memberName: "阿青（青女士）", roomCode: "201", identityBasis: "STAY_CONVERSION" });
    expect(result.residentTrend?.[0]?.memberItems).toBeUndefined();
    expect(JSON.stringify(result.residentTrend)).not.toContain("阿青");
    expect(JSON.stringify(result.residentCurrent)).not.toContain("personKey");
  });
  it("deduplicates the resident union by exact membership across different nickname identities and long-stay overlap", () => {
    const member = { "2026-10-09": { status: "CONFIRMED" as const, memberId: "member-one", identityBasis: "STAY_CONVERSION" as const } };
    const long = stay({ personKey: "first-nickname", orderId: "long", registrationKey: "long-guest", arrival: "2026-10-01", departure: "2026-10-12", current: true, membershipByDate: member });
    const short = stay({ personKey: "second-nickname", orderId: "short", registrationKey: "short-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true, membershipByDate: member });
    const result = communityMetrics([long, short], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 1, knownTotal: 1, member: 1, longStay: 1 });
    expect(result.current).toMatchObject({ total: 1, paid: 1 });
    expect(communityMetrics([long, { ...short, arrival: "2026-10-01" }], [], residentRange, "2026-10-09").residentCurrent).toMatchObject({ total: 1, member: 1, longStay: 1 });
  });
  it("does not collapse different confirmed members that share a fuzzy person grouping", () => {
    const first = stay({ personKey: "same-fuzzy-name", orderId: "first", registrationKey: "first-guest", arrival: "2026-10-01", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member-one" } } });
    const second = { ...first, orderId: "second", registrationKey: "second-guest", membershipByDate: { "2026-10-09": { status: "CONFIRMED" as const, memberId: "member-two" } } };
    const result = communityMetrics([first, second], [], residentRange, "2026-10-09");
    expect(result.residentCurrent).toMatchObject({ total: 2, knownTotal: 2, member: 2, longStay: 2 });
    expect(result.current).toMatchObject({ total: 2, paid: 2 });
  });
  it("keeps a short unknown registration unresolved beside a confirmed member with the same fuzzy name", () => {
    const first = stay({ personKey: "shared-name", orderId: "first", registrationKey: "first-guest", arrival: "2026-10-09", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member-one" } } });
    const unknown = { ...first, orderId: "second", registrationKey: "second-guest", membershipByDate: { "2026-10-09": { status: "UNKNOWN" as const, memberId: "member-one", reason: "未记录本人关系" } } };
    const result = communityMetrics([first, unknown], [], residentRange, "2026-10-09");
    expect(result.current.total).toBe(2);
    expect(result.residentCurrent).toMatchObject({ total: null, knownTotal: 1, knownMember: 1, memberReview: 1, residentReview: 1 });
    expect(result.residentCurrent?.memberItems).toHaveLength(1); expect(result.residentCurrent?.reviewItems?.[0]?.occupantId).toBe("second-guest");
  });
  it("never lets a short-stay member borrow another member's long-stay chain through a shared nickname", () => {
    const first = stay({ personKey: "shared-nickname", orderId: "long", registrationKey: "guest-long", arrival: "2026-09-25", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member-long", identityBasis: "STAY_CONVERSION" } } });
    const second = stay({ personKey: "shared-nickname", orderId: "short", registrationKey: "guest-short", arrival: "2026-10-07", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member-short", identityBasis: "DOCUMENT" } } });
    const result = communityMetrics([first, second], [], residentRange, "2026-10-09");
    expect(result.current.total).toBe(2);
    expect(result.residentCurrent).toMatchObject({ total: 2, member: 2, longStay: 1 });
  });
  it.each(["2026-10-01", "2026-10-09"])("keeps exact person totals stable after membership expires for arrival %s", arrival => {
    const membershipByDate = {
      "2026-10-09": { status: "CONFIRMED" as const, memberId: "member", identityBasis: "STAY_CONVERSION" as const },
      "2026-10-10": { status: "NOT_MEMBER" as const, memberId: "member", identityBasis: "STAY_CONVERSION" as const }
    };
    const first = stay({ personKey: "first-nickname", orderId: "first", registrationKey: "guest-first", arrival, departure: "2026-10-15", current: true, membershipByDate });
    const second = { ...first, personKey: "second-nickname", orderId: "second", registrationKey: "guest-second" };
    const result = communityMetrics([first, second], [], { from: "2026-10-09", to: "2026-10-10" }, "2026-10-10");
    expect(result.trend.map(row => row.total)).toEqual([1, 1]);
    expect(result.current).toMatchObject({ total: 1, paid: 1 });
    expect(result.visitors).toBe(1);
    expect(result.residentCurrent).toMatchObject({ total: arrival === "2026-10-01" ? 1 : 0, member: 0, longStay: arrival === "2026-10-01" ? 1 : 0 });
    expect(result.residentTrend?.[0]?.member).toBe(1);
  });
  it("does not join an uncertain old nickname to a different proven member's continuous stay", () => {
    const old = stay({ personKey: "same-nickname", orderId: "old", registrationKey: "old-guest", arrival: "2026-10-01", departure: "2026-10-06" });
    const current = stay({ personKey: "same-nickname", orderId: "current", registrationKey: "current-guest", arrival: "2026-10-06", departure: "2026-10-12", current: true,
      membershipByDate: { "2026-10-09": { status: "CONFIRMED", memberId: "member", identityBasis: "DOCUMENT" } } });
    expect(communityMetrics([old, current], [], residentRange, "2026-10-09").residentCurrent).toMatchObject({ total: 1, member: 1, longStay: 0 });
  });
  it("counts a proven person in visitors even without a nickname grouping, but keeps historical attendance gaps unknown", () => {
    const membershipByDate = { "2026-10-09": { status: "CONFIRMED" as const, memberId: "member", identityBasis: "DOCUMENT" as const } };
    const actual = stay({ personKey: null, registrationKey: "guest", arrival: "2026-10-09", departure: "2026-10-12", current: true, membershipByDate });
    const result = communityMetrics([actual], [], { from: "2026-10-09", to: "2026-10-09" }, "2026-10-09");
    expect(result.current).toMatchObject({ total: 1, unlinked: 0 }); expect(result.visitors).toBe(1);
    const gap = communityMetrics([{ ...actual, attendanceConfirmed: false }], [], { from: "2026-10-09", to: "2026-10-09" }, "2026-10-09");
    expect(gap.current).toMatchObject({ total: null, unlinked: 1 }); expect(gap.visitors).toBeNull();
    expect(gap.residentCurrent).toMatchObject({ knownTotal: 0, knownMember: 0, memberReview: 1 });
    expect(gap.residentCurrent?.memberItems).toEqual([]);
  });
  it("keeps category conflicts visible when exact identity joins different nickname registrations", () => {
    const membershipByDate = { "2026-10-09": { status: "NOT_MEMBER" as const, memberId: "member", identityBasis: "DOCUMENT" as const } };
    const first = stay({ personKey: "paid-name", registrationKey: "paid-guest", arrival: "2026-10-01", departure: "2026-10-12", current: true, membershipByDate });
    const second = { ...first, personKey: "free-name", registrationKey: "free-guest", orderId: "free", free: true, category: "VOLUNTEER" };
    const result = communityMetrics([first, second], [], residentRange, "2026-10-09");
    expect(result.current).toMatchObject({ total: 1, paid: 0, volunteer: 0, unclassified: 1 });
    expect(result.residentCurrent).toMatchObject({ total: 1, member: 0, longStay: 1 });
  });
});
