import { useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { AccountManagementRequest, MemberDeletionPreview } from "@qintopia/contracts";
import { api, ApiError } from "../api";
import { errorMessage, Modal } from "../ui";

export function MemberDeletionButton({ propertyId, memberId, disabled, onDeleted }: {
  propertyId: string; memberId: string; disabled: boolean; onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<MemberDeletionPreview>();
  const [reason, setReason] = useState("");
  const [erroneousPayments, setErroneousPayments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = useRef<AccountManagementRequest | undefined>(undefined);
  const inFlight = useRef(false);
  async function prepare() {
    setOpen(true); setPreview(undefined); setError(undefined); setReason(""); setErroneousPayments(false); setBusy(true);
    pending.current = undefined;
    try { setPreview(await api.memberDeletionPreview(propertyId, memberId)); }
    catch (value) { setError(value); }
    finally { setBusy(false); }
  }
  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!preview?.canDelete || inFlight.current) return;
    if (preview.reversalAmountMinor > 0 && !erroneousPayments) return;
    pending.current ??= { propertyId, requestId: crypto.randomUUID(), action: "DELETE_MEMBER", targetId: memberId, expectedVersion: preview.version, confirmation: true, reason: reason.trim(), ...(erroneousPayments ? { confirmErroneousPayments: true as const } : {}) };
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await api.manageAccount(pending.current); setOpen(false); onDeleted(); }
    catch (value) {
      setError(value);
      if (value instanceof ApiError && value.status < 500) { pending.current = undefined; setPreview(undefined); }
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <>
    <button className="icon-button account-danger" type="button" title="删除误建会员" aria-label="删除误建会员" disabled={disabled || busy} onClick={() => void prepare()}><Trash2 size={17} aria-hidden="true" /></button>
    {open ? <Modal title="确认删除会员" onClose={() => setOpen(false)} closeDisabled={busy} footer={null}>
      <form className="account-form" onSubmit={(event) => void remove(event)}>
        {error ? <div className="inline-error" role="alert">{errorMessage(error)}</div> : null}
        {preview ? <><dl className="account-confirmation"><div><dt>姓名</dt><dd>{preview.fullName}</dd></div><div><dt>昵称</dt><dd>{preview.nickname}</dd></div><div><dt>手机号</dt><dd>{preview.phone}</dd></div></dl>
          {preview.canDelete ? <>
            {preview.membershipOrderCount > 0 ? <dl className="account-confirmation"><div><dt>作废办卡</dt><dd>{preview.membershipOrderCount} 笔</dd></div><div><dt>作废权益</dt><dd>{preview.roomNights} 间夜 / {preview.bedNights} 床夜</dd></div><div><dt>冲销收款</dt><dd>{(preview.reversalAmountMinor / 100).toLocaleString("zh-CN", { style: "currency", currency: "CNY" })}</dd></div></dl> : null}
            <p>删除后手机号可重新建档，原档案、订单、收款与操作记录保留；未用权益将作废。</p>
            {preview.reversalAmountMinor > 0 ? <label className="account-payment-confirmation"><input type="checkbox" checked={erroneousPayments} onChange={(event) => setErroneousPayments(event.target.checked)} disabled={busy || Boolean(pending.current)} required /><span>我确认以上收款均为误录，追加冲销，不办理真实退款</span></label> : null}
            <label>删除原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} disabled={busy || Boolean(pending.current)} /></label>
          </> : <p role="alert">{preview.blockedReason}</p>}
        </> : busy ? <p role="status">正在核对会员记录...</p> : null}
        <div className="form-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>{preview?.canDelete ? <button className="button button-danger" type="submit" disabled={busy || !reason.trim() || (preview.reversalAmountMinor > 0 && !erroneousPayments)}><Trash2 size={16} aria-hidden="true" />{busy ? "正在删除..." : pending.current ? "核对并重试" : "确认删除"}</button> : null}</div>
      </form>
    </Modal> : null}
  </>;
}
