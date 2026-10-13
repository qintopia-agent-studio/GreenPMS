import { describe, expect, it } from "vitest";
import { confirmedInventoryAvailability, type ConfirmedInventoryAvailability } from "./confirmed-inventory-availability";
import { dailySalesCapacity, type CapacityUnit } from "./daily-sales-capacity";

const local=(date:Date)=>date.toISOString().slice(0,10);
const evidence:ConfirmedInventoryAvailability={unitId:"late-room",recordedAt:"2026-09-15T12:00:00.000Z",availableFrom:"2026-08-30",confirmedOn:"2026-10-13",source:"reviewed-test-evidence"};
const unit=(patch:Partial<CapacityUnit>={}):CapacityUnit=>({id:"late-room",kind:"ROOM",parent_room_id:null,active:true,building_code:"F",room_type_code:"single",created_at:new Date(evidence.recordedAt),...patch});
const insertion={created_at:new Date(evidence.recordedAt),effect:{action:"SAVE_ROOM",insertUnits:[{id:"late-room"}],retireUnitIds:[]}};

describe("confirmed late inventory registration",()=>{
 it("restores both occupied weight and daily capacity without changing recorded creation time",()=>{
  const row=unit(),originalDate=row.created_at.toISOString();
  const before=dailySalesCapacity([row],[insertion],local);
  const after=dailySalesCapacity([row],[insertion],local,[evidence]);
  expect(before.weight(row.id,"2026-09-13")).toBeNull();expect(before.on("2026-09-13").value).toBe(0);
  expect(after.weight(row.id,"2026-09-13")).toBe(1);expect(after.on("2026-09-13").value).toBe(1);
  expect(after.period("2026-09-13","2026-09-15").value).toBe(2);expect(row.created_at.toISOString()).toBe(originalDate);
 });
 it("does not invent zero capacity or an opening date before the evidence starts",()=>{
  const after=dailySalesCapacity([unit()],[insertion],local,[evidence]);
  expect(after.on("2026-08-29").value).toBeNull();expect(after.on("2026-08-29").reason).toContain("更早启用依据");
  expect(after.period("2026-08-29","2026-09-01").value).toBeNull();expect(after.on("2026-08-30").value).toBe(1);
 });
 it("never reactivates a later retired room",()=>{
  const c=dailySalesCapacity([unit({active:false})],[insertion,{created_at:new Date("2026-10-01"),effect:{action:"SET_ROOM_ACTIVE",insertUnits:[],retireUnitIds:["late-room"]}}],local,[evidence]);
  expect(c.on("2026-09-13").value).toBe(1);expect(c.on("2026-10-01").value).toBe(0);expect(c.weight("late-room","2026-10-01")).toBeNull();
 });
 it("requires the exact unit version and timestamp",()=>{
  const changed=dailySalesCapacity([unit({created_at:new Date("2026-09-16")})],[insertion],local,[evidence]);
  expect(changed.weight("late-room","2026-09-13")).toBeNull();
  const another=dailySalesCapacity([unit({id:"new-version"})],[],local,[evidence]);expect(another.on("2026-09-13").value).toBeNull();
 });
 it("does not apply independent-room evidence to a split-bed structure",()=>{
  const rows=[unit(),unit({id:"bed",kind:"BED",parent_room_id:"late-room"})];
  const c=dailySalesCapacity(rows,[insertion],local,[evidence]);expect(c.weight("late-room","2026-09-13")).toBeNull();
 });
 it("does not affect an unrelated group's historical capacity",()=>{
  const c=dailySalesCapacity([unit(),unit({id:"known",building_code:"A",created_at:new Date("2026-01-01")})],[insertion],local,[evidence]);
  expect(c.on("2026-08-29",{building:"A"}).value).toBe(1);expect(c.on("2026-08-29",{building:"F"}).value).toBeNull();
 });
 it("is scoped to the confirmed property only, not demo properties sharing a code",()=>{
  expect(confirmedInventoryAvailability("prop_qintopia_demo")).toEqual([]);
  expect(confirmedInventoryAvailability("another-property")).toEqual([]);
  const entries=confirmedInventoryAvailability("prop_qintopia");expect(entries).toHaveLength(2);
  expect(entries.map(e=>e.availableFrom)).toEqual(["2026-08-30","2026-08-31"]);
 });
});
