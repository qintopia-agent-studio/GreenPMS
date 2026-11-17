import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MembershipCatalogEntry, MembershipCatalogInput, MembershipCatalogView, MembershipProductSpecification, RoomCatalogView } from "@qintopia/contracts";
import { api } from "../api";
import { principalCan, useWorkspace } from "../session";
import type { CommandRequest } from "../types";
import { CommandDialog, CommandRecoveryBar, DamagedCommandRecoveryNotice, EmptyState, InlineError, LoadingBlock, Modal,
  QuoteRecoveryConflictNotice, formatDateTime, formatMinor, isTerminalCommandRecovery, recoveryCommandRequest, usePersistentCommandRecovery } from "../ui";
import { SettingsHint as InfoHint } from "../components/SettingsHint";
import "./room-catalog.css";
import "./membership-catalog.css";
export function membershipPeriodLabel(period: string) {
  const match = /^P([1-9]\d*)(M|Y)$/.exec(period);
  return match ? `${match[1]} ${match[2] === "M" ? "个月" : "年"}` : period;
}
function Specification({ entry, rooms, compact = false }: { entry: MembershipCatalogEntry; rooms?: RoomCatalogView; compact?: boolean }) {
  const p = entry.current;
  return <dl className="difference-grid membership-specification">{!compact ? <><dt>名称</dt><dd>{p.name}</dd><dt>售价</dt><dd>{formatMinor(p.listPriceMinor,p.currency)}</dd></> : null}
    <dt>权益</dt><dd>{p.entitlementUnits} {p.entitlementUnitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</dd>
    <dt>适用房型</dt><dd>{p.allowedRoomTypeCodes.map(code => rooms?.types.find(t => t.code === code)?.name ?? code).join("、")}</dd>
    <dt>有效期</dt><dd>{membershipPeriodLabel(p.validityPeriod)}</dd>{!compact ? <><dt>销售状态</dt><dd>{entry.saleStatus === "ON_SALE" ? "在售" : "停售"}</dd></> : null}</dl>;
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
  return <Modal title={copy ? "复制会员产品" : entry ? "编辑会员产品" : "新增会员产品"} onClose={onClose} footer={<><button className="button button-secondary" onClick={onClose}>取消</button><button type="submit" form="membership-editor" className="button button-primary">核对产品</button></>}>
    <form id="membership-editor" onSubmit={submit} className="catalog-form membership-editor">
      <InlineError error={error} />
      <div className="field">
        <div className="membership-field-heading"><label htmlFor="membership-name">产品名称</label><InfoHint label="会员产品修改说明" text="只影响此后新建订单；已建订单与已售权益保持原规格。" /></div>
        <input id="membership-name" required maxLength={100} value={name} onChange={e=>setName(e.target.value)} />
      </div>
      <div className="catalog-form-pair">
        <label className="field"><span>售价（元）</span><input required inputMode="numeric" value={price} onChange={e=>setPrice(e.target.value)} /></label>
        <div className="field">
          <div className="membership-field-heading"><label htmlFor="membership-units">总夜数</label><InfoHint label="总夜数说明" text="所选房型共享这份总额度。整房按间夜、床位按床夜计算，不是每种房型各有一份额度。" /></div>
          <input id="membership-units" required inputMode="numeric" value={units} onChange={e=>setUnits(e.target.value)} />
        </div>
      </div>
      <fieldset className="membership-scope">
        <legend><span>适用房型</span><InfoHint label="适用房型说明" text="可选择多个房型，共享总夜数。整房与床位不能混选。" /></legend>
        <div className="membership-scope-options">{rooms.types.filter(t=>t.active).map(t=><label key={t.code} className={`membership-scope-option${scope.includes(t.code) ? " is-selected" : ""}`}>
          <input type="checkbox" aria-label={`${t.name}（${t.saleMode==="ROOM"?"间夜":"床夜"}）`} checked={scope.includes(t.code)} onChange={e=>setScope(e.target.checked?[...scope,t.code]:scope.filter(code=>code!==t.code))}/>
          <span>{t.name}</span><small>{t.saleMode==="ROOM"?"间夜":"床夜"}</small>
        </label>)}</div>
      </fieldset>
      <div className="field">
        <div className="membership-field-heading"><label htmlFor="membership-period">有效期</label><InfoHint label="有效期说明" text="从会员生效日一次加上指定的月数或年数；目标月没有对应日期时取月底，到期当天仍可使用。" /></div>
        <div className="membership-period"><input id="membership-period" required inputMode="numeric" value={period} onChange={e=>setPeriod(e.target.value)} />
          <select aria-label="期限单位" value={periodUnit} onChange={e=>setPeriodUnit(e.target.value)}><option value="M">个月</option><option value="Y">年</option></select></div>
      </div>
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
  useEffect(()=>{setData(undefined);setRooms(undefined);setEditor(undefined);setCommand(undefined);setDraft(undefined);setDraftReason("");setNotice("");if(canManage)void refresh();else setLoading(false);return()=>{lease.current++;};},[propertyId,canManage]);
  const blocked=loading || Boolean(error) || recovery.blocked || !canManage;
  function submit(input:MembershipCatalogInput) { setRecovering(false);setCommand({commandType:"MANAGE_MEMBERSHIP_CATALOG",input:{...input},title:"核对会员产品",
    description:"核对完整规格及影响，填写原因后确认。",initialReason:{code:"MEMBERSHIP_CATALOG_CHANGE",note:draftReason}}); }
  if(!canManage)return <EmptyState title="仅管理员可管理会员产品" detail="普通工作人员可在会员页面办理在售产品。"/>;
  return <div className="membership-catalog-page"><header className="page-heading membership-page-heading"><div className="membership-page-title"><h1>会员产品</h1><InfoHint label="会员产品说明" text="配置会员售价、房型、总夜数和有效期。修改和停售只影响此后的新订单，已建订单及已售权益保持原规格。" /></div><div className="page-heading-actions catalog-page-actions"><button className="button button-secondary" disabled={loading} onClick={()=>void refresh()}>刷新</button><button className="button button-primary" disabled={blocked} onClick={()=>{setDraft(undefined);setDraftReason("");setEditor({});}}>新增产品</button></div></header>
    {notice?<p className="catalog-notice" role="status">{notice}</p>:null}<InlineError error={error}/>
    {recovery.pending ? <CommandRecoveryBar recovery={recovery.pending} businessFacing onOpen={()=>{if(recovery.pending){setCommand(recoveryCommandRequest(recovery.pending));setRecovering(true);}}}/> : null}
    {recovery.canDiscardCorrupt ? <DamagedCommandRecoveryNotice error={recovery.error} onDiscard={recovery.discardCorruptAfterReview}/> : <InlineError error={recovery.error}/>}
    <QuoteRecoveryConflictNotice conflict={recovery.conflict}/>
    {loading&&!data?<LoadingBlock label="正在载入会员产品"/>:data&&!error?<>
    {data.entries.length ? <section className="membership-product-list" aria-label="会员产品列表">
      <table className="membership-products" role="table">
        <caption className="sr-only">会员产品的售价、总夜数、适用房型、有效期及销售状态</caption>
        <colgroup><col/><col/><col/><col/><col/><col/></colgroup>
        <thead role="rowgroup"><tr role="row">
          <th scope="col" role="columnheader">产品名称 / 状态</th><th scope="col" role="columnheader">售价</th>
          <th scope="col" role="columnheader">总夜数</th><th scope="col" role="columnheader">适用房型</th>
          <th scope="col" role="columnheader">有效期</th><th scope="col" role="columnheader">操作</th>
        </tr></thead>
        <tbody role="rowgroup">{data.entries.map(entry=><tr key={entry.code} role="row" data-testid="membership-product-row">
          <th scope="row" role="rowheader" className="membership-product-name">
            <h2>{entry.current.name}</h2><span className={`catalog-status${entry.saleStatus === "OFF_SALE" ? " is-inactive" : ""}`}>{entry.saleStatus === "ON_SALE" ? "在售" : "停售"}</span>
          </th>
          <td role="cell" className="membership-product-price">{formatMinor(entry.current.listPriceMinor, entry.current.currency)}</td>
          <td role="cell" className="membership-product-units">{entry.current.entitlementUnits} {entry.current.entitlementUnitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</td>
          <td role="cell" className="membership-product-scope"><span className="membership-cell-label">适用房型</span>{entry.current.allowedRoomTypeCodes.map(code=><span className="membership-room-type" key={code}>{rooms?.types.find(type=>type.code===code)?.name ?? code}</span>)}</td>
          <td role="cell" className="membership-product-validity"><span className="membership-cell-label">有效期</span>{membershipPeriodLabel(entry.current.validityPeriod)}</td>
          <td role="cell" className="membership-product-actions"><div className="membership-row-actions">
            <button className="membership-row-button membership-row-edit" disabled={blocked} onClick={()=>{setDraft(undefined);setDraftReason("");setEditor({entry});}}>编辑</button>
            <button className="membership-row-button" disabled={blocked} onClick={()=>{setDraft(undefined);setDraftReason("");setEditor({entry,copy:true});}}>复制</button>
            <button className="membership-row-button" disabled={blocked} onClick={()=>submit({propertyId,expectedRoomCatalogVersion:rooms!.version,action:"SET_SALE_STATUS",code:entry.code,expectedRevision:entry.revision,saleStatus:entry.saleStatus==="ON_SALE"?"OFF_SALE":"ON_SALE"})}>{entry.saleStatus==="ON_SALE"?"停售":"恢复销售"}</button>
          </div></td>
        </tr>)}</tbody>
      </table>
    </section> : <EmptyState title="暂无会员产品" detail="新增产品后，工作人员即可办理。"/>}
    <details className="catalog-history membership-history">
      <summary><span>变更历史</span><span className="membership-history-count">{data.history.length} 条</span></summary>
      {data.history.length ? data.history.map(item=><article key={item.id}>
        <header><h3>{item.effect.after.current.name} · {item.effect.title}</h3><time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time></header>
        <p>{item.operator} · {item.reason}</p>
        <details className="membership-history-change"><summary>查看修改前后</summary><div className="membership-history-comparison">
          {item.effect.before?<section><h4>修改前</h4><Specification entry={item.effect.before} {...(rooms?{rooms}:{})}/></section>:null}
          <section><h4>修改后</h4><Specification entry={item.effect.after} {...(rooms?{rooms}:{})}/></section>
        </div></details>
      </article>) : <p className="muted">暂无变更记录</p>}
    </details></>:null}
    {editor&&rooms&&!command&&!loading?<Editor {...editor} rooms={rooms} {...(draft?{draft}:{})} onClose={()=>{setEditor(undefined);setDraft(undefined);setDraftReason("");}} onSubmit={spec=>{setDraft(spec);submit(editor.entry&&!editor.copy?{propertyId,expectedRoomCatalogVersion:rooms.version,action:"UPDATE",code:editor.entry.code,expectedRevision:editor.entry.revision,specification:spec}:{propertyId,expectedRoomCatalogVersion:rooms.version,action:"CREATE",specification:spec});}}/>:null}
    {command?<CommandDialog key={recovering?recovery.pending?.confirmationKey:"membership-command"} request={command} inventoryUnitLabels={Object.fromEntries((rooms?.types ?? []).map(type=>[type.code,type.name]))}
      {...(recovering&&recovery.pending?{initialConfirmationKey:recovery.pending.confirmationKey}:{})}
      onProgress={progress=>recovery.track(command,progress)} onReturnToEdit={request=>{setEditor(editor);setDraftReason(request.initialReason?.note ?? "");setCommand(undefined);void refresh();}}
      onCommitted={async()=>{setEditor(undefined);await Promise.all([refresh(),refreshMeta()]);setNotice("会员产品已保存");}}
      onClose={async context=>{setDraftReason("");setCommand(undefined);setEditor(undefined);setRecovering(false);if(context||(recovery.pending&&isTerminalCommandRecovery(recovery.pending.state)))await recovery.clearResolved();}}/>:null}
  </div>;
}
