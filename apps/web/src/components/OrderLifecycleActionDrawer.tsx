import { useState, type FormEvent } from "react";
import type { OrderActionCode } from "@qintopia/contracts";
import type { CommandRequest, OrderViewDto } from "../types";
import { formatDate, guestName, InlineError, Modal } from "../ui";

export type OrderLifecycleAction = Extract<OrderActionCode, "CANCEL_ORDER" | "MARK_NO_SHOW" | "REVOKE_CHECK_IN">;

export interface OrderLifecycleActionCopy {
  title: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  consequence: string;
}

export function lifecycleActionCopy(action: OrderLifecycleAction): OrderLifecycleActionCopy {
  if (action === "CANCEL_ORDER") return {
    title: "取消订单",
    reasonLabel: "取消原因",
    reasonPlaceholder: "请填写住客取消本次住宿的真实原因",
    consequence: "订单将结束，当前及后续住宿库存立即恢复可售；已登记收款仅生成退款参考，不会自动退款。"
  };
  if (action === "MARK_NO_SHOW") return {
    title: "标记未到",
    reasonLabel: "未到说明",
    reasonPlaceholder: "请填写确认住客未到店的依据",
    consequence: "订单将标记为未到，住宿库存立即恢复可售；已登记收款仅生成退款参考，不会自动退款。"
  };
  return {
    title: "撤销入住",
    reasonLabel: "撤销原因",
    reasonPlaceholder: "请填写误办入住及住客未使用房间的真实情况",
    consequence: "原入住记录继续保留；当天及以后库存立即恢复可售，已核销会员权益以补偿记录恢复，已登记收款仅生成退款参考。"
  };
}

export function buildOrderLifecycleRequest(
  action: OrderLifecycleAction,
  view: OrderViewDto,
  reason: string,
  unusedRoomConfirmed: boolean,
  inventoryUnitLabels?: Record<string, string>
): CommandRequest {
  const copy = lifecycleActionCopy(action);
  const note = reason.trim();
  if (!note) throw new Error(`必须填写${copy.reasonLabel}`);
  if (action === "REVOKE_CHECK_IN" && !unusedRoomConfirmed) {
    throw new Error("必须确认房间未被实际使用，才能撤销入住");
  }
  return {
    commandType: action,
    title: copy.title,
    description: `${copy.consequence}请核对状态、库存、权益、归零后的订单金额与退款参考。`,
    presentation: "ORDER_LIFECYCLE",
    input: {
      propertyId: view.order.property_id,
      orderId: view.order.id,
      ...(action === "REVOKE_CHECK_IN" ? { unusedRoomConfirmed: true } : {})
    },
    ...(inventoryUnitLabels ? { inventoryUnitLabels } : {}),
    orderLifecycleContext: {
      guestName: guestName(view.order.primary_guest_snapshot),
      arrivalDate: view.effectiveArrangement.arrivalDate,
      departureDate: view.effectiveArrangement.departureDate
    },
    initialReason: { code: action, note }
  };
}

export function OrderLifecycleActionDrawer({
  action,
  view,
  inventoryUnitLabels = {},
  draft,
  writeBlocked = false,
  onClose,
  onSubmit
}: {
  action: OrderLifecycleAction;
  view: OrderViewDto;
  inventoryUnitLabels?: Record<string, string>;
  draft?: CommandRequest;
  writeBlocked?: boolean;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const copy = lifecycleActionCopy(action);
  const [reason, setReason] = useState(draft?.initialReason?.note ?? "");
  const [unusedRoomConfirmed, setUnusedRoomConfirmed] = useState(draft?.input.unusedRoomConfirmed === true);
  const [validationError, setValidationError] = useState<unknown>();
  const unitLabels = [...new Set(view.effectiveArrangement.intervals.map((interval) => (
    inventoryUnitLabels[interval.inventoryUnitId] ?? "房源名称暂不可用"
  )))];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    try {
      onSubmit(buildOrderLifecycleRequest(action, view, reason, unusedRoomConfirmed, inventoryUnitLabels));
    } catch (error) {
      setValidationError(error);
    }
  }

  return <Modal title={copy.title} size="drawer" onClose={onClose} footer={null} className="order-lifecycle-action-drawer">
    <form className="modal-form" onSubmit={submit}>
      <section className="lifecycle-action-context" aria-label="本次操作对象">
        <strong>{guestName(view.order.primary_guest_snapshot)}</strong>
        <span>{unitLabels.join("、")}</span>
        <span>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</span>
      </section>
      <p className="command-description">{copy.consequence}</p>
      <InlineError error={validationError} title="无法继续核对" hideTechnicalDetails />
      {action === "REVOKE_CHECK_IN" ? <label className="lifecycle-unused-confirmation">
        <input
          type="checkbox"
          checked={unusedRoomConfirmed}
          onChange={(event) => { setUnusedRoomConfirmed(event.target.checked); setValidationError(undefined); }}
          disabled={writeBlocked}
          data-testid="unused-room-confirmed"
        />
        <span><strong>确认房间未被实际使用</strong><small>仅适用于误办入住或住客看房后未入住；原入住记录不会删除。</small></span>
      </label> : null}
      <label>{copy.reasonLabel}
        <textarea
          value={reason}
          onChange={(event) => { setReason(event.target.value); setValidationError(undefined); }}
          required
          maxLength={1000}
          rows={4}
          placeholder={copy.reasonPlaceholder}
          disabled={writeBlocked}
          data-testid="lifecycle-reason"
        />
      </label>
      <div className="form-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
        <button type="submit" className="button button-primary" disabled={writeBlocked}>继续核对</button>
      </div>
    </form>
  </Modal>;
}
