import { describe, expect, it } from 'vitest';
import type { RetainedFundItem, PaymentAllocationItem } from '@qintopia/contracts';
import type { CollectionFactDto } from './types';
import { readOrderRetainedFunds, unreservedSourceMinor, retainedAmountAllowed } from './retainedFunds';
import { remainingRefundableMinor, buildOrderFundsRequest } from './orderFunds';
import { paymentSelectable } from './components/ExternalPaymentPicker';

const source = {fact_id:'a',fact_type:'COLLECTION',amount_minor:60000,currency:'CNY',method:'WECOM'} as CollectionFactDto;
const item = {sourceFactId:'a',remainingMinor:20000} as RetainedFundItem;
describe('retained funds and allocation accounting', () => {
  it('subtracts refunds, transfers and retained reservations without adding receipts', () => {
    const facts = [source, {fact_id:'refund',fact_type:'REFUND',references_fact_id:'a',amount_minor:10000}, {fact_id:'out',fact_type:'REALLOCATION_OUT',references_fact_id:'a',amount_minor:30000}] as CollectionFactDto[];
    expect(remainingRefundableMinor(facts, source)).toBe(20000);
    expect(unreservedSourceMinor(facts, source, [item])).toBe(0);
    expect(unreservedSourceMinor(facts, source, [{...item,sourceFactId:'different'}])).toBe(20000);
  });
  it('allows the transferred-in share to refund and does not refund outgoing money', () => {
    const incoming = {...source,fact_type:'REALLOCATION_IN' as const};
    expect(remainingRefundableMinor([incoming], incoming)).toBe(60000);
    expect(remainingRefundableMinor([source], {...source,fact_type:'REALLOCATION_OUT'})).toBe(0);
    expect(remainingRefundableMinor([incoming,{fact_id:'reverse',fact_type:'REVERSAL',reverses_fact_id:'a'} as CollectionFactDto], incoming)).toBe(0);
  });
  it('excludes reversed refunds and never returns negative money', () => {
    const refund = {fact_id:'r',fact_type:'REFUND',references_fact_id:'a',amount_minor:70000} as CollectionFactDto;
    expect(unreservedSourceMinor([source,refund], source, [item])).toBe(0);
    expect(unreservedSourceMinor([source,refund,{fact_type:'REVERSAL',reverses_fact_id:'r'} as CollectionFactDto], source, [item])).toBe(40000);
  });
  it('validates positive integer cents and the available ceiling', () => {
    for (const amount of [undefined,0,-1,1.5,NaN,Infinity,20001]) expect(retainedAmountAllowed(amount,20000)).toBe(false);
    expect(retainedAmountAllowed(20000,20000)).toBe(true);
  });
  it('keeps shared v1 picker whole-payment only; v2 permits available partial shares', () => {
    const partial = {status:'PARTIALLY_MATCHED',amountMinor:100000,remainingMinor:60000} as PaymentAllocationItem;
    expect(paymentSelectable(partial)).toBe(false);
    expect(paymentSelectable(partial,true)).toBe(true);
    expect(paymentSelectable({...partial,remainingMinor:0},true)).toBe(false);
    expect(paymentSelectable({...partial,status:'REVIEW'},true)).toBe(false);
  });
  it('loads every reservation page before presenting an available balance', async () => {
    const queries: Record<string,string>[] = [];
    const result = await readOrderRetainedFunds(async query => {queries.push(query); return {enabled:true,items:[item],hasMore:queries.length === 1,nextBeforeId:queries.length === 1 ? 'cursor' : null};}, 'p','o',new AbortController().signal);
    expect(result.items).toHaveLength(2);
    expect(queries[1]?.beforeId).toBe('cursor');
    expect(result.hasMore).toBe(false);
  });
  it('preserves disabled reservations across every page and deducts them from refundable funds', async () => {
    const queries: Record<string,string>[] = [];
    const result = await readOrderRetainedFunds(async query => {
      queries.push(query);
      return {enabled:false,items:[{...item,id:String(queries.length)}],hasMore:queries.length === 1,nextBeforeId:queries.length === 1 ? 'next' : null};
    }, 'p','o',new AbortController().signal);
    expect(result.enabled).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(queries[1]?.beforeId).toBe('next');
    expect(unreservedSourceMinor([source],source,result.items)).toBe(20000);
  });
  it('keeps reads disabled if a feature flag changes between pages', async () => {
    let calls = 0;
    const result = await readOrderRetainedFunds(async () => ({enabled:++calls > 1,items:[item],hasMore:calls === 1,nextBeforeId:calls === 1 ? 'next' : null}), 'p','o',new AbortController().signal,'ALL');
    expect(result.enabled).toBe(false);
    expect(result.items).toHaveLength(2);
  });
  it('fails closed on a repeating pagination cursor', async () => {
    await expect(readOrderRetainedFunds(async () => ({enabled:true,items:[],hasMore:true,nextBeforeId:'repeated'}),'p','o',new AbortController().signal)).rejects.toThrow();
  });
  it('carries bill identity and the chosen portion, not the total receipt', () => {
    const request = buildOrderFundsRequest({order:{id:'o',property_id:'p'},collectionFacts:[]} as never,'RECORD_COLLECTION',{amountYuan:'400',method:'WECOM',note:'',transactionReference:'tx',refundReference:'',factId:'',externalPaymentBillId:'bill'});
    expect(request.input).toMatchObject({amountMinor:40000,externalPaymentBillId:'bill',transactionReference:'tx'});
  });
});
