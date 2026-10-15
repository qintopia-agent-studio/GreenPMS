import { useState, type FormEvent } from "react";
import type { CommandRequest, OrderViewDto } from "../types";
import { collectionAmountYuanInputToMinor } from "../orderFunds";
import { InlineError, Modal, formatMinor } from "../uiBasic";

export function buildChannelRefundRequest(view:OrderViewDto,values:{amount:string;date:string;reference:string;note:string}):CommandRequest {
 const summary=view.channelOperating;
 const amount=collectionAmountYuanInputToMinor(values.amount);
 if(!summary?.initialized||!summary.originalSaleFactId||amount===undefined||BigInt(amount)>BigInt(summary.netMinor))throw new Error("退款金额须精确到分且不超过可退渠道金额");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(values.date)||values.date>summary.businessDate)throw new Error("请填写有效的退款日期，不能晚于今天");
 if(!values.reference.trim()||!values.note.trim())throw new Error("请填写平台退款单号和退款说明");
 return {commandType:"RECORD_REFUND",title:"登记渠道退款",description:"记录已在渠道平台发生的退款及应结减少，不发起平台退款，不改变住宿安排。",initialReason:{code:"RECORD_REFUND",note:values.note.trim()},input:{propertyId:view.order.property_id,orderId:view.order.id,referencesFactId:summary.originalSaleFactId,amountMinor:amount,method:"CHANNEL",refundReference:values.reference.trim(),businessDate:values.date,note:values.note.trim()}};
}
export function ChannelRefundForm({view,draft,onSubmit,onClose,writeBlocked=false,writeBlockedReason}:{view:OrderViewDto;draft?:CommandRequest;onSubmit:(r:CommandRequest)=>void;onClose:()=>void;writeBlocked?:boolean;writeBlockedReason?:string}) {
 const summary=view.channelOperating!;
 const input=draft?.commandType==='RECORD_REFUND'&&draft.input.orderId===view.order.id?draft.input:undefined;
 const [amount,setAmount]=useState(typeof input?.amountMinor==='number'?String(input.amountMinor/100):'');
 const [date,setDate]=useState(typeof input?.businessDate==='string'?input.businessDate:summary.businessDate);
 const [reference,setReference]=useState(typeof input?.refundReference==='string'?input.refundReference:'');
 const [note,setNote]=useState(typeof input?.note==='string'?input.note:'');
 const [error,setError]=useState<unknown>();
 function submit(e:FormEvent){e.preventDefault();if(writeBlocked)return;try{onSubmit(buildChannelRefundRequest(view,{amount,date,reference,note}));}catch(e){setError(e)}}
 return <Modal title="登记渠道退款" onClose={onClose} footer={null}><form className="modal-form" onSubmit={submit}>
  <p>仅登记已在平台发生的退款。可退渠道金额：<strong>{formatMinor(Number(summary.netMinor),summary.currency)}</strong>。取消订单不等于已退款。</p>
  <InlineError error={error}/>{writeBlocked?<p role="status">{writeBlockedReason}</p>:null}
  <div className="form-grid form-grid-two">
   <label>本次应结减少金额（元）<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} required placeholder="例如 165.00"/></label>
   <label>退款业务日期<input type="date" value={date} max={summary.businessDate} onChange={e=>setDate(e.target.value)} required/></label>
   <label className="span-two">平台退款单号<input value={reference} onChange={e=>setReference(e.target.value)} required maxLength={200}/></label>
   <label className="span-two">退款说明<textarea value={note} onChange={e=>setNote(e.target.value)} required maxLength={1000}/></label>
  </div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button className="button button-primary" disabled={writeBlocked}>核对退款</button></div>
 </form></Modal>;
}

export function ChannelOperatingHistory({view,onSubmit,blocked}:{view:OrderViewDto;onSubmit:(r:CommandRequest)=>void;blocked:boolean}) {
 const [reversing,setReversing]=useState<string|null>(null),[reason,setReason]=useState('');
 const summary=view.channelOperating;
 if(!summary)return null;
 const canReverse=view.allowedActions.some(a=>a.code==='REVERSE_FACT'&&a.enabled);
 return <section className="detail-section"><div className="section-title-row"><h2>渠道成交与退款</h2><strong>经营净额 {summary.initialized?formatMinor(Number(summary.netMinor),summary.currency):"—"}</strong></div>
 {BigInt(summary.openingRefundMinor)>0n?<p>期初已确认退款 {formatMinor(Number(summary.openingRefundMinor),summary.currency)}，已扣除，不再重复登记。</p>:null}
 <div className="table-region" role="region" aria-label="渠道成交与退款明细" tabIndex={0}><table className="data-table compact-table"><thead><tr><th>业务日期</th><th>记录</th><th>金额</th><th>依据</th><th>操作</th></tr></thead><tbody>{summary.facts.map(f=><tr key={f.id}><td>{f.businessDate}</td><td>{{SALE:'渠道成交',CORRECTION:'金额更正',REFUND:'渠道退款',REVERSAL:'撤销误录'}[f.kind]}</td><td>{formatMinor(f.amountMinor,summary.currency)}</td><td>{f.refundReference??f.note}</td><td>{f.kind==='REFUND'&&canReverse&&!summary.facts.some(v=>v.kind==='REVERSAL'&&v.referencesFactId===f.id)?<button type="button" className="button button-secondary" disabled={blocked} onClick={()=>{setReversing(f.id);setReason('')}}>撤销误录</button>:null}</td></tr>)}</tbody></table></div>
 {reversing?<form onSubmit={e=>{e.preventDefault();if(blocked||!reason.trim())return;onSubmit({commandType:'REVERSE_FACT',title:'撤销渠道退款误录',description:'保留原退款记录并追加冲销，不实际发起收退款。',initialReason:{code:'REVERSE_FACT',note:reason.trim()},input:{propertyId:view.order.property_id,orderId:view.order.id,reversesFactId:reversing,note:reason.trim()}});setReversing(null)}}><label>误录原因<textarea required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button className="button button-primary" disabled={blocked}>核对撤销</button><button type="button" className="button button-secondary" onClick={()=>setReversing(null)}>取消</button></form>:null}
 </section>;
}
