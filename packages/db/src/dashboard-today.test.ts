import { describe, expect, it } from "vitest";
import { summarizeDashboardToday } from "./dashboard-today";
import type { LoadedDashboardMoney } from "./dashboard-money";
const date="2026-10-14";
const fact=(patch:Partial<LoadedDashboardMoney>={}):LoadedDashboardMoney=>({id:"fact_1",date,currency:"CNY",netMinor:"27720",kind:"COLLECTION",commandType:"RECORD_COLLECTION",family:"STAY",linkedTransfer:false,transferSource:false,reclassifiedReversal:false,replacementCollection:false,correctsFact:false,deletionCorrection:false,orderId:"order_1",memberId:null,registeredAt:"2026-10-14T00:00:00.000Z",businessDate:null,...patch});
describe("今日订单与登记金额",()=>{
 it("只统计门店当天，收款、退款和更正按正负方向汇总，内部转款不计入",()=>{
  const result=summarizeDashboardToday(date,"CNY",[{id:"order_1",date,registeredAt:"2026-10-14T00:00:00Z"},{id:"old",date:"2026-09-30",registeredAt:"2026-09-30T00:00:00Z"}], [
   fact(),fact({id:"member",family:"MEMBER",orderId:null,memberId:"member_1",commandType:"RECORD_MEMBERSHIP_PAYMENT",netMinor:"10001"}),
   fact({id:"refund",kind:"REFUND",commandType:"RECORD_REFUND",netMinor:"-100"}),fact({id:"correction",kind:"REVERSAL",commandType:"REVERSE_FACT",netMinor:"-20"}),
   fact({id:"transfer",linkedTransfer:true}),fact({id:"old",date:"2026-09-30"}),fact({id:"review",commandType:null})
  ]);
  expect(result.todayOrders).toBe(1);
  expect(result.todayCollections).toEqual([{currency:"CNY",amountMinor:"37601",count:4}]);
  expect(result.todayCollectionReviewCount).toBe(1);
  expect(result.details.filter(row=>row.metric==="TODAY_COLLECTIONS")).toHaveLength(4);
 });
 it("币种分开、零值明确且重复事实不重复计数",()=>{
  expect(summarizeDashboardToday(date,"CNY",[],[]).todayCollections).toEqual([{currency:"CNY",amountMinor:"0",count:0}]);
  const result=summarizeDashboardToday(date,"CNY",[],[fact(),fact(),fact({id:"usd",currency:"USD",netMinor:"1"})]);
  expect(result.todayCollections).toEqual([{currency:"CNY",amountMinor:"27720",count:1},{currency:"USD",amountMinor:"1",count:1}]);
 });
});
