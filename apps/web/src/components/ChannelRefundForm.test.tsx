import { describe,expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildChannelRefundRequest,ChannelRefundForm } from './ChannelRefundForm';
import type { OrderViewDto } from '../types';
const view={order:{id:'order_test',property_id:'prop_test',status:'CANCELLED'},channelOperating:{initialized:true,businessDate:'2026-10-15',currency:'CNY',originalSaleFactId:'channel_sale',netMinor:'16500',openingRefundMinor:'0',facts:[]}} as unknown as OrderViewDto;
const values={amount:'165.00',date:'2026-10-15',reference:'platform-refund-1',note:'平台已退，登记应结减少'};
describe('原订单入口中的渠道退款',()=>{
 it('已取消合同为零也可登记已发生的平台退款，不依赖住宿收款表',()=>{
  const r=buildChannelRefundRequest(view,values);
  expect(r.input).toMatchObject({orderId:'order_test',amountMinor:16500,method:'CHANNEL',referencesFactId:'channel_sale',refundReference:'platform-refund-1',businessDate:'2026-10-15'});
  expect(r.input).not.toHaveProperty('externalPaymentBillId');
 });
 it.each(['0','165.01','1.001','1e2','-1'])('拒绝超额或非法金额%s',amount=>{expect(()=>buildChannelRefundRequest(view,{...values,amount})).toThrow()});
 it('期初未承接、无原成交、缺退款单号或原因均不能继续',()=>{
  expect(()=>buildChannelRefundRequest({...view,channelOperating:{...view.channelOperating!,initialized:false}},values)).toThrow();
  expect(()=>buildChannelRefundRequest({...view,channelOperating:{...view.channelOperating!,originalSaleFactId:null}},values)).toThrow();
  expect(()=>buildChannelRefundRequest(view,{...values,reference:''})).toThrow();
  expect(()=>buildChannelRefundRequest(view,{...values,note:''})).toThrow();
 });
 it('日期默认服务器门店今天，草稿保留角分',()=>{
  const html=renderToStaticMarkup(<ChannelRefundForm view={view} onSubmit={()=>{}} onClose={()=>{}} draft={{commandType:'RECORD_REFUND',title:'退款',description:'退款',input:{propertyId:'prop_test',orderId:'order_test',amountMinor:2772,refundReference:'r1'}}}/>);
  expect(html).toContain('2026-10-15');expect(html).toContain('27.72');expect(html).toContain('平台退款单号');
 });
});
