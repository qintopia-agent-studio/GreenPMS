import { describe, expect, it } from "vitest";
import { summarizeDashboardToday } from "./dashboard-today";
import { dashboardMoneyDetail } from "./dashboard-money";
import type { LoadedDashboardMoney } from "./dashboard-money";
const date="2026-10-14";
const fact=(patch:Partial<LoadedDashboardMoney>={}):LoadedDashboardMoney=>({id:"fact_1",date,currency:"CNY",netMinor:"27720",kind:"COLLECTION",commandType:"RECORD_COLLECTION",family:"STAY",linkedTransfer:false,transferSource:false,reclassifiedReversal:false,replacementCollection:false,correctsFact:false,deletionCorrection:false,orderId:"order_1",memberId:null,registeredAt:"2026-10-14T00:00:00.000Z",businessDate:null,...patch});
describe("今日订单与登记金额",()=>{
 it("为登记事实保留来源、认领、同步与关联链字段",()=>{
  const detail=dashboardMoneyDetail(fact({family:"CHANNEL",id:"channel-refund",kind:"REFUND",netMinor:"-4000",syncStatus:"MANUAL_ENTRY",evidenceStatus:"COMPLETE",referencesFactId:"channel-sale"}));
  expect(detail).toMatchObject({sourceType:"CHANNEL",claimStatus:"CONFIRMED",sourceFactId:"channel-refund",referencesFactId:"channel-sale",syncStatus:"MANUAL_ENTRY",evidenceStatus:"COMPLETE"});
 });
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
 it("把渠道应结、渠道退款和更正按登记日纳入，并保留业务日期追溯",()=>{
  const result=summarizeDashboardToday(date,"CNY",[],[
   fact({id:"channel-sale",family:"CHANNEL",kind:"SALE",commandType:null,netMinor:"30000",businessDate:"2026-10-12",orderId:"channel-order"}),
   fact({id:"channel-refund",family:"CHANNEL",kind:"REFUND",commandType:null,netMinor:"-4000",businessDate:"2026-10-13",orderId:"channel-order"}),
   fact({id:"channel-correction",family:"CHANNEL",kind:"CORRECTION",commandType:null,netMinor:"-100",businessDate:"2026-10-01",orderId:"channel-order"}),
   fact({id:"channel-reversal",family:"CHANNEL",kind:"REVERSAL",commandType:null,netMinor:"4000",businessDate:"2026-10-13",orderId:"channel-order"})
  ]);
  expect(result.todayCollections).toEqual([{currency:"CNY",amountMinor:"29900",count:4}]);
  expect(result.todayCollectionBreakdown).toEqual([{currency:"CNY",source:"CHANNEL",amountMinor:"29900",count:4}]);
  expect(result.details.filter(row=>row.metric==="TODAY_COLLECTIONS").map(row=>({id:row.id,amount:row.amountMinor,businessDate:row.businessDate,label:row.label}))).toEqual([
   {id:"today-collection:channel-sale",amount:"30000",businessDate:"2026-10-12",label:"渠道应结登记"},
   {id:"today-collection:channel-refund",amount:"-4000",businessDate:"2026-10-13",label:"渠道登记退款"},
   {id:"today-collection:channel-correction",amount:"-100",businessDate:"2026-10-01",label:"渠道登记更正"},
   {id:"today-collection:channel-reversal",amount:"4000",businessDate:"2026-10-13",label:"渠道登记更正"}
  ]);
 });
 it("币种分开、零值明确且重复事实不重复计数",()=>{
  expect(summarizeDashboardToday(date,"CNY",[],[]).todayCollections).toEqual([{currency:"CNY",amountMinor:"0",count:0}]);
  const result=summarizeDashboardToday(date,"CNY",[],[fact(),fact(),fact({id:"usd",currency:"USD",netMinor:"1"})]);
  expect(result.todayCollections).toEqual([{currency:"CNY",amountMinor:"27720",count:1},{currency:"USD",amountMinor:"1",count:1}]);
 });
});
