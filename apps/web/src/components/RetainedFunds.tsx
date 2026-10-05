import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RetainedFundItem, RetainedFundList, RetainedFundsCommandType } from '@qintopia/contracts';
import { api } from '../api';
import type { CommandRequest, OrderViewDto } from '../types';
import { collectionAmountMinorToYuanInput, collectionAmountYuanInputToMinor } from '../orderFunds';
import { readOrderRetainedFunds, retainedAmountAllowed, unreservedSourceMinor } from '../retainedFunds';
import { InlineError, Modal, formatMinor, formatDateTime } from '../uiBasic';
import { ExternalPaymentPicker } from './ExternalPaymentPicker';

const titles: Record<RetainedFundsCommandType, string> = {
  RETAIN_ORDER_FUNDS: '登记客户留存', APPLY_RETAINED_FUNDS: '使用客户留存款', RELEASE_RETAINED_FUNDS: '解除留存', REFUND_RETAINED_FUNDS: '登记留存款实际退款'
};
export function RetainedFundsList({propertyId, onChoose, orderId, refreshKey, toolbarEnd}: {propertyId: string; onChoose?: (item: RetainedFundItem) => void; orderId?: string; refreshKey?: unknown; toolbarEnd?: ReactNode}) {
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [cursor, setCursor] = useState('');
  const [data, setData] = useState<RetainedFundList>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController(); setData(undefined); setError(undefined);
    void api.retainedFunds({propertyId, query, status: all ? 'ALL' : 'AVAILABLE', ...(orderId ? {orderId} : {}), ...(cursor ? {beforeId: cursor} : {})}, controller.signal)
      .then(async result => {
        if (controller.signal.aborted) return;
        // A closed feature may have only fully processed historical records.
        if (!result.enabled && !result.items.length && !all && !query && !cursor) {
          const history = await api.retainedFunds({propertyId, status: 'ALL', ...(orderId ? {orderId} : {})}, controller.signal);
          if (controller.signal.aborted) return;
          if (history.items.length) {setAll(true); return;}
        }
        setData(result);
      }).catch(reason => {if (!controller.signal.aborted) setError(reason);});
    return () => controller.abort();
  }, [propertyId, query, all, cursor, orderId, refreshKey]);
  if (data && !data.enabled && !data.items.length && !query && !cursor && !all && !toolbarEnd) return null;
  return <section className="retained-funds-list" aria-label="客户留存待用"><h3>客户留存待用</h3>
    <div className={toolbarEnd ? "list-toolbar orders-filter-toolbar retained-funds-toolbar" : undefined}>
      <label className={toolbarEnd ? "search-control" : "retained-funds-search"}>
        {toolbarEnd ? <span className="sr-only">搜索客户 / 联系方式 / 来源订单</span> : '搜索客户 / 联系方式 / 来源订单'}
        <input type="search" value={query} onChange={e => {setQuery(e.target.value); setCursor('');}} maxLength={200} placeholder={toolbarEnd ? "客户、联系方式或来源订单" : undefined}/>
      </label>
      {toolbarEnd}
    </div>
    <label className="retained-funds-check"><input type="checkbox" checked={all} onChange={e => {setAll(e.target.checked); setCursor('');}}/>包含已处理历史</label>
    <InlineError error={error}/>
    {!data && !error ? <p role="status">正在读取留存款…</p> : null}
    {data && !data.enabled ? <p role="status">留存款写入已关闭，已有记录仅供查询。</p> : null}
    {data ? <><div className="table-region retained-funds-table-region"><table className="data-table retained-funds-table" role="table" aria-label="客户留存记录"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">归属客户</th><th scope="col" role="columnheader">来源订单</th><th scope="col" role="columnheader">剩余留存</th><th scope="col" role="columnheader">登记日期 / 说明</th><th scope="col" role="columnheader">操作</th></tr></thead><tbody role="rowgroup">{data.items.map(item => <tr key={item.id} role="row">
      <td role="cell" data-label="归属客户" className="retained-funds-owner"><strong>{item.ownerName}</strong><span>{item.ownerContact}</span></td>
      <td role="cell" data-label="来源订单" className="retained-funds-source"><Link to={`/orders/${encodeURIComponent(item.sourceOrderId)}`}>{item.sourceOrderId}</Link></td>
      <td role="cell" data-label="剩余留存" className="retained-funds-amount"><strong>{formatMinor(item.remainingMinor, 'CNY')}</strong><small className="retained-funds-breakdown"><span>原留存 {formatMinor(item.amountMinor, 'CNY')}</span><span>已用 {formatMinor(item.usedMinor, 'CNY')}</span><span>已退 {formatMinor(item.refundedMinor, 'CNY')}</span><span>已解除 {formatMinor(item.releasedMinor, 'CNY')}</span></small></td>
      <td role="cell" data-label="登记日期 / 说明" className="retained-funds-note"><span>{formatDateTime(item.createdAt)}</span><span>{item.confirmationNote}</span></td><td role="cell" data-label="操作" className="retained-funds-actions">{data.enabled && onChoose && item.remainingMinor > 0 ? <button type="button" className="button button-secondary" onClick={() => onChoose(item)}>选择并核对归属</button> : '—'}</td>
    </tr>)}</tbody></table></div>{!data.items.length ? <p>没有符合条件的留存记录。</p> : null}
    {cursor ? <button type="button" onClick={() => setCursor('')}>回到首页</button> : null}
    {data.hasMore && data.nextBeforeId ? <button type="button" onClick={() => setCursor(data.nextBeforeId!)}>下一页</button> : null}</> : null}
  </section>;
}

export function RetainedFundsPanel({view, can, blocked, onSubmit}: {view: OrderViewDto; can: (command: RetainedFundsCommandType) => boolean; blocked: boolean; onSubmit: (request: CommandRequest) => void}) {
  const [data, setData] = useState<RetainedFundList>();
  const [error, setError] = useState<unknown>();
  const [action, setAction] = useState<RetainedFundsCommandType>();
  const [selected, setSelected] = useState<RetainedFundItem>();
  useEffect(() => { const c = new AbortController(); setData(undefined); void readOrderRetainedFunds(api.retainedFunds, view.order.property_id, view.order.id, c.signal, "ALL").then(result => {if (!c.signal.aborted) {setData(result); setError(undefined);}}).catch(e => {if (!c.signal.aborted) setError(e);}); return () => c.abort(); }, [view]);
  useEffect(() => {setAction(undefined); setSelected(undefined);}, [view.order.id, view.order.version, blocked]);
  if (!data || (!data.enabled && !data.items.length)) return error ? <InlineError error={error} title="留存款状态暂不可用"/> : null;
  const total = data.items.reduce((sum, item) => sum + item.remainingMinor, 0);
  return <section className="detail-section"><h2>客户留存与资金归属</h2>
    {!data.enabled ? <p role="status">留存款写入已关闭，已有记录仅供查询。</p> : null}
    <p>留存待用 {formatMinor(total, 'CNY')}。留存与内部划转不是新增现金收款；取消订单不会自动退款。</p>
    {view.order.status === 'CANCELLED' ? <p role="status">已取消 · 当前持有 {formatMinor(view.amounts.netRecordedCollection.minorUnits, 'CNY')}，其中留存待用 {formatMinor(total, 'CNY')}；其余请核对退款意向。</p> : null}
    <div className="form-actions">{(['RETAIN_ORDER_FUNDS','APPLY_RETAINED_FUNDS'] as const).filter(a => data.enabled && can(a) && (a !== 'RETAIN_ORDER_FUNDS' || ['CANCELLED','NO_SHOW','CHECKED_OUT'].includes(view.order.status))).map(a => <button key={a} disabled={blocked} className="button button-secondary" onClick={() => {setSelected(undefined); setAction(a);}}>{titles[a]}</button>)}</div>
    {data.hasMore ? <p role="alert">留存明细尚未完整加载，暂不允许新增留存；请从清单查询全部记录。</p> : null}
    {data.items.map(item => <div key={item.id}><strong>{item.ownerName} · {formatMinor(item.remainingMinor, 'CNY')}</strong><p>{item.ownerContact} · {item.confirmationNote} · 原留存 {formatMinor(item.amountMinor, "CNY")} · 已用 {formatMinor(item.usedMinor, "CNY")} · 已退 {formatMinor(item.refundedMinor, "CNY")} · 已解除 {formatMinor(item.releasedMinor, "CNY")}</p>{(['RELEASE_RETAINED_FUNDS','REFUND_RETAINED_FUNDS'] as const).filter(a => data.enabled && item.remainingMinor > 0 && can(a)).map(a => <button key={a} disabled={blocked} className="button button-secondary" onClick={() => {setSelected(item); setAction(a);}}>{titles[a]}</button>)}</div>)}
    {data.enabled && action ? <RetainedFundsDialog key={action + (selected?.id ?? '')} action={action} view={view} retained={data.items} item={selected} blocked={blocked || (action === 'RETAIN_ORDER_FUNDS' && data.hasMore)} onClose={() => setAction(undefined)} onSubmit={request => {if (!data.enabled || !can(action) || blocked) return; setAction(undefined); onSubmit(request);}}/> : null}
  </section>;
}

function RetainedFundsDialog({action, view, retained, item, blocked, onClose, onSubmit}: {action: RetainedFundsCommandType; view: OrderViewDto; retained: RetainedFundItem[]; item: RetainedFundItem | undefined; blocked: boolean; onClose: () => void; onSubmit: (request: CommandRequest) => void}) {
  const sources = view.collectionFacts.filter(f => f.method === 'WECOM' && unreservedSourceMinor(view.collectionFacts, f, retained) > 0);
  const [factId, setFactId] = useState(sources[0]?.fact_id ?? '');
  const [chosen, setChosen] = useState(item);
  const [amount, setAmount] = useState(item ? collectionAmountMinorToYuanInput(item.remainingMinor) : '');
  const [name, setName] = useState(''); const [contact, setContact] = useState(''); const [note, setNote] = useState('');
  const [verified, setVerified] = useState(false);
  const [billId, setBillId] = useState(''); const [reference, setReference] = useState(''); const [refundAvailable, setRefundAvailable] = useState(0);
  const [error, setError] = useState<unknown>();
  const source = sources.find(f => f.fact_id === factId);
  const maximum = action === 'RETAIN_ORDER_FUNDS' ? Math.min(source ? unreservedSourceMinor(view.collectionFacts, source, retained) : 0, Math.max(0, view.amounts.refundReferenceAmount.minorUnits - retained.reduce((sum, f) => sum + f.remainingMinor, 0))) : action === 'REFUND_RETAINED_FUNDS' ? Math.min(chosen?.remainingMinor ?? 0, refundAvailable) : chosen?.remainingMinor ?? 0;
  return <Modal title={titles[action]} onClose={onClose}><form className="modal-form" onSubmit={e => {e.preventDefault(); setError(undefined); const minor = collectionAmountYuanInputToMinor(amount);
    if (blocked) return;
    if (!retainedAmountAllowed(minor, maximum)) {setError(new Error(`金额必须大于零且不超过 ${formatMinor(maximum,'CNY')}`)); return;}
    if (!note.trim() || !verified) {setError(new Error('请填写确认说明并核实客户意向及款项归属')); return;}
    if (action === 'RETAIN_ORDER_FUNDS' && (!name.trim() || !contact.trim())) {setError(new Error('请填写经核实的款项归属客户与联系方式或核验依据')); return;}
    if (action === 'REFUND_RETAINED_FUNDS' && (!billId || !reference)) {setError(new Error('请选择已成功的真实退款流水')); return;}
    onSubmit({commandType: action, title: titles[action], description: '仅处理现有资金归属；不发起真实支付或退款。', input: {propertyId:view.order.property_id, orderId:view.order.id, amountMinor:minor,
      ...(action === 'RETAIN_ORDER_FUNDS' ? {sourceFactId:factId,ownerName:name.trim(),ownerContact:contact.trim(),confirmationNote:note.trim()} : {retainedFundId:chosen?.id}),
      ...(action === 'APPLY_RETAINED_FUNDS' ? {authorizationNote:note.trim()} : action === 'RETAIN_ORDER_FUNDS' ? {} : {note:note.trim()}),
      ...(action === 'REFUND_RETAINED_FUNDS' ? {externalPaymentBillId:billId,refundReference:reference} : {})}, initialReason:{code:action,note:note.trim()}});
  }}><InlineError error={error}/>
    {action === 'APPLY_RETAINED_FUNDS' ? <RetainedFundsList propertyId={view.order.property_id} onChoose={f => {setChosen(f); setAmount(collectionAmountMinorToYuanInput(f.remainingMinor)); setVerified(false);}}/> : null}
    {chosen ? <p>归属客户：{chosen.ownerName} · {chosen.ownerContact} · 来源订单 {chosen.sourceOrderId}</p> : null}
    {action === 'RETAIN_ORDER_FUNDS' ? <><label>可留存原资金<select value={factId} onChange={e => {setFactId(e.target.value);setAmount('');}}>{sources.map(f => <option key={f.fact_id} value={f.fact_id}>{f.transaction_reference ?? f.fact_id} · 可用 {formatMinor(unreservedSourceMinor(view.collectionFacts,f,retained),'CNY')}</option>)}</select></label><label>款项归属客户<input value={name} onChange={e=>setName(e.target.value)} maxLength={100}/></label><label>联系方式 / 核验依据<input value={contact} onChange={e=>setContact(e.target.value)} maxLength={200}/></label></> : null}
    {action === 'REFUND_RETAINED_FUNDS' && chosen ? <ExternalPaymentPicker allocationMode propertyId={view.order.property_id} kind="REFUND" originalCollectionFactId={chosen.sourceFactId} value={reference} onChange={(r,f)=>{setReference(r);setBillId(f?.id ?? '');setRefundAvailable(f && 'remainingMinor' in f ? f.remainingMinor : 0);}}/> : null}
    <label>本次金额（元）<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label><small>本次上限 {formatMinor(maximum,'CNY')}；确认时重新校验。</small>
    <label>{action === 'APPLY_RETAINED_FUNDS' ? '使用授权说明（代订须记录款项归属人授权）' : '客户确认说明 / 处理原因'}<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/></label>
    <label className="retained-funds-check"><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/>已核实款项归属及客户意向，不以姓名或付款昵称自动认定</label>
    <div className="form-actions"><button type="button" onClick={onClose}>取消</button><button className="button button-primary" disabled={blocked} type="submit">继续核对</button></div>
  </form></Modal>;
}
