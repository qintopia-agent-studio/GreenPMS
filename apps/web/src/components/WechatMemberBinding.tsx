import { useState } from "react";
import { api } from "../api";
import { Modal } from "../ui";

export function WechatMemberBinding({ propertyId, memberId, name }: { propertyId: string; memberId: string; name: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<string | null | undefined>(), [code, setCode] = useState("");
  const [method, setMethod] = useState<"IN_PERSON" | "REGISTERED_PHONE">("IN_PERSON");
  const [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState("");
  async function read() {
    setBusy(true); setMessage(""); setConfirmed(false); setCurrent(undefined);
    try { const result = await api.wechatBinding(propertyId, memberId); if (!result.enabled) throw new Error("本门店尚未开通服务号查询。"); setCurrent(result.bindingId ?? null); }
    catch (error) { setMessage(error instanceof Error ? error.message : "绑定状态读取失败。"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!confirmed || busy || current === undefined) return;
    setBusy(true); setMessage("");
    try {
      const result = await api.changeWechatBinding(propertyId, memberId, current ? { action: "REVOKE", bindingId: current } : { action: "BIND", code: code.trim().toUpperCase(), method });
      setCurrent(result.bindingId); setCode(""); setConfirmed(false); setMessage(result.bindingId ? "已绑定，请会员在微信点「已完成核验」。" : "原微信已解绑。");
    } catch (error) { await read(); setMessage(error instanceof Error ? error.message : "请核对当前状态后重试。"); }
    finally { setBusy(false); }
  }
  return <><button className="button button-secondary" onClick={() => { setOpen(true); setCode(""); void read(); }}>服务号绑定</button>
    {open && <Modal title="服务号绑定" onClose={() => setOpen(false)}><p>当前会员 · {name}</p>
      {current === undefined ? <button className="button" disabled={busy} onClick={() => void read()}>重新读取绑定状态</button> : <>
        <p>{current ? "此会员已绑定微信，可查看本人的住宿权益。" : "请会员打开服务号的「我的权益」，生成并出示绑定码。"}</p>
        {!current && <><label>核身方式<select value={method} onChange={e => { setMethod(e.target.value as typeof method); setConfirmed(false); }}>
          <option value="IN_PERSON">在前台核实本人</option><option value="REGISTERED_PHONE">回拨档案预留手机号核身</option></select></label>
          <label>会员微信页面上的绑定码<input value={code} maxLength={10} autoComplete="off" autoCapitalize="characters" onChange={e => { setCode(e.target.value.toUpperCase()); setConfirmed(false); }} /></label></>}
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{current ? "已核实本人要求解除原微信绑定" : "已按所选方式核实此会员，并核对本人微信上的绑定码"}</label>
        <div className="form-actions"><button className="button button-primary" disabled={busy || !confirmed || (!current && !/^[0-9A-F]{10}$/.test(code))} onClick={() => void save()}>{current ? "解除绑定" : "确认绑定"}</button></div></>}
      {message && <p role="status">{message}</p>}</Modal>}</>;
}
