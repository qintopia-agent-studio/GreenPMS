import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { RetainedFundList } from '@qintopia/contracts';
import type { OrderViewDto } from '../types';

const state = vi.hoisted(() => ({ values: [] as unknown[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual, useState: (initial: unknown) => {
    const value = state.values.length ? state.values.shift() : initial;
    return actual.useState(value);
  }};
});
import { RetainedFundsList, RetainedFundsPanel } from './RetainedFunds';

const data: RetainedFundList = {enabled:false,hasMore:false,nextBeforeId:null,items:[{
  id:'retained', propertyId:'p',sourceOrderId:'order',sourceFactId:'source',billId:'bill',ownerName:'留存客户',ownerContact:'核验联系方式',confirmationNote:'客户确认下次使用',amountMinor:60000,usedMinor:40000,refundedMinor:0,releasedMinor:0,remainingMinor:20000,createdAt:'2026-10-02T00:00:00Z'
}]};
afterEach(() => { state.values = []; });

const view = {order:{id:'order',property_id:'p',status:'CANCELLED',version:1},collectionFacts:[],amounts:{netRecordedCollection:{minorUnits:20000}}} as unknown as OrderViewDto;
describe('retained funds read-only rendering after writes are disabled', () => {
  it('renders existing list records and pagination without a selection action', () => {
    state.values = ['',false,'',{...data,hasMore:true,nextBeforeId:'next'},undefined];
    const html = renderToStaticMarkup(<MemoryRouter><RetainedFundsList propertyId="p" onChoose={vi.fn()}/></MemoryRouter>);
    expect(html).toContain('留存客户');
    expect(html).toContain('已有记录仅供查询');
    expect(html).toContain('下一页');
    expect(html).not.toContain('选择并核对归属');
  });
  it('shows panel audit amounts but neither write actions nor an already-open editor', () => {
    state.values = [data,undefined,'REFUND_RETAINED_FUNDS',data.items[0]];
    const html = renderToStaticMarkup(<RetainedFundsPanel view={view} can={() => true} blocked={false} onSubmit={vi.fn()}/>);
    expect(html).toContain('留存客户');
    expect(html).toContain('已用');
    expect(html).toContain('已有记录仅供查询');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('继续核对');
  });
  it('keeps fully consumed history readable', () => {
    state.values = [{...data,items:[{...data.items[0]!,remainingMinor:0,usedMinor:60000}]},undefined,undefined,undefined];
    expect(renderToStaticMarkup(<RetainedFundsPanel view={view} can={() => true} blocked={false} onSubmit={vi.fn()}/>)).toContain('留存客户');
  });
  it('adds no panel or list noise when disabled and without any records', () => {
    state.values = [{...data,items:[]},undefined,undefined,undefined];
    expect(renderToStaticMarkup(<RetainedFundsPanel view={view} can={() => true} blocked={false} onSubmit={vi.fn()}/>)).toBe('');
    state.values = ['',false,'',{...data,items:[]},undefined];
    expect(renderToStaticMarkup(<RetainedFundsList propertyId="p"/>)).toBe('');
  });
});


describe('retained funds responsive list content and semantics', () => {
  const sourceOrderId = 'order_7d976b84-b8a7-4a1a-957f-9862dad35394';
  const item = {...data.items[0]!, sourceOrderId, usedMinor:10000, refundedMinor:5000, releasedMinor:25000};
  function renderList(enabled = true, remainingMinor = item.remainingMinor) {
    state.values = ['',true,'',{...data,enabled,items:[{...item,remainingMinor}]},undefined];
    return renderToStaticMarkup(<MemoryRouter><RetainedFundsList propertyId="p" onChoose={vi.fn()}/></MemoryRouter>);
  }

  it('keeps table, row and column semantics with labelled card cells and the full source link', () => {
    const html = renderList();
    expect(html).toContain('role="table" aria-label="客户留存记录"');
    expect(html.match(/role="row"/g)).toHaveLength(2);
    expect(html.match(/scope="col" role="columnheader"/g)).toHaveLength(5);
    expect(html.match(/role="cell"/g)).toHaveLength(5);
    for (const label of ['归属客户', '来源订单', '剩余留存', '登记日期 / 说明', '操作']) {
      expect(html).toContain(`data-label="${label}"`);
    }
    expect(html).toContain(`href="/orders/${sourceOrderId}"`);
    expect(html).toContain(`>${sourceOrderId}</a>`);
    expect(html).toContain('留存客户');
    expect(html).toContain('核验联系方式');
    expect(html).toContain('客户确认下次使用');
    expect(html).toContain('class="retained-funds-check"><input type="checkbox"');
  });

  it('displays remaining, original, used, refunded and released amounts without hiding the audit breakdown', () => {
    const html = renderList();
    expect(html).toContain('<strong>¥200.00</strong>');
    expect(html).toContain('原留存 ¥600.00');
    expect(html).toContain('已用 ¥100.00');
    expect(html).toContain('已退 ¥50.00');
    expect(html).toContain('已解除 ¥250.00');
  });

  it('keeps choosing limited to enabled records with a remaining balance', () => {
    expect(renderList()).toContain('选择并核对归属');
    expect(renderList(true, 0)).not.toContain('选择并核对归属');
    const readOnly = renderList(false);
    expect(readOnly).not.toContain('选择并核对归属');
    expect(readOnly).toContain('已有记录仅供查询');
    expect(readOnly).toContain('已解除 ¥250.00');
    expect(readOnly).toContain(sourceOrderId);
  });
});

describe('retained funds inline view switch', () => {
  const toolbarEnd = <label className="filter-select-control"><span className="sr-only">资金视图</span><select aria-label="资金视图" defaultValue="RETAINED"><option value="ORDERS">资金视图</option><option value="RETAINED">客户留存待用</option></select></label>;

  it('places customer search and the view switch in one toolbar without order filters', () => {
    state.values = ['',false,'',data,undefined];
    const html = renderToStaticMarkup(<MemoryRouter><RetainedFundsList propertyId="p" toolbarEnd={toolbarEnd}/></MemoryRouter>);
    const toolbar = html.slice(html.indexOf('class="list-toolbar'), html.indexOf('</div>', html.indexOf('class="list-toolbar')));
    expect(toolbar).toContain('搜索客户 / 联系方式 / 来源订单');
    expect(toolbar).toContain('aria-label="资金视图"');
    expect(toolbar).toContain('type="search"');
    expect(html).not.toContain('按订单状态筛选');
    expect(html).not.toContain('按收退款核对筛选');
    expect(html).toContain('已有记录仅供查询');
  });

  it('keeps the return switch visible when the feature closes with an empty list', () => {
    state.values = ['',false,'',{...data,items:[]},undefined];
    const html = renderToStaticMarkup(<RetainedFundsList propertyId="p" toolbarEnd={toolbarEnd}/>);
    expect(html).toContain('aria-label="资金视图"');
    expect(html).toContain('没有符合条件的留存记录');
    expect(html).not.toContain('选择并核对归属');
  });
});
