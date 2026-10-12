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
