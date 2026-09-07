import { useState, type FormEvent } from "react";
import type { CommandRequest, OrderViewDto } from "../types";
import { InlineError, Modal, formatDate } from "../ui";

export function OrderCompanionDialog({ view, occupantId, draft, onClose, onSubmit }: {
  view: OrderViewDto;
  occupantId?: string;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const removing = Boolean(occupantId);
  const occupant = view.occupants.find((person) => person.id === occupantId);
  const initial = draft?.input.guest as Record<string, string | null> | undefined;
  const [nickname, setNickname] = useState(initial?.nickname ?? "");
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [documentNumber, setDocumentNumber] = useState(initial?.documentNumber ?? "");
  const [reason, setReason] = useState(draft?.initialReason?.note ?? "");
  const [error, setError] = useState<unknown>();
  const title = removing ? "撤销同住人登记" : "添加同住人";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim() || (!removing && (!nickname.trim() || !fullName.trim()))) {
      setError(new Error("请填写必填资料和操作原因"));
      return;
    }
    onSubmit({ commandType: "MANAGE_ORDER_OCCUPANTS", title, description: "同住人与主要入住人共用订单住宿期间。",
      input: { propertyId: view.order.property_id, orderId: view.order.id,
        ...(removing ? { action: "REMOVE", occupantId } : { action: "ADD", guest: {
          nickname: nickname.trim(), fullName: fullName.trim(), phone: phone.trim() || null, documentNumber: documentNumber.trim() || null
        } }) }, initialReason: { code: "MANAGE_ORDER_OCCUPANTS", note: reason.trim() } });
  }
  return <Modal title={title} onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit}>
      <InlineError error={error} title="无法继续" />
      <dl className="detail-list"><div><dt>共同住宿期间</dt><dd>{formatDate(view.order.arrival_date)} 至 {formatDate(view.order.departure_date)}</dd></div></dl>
      {removing ? <p>撤销 {occupant?.nickname || occupant?.fullName} 的误录登记，将从整个订单期间的住宿人数中移除，不作为提前离开记录。</p> : null}
      <div className="form-grid form-grid-two">
        {!removing ? <>
          <label>昵称<input required maxLength={200} value={nickname} onChange={(event) => setNickname(event.target.value)} /></label>
          <label>姓名<input required maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
          <label>联系电话（选填）<input inputMode="tel" maxLength={80} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
          <label>证件号码（选填）<input maxLength={120} value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} /></label>
        </> : null}
        <label className="span-two">{removing ? "撤销原因" : "添加原因"}<textarea required maxLength={1000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      </div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary">继续核对</button></div>
    </form>
  </Modal>;
}
