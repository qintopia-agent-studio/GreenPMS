import { useState } from "react";
import { api } from "../api";
import { Modal } from "../ui";

export function WechatMemberBinding({ propertyId, memberId, name }: { propertyId: string; memberId: string; name: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<string | null | undefined>();
  const [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState("");
  async function read() {
    setBusy(true); setMessage(""); setConfirmed(false); setCurrent(undefined);
    try { const result = await api.wechatBinding(propertyId, memberId); if (!result.enabled) throw new Error("本门店尚未开通服务号查询。"); setCurrent(result.bindingId ?? null); }
    catch (error) { setMessage(error instanceof Error ? error.message : "绑定状态读取失败。"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!confirmed || busy || !current) return;
    setBusy(true); setMessage("");
    try {
      const result = await api.changeWechatBinding(propertyId, memberId, { action: "REVOKE", bindingId: current });
      setCurrent(result.bindingId); setConfirmed(false); setMessage("原微信已解绑。");
    } catch (error) { await read(); setMessage(error instanceof Error ? error.message : "请核对当前状态后重试。"); }
    finally { setBusy(false); }
  }
  return <><button className="button button-secondary" onClick={() => { setOpen(true); void read(); }}>服务号绑定</button>
    {open && <Modal title="服务号绑定" onClose={() => setOpen(false)}><p>当前会员 · {name}</p>
      {current === undefined ? <button className="button" disabled={busy} onClick={() => void read()}>重新读取绑定状态</button> : <>
        <p>{current ? "此会员已绑定微信，可查看本人的住宿权益。" : "此会员尚未绑定。会员可在服务号「我的权益」用办卡时预留的手机号和短信验证码自行绑定。"}</p>
        {current && <><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />已核实本人要求解除原微信绑定</label>
          <div className="form-actions"><button className="button button-primary" disabled={busy || !confirmed} onClick={() => void save()}>解除绑定</button></div></>}</>}
      {message && <p role="status">{message}</p>}</Modal>}</>;
}
