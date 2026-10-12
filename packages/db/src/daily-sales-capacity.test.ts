import { describe, expect, it } from "vitest";
import { dailySalesCapacity, type CapacityUnit } from "./daily-sales-capacity";
const room=(p:Partial<CapacityUnit>={}):CapacityUnit=>({id:"room",kind:"ROOM",parent_room_id:null,active:true,building_code:"A",room_type_code:"standard",created_at:new Date("2026-01-01"),...p});
const local=(d:Date)=>d.toISOString().slice(0,10);
describe("daily sales capacity",()=>{
 it("sums daily structure rather than using current stock for all dates",()=>{
  const units=[room({active:false}),room({id:"new",created_at:new Date("2026-01-03")}),room({id:"bed1",kind:"BED",parent_room_id:"new",created_at:new Date("2026-01-03")}),room({id:"bed2",kind:"BED",parent_room_id:"new",created_at:new Date("2026-01-03")})];
  const c=dailySalesCapacity(units,[{created_at:new Date("2026-01-03"),effect:{action:"SAVE_ROOM",retireUnitIds:["room"],insertUnits:[{id:"new"},{id:"bed1"},{id:"bed2"}]}}],local);
  expect(c.on("2026-01-02").value).toBe(1);expect(c.on("2026-01-03").value).toBe(2);expect(c.period("2026-01-01","2026-01-05").value).toBe(6);expect(c.weight("new","2026-01-03")).toBe(2);
 });
 it("does not treat rename as a capacity change",()=>{
  const c=dailySalesCapacity([room()],[{created_at:new Date("2026-01-03"),effect:{action:"SAVE_ROOM",roomRename:{roomId:"room",beforeCode:"101",afterCode:"102"},insertUnits:[],retireUnitIds:[]}}],local);expect(c.period("2026-01-01","2026-01-05").value).toBe(4);
 });
 it("scopes unknown activation records to the affected group and day",()=>{
  const c=dailySalesCapacity([room(),room({id:"b",building_code:"B",created_at:new Date("2026-02-01")})],[],local);
  expect(c.on("2026-01-02",{building:"A"}).value).toBe(1);expect(c.on("2026-01-02",{building:"B"}).value).toBeNull();expect(c.on("2026-02-02").value).toBe(2);
 });
 it("does not erase proven independent stay nights merely because inventory was imported later",()=>{
  const c=dailySalesCapacity([room({created_at:new Date("2026-02-01")})],[],local);
  expect(c.on("2026-01-02").value).toBeNull();expect(c.weight("room","2026-01-02")).toBe(1);
 });
 it("keeps unknown inactive lifecycle conservative",()=>{expect(dailySalesCapacity([room({active:false})],[],local).on("2026-02-02").value).toBeNull()});
});
