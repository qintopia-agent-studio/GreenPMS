import { describe, expect, it, vi } from "vitest";
import type { Transaction } from "kysely";
import type { Database } from "./schema";
import { loadDashboardCommunity } from "./dashboard-community";

const { loadStays } = vi.hoisted(() => ({ loadStays: vi.fn() }));
vi.mock("./dashboard-stays", () => ({ loadDashboardStays: loadStays }));

describe("当前社区人数包含今日入住，不随历史筛选变化", () => {
  it.each([{from:"2026-09-01",to:"2026-09-30"},{from:"2026-10-01",to:"2026-10-13"}])("%j 中仍统计今日入住的登记", async range => {
    const today="2026-10-14";
    const orders=Array.from({length:31},(_,i)=>({id:`order_${i}`,arrival_date:i===30?today:"2026-09-01",departure_date:"2026-10-16",status:"CHECKED_IN",stay_type:i<5?"FREE":"TRANSIENT",free_stay_category_code:i<5?"VOLUNTEER":null,member_id:null}));
    const occupants=orders.map(o=>({id:`guest_${o.id}`,order_id:o.id,ordinal:1,role:"PRIMARY",full_name:"测试",nickname:"测试",phone:null,document_number:null,created_at:new Date(`${o.arrival_date}T01:00:00Z`),created_by_command_id:null}));
    const tables:Record<string,unknown[]>={"orders as o":orders,order_occupants:occupants,order_occupant_corrections:[],amendments:[],order_occupant_removals:[]};
    const trx={selectFrom:(table:string)=>{
      const q:any={innerJoin:()=>q,select:()=>q,selectAll:()=>q,where:()=>q,orderBy:()=>q,execute:async()=>tables[table]??[]};return q;
    }} as unknown as Transaction<Database>;
    // Simulate the actual exclusive SQL arrival-date upper bound, not a fixed successful result.
    loadStays.mockImplementation(async (_trx,_property,_date,_range,until:string)=>({arrangements:new Map(orders.filter(o=>o.arrival_date<until).map(o=>[o.id,[{inventoryUnitId:"unit",arrivalDate:o.arrival_date,departureDate:o.departure_date}]]))}));
    const result=await loadDashboardCommunity(trx,"property_test",range,today,"Asia/Shanghai");
    expect(result.current.registered).toMatchObject({total:31,paid:26,volunteer:5});
    expect(result.current.total).toBeNull(); // no fabricated cross-order identities
    expect(result.reasons.some(reason=>reason.includes("时间线缺失"))).toBe(false);
  });
});
