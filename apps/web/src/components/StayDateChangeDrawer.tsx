import { CalendarPlus2, CalendarRange, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import type { CommandRequest, OrderViewDto } from "../types";
import {
  InlineError,
  Modal,
  businessStatusLabel,
  formatDate,
  formatMoney,
  stayDatePreviewPricingSummary,
  type StayDatePreviewPricingSummary
} from "../ui";

export type StayDateChangeAction = "RESCHEDULE_STAY" | "EXTEND_STAY";

export interface StayDateChangeDraft {
  newArrivalDate: string;
  newDepartureDate: string;
  reason: string;
  targetContractYuan: string;
  channelPriceDifferenceReason: string;
  manuallyAdjustWecomPrice: boolean;
  manualPriceAdjustmentReason: string;
}

export interface StayDateChangeActionState {
  action: StayDateChangeAction;
  enabled: boolean;
  reason: string | null;
}

const externalChannels = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const maxWholeYuan = 21_474_836;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/;

type PricePreviewState =
  | { status: "EMPTY" }
  | { status: "LOADING" }
  | { status: "READY"; summary: StayDatePreviewPricingSummary; expiresAt: string; signature: string }
  | { status: "ERROR"; error: unknown };

function shiftDate(value: string, days: number): string {
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)) return value;
  return new Date(epoch + days * 86_400_000).toISOString().slice(0, 10);
}

function isLocalDate(value: string): boolean {
  if (!localDatePattern.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

function wholeYuanMinor(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const yuan = Number(value);
  if (!Number.isSafeInteger(yuan) || yuan < 0 || yuan > maxWholeYuan) return undefined;
  const minor = yuan * 100;
  return Number.isSafeInteger(minor) && minor <= 2_147_483_600 ? minor : undefined;
}

function draftString(input: Record<string, unknown> | undefined, key: string): string {
  const value = input?.[key];
  return typeof value === "string" ? value : "";
}

function draftAmountYuan(input: Record<string, unknown> | undefined): string {
  const value = input?.targetCurrentContractAmountMinor;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % 100 === 0
    ? String(value / 100)
    : "";
}

export function stayDateChangeInitialDraft(
  action: StayDateChangeAction,
  view: OrderViewDto,
  recovered?: CommandRequest
): StayDateChangeDraft {
  const recoveredInput = recovered?.commandType === action ? recovered.input : undefined;
  const targetContractYuan = draftAmountYuan(recoveredInput);
  return {
    newArrivalDate: action === "RESCHEDULE_STAY"
      ? draftString(recoveredInput, "newArrivalDate") || view.effectiveArrangement.arrivalDate
      : view.effectiveArrangement.arrivalDate,
    newDepartureDate: draftString(recoveredInput, "newDepartureDate")
      || (action === "EXTEND_STAY" ? shiftDate(view.effectiveArrangement.departureDate, 1) : view.effectiveArrangement.departureDate),
    reason: recovered?.commandType === action ? recovered.initialReason?.note ?? "" : "",
    targetContractYuan,
    channelPriceDifferenceReason: draftString(recoveredInput, "channelPriceDifferenceReason"),
    manuallyAdjustWecomPrice: view.order.booking_channel_code === "WECOM" && targetContractYuan !== "",
    manualPriceAdjustmentReason: draftString(recoveredInput, "manualPriceAdjustmentReason")
  };
}

export function stayDateChangeActionState(view: OrderViewDto): StayDateChangeActionState | undefined {
  const action = view.order.status === "RESERVED"
    ? "RESCHEDULE_STAY"
    : view.order.status === "CHECKED_IN"
      ? "EXTEND_STAY"
      : undefined;
  if (!action) return undefined;
  const authoritative = view.allowedActions.find((candidate) => candidate.code === action);
  if (!authoritative) return undefined;
  if (!authoritative?.enabled) {
    return {
      action,
      enabled: false,
      reason: authoritative?.disabledReason?.trim() || "当前订单状态暂不能办理日期调整"
    };
  }
  if (action === "RESCHEDULE_STAY" && view.effectiveArrangement.intervals.length !== 1) {
    return {
      action,
      enabled: false,
      reason: "该订单已有换房安排，当前版本暂不能调整预订日期"
    };
  }
  return { action, enabled: view.accessLevel === "WRITE", reason: view.accessLevel === "WRITE" ? null : "当前账号只有查看权限" };
}

export function buildStayDateChangeRequest(
  action: StayDateChangeAction,
  view: OrderViewDto,
  draft: StayDateChangeDraft
): CommandRequest {
  const actionState = stayDateChangeActionState(view);
  if (!actionState || actionState.action !== action || !actionState.enabled) {
    throw new Error(actionState?.reason || "当前订单状态暂不能办理日期调整");
  }
  if (!isLocalDate(draft.newArrivalDate) || !isLocalDate(draft.newDepartureDate)) {
    throw new Error("请选择有效的入住日期和退房日期");
  }
  if (draft.newDepartureDate <= draft.newArrivalDate) {
    throw new Error("退房日期必须晚于入住日期");
  }
  if (action === "RESCHEDULE_STAY") {
    if (draft.newArrivalDate < view.effectiveArrangement.businessDate) {
      throw new Error("新入住日期不能早于当前营业日");
    }
    if (draft.newArrivalDate === view.effectiveArrangement.arrivalDate
      && draft.newDepartureDate === view.effectiveArrangement.departureDate) {
      throw new Error("入住日期和退房日期均未变化");
    }
  } else {
    if (draft.newArrivalDate !== view.effectiveArrangement.arrivalDate) {
      throw new Error("在住续住不能修改入住日期");
    }
    if (draft.newDepartureDate <= view.effectiveArrangement.departureDate) {
      throw new Error("续住后的退房日期必须晚于原退房日");
    }
    if (view.effectiveArrangement.businessDate > view.effectiveArrangement.departureDate
      && draft.newDepartureDate <= view.effectiveArrangement.businessDate) {
      throw new Error("逾期续住后的退房日期必须晚于当前营业日");
    }
  }
  const reason = draft.reason.trim();
  if (!reason) throw new Error("请填写本次住宿日期变更原因");

  const input: Record<string, unknown> = {
    propertyId: view.order.property_id,
    orderId: view.order.id,
    ...(action === "RESCHEDULE_STAY" ? { newArrivalDate: draft.newArrivalDate } : {}),
    newDepartureDate: draft.newDepartureDate
  };
  const memberStay = Boolean(view.order.member_id || view.order.member_contract_id);
  const freeStay = view.order.stay_type === "FREE";
  const channel = view.order.booking_channel_code;
  if (!memberStay && !freeStay && channel && externalChannels.has(channel)) {
    const target = wholeYuanMinor(draft.targetContractYuan);
    if (target === undefined) throw new Error("请重新填写本单渠道应结金额，金额必须是支持范围内的非负整元");
    input.targetCurrentContractAmountMinor = target;
    if (draft.channelPriceDifferenceReason.trim()) {
      input.channelPriceDifferenceReason = draft.channelPriceDifferenceReason.trim();
    }
  } else if (!memberStay && !freeStay && channel === "WECOM" && draft.manuallyAdjustWecomPrice) {
    const target = wholeYuanMinor(draft.targetContractYuan);
    if (target === undefined) throw new Error("人工调整后的订单金额必须是支持范围内的非负整元");
    if (!draft.manualPriceAdjustmentReason.trim()) throw new Error("主动偏离政策重算金额时必须填写人工调价原因");
    input.targetCurrentContractAmountMinor = target;
    input.manualPriceAdjustmentReason = draft.manualPriceAdjustmentReason.trim();
  }
  return {
    commandType: action,
    title: action === "RESCHEDULE_STAY" ? "调整预订日期" : "延长住宿",
    description: action === "RESCHEDULE_STAY"
      ? "系统将按新日期重新核对完整库存、原锁定价格政策、会员权益和已登记收款差额。"
      : "系统将按完整新住宿周期重新核对新增库存、原锁定价格政策、会员权益和已登记收款差额。",
    presentation: "STAY_DATES",
    initialReason: { code: action, note: reason },
    input
  };
}

export function StayDateChangeDrawer({
  action,
  view,
  inventoryUnitLabel,
  draft: recovered,
  writeBlocked = false,
  onClose,
  onSubmit
}: {
  action: StayDateChangeAction;
  view: OrderViewDto;
  inventoryUnitLabel: string;
  draft?: CommandRequest;
  writeBlocked?: boolean;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const initial = stayDateChangeInitialDraft(action, view, recovered);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<unknown>();
  const memberStay = Boolean(view.order.member_id || view.order.member_contract_id);
  const freeStay = view.order.stay_type === "FREE";
  const externalChannel = Boolean(view.order.booking_channel_code && externalChannels.has(view.order.booking_channel_code));
  const wecom = view.order.booking_channel_code === "WECOM";
  const actionState = stayDateChangeActionState(view);
  const guestNickname = typeof view.order.primary_guest_snapshot.nickname === "string"
    && view.order.primary_guest_snapshot.nickname.trim()
    ? view.order.primary_guest_snapshot.nickname.trim()
    : "未命名住客";
  const [pricePreview, setPricePreview] = useState<PricePreviewState>({ status: "EMPTY" });
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewGeneration = useRef(0);

  const previewRequest = useMemo(() => {
    try {
      return buildStayDateChangeRequest(action, view, {
        ...draft,
        reason: draft.reason.trim() || "住宿日期调整金额核对"
      });
    } catch {
      return undefined;
    }
  }, [
    action,
    view,
    draft.newArrivalDate,
    draft.newDepartureDate,
    draft.targetContractYuan,
    draft.channelPriceDifferenceReason,
    draft.manuallyAdjustWecomPrice,
    draft.manualPriceAdjustmentReason
  ]);
  const previewSignature = previewRequest
    ? JSON.stringify({ commandType: previewRequest.commandType, input: previewRequest.input })
    : "";

  useEffect(() => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    if (!previewRequest || !previewSignature || writeBlocked || !actionState?.enabled) {
      setPricePreview({ status: "EMPTY" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPricePreview({ status: "LOADING" });
      void api.preview(
        { commandType: action, input: previewRequest.input },
        api.commandMetadata(`stay-date-price-${action.toLowerCase()}`),
        controller.signal
      ).then((response) => {
        if (controller.signal.aborted || previewGeneration.current !== generation) return;
        const summary = stayDatePreviewPricingSummary(action, response.preview, previewRequest.input);
        if (!summary) {
          setPricePreview({ status: "ERROR", error: new Error("服务端返回的日期与金额核对信息不完整，请重新选择日期") });
          return;
        }
        setPricePreview({
          status: "READY",
          summary,
          expiresAt: response.preview.expiresAt,
          signature: previewSignature
        });
      }).catch((nextError: unknown) => {
        if (controller.signal.aborted || previewGeneration.current !== generation
          || (nextError instanceof DOMException && nextError.name === "AbortError")) return;
        setPricePreview({ status: "ERROR", error: nextError });
      });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [action, actionState?.enabled, previewRefresh, previewSignature, writeBlocked]);

  useEffect(() => {
    if (pricePreview.status !== "READY") return;
    const expiry = Date.parse(pricePreview.expiresAt);
    if (!Number.isFinite(expiry)) {
      setPricePreview({ status: "ERROR", error: new Error("金额核对结果缺少有效期，请重新计算") });
      return;
    }
    const timer = window.setTimeout(() => {
      setPricePreview({ status: "EMPTY" });
      setPreviewRefresh((value) => value + 1);
    }, Math.max(0, expiry - Date.now() + 20));
    return () => window.clearTimeout(timer);
  }, [pricePreview]);

  function update(patch: Partial<StayDateChangeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setError(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      if (pricePreview.status !== "READY" || pricePreview.signature !== previewSignature) {
        throw new Error("请等待调整后订单金额计算完成，再继续核对");
      }
      onSubmit(buildStayDateChangeRequest(action, view, draft));
    } catch (nextError) {
      setError(nextError);
    }
  }

  const title = action === "RESCHEDULE_STAY" ? "调整预订日期" : "延长住宿";
  return <Modal
    title={title}
    size="drawer"
    className="stay-date-change-drawer room-status-write-drawer"
    onClose={onClose}
    footer={<>
      <button type="button" className="button button-secondary" onClick={onClose}>取消</button>
      <button type="submit" form="stay-date-change-form" className="button button-primary" disabled={writeBlocked || !actionState?.enabled || !draft.reason.trim() || pricePreview.status !== "READY" || pricePreview.signature !== previewSignature}>继续核对</button>
    </>}
  >
    <div className="stay-date-change-heading">
      {action === "RESCHEDULE_STAY" ? <CalendarRange aria-hidden="true" size={20} /> : <CalendarPlus2 aria-hidden="true" size={20} />}
      <div data-testid="stay-date-order-context">
        <span>{action === "RESCHEDULE_STAY" ? "当前预订日期" : "当前住宿日期"} · {businessStatusLabel(view.order.status)}</span>
        <strong>{guestNickname}</strong>
        <small>{inventoryUnitLabel}</small>
        <small>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</small>
      </div>
    </div>
    <InlineError error={error} title="无法继续核对" />
    <InlineError error={!actionState?.enabled ? new Error(actionState?.reason || "当前订单状态暂不能办理日期调整") : undefined} title="暂不能办理" hideTechnicalDetails />
    <InlineError error={writeBlocked ? new Error("当前页面正在恢复未完成操作或订单事实已经变化，请收口后重新打开") : undefined} title="写入已暂停" hideTechnicalDetails />
    <form id="stay-date-change-form" className="modal-form" onSubmit={submit}>
      <div className="form-grid form-grid-two">
        <label>入住日期<input type="date" value={draft.newArrivalDate} min={view.effectiveArrangement.businessDate} disabled={action === "EXTEND_STAY"} onChange={(event) => update({ newArrivalDate: event.target.value })} required data-testid="stay-date-arrival" /></label>
        <label>退房日期<input type="date" value={draft.newDepartureDate} min={shiftDate(draft.newArrivalDate, 1)} onChange={(event) => update({ newDepartureDate: event.target.value })} required data-testid="stay-date-departure" /></label>
        <label className="span-two">住宿日期变更原因<textarea value={draft.reason} onChange={(event) => update({ reason: event.target.value })} required maxLength={1000} rows={3} data-testid="stay-date-reason" /></label>
      </div>

      {externalChannel && !memberStay && !freeStay ? <section className="stay-date-pricing-section" aria-labelledby="channel-repricing-heading">
        <h3 id="channel-repricing-heading">渠道订单金额</h3>
        <p>旧金额不会自动继承。请按本次渠道合同重新填写，系统将在核对时与政策基础金额比较。</p>
        <div className="form-grid">
          <label>本单渠道应结金额（元）<input type="number" min="0" max={maxWholeYuan} step="1" inputMode="numeric" value={draft.targetContractYuan} onChange={(event) => update({ targetContractYuan: event.target.value })} required data-testid="stay-date-channel-amount" /></label>
          <label>渠道价格差异说明<textarea value={draft.channelPriceDifferenceReason} onChange={(event) => update({ channelPriceDifferenceReason: event.target.value })} maxLength={1000} rows={2} aria-describedby="channel-difference-hint" data-testid="stay-date-channel-reason" /></label>
          <small id="channel-difference-hint">与政策基础金额差异超过 15% 时必须填写；核对页会显示比较结果。</small>
        </div>
      </section> : null}

      {wecom && !memberStay && !freeStay ? <section className="stay-date-pricing-section" aria-labelledby="wecom-repricing-heading">
        <h3 id="wecom-repricing-heading">订单金额</h3>
        <p>系统会根据新的入住和退房日期重新计算订单金额。</p>
        <label className="stay-date-price-toggle"><input type="checkbox" role="switch" checked={draft.manuallyAdjustWecomPrice} onChange={(event) => update({ manuallyAdjustWecomPrice: event.target.checked, ...(!event.target.checked ? { targetContractYuan: "", manualPriceAdjustmentReason: "" } : {}) })} data-testid="stay-date-wecom-adjust-toggle" /><span><strong>另行调整金额</strong><small>只有本次需要使用其他金额时才打开，并填写原因。</small></span></label>
        {draft.manuallyAdjustWecomPrice ? <div className="form-grid">
          <label>调整后订单金额（元）<input type="number" min="0" max={maxWholeYuan} step="1" inputMode="numeric" value={draft.targetContractYuan} onChange={(event) => update({ targetContractYuan: event.target.value })} required data-testid="stay-date-wecom-amount" /></label>
          <label>人工调价原因<textarea value={draft.manualPriceAdjustmentReason} onChange={(event) => update({ manualPriceAdjustmentReason: event.target.value })} required maxLength={1000} rows={2} data-testid="stay-date-wecom-reason" /></label>
        </div> : null}
      </section> : null}

      <section className="stay-date-pricing-section" aria-labelledby="stay-date-price-result-heading" aria-live="polite">
        <h3 id="stay-date-price-result-heading">金额核对</h3>
        {pricePreview.status === "EMPTY" ? <p data-testid="stay-date-price-empty">填写有效的新日期和所需金额后，系统会在这里显示调整结果。</p> : null}
        {pricePreview.status === "LOADING" ? <div className="stay-date-price-loading" role="status" data-testid="stay-date-price-loading"><LoaderCircle className="spin" aria-hidden="true" size={17} /><span>正在计算调整后订单金额</span></div> : null}
        {pricePreview.status === "ERROR" ? <InlineError error={pricePreview.error} title="暂时无法核对新金额" hideTechnicalDetails /> : null}
        {pricePreview.status === "READY" ? (() => {
          const { summary } = pricePreview;
          const change = {
            currency: summary.targetAmount.currency,
            minorUnits: summary.targetAmount.minorUnits - summary.beforeAmount.minorUnits
          };
          return <>
            <div className="stay-date-price-preview" data-testid="stay-date-price-preview">
              <span>原订单金额</span>
              <strong data-testid="stay-date-original-amount">{formatMoney(summary.beforeAmount)}</strong>
              {summary.pricingBasis === "CHANNEL_CONTRACT" ? <><span>新日期政策金额</span><strong>{formatMoney(summary.policyBaseAmount)}</strong></> : null}
              <span>{summary.pricingBasis === "CHANNEL_CONTRACT" ? "本单渠道应结金额" : "调整后订单金额"}</span>
              <strong data-testid="stay-date-new-amount">{formatMoney(summary.targetAmount)}</strong>
              <span>金额变化</span>
              <strong>{formatMoney(change)}</strong>
            </div>
            <p>系统已按新的住宿日期重新计算。正式确认时还会再次核对库存和订单事实。</p>
          </>;
        })() : null}
      </section>

      {memberStay ? <p className="stay-date-pricing-note">核对页将显示会员权益覆盖晚数、未覆盖晚数和未覆盖金额。</p> : null}
      {freeStay ? <p className="stay-date-pricing-note">免费住宿保持 0 元，不产生会员权益或收付款事实。</p> : null}
    </form>
  </Modal>;
}
