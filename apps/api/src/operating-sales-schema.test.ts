import {describe,expect,it} from 'vitest';
import {FormatRegistry} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {CommandEffectSchema,CommandEnvelopeSchema} from './schemas';
import {DashboardResponseSchema} from './dashboard';
import {dashboardFixture} from '../../../tests/helpers/dashboard-ui-fixture';
import {aggregateOperatingSales} from '@qintopia/domain';
FormatRegistry.Set('date-time',value=>Number.isFinite(Date.parse(value)));
describe('经营收入与渠道退款接口',()=>{
 it('同一退款命令允许渠道凭据及业务日期，金额仍是整数分',()=>{
  const input={propertyId:'prop_test',orderId:'order_test',referencesFactId:'channel_fact_test',amountMinor:2772,method:'CHANNEL',refundReference:'platform-refund-1',note:'平台已退',businessDate:'2026-10-15'};
  expect(Value.Check(CommandEnvelopeSchema,{commandType:'RECORD_REFUND',input})).toBe(true);
  expect(Value.Check(CommandEnvelopeSchema,{commandType:'RECORD_REFUND',input:{...input,amountMinor:27.72}})).toBe(false);
  const {propertyId: _,...effect}=input;
  expect(Value.Check(CommandEffectSchema,{...effect,currency:'CNY',channelOperating:true,transactionReference:null})).toBe(true);
 });
 it('封账月的总额不伪造成销售毛额或退款零值',()=>{
  const fixture=dashboardFixture(new URL('http://localhost/api/v1/properties/ui-a/dashboard'));
  const {summary}=aggregateOperatingSales({from:'2026-09-01',to:'2026-09-30',currency:'CNY',events:[],reviews:[],baselines:[{month:'2026-09-01',currency:'CNY',amountMinor:'4864998',recognitionFrom:'2026-10-01'}]});
  expect(summary.totals[0]).toMatchObject({salesMinor:null,refundsMinor:null,netMinor:'4864998'});
  expect(Value.Check(DashboardResponseSchema,{...fixture,sales:summary,current:{...fixture.current,todaySales:summary}})).toBe(true);
 });
});
