import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, Clock3, Copy, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import {
  commandTypes,
  historicalRecoverableCommandTypes,
  type CommandType,
  type HistoricalCommandType,
  type HistoricalRecoverableCommandType,
  type MoneyDto
} from "@qintopia/contracts";
import { api, ApiError } from "./api";
import type { ClientCommandMetadata, CommandRequest, PreviewDto, ReceiptDto } from "./types";

type ExecutableCommandType = (typeof commandTypes)[number];

function isExecutableCommandType(commandType: HistoricalCommandType): commandType is ExecutableCommandType {
  return (commandTypes as readonly string[]).includes(commandType);
}

function isHistoricalRecoverableCommandType(commandType: unknown): commandType is HistoricalRecoverableCommandType {
  return typeof commandType === "string" && (historicalRecoverableCommandTypes as readonly string[]).includes(commandType);
}

export function formatMoney(value: MoneyDto | undefined): string {
  if (!value) return "-";
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value.minorUnits / 100);
  } catch {
    return `${value.currency} ${value.minorUnits}`;
  }
}

export function formatMinor(minorUnits: number, currency: string): string {
  return formatMoney({ minorUnits, currency });
}

export function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function guestName(snapshot: Record<string, unknown>): string {
  const nickname = snapshot.nickname;
  if (typeof nickname === "string" && nickname.trim()) return nickname;
  const fullName = snapshot.fullName;
  return typeof fullName === "string" && fullName.trim() ? fullName : "未命名住客";
}

export function guestSearchText(snapshot: Record<string, unknown>): string {
  return [snapshot.nickname, snapshot.fullName, snapshot.phone, snapshot.documentNumber]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "请求失败，请稍后重试";
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge status-${normalized}`}>{value.replaceAll("_", " ")}</span>;
}

export function InlineError({ error, title = "操作未完成", hideTechnicalDetails = false }: {
  error: unknown;
  title?: string;
  hideTechnicalDetails?: boolean;
}) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : undefined;
  const message = hideTechnicalDetails && error instanceof Error ? error.message : errorMessage(error);
  return (
    <div className="inline-error" role="alert" tabIndex={-1}>
      <AlertCircle aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
        {!hideTechnicalDetails && apiError?.correlationId ? <small>Correlation ID: {apiError.correlationId}</small> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function LoadingBlock({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" aria-hidden="true" size={20} />
      <span>{label}</span>
    </div>
  );
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "default" | "wide" | "drawer" | "mobile-fullscreen";
  closeDisabled?: boolean;
  modal?: boolean;
}

export function Modal({ title, onClose, children, footer, size = "default", closeDisabled = false, modal = true }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modal && dialog && !dialog.open) dialog.showModal();
    return () => {
      if (modal) previousFocus?.focus();
    };
  }, [modal]);

  useEffect(() => {
    if (modal) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || closeDisabled || !dialogRef.current?.open) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [closeDisabled, modal, onClose]);

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (!modal && event.key === "Escape") {
      event.preventDefault();
      if (!closeDisabled) onClose();
      return;
    }
    if (!modal) return;
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )].filter((element) => !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      className={`modal modal-${size}`}
      ref={dialogRef}
      open={modal ? undefined : true}
      tabIndex={-1}
      aria-labelledby={titleId}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (!closeDisabled && event.target === dialogRef.current) onClose();
      }}
    >
      <div className="modal-shell">
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" onClick={onClose} disabled={closeDisabled} aria-label="关闭" title="关闭">
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface OccupantSummaryItem {
  key: string;
  roleLabel: string;
  nickname: string;
  fullName: string;
}

export function occupantSummaryItems(value: unknown): OccupantSummaryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const ordinal = typeof candidate.ordinal === "number" ? candidate.ordinal : index + 1;
    return [{
      key: typeof candidate.id === "string" ? candidate.id : `occupant-${ordinal}-${index}`,
      roleLabel: candidate.role === "PRIMARY" ? "主要 / 联系人" : `同行人 ${Math.max(1, ordinal - 1)}`,
      nickname: guestNicknameLabel(candidate),
      fullName: typeof candidate.fullName === "string" && candidate.fullName.trim() ? candidate.fullName : "-"
    }];
  });
}

function OccupantSummary({ value }: { value: unknown }) {
  const occupants = occupantSummaryItems(value);
  if (!occupants.length) return null;
  return (
    <ol className="occupant-summary-list">
      {occupants.map((occupant) => (
        <li key={occupant.key}>
          <span>{occupant.roleLabel}</span>
          <strong>{occupant.nickname}</strong>
          <small>{occupant.fullName}</small>
        </li>
      ))}
    </ol>
  );
}

function moneyFrom(value: unknown): MoneyDto | undefined {
  if (!isRecord(value) || typeof value.currency !== "string" || typeof value.minorUnits !== "number") return undefined;
  return { currency: value.currency, minorUnits: value.minorUnits };
}

const membershipBusinessCommands = new Set<CommandType>([
  "CREATE_MEMBERSHIP_ORDER",
  "RECORD_MEMBERSHIP_PAYMENT",
  "CORRECT_MEMBERSHIP_PAYMENT",
  "ACTIVATE_MEMBERSHIP_ORDER",
  "CORRECT_MEMBER_ENTITLEMENT_BALANCE"
]);

function membershipCommandLabel(commandType: CommandType): string {
  if (commandType === "CREATE_MEMBERSHIP_ORDER") return "创建会员订单";
  if (commandType === "RECORD_MEMBERSHIP_PAYMENT") return "登记企微收款";
  if (commandType === "CORRECT_MEMBERSHIP_PAYMENT") return "更正企微收款";
  if (commandType === "ACTIVATE_MEMBERSHIP_ORDER") return "生效会员订单";
  if (commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") return "更正会员余额";
  return "会员操作";
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function guestNicknameLabel(snapshot: Record<string, unknown>): string {
  const nickname = snapshot.nickname;
  return typeof nickname === "string" && nickname.trim() ? nickname : "历史未记录";
}

const bookingChannelLabels: Record<string, string> = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
};

function pricingFromEffect(effect: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(effect.pricing)) return effect.pricing;
  if (isRecord(effect.after) && isRecord(effect.after.pricing)) return effect.after.pricing;
  return undefined;
}

function localDateNightCount(arrivalDate: unknown, departureDate: unknown): number | undefined {
  if (typeof arrivalDate !== "string" || typeof departureDate !== "string") return undefined;
  const arrival = Date.parse(`${arrivalDate}T00:00:00Z`);
  const departure = Date.parse(`${departureDate}T00:00:00Z`);
  if (!Number.isFinite(arrival) || !Number.isFinite(departure) || departure <= arrival) return undefined;
  return Math.round((departure - arrival) / 86_400_000);
}

export function receiptTransactionReferenceLabel(result: Record<string, unknown>): string {
  if (result.factType === "REVERSAL") return "不适用";
  return typeof result.transactionReference === "string" ? result.transactionReference : "历史未记录";
}

function EffectSummary({ preview }: { preview: PreviewDto }) {
  const effect = preview.effect;
  const before = isRecord(effect.before) ? effect.before : undefined;
  const after = isRecord(effect.after) ? effect.after : undefined;
  const pricing = pricingFromEffect(effect);
  const inventoryUnit = isRecord(effect.inventoryUnit) ? effect.inventoryUnit : undefined;
  const fromUnit = isRecord(effect.fromInventoryUnit) ? effect.fromInventoryUnit : undefined;
  const toUnit = isRecord(effect.toInventoryUnit) ? effect.toInventoryUnit : undefined;
  const guest = isRecord(effect.primaryGuest) ? effect.primaryGuest : undefined;
  const occupants = occupantSummaryItems(effect.occupants);
  const member = isRecord(effect.member) ? effect.member : undefined;
  const submittedProfile = isRecord(effect.submittedProfile) ? effect.submittedProfile : undefined;
  const memberContract = isRecord(effect.contract) ? effect.contract : undefined;
  const externalReference = isRecord(effect.externalReference) ? effect.externalReference : undefined;
  const entitlementTransition = isRecord(effect.entitlementTransition) ? effect.entitlementTransition : undefined;
  const policyBaseAmount = moneyFrom(effect.policyBaseAmount);
  const targetCurrentContractAmount = moneyFrom(effect.targetCurrentContractAmount);
  const manualAdjustmentMinor = typeof effect.manualAdjustmentMinor === "number" ? effect.manualAdjustmentMinor : undefined;
  const coverage = pricing && Array.isArray(pricing.coverageSet) ? pricing.coverageSet : [];
  const cashLines = pricing && Array.isArray(pricing.cashLines) ? pricing.cashLines : [];
  const hasBookingChannel = Object.hasOwn(effect, "bookingChannelCode");
  const bookingChannelCode = typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : null;
  const channelOrderReference = typeof effect.channelOrderReference === "string" ? effect.channelOrderReference : null;
  const hasTransactionReference = Object.hasOwn(effect, "transactionReference");

  if (preview.commandType === "CREATE_MEMBER" && member) {
    return <div className="effect-summary member-create-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="member-create-summary-heading">
        <h3 id="member-create-summary-heading">请核对会员资料</h3>
        <dl className="difference-grid">
          <dt>姓名</dt><dd>{scalar(member.fullName)}</dd>
          <dt>身份证号</dt><dd>{scalar(member.identityCardNumber)}</dd>
          <dt>手机号</dt><dd>{scalar(member.phone)}</dd>
          <dt>微信号</dt><dd>{scalar(member.wechat)}</dd>
        </dl>
        <p className="muted compact">确认后只创建会员档案并加入当前门店，不创建会员订单或权益。</p>
      </section>
    </div>;
  }

  if (membershipBusinessCommands.has(preview.commandType)) {
    const product = isRecord(effect.product) ? effect.product : undefined;
    const membershipPricing = isRecord(effect.pricing) ? effect.pricing : undefined;
    const payment = isRecord(effect.payment) ? effect.payment : undefined;
    const original = isRecord(effect.original) ? effect.original : undefined;
    const replacement = isRecord(effect.replacement) ? effect.replacement : undefined;
    const totals = isRecord(effect.totals) ? effect.totals : undefined;
    return <div className="effect-summary membership-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="membership-command-summary-heading">
        <h3 id="membership-command-summary-heading">请核对{membershipCommandLabel(preview.commandType)}</h3>
        <dl className="difference-grid">
          {member ? <><dt>会员</dt><dd>{scalar(member.fullName)}</dd></> : null}
          {typeof effect.memberName === "string" ? <><dt>会员</dt><dd>{effect.memberName}</dd></> : null}
          {product ? <>
            <dt>会员产品</dt><dd>{scalar(product.name)}</dd>
            <dt>发放权益</dt><dd>{scalar(product.entitlementUnits)} {product.entitlementUnitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</dd>
            <dt>适用范围</dt><dd>{product.allowedInventoryKind === "ROOM" ? "指定房型的独立房间" : "指定房型的单床"}</dd>
          </> : null}
          {typeof effect.productName === "string" ? <><dt>会员产品</dt><dd>{effect.productName}</dd></> : null}
          {membershipPricing ? <>
            <dt>标价</dt><dd>{formatMoney(moneyFrom(membershipPricing.listedPrice))}</dd>
            <dt>成交价</dt><dd><strong>{formatMoney(moneyFrom(membershipPricing.agreedPrice))}</strong></dd>
            <dt>调价差额</dt><dd>{formatMoney(moneyFrom(membershipPricing.adjustment))}</dd>
            {membershipPricing.adjustmentReason ? <><dt>调价原因</dt><dd>{scalar(membershipPricing.adjustmentReason)}</dd></> : null}
          </> : null}
          {payment ? <><dt>本次收款</dt><dd>{formatMoney(moneyFrom(payment.amount))}</dd><dt>企微交易单号</dt><dd>{scalar(payment.transactionReference)}</dd></> : null}
          {original && replacement ? <>
            <dt>原收款</dt><dd>{formatMoney(moneyFrom(original.amount))} · {scalar(original.transactionReference)}</dd>
            <dt>更正后收款</dt><dd>{formatMoney(moneyFrom(replacement.amount))} · {scalar(replacement.transactionReference)}</dd>
          </> : null}
          {totals ? <>
            <dt>更正/登记前有效收款</dt><dd>{formatMoney(moneyFrom(totals.before))}</dd>
            <dt>操作后有效收款</dt><dd><strong>{formatMoney(moneyFrom(totals.after))}</strong></dd>
            <dt>操作后与成交价差额</dt><dd>{formatMoney(moneyFrom(totals.differenceAfter))}</dd>
          </> : null}
          {moneyFrom(effect.paymentTotal) ? <><dt>有效企微收款合计</dt><dd><strong>{formatMoney(moneyFrom(effect.paymentTotal))}</strong></dd></> : null}
          {moneyFrom(effect.agreedPrice) ? <><dt>成交价</dt><dd>{formatMoney(moneyFrom(effect.agreedPrice))}</dd></> : null}
          {moneyFrom(effect.paymentDifference) ? <><dt>收款与成交价差额</dt><dd>{formatMoney(moneyFrom(effect.paymentDifference))}</dd></> : null}
          {typeof effect.validFrom === "string" && typeof effect.validUntil === "string" ? <><dt>有效期</dt><dd>{formatDate(effect.validFrom)} 至 {formatDate(effect.validUntil)}</dd></> : null}
          {typeof effect.entitlementUnits === "number" ? <><dt>生效发放</dt><dd>{effect.entitlementUnits} {effect.entitlementUnitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</dd></> : null}
          {preview.commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE" ? <>
            <dt>当前可用余额</dt><dd>{scalar(effect.availableBefore)} {effect.unitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</dd>
            <dt>更正后可用余额</dt><dd><strong>{scalar(effect.availableAfter)} {effect.unitKind === "ROOM_NIGHT" ? "间夜" : "床夜"}</strong></dd>
            <dt>本次变动</dt><dd>{typeof effect.quantityDelta === "number" && effect.quantityDelta > 0 ? "+" : ""}{scalar(effect.quantityDelta)}</dd>
            <dt>更正原因</dt><dd>{scalar(effect.adjustmentReason)}</dd>
          </> : null}
        </dl>
        {preview.commandType === "ACTIVATE_MEMBERSHIP_ORDER" ? <p className="muted compact">收款差额只作提示。确认生效不会自动改价，也不代表支付平台已对账或结清。</p> : null}
        {preview.commandType === "CORRECT_MEMBERSHIP_PAYMENT" ? <p className="muted compact">确认后保留原收款，追加一笔冲销和一笔更正后收款。</p> : null}
      </section>
    </div>;
  }

  if (preview.commandType === "CREATE_ORDER" && (typeof effect.memberId === "string" || typeof effect.memberContractId === "string")) {
    const totalNights = localDateNightCount(effect.arrivalDate, effect.departureDate);
    const coveredNights = coverage.length;
    const uncoveredNights = totalNights === undefined ? undefined : Math.max(0, totalNights - coveredNights);
    return <div className="effect-summary membership-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="member-stay-summary-heading">
        <h3 id="member-stay-summary-heading">请核对会员住宿</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {inventoryUnit ? <><dt>住宿位置</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>住宿日期</dt><dd>{formatDate(effect.arrivalDate)} 至 {formatDate(effect.departureDate)}</dd></> : null}
          {totalNights !== undefined ? <><dt>总住宿晚数</dt><dd>{totalNights} 晚</dd></> : null}
          <dt>会员权益覆盖</dt><dd>{coveredNights} 晚</dd>
          {uncoveredNights !== undefined ? <><dt>未覆盖晚数</dt><dd>{uncoveredNights} 晚</dd></> : null}
          <dt>未覆盖金额</dt><dd><strong>{formatMoney(pricing ? moneyFrom(pricing.cashRemainder) : undefined)}</strong></dd>
        </dl>
        <p className="muted compact">确认后创建会员住宿订单，并按本次核对结果冻结可用会员权益。</p>
      </section>
    </div>;
  }

  return (
    <div className="effect-summary" data-testid="command-effect">
      <div className="preview-meta">
        <span><Clock3 aria-hidden="true" size={15} />有效至 {formatDateTime(preview.expiresAt)}</span>
        <code title={preview.effectHash}>{preview.effectHash.slice(0, 12)}...</code>
      </div>

      <section className="effect-section" aria-labelledby="effect-difference-heading">
        <h3 id="effect-difference-heading">服务端变更差异</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {member ? <><dt>会员档案动作</dt><dd>{scalar(effect.operation)}</dd><dt>会员姓名 / 身份证</dt><dd>{scalar(member.fullName)} · <code>{scalar(member.identityCardNumber)}</code></dd><dt>手机号 / 微信号</dt><dd>{scalar(member.phone)} · {scalar(member.wechat)}</dd></> : null}
          {submittedProfile && effect.profileMatch === false ? <><dt>申请资料差异</dt><dd>申请资料与现有档案不一致；本命令保留现有档案，仅关联申请记录。</dd></> : null}
          {memberContract ? <><dt>会员合同动作</dt><dd>{scalar(memberContract.operation)}</dd><dt>合同周期</dt><dd>{scalar(memberContract.validFrom)} 至 {scalar(memberContract.validUntil)}</dd></> : null}
          {externalReference ? <><dt>外部申请关联</dt><dd>{scalar(externalReference.operation)} · {scalar(externalReference.provider)} · <code>{scalar(externalReference.externalRecordId)}</code></dd></> : null}
          {hasBookingChannel ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd></> : null}
          {hasBookingChannel ? <><dt>渠道订单号</dt><dd>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</dd></> : null}
          {inventoryUnit ? <><dt>库存单元</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>生效区间</dt><dd><code>[{effect.arrivalDate}, {effect.departureDate})</code></dd></> : null}
          {typeof effect.serviceDate === "string" ? <><dt>营业日期</dt><dd>{effect.serviceDate}</dd></> : null}
          {typeof effect.reason === "string" ? <><dt>业务原因</dt><dd>{effect.reason}</dd></> : null}
          {typeof effect.internalUseBlockId === "string" ? <><dt>内部占用 Block</dt><dd><code>{effect.internalUseBlockId}</code></dd></> : null}
          {typeof effect.cleaningTaskId === "string" ? <><dt>清洁任务</dt><dd><code>{effect.cleaningTaskId}</code></dd></> : null}
          {fromUnit && toUnit ? <><dt>换房</dt><dd>{scalar(fromUnit.code)} <ChevronRight aria-label="变更为" size={15} /> {scalar(toUnit.code)}</dd></> : null}
          {before ? Object.entries(before).map(([key, value]) => (
            <div className="difference-row" key={`before-${key}`}>
              <dt>{key}</dt><dd><span className="before-value">{moneyFrom(value) ? formatMoney(moneyFrom(value)) : scalar(value)}</span></dd>
            </div>
          )) : null}
          {after ? Object.entries(after).filter(([key]) => key !== "pricing").map(([key, value]) => (
            <div className="difference-row" key={`after-${key}`}>
              <dt>{key}（变更后）</dt><dd><span className="after-value">{moneyFrom(value) ? formatMoney(moneyFrom(value)) : scalar(value)}</span></dd>
            </div>
          )) : null}
          {typeof effect.amountMinor === "number" && typeof effect.currency === "string" ? <><dt>事实金额</dt><dd>{formatMoney({ currency: effect.currency, minorUnits: effect.amountMinor })}</dd></> : null}
          {hasTransactionReference ? <><dt>外部交易单号</dt><dd>{typeof effect.transactionReference === "string" ? effect.transactionReference : "历史未记录"}</dd></> : null}
          {typeof effect.fromStatus === "string" && typeof effect.toStatus === "string" ? <><dt>状态</dt><dd>{effect.fromStatus} <ChevronRight aria-label="变更为" size={15} /> {effect.toStatus}</dd></> : null}
          {entitlementTransition ? <><dt>权益状态变化</dt><dd>{scalar(entitlementTransition.from)} <ChevronRight aria-label="变更为" size={15} /> {scalar(entitlementTransition.to)} · {scalar(entitlementTransition.coverageCount)} 晚</dd></> : null}
          {policyBaseAmount ? <><dt>政策基础报价</dt><dd data-testid="preview-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>指定最终总价</dt><dd data-testid="preview-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
          {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>人工调价差额</dt><dd data-testid="preview-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
          {!before && !after && !guest && !inventoryUnit && !fromUnit && typeof effect.amountMinor !== "number" && typeof effect.fromStatus !== "string"
            ? <><dt>命令</dt><dd>{preview.commandType}</dd></> : null}
        </dl>
      </section>

      {pricing ? (
        <section className="effect-section" aria-labelledby="effect-pricing-heading">
          <h3 id="effect-pricing-heading">计价结果</h3>
          <div className="preview-amounts">
            <div><span>coverageSet</span><strong>{coverage.length} 晚</strong></div>
            <div><span>cashRemainder</span><strong>{formatMoney(moneyFrom(pricing.cashRemainder))}</strong></div>
            <div><span>currentContractAmount</span><strong>{formatMoney(moneyFrom(pricing.currentContractAmount))}</strong></div>
          </div>
          {cashLines.length ? <p className="muted compact">现金计价行：{cashLines.length}</p> : null}
        </section>
      ) : null}

      <details className="raw-details">
        <summary>完整 effect</summary>
        <pre>{JSON.stringify(effect, null, 2)}</pre>
      </details>
    </div>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function lodgingReceiptCopy(committed: boolean, memberStay: boolean): { heading: string; description: string } {
  if (memberStay) {
    return committed
      ? { heading: "会员住宿订单已创建", description: "住宿日期、库存和会员权益覆盖已按核对结果记录。" }
      : { heading: "会员住宿订单未创建", description: "本次操作没有写入住宿订单或会员权益变动。" };
  }
  return committed
    ? { heading: "住宿订单已创建", description: "住宿日期、库存和住宿人名单已按核对结果记录。" }
    : { heading: "住宿订单未创建", description: "本次操作没有写入住宿订单。" };
}

function ReceiptPanel({ receipt, onNavigateToResource, businessCommand, commandType, memberStay = false }: {
  receipt: ReceiptDto;
  onNavigateToResource?: () => void;
  businessCommand?: CommandType;
  commandType?: CommandType;
  memberStay?: boolean;
}) {
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  const orderId = result && typeof result.orderId === "string" ? result.orderId : undefined;
  const primaryGuest = result && isRecord(result.primaryGuest) ? result.primaryGuest : undefined;
  const occupants = occupantSummaryItems(result?.occupants);
  const hasBookingChannel = Boolean(result && Object.hasOwn(result, "bookingChannelCode"));
  const bookingChannelCode = result && typeof result.bookingChannelCode === "string" ? result.bookingChannelCode : null;
  const channelOrderReference = result && typeof result.channelOrderReference === "string" ? result.channelOrderReference : null;
  const hasTransactionReference = Boolean(result && Object.hasOwn(result, "transactionReference"));
  const memberId = result && typeof result.memberId === "string" ? result.memberId : undefined;
  const memberContractId = result && typeof result.memberContractId === "string" ? result.memberContractId : undefined;
  const memberExternalReferenceId = result && typeof result.memberExternalReferenceId === "string" ? result.memberExternalReferenceId : undefined;
  const policyBaseAmount = result ? moneyFrom(result.policyBaseAmount) : undefined;
  const targetCurrentContractAmount = result ? moneyFrom(result.targetCurrentContractAmount) : undefined;
  const manualAdjustmentMinor = result && typeof result.manualAdjustmentMinor === "number" ? result.manualAdjustmentMinor : undefined;
  const committed = receipt.businessCommitted;
  if (businessCommand === "CREATE_MEMBER") {
    const memberErrorMessage = receipt.error?.code === "PREVIEW_STALE"
      ? "会员资料已发生变化，请关闭后重新核对。"
      : receipt.error?.code === "VALIDATION_ERROR"
        ? receipt.error.message
        : receipt.error
          ? "会员档案未创建，请稍后重新核对。"
          : undefined;
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "会员档案已创建" : "会员档案未创建"}</h3>
          <p>{committed ? "新会员已加入当前门店的会员列表。" : "本次操作没有写入会员资料。"}</p>
        </div>
      </div>
      {memberErrorMessage ? <div className="receipt-error"><p>{memberErrorMessage}</p></div> : null}
    </section>;
  }
  if (businessCommand && membershipBusinessCommands.has(businessCommand)) {
    const label = membershipCommandLabel(businessCommand);
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? `${label}已完成` : `${label}未完成`}</h3>
          <p>{committed
            ? businessCommand === "ACTIVATE_MEMBERSHIP_ORDER"
              ? "会员订单已生效，有效期和 30 夜权益已经生成。"
              : businessCommand === "CORRECT_MEMBER_ENTITLEMENT_BALANCE"
                ? "会员可住宿余额和权益变动历史已经更新。"
                : "会员订单页面已更新。"
            : "本次操作没有写入会员订单或收款事实。"}</p>
        </div>
      </div>
      {receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
    </section>;
  }
  if (memberStay || commandType === "CREATE_ORDER") {
    const copy = lodgingReceiptCopy(committed, memberStay);
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{copy.heading}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
      {receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
      {occupants.length && committed ? <div className="receipt-occupants"><strong>{occupants.length} 位住宿人</strong><OccupantSummary value={result?.occupants} /></div> : null}
      {orderId && committed ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>;
  }
  return (
    <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "业务写入已提交" : "业务写入未提交"}</h3>
          <p>{receipt.executionStatus}</p>
        </div>
      </div>
      {receipt.error ? <div className="receipt-error"><strong>{receipt.error.code}</strong><p>{receipt.error.message}</p></div> : null}
      <dl className="receipt-grid">
        <dt>Receipt ID</dt><dd><code>{receipt.receiptId || "-"}</code>{receipt.receiptId ? <button type="button" className="copy-button" onClick={() => copyText(receipt.receiptId)} aria-label="复制 Receipt ID" title="复制"><Copy size={14} /></button> : null}</dd>
        <dt>Command ID</dt><dd><code>{receipt.commandId || "-"}</code></dd>
        <dt>Correlation ID</dt><dd><code>{receipt.correlationId || "-"}</code></dd>
        <dt>资源引用</dt><dd className="code-list">{receipt.resourceRefs.length ? receipt.resourceRefs.map((ref) => <code key={ref}>{ref}</code>) : "-"}</dd>
        <dt>事实引用</dt><dd className="code-list">{receipt.factRefs.length ? receipt.factRefs.map((ref) => <code key={ref}>{ref}</code>) : "-"}</dd>
        {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={result?.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : primaryGuest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(primaryGuest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(primaryGuest.fullName)}</dd></> : null}
        {hasBookingChannel ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd><dt>渠道订单号</dt><dd><code>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</code></dd></> : null}
        {hasTransactionReference && result ? <><dt>外部交易单号</dt><dd><code>{receiptTransactionReferenceLabel(result)}</code></dd></> : null}
        {memberId ? <><dt>Member ID</dt><dd><code>{memberId}</code></dd><dt>Member Contract ID</dt><dd><code>{memberContractId ?? "未选择"}</code></dd><dt>外部申请引用</dt><dd><code>{memberExternalReferenceId ?? "未关联"}</code></dd></> : null}
        {policyBaseAmount ? <><dt>政策基础报价</dt><dd data-testid="receipt-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
        {targetCurrentContractAmount ? <><dt>指定最终总价</dt><dd data-testid="receipt-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
        {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>人工调价差额</dt><dd data-testid="receipt-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
      </dl>
      {orderId ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>
  );
}

interface CommandDialogProps {
  request: CommandRequest;
  onClose: () => void;
  onCommitted?: (receipt: ReceiptDto) => void;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
  initialReceipt?: ReceiptDto;
  writeBlocked?: boolean;
  writeBlockedReason?: string;
  onProgress?: (progress: CommandDialogProgress) => boolean | void;
}

export type CommandDialogProgress =
  | { state: "PREVIEWING"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_UNKNOWN"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_FAILED"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEWED"; previewId: string; previewMetadata: ClientCommandMetadata }
  | { state: "CONFIRMING"; previewId: string; confirmationKey: string }
  | { state: "FAILED_NOT_EXECUTED"; confirmationKey: string }
  | { state: "UNKNOWN"; confirmationKey: string }
  | { state: "RESOLVED"; confirmationKey: string; receipt: ReceiptDto };

export type PersistedCommandRecoveryState = "CONFIRMING" | "UNKNOWN" | "EXECUTED" | "NOT_EXECUTED";

export interface PersistedCommandRecovery {
  version: 1;
  subjectId: string;
  scopeId: string;
  propertyId: string;
  commandType: HistoricalCommandType;
  confirmationKey: string;
  targetRefs: string[];
  presentation?: "MEMBER_STAY";
  state: PersistedCommandRecoveryState;
  receipt?: ReceiptDto;
  updatedAt: string;
}

export interface CommandRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CommandRecoveryReadResult =
  | { kind: "ABSENT" }
  | { kind: "VALID"; recovery: PersistedCommandRecovery }
  | { kind: "CORRUPT"; error: Error }
  | { kind: "READ_ERROR"; error: Error };

export interface CommandRecoveryContext {
  subjectId: string;
  scopeId: string;
  request: CommandRequest;
}

const COMMAND_RECOVERY_STORAGE_PREFIX = "qintopia.command-recovery.v1";
const persistableCommandTypes = new Set<CommandType>(commandTypes.filter((commandType) => (
  commandType !== "ISSUE_TOKEN" && commandType !== "ROTATE_TOKEN" && commandType !== "REVOKE_TOKEN"
)));
const readableRecoveryCommandTypes = new Set<HistoricalCommandType>([
  ...persistableCommandTypes,
  "PLACE_INTERNAL_USE",
  "RELEASE_INTERNAL_USE"
]);
const recoveryReferenceKeys = [
  "orderId",
  "memberId",
  "memberContractId",
  "inventoryUnitId",
  "maintenanceLockId",
  "internalUseBlockId",
  "cleaningTaskId",
  "entitlementLotId",
  "quoteId"
] as const;

function recoveryTargetRefs(input: Record<string, unknown>): string[] {
  return recoveryReferenceKeys.flatMap((key) => {
    const value = input[key];
    return typeof value === "string" && value ? [`${key}=${value}`] : [];
  });
}

function isPersistableCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && persistableCommandTypes.has(value as CommandType);
}

function isReadableRecoveryCommandType(value: unknown): value is HistoricalCommandType {
  return typeof value === "string" && readableRecoveryCommandTypes.has(value as HistoricalCommandType);
}

export function isTerminalCommandRecovery(value: PersistedCommandRecoveryState): value is "EXECUTED" | "NOT_EXECUTED" {
  return value === "EXECUTED" || value === "NOT_EXECUTED";
}

function isTerminalReceipt(value: unknown): value is ReceiptDto {
  if (!isRecord(value)) return false;
  return (value.executionStatus === "EXECUTED" || value.executionStatus === "NOT_EXECUTED")
    && typeof value.businessCommitted === "boolean"
    && typeof value.receiptId === "string"
    && typeof value.commandId === "string"
    && typeof value.correlationId === "string"
    && Array.isArray(value.resourceRefs)
    && value.resourceRefs.every((item) => typeof item === "string")
    && Array.isArray(value.factRefs)
    && value.factRefs.every((item) => typeof item === "string");
}

function browserSessionStorage(): { kind: "AVAILABLE"; storage: CommandRecoveryStorage } | { kind: "READ_ERROR"; error: Error } {
  if (typeof window === "undefined") return { kind: "READ_ERROR", error: new Error("浏览器 sessionStorage 不可用") };
  try {
    return { kind: "AVAILABLE", storage: window.sessionStorage };
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法访问本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
}

export function commandRecoveryStorageKey(subjectId: string, scopeId: string): string {
  return `${COMMAND_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(scopeId)}`;
}

export function readPersistedCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, scopeId: string): CommandRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(commandRecoveryStorageKey(subjectId, scopeId));
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法读取本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
  if (serialized === null) return { kind: "ABSENT" };

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录已损坏；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  if (!isRecord(value)
    || value.version !== 1
    || value.subjectId !== subjectId
    || value.scopeId !== scopeId
    || typeof value.propertyId !== "string"
    || !value.propertyId
    || !isReadableRecoveryCommandType(value.commandType)
    || typeof value.confirmationKey !== "string"
    || !value.confirmationKey
    || !Array.isArray(value.targetRefs)
    || !value.targetRefs.every((item) => typeof item === "string")
    || (value.presentation !== undefined && value.presentation !== "MEMBER_STAY")
    || (value.state !== "CONFIRMING" && value.state !== "UNKNOWN" && value.state !== "EXECUTED" && value.state !== "NOT_EXECUTED")
    || typeof value.updatedAt !== "string") {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录版本或结构无效；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  const state = value.state;
  if ((isTerminalCommandRecovery(state) && !isTerminalReceipt(value.receipt))
    || (!isTerminalCommandRecovery(state) && value.receipt !== undefined)) {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录的执行状态与 Receipt 不一致；已暂停本物业写命令") };
  }
  return { kind: "VALID", recovery: value as unknown as PersistedCommandRecovery };
}

export function savePersistedCommandRecovery(storage: CommandRecoveryStorage, recovery: PersistedCommandRecovery): boolean {
  try {
    storage.setItem(commandRecoveryStorageKey(recovery.subjectId, recovery.scopeId), JSON.stringify(recovery));
    return true;
  } catch {
    return false;
  }
}

export function clearPersistedCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, scopeId: string): boolean {
  try {
    storage.removeItem(commandRecoveryStorageKey(subjectId, scopeId));
    return true;
  } catch {
    return false;
  }
}

export function transitionPersistedCommandRecovery(
  current: PersistedCommandRecovery | undefined,
  context: CommandRecoveryContext,
  progress: CommandDialogProgress,
  updatedAt = new Date().toISOString()
): { accepted: boolean; recovery: PersistedCommandRecovery | undefined } {
  if (progress.state !== "CONFIRMING" && progress.state !== "FAILED_NOT_EXECUTED" && progress.state !== "UNKNOWN" && progress.state !== "RESOLVED") {
    return { accepted: true, recovery: current };
  }
  if (progress.state === "CONFIRMING") {
    const propertyId = context.request.input.propertyId;
    if (!isPersistableCommandType(context.request.commandType) || typeof propertyId !== "string" || !propertyId) {
      return { accepted: false, recovery: current };
    }
    if (current && current.confirmationKey !== progress.confirmationKey) return { accepted: false, recovery: current };
    if (current && isTerminalCommandRecovery(current.state)) return { accepted: false, recovery: current };
    return {
      accepted: true,
      recovery: current ?? {
        version: 1,
        subjectId: context.subjectId,
        scopeId: context.scopeId,
        propertyId,
        commandType: context.request.commandType,
        confirmationKey: progress.confirmationKey,
        targetRefs: recoveryTargetRefs(context.request.input),
        ...(context.request.presentation ? { presentation: context.request.presentation } : {}),
        state: "CONFIRMING",
        updatedAt
      }
    };
  }
  if (progress.state === "FAILED_NOT_EXECUTED") {
    if (!current || current.confirmationKey !== progress.confirmationKey || isTerminalCommandRecovery(current.state)) {
      return { accepted: true, recovery: current };
    }
    return { accepted: true, recovery: undefined };
  }
  if (!current || current.confirmationKey !== progress.confirmationKey || isTerminalCommandRecovery(current.state)) {
    return { accepted: true, recovery: current };
  }
  if (progress.state === "UNKNOWN" || progress.receipt.executionStatus === "UNKNOWN") {
    return { accepted: true, recovery: { ...current, state: "UNKNOWN", updatedAt } };
  }
  return {
    accepted: true,
    recovery: { ...current, state: progress.receipt.executionStatus, receipt: progress.receipt, updatedAt }
  };
}

export function recoveryCommandRequest(recovery: PersistedCommandRecovery): CommandRequest {
  const memberStay = recovery.presentation === "MEMBER_STAY";
  return {
    commandType: recovery.commandType,
    title: memberStay ? "恢复会员住宿结果" : `${recovery.commandType} · 原命令恢复`,
    description: memberStay ? "系统只查询原住宿办理结果，不会重复创建订单或冻结会员权益。" : "仅使用已保存的原幂等键查询服务端命令结果，不会发起新的业务写入。",
    ...(recovery.presentation ? { presentation: recovery.presentation } : {}),
    input: { propertyId: recovery.propertyId }
  };
}

export function usePersistentCommandRecovery({ subjectId, scopeId }: { subjectId: string; scopeId: string }) {
  const storageScope = commandRecoveryStorageKey(subjectId, scopeId);
  const activeStorageScopeRef = useRef(storageScope);
  activeStorageScopeRef.current = storageScope;
  const [snapshot, setSnapshot] = useState<{ storageScope: string; read: CommandRecoveryReadResult }>(() => {
    const access = browserSessionStorage();
    const read = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readPersistedCommandRecovery(access.storage, subjectId, scopeId)
        : access;
    return { storageScope, read };
  });

  function setActiveSnapshot(read: CommandRecoveryReadResult): void {
    if (activeStorageScopeRef.current === storageScope) setSnapshot({ storageScope, read });
  }

  useEffect(() => {
    const access = browserSessionStorage();
    const read = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readPersistedCommandRecovery(access.storage, subjectId, scopeId)
        : access;
    setActiveSnapshot(read);
  }, [scopeId, storageScope, subjectId]);

  const ready = snapshot.storageScope === storageScope;
  const read = ready ? snapshot.read : { kind: "READ_ERROR", error: new Error("正在核对本地命令恢复记录") } as const;
  const pending = read.kind === "VALID" ? read.recovery : undefined;
  const error = read.kind === "CORRUPT" || read.kind === "READ_ERROR" ? read.error : undefined;
  const blocked = !ready || read.kind !== "ABSENT";

  function track(request: CommandRequest, progress: CommandDialogProgress): boolean {
    if (progress.state !== "CONFIRMING" && progress.state !== "FAILED_NOT_EXECUTED" && progress.state !== "UNKNOWN" && progress.state !== "RESOLVED") return true;
    const access = browserSessionStorage();
    if (access.kind === "READ_ERROR" || !scopeId) {
      setActiveSnapshot(access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") });
      return false;
    }
    const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
    if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") {
      setActiveSnapshot(currentRead);
      return false;
    }
    const current = currentRead.kind === "VALID" ? currentRead.recovery : undefined;
    const transition = transitionPersistedCommandRecovery(current, { subjectId, scopeId, request }, progress);
    if (!transition.accepted) return false;
    if (progress.state === "FAILED_NOT_EXECUTED" && current && transition.recovery === undefined) {
      if (!clearPersistedCommandRecovery(access.storage, subjectId, scopeId)) {
        setActiveSnapshot({ kind: "READ_ERROR", error: new Error("命令已明确未执行，但无法清除本地恢复记录；写入口继续暂停") });
        return false;
      }
      setActiveSnapshot({ kind: "ABSENT" });
      return true;
    }
    if (transition.recovery && transition.recovery !== current) {
      if (!savePersistedCommandRecovery(access.storage, transition.recovery)) {
        setActiveSnapshot({ kind: "READ_ERROR", error: new Error("无法保存本地命令恢复记录；命令尚未发送，写入口已暂停") });
        return false;
      }
      setActiveSnapshot({ kind: "VALID", recovery: transition.recovery });
    } else if (transition.recovery) {
      setActiveSnapshot({ kind: "VALID", recovery: transition.recovery });
    } else {
      setActiveSnapshot(currentRead);
    }
    return true;
  }

  function clearResolved(): boolean {
    const access = browserSessionStorage();
    if (access.kind === "READ_ERROR" || !scopeId) {
      setActiveSnapshot(access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") });
      return false;
    }
    const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
    if (currentRead.kind !== "VALID" || !isTerminalCommandRecovery(currentRead.recovery.state)) {
      if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") setActiveSnapshot(currentRead);
      return false;
    }
    if (!clearPersistedCommandRecovery(access.storage, subjectId, scopeId)) {
      setActiveSnapshot({ kind: "READ_ERROR", error: new Error("无法清除已收口的本地命令恢复记录；写入口继续暂停") });
      return false;
    }
    setActiveSnapshot({ kind: "ABSENT" });
    return true;
  }

  return { ready, pending, error, blocked, track, clearResolved };
}

export function CommandRecoveryBar({ recovery, onOpen, testId = "command-recovery", businessFacing = false }: {
  recovery: PersistedCommandRecovery;
  onOpen: () => void;
  testId?: string;
  businessFacing?: boolean;
}) {
  const resolved = isTerminalCommandRecovery(recovery.state);
  const memberStay = recovery.presentation === "MEMBER_STAY";
  const businessMode = businessFacing || memberStay;
  const memberRegistration = businessMode && recovery.commandType === "CREATE_MEMBER";
  return (
    <section className="recovery-bar" role="status" aria-live="polite" aria-label={memberRegistration ? "待恢复会员建档" : memberStay ? "待恢复会员住宿" : businessMode ? "待恢复会员操作" : "待恢复命令"} data-testid={testId}>
      <div>
        <strong>{businessMode
          ? memberRegistration
            ? (resolved ? "原建档结果已确认" : "会员建档结果需要恢复查询")
            : memberStay
              ? (resolved ? "原会员住宿结果已确认" : "会员住宿结果需要恢复查询")
              : (resolved ? "原会员操作结果已确认" : "会员操作结果需要恢复查询")
          : (resolved ? "原命令结果已确认" : "原命令执行状态需要恢复查询")}</strong>
        {!businessMode ? <>
          <p><code>{recovery.commandType}</code> · {recovery.state} · Property <code>{recovery.propertyId}</code></p>
          {recovery.targetRefs.length ? <p>业务目标 {recovery.targetRefs.map((reference) => <code key={reference}>{reference}</code>)}</p> : null}
          <p>原幂等键 <code>{recovery.confirmationKey}</code></p>
          {recovery.receipt ? <p>Command <code>{recovery.receipt.commandId || "-"}</code> · Receipt <code>{recovery.receipt.receiptId || "-"}</code></p> : null}
        </> : null}
        <p>{businessMode
          ? memberRegistration
            ? (resolved ? "查看并关闭原建档结果后，可继续新建会员。" : "新的会员建档已暂停，请先恢复查询原结果。")
            : memberStay
              ? (resolved ? "查看并关闭原住宿结果后，可继续办理住宿。" : "新的会员住宿已暂停，请先恢复查询原结果。")
              : (resolved ? "查看并关闭原操作结果后，可继续处理会员业务。" : "新的会员操作已暂停，请先恢复查询原结果。")
          : (resolved ? "查看并关闭 Receipt 后恢复新的业务写入。" : "新的业务写入已暂停，必须继续查询原命令。")}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen} data-testid={`${testId}-open`}>
        <RefreshCw aria-hidden="true" size={17} />{businessMode
          ? memberRegistration
            ? (resolved ? "查看建档结果" : "恢复建档结果")
            : memberStay
              ? (resolved ? "查看住宿结果" : "恢复住宿结果")
              : (resolved ? "查看会员操作结果" : "恢复会员操作结果")
          : (resolved ? "查看已确认结果" : "恢复原命令")}
      </button>
    </section>
  );
}

function displayCommandInput(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.tokenSecret !== "string") return input;
  return { ...input, tokenSecret: "[client-held secret]" };
}

export function CommandDialog({
  request,
  onClose,
  onCommitted,
  initialPreviewMetadata,
  initialConfirmationKey,
  initialReceipt,
  writeBlocked = false,
  writeBlockedReason = "当前事实不再满足安全写入条件。请关闭后刷新并重新生成 Preview。",
  onProgress
}: CommandDialogProps) {
  const [preview, setPreview] = useState<PreviewDto>();
  const [receipt, setReceipt] = useState<ReceiptDto | undefined>(initialReceipt);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const executableCommandType = isExecutableCommandType(request.commandType) ? request.commandType : undefined;
  const memberProfile = request.commandType === "CREATE_MEMBER";
  const membershipBusiness = Boolean(executableCommandType && membershipBusinessCommands.has(executableCommandType));
  const memberLodging = request.commandType === "CREATE_ORDER" && request.presentation === "MEMBER_STAY";
  const businessFacing = memberProfile || membershipBusiness || memberLodging;
  const [reasonCode, setReasonCode] = useState(request.initialReason?.code ?? (memberProfile ? "CREATE_MEMBER_PROFILE" : membershipBusiness ? request.commandType : memberLodging ? "CREATE_MEMBER_STAY" : "OPERATOR_CONFIRMED"));
  const [reasonNote, setReasonNote] = useState(request.initialReason?.note ?? (memberProfile ? "创建会员档案" : membershipBusiness && executableCommandType ? membershipCommandLabel(executableCommandType) : memberLodging ? "创建会员住宿订单" : ""));
  const [confirmationKey, setConfirmationKey] = useState(initialConfirmationKey);
  const [networkUncertain, setNetworkUncertain] = useState(Boolean(initialConfirmationKey && !initialReceipt));
  const [failedNotExecuted, setFailedNotExecuted] = useState(false);
  const [returnedOriginalReceipt, setReturnedOriginalReceipt] = useState(Boolean(initialReceipt));
  const [expiryClock, setExpiryClock] = useState(() => Date.now());
  const [previewMetadata, setPreviewMetadata] = useState<ClientCommandMetadata>(() => initialPreviewMetadata ?? api.commandMetadata(`preview-${request.commandType.toLowerCase()}`));
  const automaticPreviewStarted = useRef(false);

  const previewExpiry = preview ? Date.parse(preview.expiresAt) : Number.POSITIVE_INFINITY;
  const previewExpired = Boolean(preview && (!Number.isFinite(previewExpiry) || expiryClock >= previewExpiry));
  const canConfirm = Boolean(preview
    && reasonCode.trim()
    && reasonNote.trim()
    && !busy
    && !writeBlocked
    && !previewExpired
    && !networkUncertain
    && !confirmationKey);
  const currentKey = useMemo(() => confirmationKey ?? api.recoveryKey(request.commandType), [confirmationKey, request.commandType]);

  useEffect(() => {
    if (!preview || receipt || !Number.isFinite(previewExpiry)) return;
    const delay = Math.max(0, previewExpiry - Date.now() + 20);
    const timer = window.setTimeout(() => setExpiryClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [preview, previewExpiry, receipt]);

  async function loadPreview(metadata = previewMetadata) {
    if (writeBlocked) return;
    if (!isExecutableCommandType(request.commandType)) {
      setError(new Error("该历史操作只支持查询原结果"));
      return;
    }
    setBusy(true);
    setError(undefined);
    setFailedNotExecuted(false);
    onProgress?.({ state: "PREVIEWING", previewMetadata: metadata });
    try {
      const response = await api.preview({ commandType: request.commandType, input: request.input }, metadata);
      setPreview(response.preview);
      setReceipt(undefined);
      setExpiryClock(Date.now());
      onProgress?.({ state: "PREVIEWED", previewId: response.preview.previewId, previewMetadata: metadata });
    } catch (nextError) {
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      onProgress?.({ state: uncertain ? "PREVIEW_UNKNOWN" : "PREVIEW_FAILED", previewMetadata: metadata });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!businessFacing || receipt || confirmationKey || writeBlocked || automaticPreviewStarted.current) return;
    automaticPreviewStarted.current = true;
    void loadPreview();
  }, [businessFacing, receipt, confirmationKey, writeBlocked]);

  function regeneratePreview() {
    if (writeBlocked || busy || networkUncertain || confirmationKey) return;
    const metadata = api.commandMetadata(`preview-${request.commandType.toLowerCase()}`);
    setPreviewMetadata(metadata);
    setPreview(undefined);
    setReceipt(undefined);
    setError(undefined);
    setFailedNotExecuted(false);
    void loadPreview(metadata);
  }

  async function confirm() {
    if (!preview || !reasonCode.trim() || !reasonNote.trim() || writeBlocked || previewExpired || networkUncertain || confirmationKey) return;
    if (!isExecutableCommandType(request.commandType)) {
      setError(new Error("该历史操作不能重新确认"));
      return;
    }
    const propertyId = request.input.propertyId;
    if (typeof propertyId !== "string" || !propertyId) {
      setError(new Error("Command property scope is missing"));
      return;
    }
    const key = currentKey;
    setConfirmationKey(key);
    setBusy(true);
    setError(undefined);
    setNetworkUncertain(false);
    setFailedNotExecuted(false);
    try {
      const accepted = onProgress?.({ state: "CONFIRMING", previewId: preview.previewId, confirmationKey: key });
      if (accepted === false) {
        setError(new Error("无法安全保存本次确认的恢复信息，命令尚未发送"));
        setBusy(false);
        return;
      }
    } catch (progressError) {
      setError(progressError);
      setBusy(false);
      return;
    }
    try {
      const result = await api.confirm(preview.previewId, propertyId, request.commandType, preview.effectHash, {
        code: reasonCode.trim(),
        note: reasonNote.trim()
      }, key);
      setReceipt(result);
      setReturnedOriginalReceipt(false);
      onProgress?.({ state: "RESOLVED", confirmationKey: key, receipt: result });
      if (result.businessCommitted) onCommitted?.(result);
    } catch (nextError) {
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      setNetworkUncertain(uncertain);
      setFailedNotExecuted(!uncertain);
      onProgress?.(uncertain
        ? { state: "UNKNOWN", confirmationKey: key }
        : { state: "FAILED_NOT_EXECUTED", confirmationKey: key });
      if (!uncertain) {
        setPreview(undefined);
        setConfirmationKey(undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    if (!confirmationKey) return;
    if (!isHistoricalRecoverableCommandType(request.commandType)) {
      setError(new Error("该操作无法查询历史结果"));
      return;
    }
    const propertyId = request.input.propertyId;
    if (typeof propertyId !== "string" || !propertyId) {
      setError(new Error("Command property scope is missing"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.commandResult(propertyId, request.commandType, confirmationKey);
      setNetworkUncertain(result.executionStatus === "UNKNOWN");
      if (result.executionStatus === "UNKNOWN") {
        setReceipt(undefined);
        setReturnedOriginalReceipt(false);
        onProgress?.({ state: "UNKNOWN", confirmationKey });
      } else {
        setReceipt(result);
        setReturnedOriginalReceipt(true);
        onProgress?.({ state: "RESOLVED", confirmationKey, receipt: result });
      }
      if (result.businessCommitted) onCommitted?.(result);
    } catch (nextError) {
      setError(nextError);
      setNetworkUncertain(true);
      onProgress?.({ state: "UNKNOWN", confirmationKey });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={request.title}
      onClose={onClose}
      size="wide"
      closeDisabled={busy}
      footer={
        <>
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>{receipt ? "完成" : "取消"}</button>
          {!preview && !receipt && !networkUncertain && (!businessFacing || Boolean(error)) ? <button className="button button-primary" type="button" onClick={() => void loadPreview()} disabled={busy || writeBlocked} data-testid="create-command-preview">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : null}{businessFacing ? "重新载入核对信息" : "生成服务端预览"}
          </button> : null}
          {preview && previewExpired && !receipt && !confirmationKey && !networkUncertain ? <button className="button button-primary" type="button" onClick={regeneratePreview} disabled={busy || writeBlocked} data-testid="regenerate-command-preview">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <RefreshCw aria-hidden="true" size={17} />}{businessFacing ? "重新载入核对信息" : "重新生成服务端预览"}
          </button> : null}
          {preview && !previewExpired && !receipt && !confirmationKey && !networkUncertain ? <button className={`button ${businessFacing ? "button-primary" : "button-danger"} command-confirm-button`} type="button" onClick={() => void confirm()} disabled={!canConfirm} data-testid="confirm-command">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <Check aria-hidden="true" size={17} />}{memberProfile ? "确认创建会员档案" : membershipBusiness && executableCommandType ? `确认${membershipCommandLabel(executableCommandType)}` : memberLodging ? "确认创建会员住宿订单" : `确认提交：${request.title}`}
          </button> : null}
        </>
      }
    >
      <p className="command-description">{request.description}</p>
      <div aria-live="polite" className="sr-status">{busy ? "正在处理" : receipt ? (receipt.businessCommitted ? "操作已完成" : "操作未完成") : ""}</div>
      <InlineError
        error={error}
        title={failedNotExecuted ? "操作未执行" : "操作处理失败"}
        hideTechnicalDetails={businessFacing}
      />
      <InlineError error={writeBlocked && !receipt ? new Error(writeBlockedReason) : undefined} title="写入已暂停" />
      <InlineError
        error={previewExpired && !receipt ? new Error(businessFacing ? "本次核对已失效，请重新载入核对信息。" : "Preview 已过期。库存或授权可能已经变化，请关闭后刷新并重新生成 Preview。") : undefined}
        title={businessFacing ? "核对已失效" : "Preview 已过期"}
      />
      {!preview && !receipt ? (
        <div className="command-pending">
          {businessFacing ? <p>{busy ? (memberProfile ? "正在检查身份证号并载入会员资料。" : memberLodging ? "正在载入会员住宿核对信息。" : "正在载入本次会员操作的核对信息。") : (memberProfile ? "系统会先检查身份证号是否已登记，再显示本次要创建的会员资料。" : memberLodging ? "系统将重新载入会员住宿核对信息。" : "系统将重新载入本次会员操作的核对信息。")}</p> : <>
            <p>命令类型</p>
            <code>{request.commandType}</code>
            <details className="raw-details">
              <summary>请求输入</summary>
              <pre>{JSON.stringify(displayCommandInput(request.input), null, 2)}</pre>
            </details>
          </>}
        </div>
      ) : null}
      {preview && !receipt ? (
        <>
          <EffectSummary preview={preview} />
          {!businessFacing ? <section className="reason-section" aria-labelledby="reason-heading">
            <h3 id="reason-heading">确认原因</h3>
            <div className="form-grid form-grid-two">
              <label>原因代码<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required maxLength={80} data-testid="reason-code" /></label>
              <label className="span-two">原因说明<textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} required maxLength={1000} rows={3} placeholder="记录本次人工确认依据" data-testid="reason-note" /></label>
            </div>
          </section> : null}
        </>
      ) : null}
      {receipt && returnedOriginalReceipt ? (
        <div
          className="command-recovered-original"
          role="status"
          data-testid="command-recovered-original"
          data-command-state="duplicate-returned-original-receipt"
        >
          <strong>{businessFacing ? "已找到原操作结果" : "已返回原 Receipt"}</strong>
          <p>{memberProfile ? "系统返回了原来的建档结果，没有重复创建会员。" : membershipBusiness ? "系统返回了原来的操作结果，没有重复写入会员订单或收款。" : memberLodging ? "系统返回了原来的住宿结果，没有重复创建订单或冻结会员权益。" : "服务端按原幂等键解析既有结果，没有重复执行业务命令。"}</p>
        </div>
      ) : null}
      {receipt ? <ReceiptPanel
        receipt={receipt}
        onNavigateToResource={onClose}
        memberStay={memberLodging}
        {...(executableCommandType ? { commandType: executableCommandType } : {})}
        {...(businessFacing && executableCommandType ? { businessCommand: executableCommandType } : {})}
      /> : null}
      {networkUncertain && confirmationKey ? (
        <div className="recovery-bar">
          <div><strong>{memberProfile ? "建档结果需要恢复查询" : membershipBusiness ? "会员操作结果需要恢复查询" : memberLodging ? "会员住宿结果需要恢复查询" : "执行状态需要恢复查询"}</strong><p>{memberProfile ? "系统会查询原建档结果，不会重复创建会员。" : membershipBusiness ? "系统会查询原操作结果，不会重复写入会员订单或收款。" : memberLodging ? "系统会查询原住宿结果，不会重复创建订单或冻结会员权益。" : "使用原幂等键查询，不会发起新的业务命令。"}</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recover()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />{memberProfile ? "查询建档结果" : membershipBusiness ? "查询会员操作结果" : memberLodging ? "查询住宿结果" : "查询命令结果"}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
