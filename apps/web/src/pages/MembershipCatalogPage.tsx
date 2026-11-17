import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MembershipCatalogEntry, MembershipCatalogInput, MembershipCatalogView, MembershipProductSpecification, RoomCatalogView } from "@qintopia/contracts";
import { api } from "../api";
import { principalCan, useWorkspace } from "../session";
import type { CommandRequest } from "../types";
import { CommandDialog, CommandRecoveryBar, DamagedCommandRecoveryNotice, EmptyState, InlineError, LoadingBlock, Modal,
  QuoteRecoveryConflictNotice, formatDateTime, formatMinor, isTerminalCommandRecovery, recoveryCommandRequest, usePersistentCommandRecovery } from "../ui";
import "./room-catalog.css";
export function membershipPeriodLabel(period: string) {
  const match = /^P([1-9]\d*)(M|Y)$/.exec(period);
  return match ? `${match[1]} ${match[2] === "M" ? "个月" : "年"}` : period;
}
function Specification({ entry, rooms }: { entry: MembershipCatalogEntry; rooms?: RoomCatalogView }) {
  const p = entry.current;
  return <dl className="difference-grid"><dt>名称</dt><dd>{p.name}</dd><dt>售价</dt><dd>{formatMinor(p.listPriceMinor,p.currency)}</dd>
    <dt>权益</dt><dd>{p.entitlementUnits} {p.entitlementUnitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}，适用房型共享</dd>
    <dt>适用房型</dt><dd>{p.allowedRoomTypeCodes.map(code => rooms?.types.find(t => t.code === code)?.name ?? code).join("、")}</dd>
    <dt>有效期</dt><dd>{membershipPeriodLabel(p.validityPeriod)}</dd><dt>销售状态</dt><dd>{entry.saleStatus === "ON_SALE" ? "在售" : "停售"}</dd></dl>;
}
function Editor({ entry, copy, rooms, draft, onSubmit, onClose }: { entry?: MembershipCatalogEntry; copy?: boolean; rooms: RoomCatalogView;
  draft?: MembershipProductSpecification; onSubmit: (spec: MembershipProductSpecification) => void; onClose: () => void }) {
  const original = draft ?? entry?.current;
  const [name,setName] = useState(original?.name ?? "");
  const [price,setPrice] = useState(original ? String(original.listPriceMinor/100) : "");
  const [units,setUnits] = useState(String(original?.entitlementUnits ?? 30));
  const [period,setPeriod] = useState(original?.validityPeriod.slice(1,-1) ?? "1");
  const [periodUnit,setPeriodUnit] = useState(original?.validityPeriod.endsWith("M") ? "M" : "Y");
  const [scope,setScope] = useState(original?.allowedRoomTypeCodes ?? []);
  const [error,setError] = useState<unknown>();
  function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    if (![price,units,period].every(value => /^[1-9]\d*$/.test(value)) || Number(price)*100 > 2147483600 || Number(units)>2147483647 || Number(period)>2147483647 || !scope.length) {
      setError(new Error("售价、总夜数和期限须为支持范围内的正整数，并至少选择一个房型")); return;
    }
    if (new Set(scope.map(code => rooms.types.find(t => t.code===code)?.saleMode)).size !== 1) { setError(new Error("不能混选整房与床位房型")); return; }
    onSubmit({ name:name.trim(),listPriceMinor:Number(price)*100,entitlementUnits:Number(units),validityPeriod:`P${period}${periodUnit}` as MembershipProductSpecification["validityPeriod"],allowedRoomTypeCodes:scope });
  }
  return <Modal title={entry && !copy ? "编辑会员产品" : "新增会员产品"} onClose={onClose} footer={<><button className="button button-secondary" onClick={onClose}>取消</button><button type="submit" form="membership-editor" className="button button-primary">核对产品</button></>}>
    <form id="membership-editor" onSubmit={submit} className="catalog-form"><InlineError error={error} />
      <label className="field"><span>产品名称</span><input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} /></label>
      <label className="field"><span>售价（元）</span><input required inputMode="numeric" value={price} onChange={e=>setPrice(e.target.value)} /></label>
      <label className="field"><span>总夜数</span><input required inputMode="numeric" value={units} onChange={e=>setUnits(e.target.value)} /></label>
      <fieldset><legend>适用房型（共享总额度）</legend>{rooms.types.filter(t=>t.active).map(t=><label key={t.code} className="catalog-check"><input type="checkbox" checked={scope.includes(t.code)} onChange={e=>setScope(e.target.checked?[...scope,t.code]:scope.filter(code=>code!==t.code))}/>{t.name}（{t.saleMode==="ROOM"?"间夜":"床夜"}）</label>)}</fieldset>
      <div className="catalog-form-pair"><label className="field"><span>有效期</span><input required inputMode="numeric" value={period} onChange={e=>setPeriod(e.target.value)} /></label>
        <label className="field"><span>期限单位</span><select value={periodUnit} onChange={e=>setPeriodUnit(e.target.value)}><option value="M">个月</option><option value="Y">年</option></select></label></div>
      <p className="muted">只影响此后新建订单；已建订单与已售权益保持原规格。</p>
    </form></Modal>;
}
export function MembershipCatalogPage() {
  const { principal,propertyId,refreshMeta } = useWorkspace();
  const [data,setData]=useState<MembershipCatalogView>(); const [rooms,setRooms]=useState<RoomCatalogView>();
  const [loading,setLoading]=useState(true); const [error,setError]=useState<unknown>(); const lease=useRef(0);
  const [editor,setEditor]=useState<{ entry?:MembershipCatalogEntry;copy?:boolean }>();
  const [draft,setDraft]=useState<MembershipProductSpecification>(); const [draftReason,setDraftReason]=useState(""); const [command,setCommand]=useState<CommandRequest>();
  const [recovering,setRecovering]=useState(false); const [notice,setNotice]=useState("");
  const recovery=usePersistentCommandRecovery({subjectId:principal.subjectId,scopeId:`property:${propertyId}`});
  const canManage=principalCan(principal,propertyId,"MANAGE_MEMBERSHIP_CATALOG");
  async function refresh() { const token=++lease.current;setLoading(true);setError(undefined);try {
    const [next,roomData]=await Promise.all([api.membershipCatalog(propertyId),api.roomCatalog(propertyId)]);
    if(token===lease.current){setData(next);setRooms(roomData);setEditor(previous=>previous?.entry ? {...previous,entry:next.entries.find(entry=>entry.code===previous.entry!.code) ?? previous.entry} : previous);}
  }catch(e){if(token===lease.current)setError(e);}finally{if(token===lease.current)setLoading(false);} }
  useEffect(()=>{setData(undefined);setRooms(undefined);setEditor(undefined);setCommand(undefined);if(canManage)void refresh();else setLoading(false);return()=>{lease.current++;};},[propertyId,canManage]);
  const blocked=loading || Boolean(error) || recovery.blocked || !canManage;
  function submit(input:MembershipCatalogInput) { setRecovering(false);setCommand({commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{...input},title:"核对会员产品",
    description:"核对完整规格及影响，填写原因后确认。",initialReason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:draftReason}}); }
  if(!canManage)return <EmptyState title="仅管理员可管理会员产品" detail="普通工作人员可在会员页面办理在售产品。"/>;
  return <div className="catalog-page"><header className="page-heading"><div><h1>会员产品</h1><p className="muted">配置新销售规格，保留已售会员原权益。</p></div><div className="row-actions"><button className="button button-secondary" onClick={()=>void refresh()}>刷新</button><button className="button button-primary" disabled={blocked} onClick={()=>{setDraft(undefined);setEditor({});}}>新增产品</button></div></header>
    {notice?<p role="status">{notice}</p>:null}<InlineError error={error}/>
    {recovery.pending ? <CommandRecoveryBar recovery={recovery.pending} businessFacing onOpen={()=>{if(recovery.pending){setCommand(recoveryCommandRequest(recovery.pending));setRecovering(true);}}}/> : null}
    {recovery.canDiscardCorrupt ? <DamagedCommandRecoveryNotice error={recovery.error} onDiscard={recovery.discardCorruptAfterReview}/> : <InlineError error={recovery.error}/>}
    <QuoteRecoveryConflictNotice conflict={recovery.conflict}/>
    {loading&&!data?<LoadingBlock label="正在载入会员产品"/>:data&&!error?<><div className="settings-cards">{data.entries.map(entry=><section className="catalog-detail" key={entry.code}><h2>{entry.current.name}</h2><Specification entry={entry} {...(rooms?{rooms}:{})}/><div className="row-actions">
      <button className="button button-secondary" disabled={blocked} onClick={()=>{setDraft(undefined);setEditor({entry});}}>编辑</button>
      <button className="button button-secondary" disabled={blocked} onClick={()=>{setDraft(undefined);setEditor({entry,copy:true});}}>复制</button>
      <button className="button button-secondary" disabled={blocked} onClick={()=>submit({propertyId,expectedRoomCatalogVersion:rooms!.version,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision,saleStatus:entry.saleStatus==="ON_SALE"?"OFF_SALE":"ON_SALE"})}>{entry.saleStatus==="ON_SALE"?"停售":"恢复销售"}</button>
    </div></section>)}</div>{!data.entries.length?<EmptyState title="暂无会员产品" detail="新增产品后，工作人员即可办理。"/>:null}
    <section className="catalog-history"><h2>变更历史</h2>{data.history.map(item=><article key={item.id}><h3>{item.effect.title}</h3><p>{item.operator} · {formatDateTime(item.createdAt)} · {item.reason}</p><details><summary>查看修改前后规格</summary>{item.effect.before?<><h4>修改前</h4><Specification entry={item.effect.before} {...(rooms?{rooms}:{})}/></>:null}<h4>修改后</h4><Specification entry={item.effect.after} {...(rooms?{rooms}:{})}/></details></article>)}</section></>:null}
    {editor&&rooms&&!command&&!loading?<Editor {...editor} rooms={rooms} {...(draft?{draft}:{})} onClose={()=>setEditor(undefined)} onSubmit={spec=>{setDraft(spec);submit(editor.entry&&!editor.copy?{propertyId,expectedRoomCatalogVersion:rooms.version,action:"UPDATE",code:editor.entry.code,expectedRevision:editor.entry.revision,specification:spec}:{propertyId,expectedRoomCatalogVersion:rooms.version,action:"CREATE",specification:spec});}}/>:null}
    {command?<CommandDialog key={recovering?recovery.pending?.confirmationKey:"membership-command"} request={command} inventoryUnitLabels={Object.fromEntries((rooms?.types ?? []).map(type=>[type.code,type.name]))}
      {...(recovering&&recovery.pending?{initialConfirmationKey:recovery.pending.confirmationKey}:{})}
      onProgress={progress=>recovery.track(command,progress)} onReturnToEdit={request=>{setEditor(editor);setDraftReason(request.initialReason?.note ?? "");setCommand(undefined);void refresh();}}
      onCommitted={async()=>{setEditor(undefined);await Promise.all([refresh(),refreshMeta()]);setNotice("会员产品已保存；已有订单保持原规格。");}}
      onClose={async context=>{setDraftReason("");setCommand(undefined);setEditor(undefined);setRecovering(false);if(context||(recovery.pending&&isTerminalCommandRecovery(recovery.pending.state)))await recovery.clearResolved();}}/>:null}
  </div>;
}
