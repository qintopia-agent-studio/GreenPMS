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
});
