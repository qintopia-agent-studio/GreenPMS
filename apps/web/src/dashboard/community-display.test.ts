import { describe, expect, it } from "vitest";
import { displayedCommunityDay, displayedCommunityTrend } from "./community-display";
import type { CommunityDay } from "@qintopia/contracts";
const day:CommunityDay={date:"2026-10-13",total:null,paid:0,volunteer:0,reception:0,otherFree:0,unlinked:37,registered:{total:37,paid:32,volunteer:3,reception:2,otherFree:0}};
describe("community display evidence basis",()=>{
 it("shows existing registration counts instead of zero when documents are absent",()=>{
  expect(displayedCommunityDay(day,true)).toMatchObject({total:37,paid:32,volunteer:3,reception:2});expect(day.total).toBeNull();
 });
 it("uses one registration basis for the whole chart and weighted daily average",()=>{
  const known:CommunityDay={...day,date:"2026-10-12",total:1,paid:1,unlinked:0,registered:{total:2,paid:2,volunteer:0,reception:0,otherFree:0}};
  const r=displayedCommunityTrend([known,day]);expect(r.registrationBasis).toBe(true);expect(r.rows.map(d=>d.total)).toEqual([2,37]);expect(r.dailyAverage).toBe(19.5);
 });
 it("does not fill absent rosters with zero or silently mix evidence",()=>{
  const {registered: _registered,...withoutRegistration}=day;
  const r=displayedCommunityTrend([day,withoutRegistration]);expect(r.dailyAverage).toBeNull();expect(r.rows[1]!.total).toBeNull();
 });
 it("keeps identity-deduplicated data when it is complete",()=>{
  const r=displayedCommunityTrend([{...day,total:5,paid:5,unlinked:0}]);expect(r.registrationBasis).toBe(false);expect(r.rows[0]!.total).toBe(5);
 });
});
