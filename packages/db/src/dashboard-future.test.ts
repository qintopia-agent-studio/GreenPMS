import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import type { loadDashboardStays } from "./dashboard-stays";
vi.mock("./inventory.ts",()=>({listAvailability:vi.fn()}));
import { listAvailability } from "./inventory";
import { loadDashboardFuture } from "./dashboard-current";
function trx(claims:unknown[]):Transaction<Database>{const builder:object=new Proxy({},{get:(_,key)=>key==="execute"?async()=>claims:()=>builder});return {selectFrom:()=>builder} as unknown as Transaction<Database>}
const date="2026-10-12";
const lodging={atomicUnits:[{id:"room",kind:"ROOM"},{id:"bed",kind:"BED"}],validOrderIds:new Set<string>(),invalidFutureDates:new Set([date])} as unknown as Awaited<ReturnType<typeof loadDashboardStays>>;
describe("future inventory uses operational availability",()=>{
 it("does not clear available stock because historical lifecycle evidence is missing",async()=>{
  vi.mocked(listAvailability).mockResolvedValue([{id:"room",nights:[{serviceDate:date,available:true,blockingClaimIds:[]}]},{id:"bed",nights:[{serviceDate:date,available:false,blockingClaimIds:["claim"]}]}] as unknown as Awaited<ReturnType<typeof listAvailability>>);
  const result=await loadDashboardFuture(trx([{id:"claim",source_type:"ORDER_SEGMENT",order_id:"order",order_property_id:"property",status:"RESERVED",stay_status:"PLANNED",stay_type:"PAID"}]),"property",date,"2026-10-13",lodging);
  expect(result[0]).toMatchObject({availableRooms:1,availableBeds:0,paid:1,free:0});
 });
 it("keeps missing availability unknown only for the affected inventory kind",async()=>{
  vi.mocked(listAvailability).mockResolvedValue([{id:"bed",nights:[{serviceDate:date,available:true,blockingClaimIds:[]}]}] as unknown as Awaited<ReturnType<typeof listAvailability>>);
  const result=await loadDashboardFuture(trx([]),"property",date,"2026-10-13",lodging);
  expect(result[0]).toMatchObject({availableRooms:null,availableBeds:1,review:1,quality:"PARTIAL"});
 });
 it("does not classify ambiguous or cross-property blocked claims as free stock",async()=>{
  vi.mocked(listAvailability).mockResolvedValue([{id:"room",nights:[{serviceDate:date,available:false,blockingClaimIds:["bad"]}]},{id:"bed",nights:[{serviceDate:date,available:false,blockingClaimIds:["x","y"]}]}] as unknown as Awaited<ReturnType<typeof listAvailability>>);
  const result=await loadDashboardFuture(trx([{id:"bad",source_type:"ORDER_SEGMENT",order_id:"order",order_property_id:"other",status:"RESERVED",stay_status:"PLANNED",stay_type:"PAID"}]),"property",date,"2026-10-13",lodging);
  expect(result[0]).toMatchObject({availableRooms:0,availableBeds:0,paid:0,review:2});
 });
});
