import { describe,expect,it } from 'vitest';
import { recognizedMatchedSales,aggregateOperatingSales,type MatchedSaleFact,type OperatingSaleEvent } from './operating-sales';
const fact=(patch:Partial<MatchedSaleFact>={}):MatchedSaleFact=>({id:'STAY:f1',source:'DIRECT',date:'2026-10-02',currency:'CNY',amountMinor:'30000',registeredAt:'2026-10-02T01:00:00Z',orderId:'o1',memberId:null,billId:'bill1',billAmountMinor:'100000',verified:true,reversed:false,refund:false,sourceKey:'STAY_FACT:f1',...patch});
const baseline={month:'2026-09-01',currency:'CNY',amountMinor:'4864998',recognitionFrom:'2026-10-01'};
describe('按业务匹配确认收入',()=>{
 it('未关联或未核实款项不计，已匹配份额只认300而非整笔1000',()=>{
  expect(recognizedMatchedSales([],[],'2026-10-01').events).toHaveLength(0);
  const r=recognizedMatchedSales([fact(),fact({id:'unverified',verified:false})],[],'2026-10-01');
  expect(r.events.map(e=>e.amountMinor)).toEqual(['30000']);expect(r.reviews).toHaveLength(1);
 });
 it('后匹配取匹配日，分别匹配不会重复整笔，重复行幂等',()=>{
  const a=fact(),b=fact({id:'STAY:f2',date:'2026-10-03',amountMinor:'70000',orderId:'o2',sourceKey:'STAY_FACT:f2'});
  const r=recognizedMatchedSales([a,a,b],[],'2026-10-01');
  expect(r.events.map(e=>[e.date,e.amountMinor])).toEqual([['2026-10-02','30000'],['2026-10-03','70000']]);
 });
 it('收款额度不足的重复归属整体待核对，不挑一笔凑总额',()=>{
  const r=recognizedMatchedSales([fact({amountMinor:'70000'}),fact({id:'member',source:'MEMBERSHIP',amountMinor:'70000'})],[],'2026-10-01');
  expect(r.events).toEqual([]);expect(r.reviews).toHaveLength(2);
 });
 it('9月已计整笔款10月补匹配不重计，已部分匹配也不重计',()=>{
  const old=fact({id:'old',date:'2026-09-20',amountMinor:'50000'}),later=fact({amountMinor:'50000'});
  expect(recognizedMatchedSales([later,old],[{key:'PAYMENT_BILL:bill1',amountMinor:'100000'}],'2026-10-01').events).toEqual([]);
  expect(recognizedMatchedSales([later,old],[{key:'PAYMENT_BILL:bill1',amountMinor:'50000'}],'2026-10-01').events[0]?.amountMinor).toBe('50000');
 });
 it('期初来源条目与整笔来源同时存在不双扣；未知来源不当作已计',()=>{
  expect(recognizedMatchedSales([fact()],[{key:'PAYMENT_BILL:bill1',amountMinor:'10000'},{key:'STAY_FACT:f1',amountMinor:'10000'}],'2026-10-01').events[0]?.amountMinor).toBe('20000');
  expect(recognizedMatchedSales([fact({billId:null,billAmountMinor:null})],[{key:'STAY_FACT:f1',amountMinor:'30000'}],'2026-10-01').events).toEqual([]);
 });
 it('撤销误匹配后重新登记只保留有效关联；退款在自身日期扣',()=>{
  const r=recognizedMatchedSales([fact({reversed:true}),fact({id:'new',date:'2026-10-03'}),fact({id:'refund',date:'2026-10-04',refund:true,amountMinor:'5000',billId:'refund1'})],[],'2026-10-01');
  expect(r.events.map(e=>[e.date,e.amountMinor])).toEqual([['2026-10-03','30000'],['2026-10-04','-5000']]);
 });
 it('fact级期初额度沿稳定账单承接，释放后新fact不重计',()=>{
  const old=fact({id:'old',sourceKey:'STAY_FACT:old',date:'2026-09-20',registeredAt:'2026-09-20T01:00:00Z',amountMinor:'30000',reversed:true,reversedAt:'2026-10-01T01:00:00Z'});
  const current=fact({id:'new',sourceKey:'STAY_FACT:new',amountMinor:'30000'});
  expect(recognizedMatchedSales([old,current],[{key:'STAY_FACT:old',amountMinor:'30000'}],'2026-10-01').events).toEqual([]);
  expect(recognizedMatchedSales([current],[{key:'STAY_FACT:old',amountMinor:'30000'}],'2026-10-01',[{sourceKey:'STAY_FACT:old',billId:'bill1',reversedAt:'2026-10-01T01:00:00Z'}]).events).toEqual([]);
 });
 it.each(['STAY_FACT:A0','PAYMENT_BILL:bill1'])('部分期初额度不抢占同账单另一单的收入日期：%s',(key)=>{
  const old=fact({id:'A0',sourceKey:'STAY_FACT:A0',orderId:'A',date:'2026-09-20',registeredAt:'2026-09-20T01:00:00Z',reversed:true,reversedAt:'2026-10-03T01:00:00Z',billAmountMinor:'60000'});
  const added=fact({id:'B0',sourceKey:'STAY_FACT:B0',orderId:'B',date:'2026-10-02',registeredAt:'2026-10-02T01:00:00Z',billAmountMinor:'60000'});
  const rematched=fact({id:'A1',sourceKey:'STAY_FACT:A1',orderId:'A',date:'2026-10-03',registeredAt:'2026-10-03T02:00:00Z',billAmountMinor:'60000'});
  const result=recognizedMatchedSales([rematched,added,old],[{key,amountMinor:'30000'}],'2026-10-01');
  expect(result.events.map(e=>[e.orderId,e.date,e.amountMinor])).toEqual([['B','2026-10-02','30000']]);
  const again=fact({...rematched,id:'A2',sourceKey:'STAY_FACT:A2',date:'2026-10-05',registeredAt:'2026-10-05T02:00:00Z'});
  expect(recognizedMatchedSales([old,added,{...rematched,reversed:true,reversedAt:'2026-10-05T01:00:00Z'},again],[{key,amountMinor:'30000'}],'2026-10-01').events).toEqual(result.events);
 });
 it('会员售卡在收款关联会员订单时计入，与住宿占用无关',()=>{
  const r=recognizedMatchedSales([fact({source:'MEMBERSHIP',id:'MEMBER:f1',orderId:null,memberId:'m1'})],[],'2026-10-01');
  expect(r.events[0]).toMatchObject({source:'MEMBERSHIP',amountMinor:'30000',orderId:null,memberId:'m1'});
 });
});
const event=(patch:Partial<OperatingSaleEvent>={}):OperatingSaleEvent=>({id:'c1',source:'CHANNEL',date:'2026-10-02',currency:'CNY',kind:'SALE',amountMinor:'16500',orderId:'o1',memberId:null,registeredAt:null,reason:'测试',...patch});
describe('全渠道汇总与封账',()=>{
 it('渠道成交退款只各算一次，取消不是额外退款',()=>{
  const result=aggregateOperatingSales({from:'2026-10-01',to:'2026-10-31',currency:'CNY',events:[event(),event(),event({id:'r1',date:'2026-10-04',kind:'REFUND',amountMinor:'-16500'})],reviews:[],baselines:[baseline]});
  expect(result.summary.totals[0]).toMatchObject({salesMinor:'16500',refundsMinor:'16500',netMinor:'0'});
 });
 it('9月固定封账不被晚更正或新规则重算，也不假装是单日收入',()=>{
  const result=aggregateOperatingSales({from:'2026-09-01',to:'2026-09-30',currency:'CNY',events:[event({date:'2026-09-21'}),event({id:'correction',kind:'CORRECTION',date:'2026-09-21',amountMinor:'120'})],reviews:[],baselines:[baseline]});
  expect(result.summary.complete).toBe(true);expect(result.summary.totals[0]).toMatchObject({salesMinor:null,refundsMinor:null,netMinor:'4864998'});expect(result.summary.trend).toEqual([]);
 });
 it('未初始化、不完整历史区间、无法核实款项均不宣称完整',()=>{
  const input={from:'2026-09-01',to:'2026-10-31',currency:'CNY',events:[],reviews:[],baselines:[baseline]};
  expect(aggregateOperatingSales({...input,baselines:[]}).summary.enabled).toBe(false);
  expect(aggregateOperatingSales({...input,from:'2026-09-15'}).summary.complete).toBe(false);
  expect(aggregateOperatingSales({...input,from:'2026-08-01'}).summary.complete).toBe(false);
  expect(aggregateOperatingSales({...input,reviews:[{date:'2026-10-03'}]}).summary.complete).toBe(false);
 });
 it('跨月汇总和分币种保持精度，历史纠错不算今天新成交',()=>{
  const result=aggregateOperatingSales({from:'2026-09-01',to:'2026-10-31',currency:'CNY',events:[event({amountMinor:'27720'}),event({id:'c2',currency:'USD',amountMinor:'1'}),event({id:'c3',kind:'CORRECTION',amountMinor:'28'})],reviews:[],baselines:[baseline]});
  expect(result.summary.totals).toEqual([{currency:'CNY',salesMinor:null,refundsMinor:null,correctedMinor:'28',netMinor:'4892746'},{currency:'USD',salesMinor:'1',refundsMinor:'0',correctedMinor:'0',netMinor:'1'}]);
 });
});
