import { useState, type FormEvent } from "react";
import type { CommandRequest, OrderViewDto } from "../types";
import { InlineError, Modal } from "../ui";

export type OrderOccupant = OrderViewDto["occupants"][number];

export interface OrderOccupantCorrectionDialogProps {
  view: OrderViewDto;
  occupant: OrderOccupant;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
  draft?: CommandRequest;
}

export interface OrderOccupantCorrectionValues {
  nickname: string;
  fullName: string;
  phone: string;
  documentNumber: string;
  reason: string;
}

function optionalTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

export function restoredOptionalCorrectionValue(value: unknown, fallback: string | null): string {
  return value === null ? "" : typeof value === "string" ? value : fallback ?? "";
}

export function correctionDraftMatchesOccupant(draft: CommandRequest | undefined, orderId: string, occupantId: string): draft is CommandRequest {
  return draft?.commandType === "CORRECT_ORDER_OCCUPANT"
    && draft.input.orderId === orderId
    && draft.input.occupantId === occupantId;
}

export function buildOrderOccupantCorrectionRequest(
  view: OrderViewDto,
  occupant: OrderOccupant,
  values: OrderOccupantCorrectionValues
): CommandRequest {
  const nickname = values.nickname.trim();
  const fullName = values.fullName.trim();
  const reason = values.reason.trim();
  if (!nickname) throw new Error("昵称不能为空");
  if (!fullName) throw new Error("姓名不能为空");
  if (!reason) throw new Error("必须填写更正原因");

  return {
    commandType: "CORRECT_ORDER_OCCUPANT",
    title: "更正住宿人资料",
    description: "服务端将校验订单、住宿人与当前资料版本，并追加不可变更正记录。",
    input: {
      propertyId: view.order.property_id,
      orderId: view.order.id,
      occupantId: occupant.id,
      expectedPriorSnapshot: {
        fullName: occupant.fullName,
        nickname: occupant.nickname,
        phone: occupant.phone,
        documentNumber: occupant.documentNumber
      },
      correctedSnapshot: {
        nickname,
        fullName,
        phone: optionalTrimmed(values.phone),
        documentNumber: optionalTrimmed(values.documentNumber)
      }
    },
    initialReason: {
      code: "CORRECT_ORDER_OCCUPANT",
      note: reason
    }
  };
}

export function OrderOccupantCorrectionDialog({ view, occupant, onClose, onSubmit, draft }: OrderOccupantCorrectionDialogProps) {
  const [baselineOccupant] = useState(() => occupant);
  const corrected = draft?.input.correctedSnapshot && typeof draft.input.correctedSnapshot === "object"
    ? draft.input.correctedSnapshot as Record<string, unknown>
    : undefined;
  const [nickname, setNickname] = useState(() => typeof corrected?.nickname === "string" ? corrected.nickname : occupant.nickname ?? "");
  const [fullName, setFullName] = useState(() => typeof corrected?.fullName === "string" ? corrected.fullName : occupant.fullName ?? "");
  const [phone, setPhone] = useState(() => restoredOptionalCorrectionValue(corrected?.phone, occupant.phone));
  const [documentNumber, setDocumentNumber] = useState(() => restoredOptionalCorrectionValue(corrected?.documentNumber, occupant.documentNumber));
  const [reason, setReason] = useState(draft?.initialReason?.note ?? "");
  const [validationError, setValidationError] = useState<unknown>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    try {
      onSubmit(buildOrderOccupantCorrectionRequest(view, baselineOccupant, {
        nickname,
        fullName,
        phone,
        documentNumber,
        reason
      }));
    } catch (error) {
      setValidationError(error);
    }
  }

  return (
    <Modal title="更正住宿人资料" onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit}>
        <InlineError error={validationError} title="无法继续" />
        <div className="form-grid form-grid-two">
          <label>昵称<input value={nickname} onChange={(event) => setNickname(event.target.value)} required maxLength={200} data-testid="occupant-correction-nickname" /></label>
          <label>姓名<input value={fullName} onChange={(event) => setFullName(event.target.value)} required maxLength={200} data-testid="occupant-correction-full-name" /></label>
          <label>联系电话<input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={80} data-testid="occupant-correction-phone" /></label>
          <label>证件号码（选填）<input value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} maxLength={120} data-testid="occupant-correction-document-number" /></label>
          <label className="span-two">更正原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} data-testid="occupant-correction-reason" /></label>
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="button button-primary">继续核对更正</button>
        </div>
      </form>
    </Modal>
  );
}
