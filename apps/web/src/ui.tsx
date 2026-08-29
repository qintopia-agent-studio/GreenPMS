import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, CircleHelp, Clock3, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import {
  commandTypes,
  currentReleaseFeatures,
  historicalRecoverableCommandTypes,
  type CommandType,
  type HistoricalCommandType,
  type HistoricalRecoverableCommandType,
  type MoneyDto
} from "@qintopia/contracts";
import { api, ApiError } from "./api";
import {
  commandShellLabel,
  commandShellNotExecutedMessage,
  commandShellRefreshFailedMessage,
  commandShellSuccessMessage,
  initialCommandShellState,
  isU1CommandType,
  transitionCommandShell,
  type CommandShellEvent,
  type U1CommandType
} from "./command-shell/commandShellState";
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

const externalBookingChannels = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);

export function stayDateFundsAreOperatorFacing(
  bookingChannelCode: string | null | undefined,
  pricingBasis?: string
): boolean {
  if (bookingChannelCode && externalBookingChannels.has(bookingChannelCode)) return false;
  return pricingBasis !== "CHANNEL_CONTRACT";
}

export function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function nextLocalDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

export function businessErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "RESOURCE_SCOPE_DENIED" && /Cross-origin session write/i.test(error.message)) {
      return "当前页面地址与系统登录地址不一致，本次没有写入。请从系统提供的地址重新打开并登录。";
    }
    if (error.code === "INVENTORY_CONFLICT") {
      return /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "所选房源在目标日期区间已有占用，请重新选择房源或日期。";
    }
    if (error.code === "REFUND_LIMIT_EXCEEDED") {
      return /[\u3400-\u9fff]/.test(error.message)
        ? error.message
        : "退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。";
    }
    if (error.code === "PREVIEW_STALE" && isRecord(error.details) && error.details.causeCode === "REFUND_LIMIT_EXCEEDED") {
      return "退款金额不能超过所选原收款的剩余可退金额，请返回修改退款金额。";
    }
    if (/[\u3400-\u9fff]/.test(error.message) && !/Preview|Confirm|Receipt|Command|effectHash|idempoten/i.test(error.message)) {
      return error.message;
    }
    if (error.status === 401 || error.status === 403) return "当前账号无权完成这项操作，本次没有写入。";
    if (error.status === 409 || error.code === "PREVIEW_STALE" || error.code === "INVALID_ORDER_STATE") {
      return "当前业务状态已经变化，本次没有写入。请刷新后重新核对。";
    }
    if (error.status >= 500 || error.retryable) return "服务暂时不可用，当前结果尚未确认。请按页面提示查询原操作结果。";
    return "本次操作未完成，服务端没有接受这次提交。请返回修改后重新核对。";
  }
  if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message) && !/Preview|Confirm|Receipt|Command|effectHash|idempoten/i.test(error.message)) {
    return error.message;
  }
  return "本次操作未完成，请返回修改后重新核对。";
}

export function commandDialogBusinessErrorMessage(commandType: HistoricalCommandType, error: unknown): string {
  if (commandType === "CORRECT_ORDER_OCCUPANT"
    && error instanceof ApiError
    && error.code === "VALIDATION_ERROR") {
    return "住宿人资料未通过校验。请返回修改，并确认至少更正一项资料。";
  }
  return businessErrorMessage(error);
}

export function commandPreviewFailureCanReload(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || error.retryable || error.code === "COMMAND_STATUS_UNKNOWN";
}

export function InfoHint({ text, label = "说明" }: { text: string; label?: string }) {
  return <span className="info-hint" tabIndex={0} role="note" aria-label={`${label}：${text}`}>
    <CircleHelp aria-hidden="true" size={14} />
    <span className="info-hint-bubble" role="tooltip">{text}</span>
  </span>;
}

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge status-${normalized}`}>{label ?? value.replaceAll("_", " ")}</span>;
}

const businessStatusLabels: Record<string, string> = {
  RESERVED: "已预订",
  PLANNED: "已预订",
  CHECKED_IN: "在住",
  IN_HOUSE: "在住",
  CHECKED_OUT: "已退房",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  NO_SHOW: "未到",
  PENDING: "待清洁",
  HELD: "已冻结",
  CONSUMED: "已核销",
  RELEASED: "已释放",
  CHECK_IN_REVOKED: "入住已撤销",
  RESTORED: "已补偿恢复"
};

export function businessStatusLabel(value: string): string {
  return businessStatusLabels[value] ?? value;
}

export function InlineError({ error, title = "操作未完成", hideTechnicalDetails = false }: {
  error: unknown;
  title?: string;
  hideTechnicalDetails?: boolean;
}) {
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : undefined;
  const message = hideTechnicalDetails ? businessErrorMessage(error) : errorMessage(error);
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

export function CommandResultNotice({ message, onDismiss }: { message: string | undefined; onDismiss: () => void }) {
  if (!message) return null;
  const warning = message.includes("未写入") || message.includes("未执行") || message.includes("刷新失败");
  return (
    <div className={`command-result-notice${warning ? " is-warning" : ""}`} role="status" aria-live="polite" tabIndex={-1} data-testid="command-result-notice">
      {warning ? <AlertCircle aria-hidden="true" size={18} /> : <Check aria-hidden="true" size={18} />}
      <span>{message}</span>
      <button type="button" className="icon-button" onClick={onDismiss} aria-label="关闭操作结果提示" title="关闭">
        <X aria-hidden="true" size={16} />
      </button>
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
  className?: string;
}

const useDialogVisibilityEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Modal({ title, onClose, children, footer, size = "default", closeDisabled = false, modal = true, className }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useDialogVisibilityEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog) {
      const currentlyModal = dialog.matches(":modal");
      if (modal && !currentlyModal) {
        if (dialog.open) dialog.close();
        dialog.showModal();
      } else if (!modal && currentlyModal) {
        dialog.close();
        dialog.show();
      } else if (!modal && !dialog.open) {
        dialog.show();
      }
    }
    if (!modal && dialog) {
      requestAnimationFrame(() => {
        const firstControl = dialog.querySelector<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        );
        (firstControl ?? dialog).focus({ preventScroll: true });
      });
    }
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else {
        const fallback = document.querySelector<HTMLElement>("[data-testid='command-result-notice'], main h1, h1");
        if (fallback) {
          if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
          fallback.focus();
        }
      }
    };
  }, [modal]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || closeDisabled || !dialogRef.current?.open) return;
      if (document.querySelector("[data-testid='room-status-quick-popover']")) return;
      const openDialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
      if (openDialogs.at(-1) !== dialogRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [closeDisabled, onClose]);

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
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
      className={`modal modal-${size}${className ? ` ${className}` : ""}`}
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
        <div className="modal-body" tabIndex={0}>{children}</div>
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
      roleLabel: candidate.role === "PRIMARY" ? "主要联系人" : `同行人 ${Math.max(1, ordinal - 1)}`,
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
const fulfillmentBusinessCommands = new Set<CommandType>(["CHECK_IN", "CHECK_OUT", "COMPLETE_CLEANING"]);
const tokenBusinessCommands = new Set<CommandType>(["ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"]);
const fulfillmentTransitions: Partial<Record<CommandType, readonly [string, string]>> = {
  CHECK_IN: ["RESERVED", "CHECKED_IN"],
  CHECK_OUT: ["CHECKED_IN", "CHECKED_OUT"],
  COMPLETE_CLEANING: ["PENDING", "COMPLETED"]
};

function isFulfillmentBusinessCommand(value: unknown): value is CommandType {
  return typeof value === "string" && fulfillmentBusinessCommands.has(value as CommandType);
}

export function fulfillmentTransitionIsExpected(commandType: CommandType, effect: Record<string, unknown>): boolean {
  const expected = fulfillmentTransitions[commandType];
  if (!expected || effect.fromStatus !== expected[0] || effect.toStatus !== expected[1]) return false;
  if (commandType === "COMPLETE_CLEANING") return true;
  if (typeof effect.businessDate !== "string" || typeof effect.effectiveDate !== "string") return false;
  if (commandType === "CHECK_IN") {
    return effect.recordingMode === "ON_SCHEDULE"
      ? effect.businessDate === effect.effectiveDate
      : effect.recordingMode === "LATE_RECORDED" && effect.businessDate > effect.effectiveDate;
  }
  if (commandType === "CHECK_OUT") {
    return effect.recordingMode === "ON_SCHEDULE"
      ? effect.businessDate === effect.effectiveDate
      : effect.recordingMode === "LATE_RECORDED" && effect.businessDate > effect.effectiveDate;
  }
  return false;
}

export function fulfillmentAuditNote(
  commandType: "CHECK_IN" | "CHECK_OUT",
  effect: Record<string, unknown>,
  operatorNote: string
): string {
  const trimmed = operatorNote.trim();
  if (trimmed) return trimmed;
  if (commandType === "CHECK_IN") return effect.recordingMode === "LATE_RECORDED" ? "迟录计划入住" : "按计划办理入住";
  return effect.recordingMode === "LATE_RECORDED" ? "迟录计划退房" : "按计划办理退房";
}

function fulfillmentCommandLabel(commandType: CommandType): string {
  if (commandType === "CHECK_IN") return "办理入住";
  if (commandType === "CHECK_OUT") return "办理退房";
  if (commandType === "COMPLETE_CLEANING") return "完成清洁";
  return "履约操作";
}

export function fulfillmentReceiptCopy(
  commandType: CommandType,
  committed: boolean,
  consumedCoverageCount = 0,
  timing?: { effectiveDate: string; recordedBusinessDate: string; recordingMode: "ON_SCHEDULE" | "LATE_RECORDED" }
): { heading: string; description: string } {
  const label = fulfillmentCommandLabel(commandType);
  if (!committed) return { heading: `${label}未完成`, description: "本次操作没有改变住宿记录。" };
  if (commandType === "CHECK_IN") {
    const lateRecorded = timing?.recordingMode === "LATE_RECORDED";
    const timingDescription = lateRecorded
      ? `入住按原计划入住日 ${formatDate(timing.effectiveDate)} 生效，于 ${formatDate(timing.recordedBusinessDate)} 营业日迟录；`
      : "";
    return {
      heading: lateRecorded ? "迟录入住已完成" : "办理入住已完成",
      description: consumedCoverageCount > 0
        ? `${timingDescription}住宿状态已更新为在住；本次核销 ${consumedCoverageCount} 晚已冻结的会员权益。`
        : `${timingDescription}住宿状态已更新为在住；本次不涉及会员权益。`
    };
  }
  if (commandType === "CHECK_OUT") return {
    heading: timing?.recordingMode === "LATE_RECORDED" ? "迟录退房已完成" : "办理退房已完成",
    description: timing?.recordingMode === "LATE_RECORDED"
      ? `退房按原计划退房日 ${formatDate(timing.effectiveDate)} 生效，于 ${formatDate(timing.recordedBusinessDate)} 营业日迟录；订单金额保持不变，住宿库存已释放。`
      : "住宿状态已更新为已退房，后续库存已按当前住宿事实释放。"
  };
  return {
    heading: "清洁已完成",
    description: "清洁任务已更新为已完成，住宿历史保持不变。"
  };
}

function membershipCommandLabel(commandType: CommandType): string {
  if (commandType === "CREATE_MEMBERSHIP_ORDER") return "创建会员订单";
  if (commandType === "RECORD_MEMBERSHIP_PAYMENT") return "登记企微收款";
  if (commandType === "CORRECT_MEMBERSHIP_PAYMENT") return "更正企微收款";
  if (commandType === "ACTIVATE_MEMBERSHIP_ORDER") return "生效会员订单";
  if (commandType === "CORRECT_MEMBER_ENTITLEMENT_BALANCE") return "更正会员余额";
  return "会员操作";
}

function tokenCommandLabel(commandType: HistoricalCommandType): string {
  if (commandType === "ISSUE_TOKEN") return "签发 Token";
  if (commandType === "ROTATE_TOKEN") return "轮换 Token";
  if (commandType === "REVOKE_TOKEN") return "撤销 Token";
  return "Token 操作";
}

function tokenAccessCeilingLabel(value: unknown): string {
  if (value === "READ") return "只读";
  if (value === "WRITE") return "可写";
  return scalar(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const commandBusinessLabels: Partial<Record<HistoricalCommandType, string>> = {
  RESCHEDULE_STAY: "调整预订日期",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "延长住宿",
  MOVE_UNIT: "换房",
  CANCEL_ORDER: "取消订单",
  MARK_NO_SHOW: "标记未到",
  REVOKE_CHECK_IN: "撤销入住",
  RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款",
  REVERSE_FACT: "冲销收退款记录",
  ISSUE_TOKEN: "签发 Token",
  ROTATE_TOKEN: "轮换 Token",
  REVOKE_TOKEN: "撤销 Token"
};

const effectFieldLabels: Record<string, string> = {
  arrivalDate: "入住日期",
  departureDate: "退房日期",
  effectiveDate: "生效日期",
  businessDate: "办理营业日",
  currentContractAmount: "订单金额",
  status: "住宿状态",
  fromStatus: "原状态",
  toStatus: "新状态",
  transactionReference: "外部交易单号",
  reason: "业务说明"
};

function operatorDifferenceEntries(value: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  return Object.entries(value).flatMap(([key, fieldValue]) => {
    const label = effectFieldLabels[key];
    if (!label) return [];
    const amount = moneyFrom(fieldValue);
    if (amount) return [{ key, label, value: formatMoney(amount) }];
    if ((key === "arrivalDate" || key === "departureDate" || key === "effectiveDate" || key === "businessDate") && typeof fieldValue === "string") {
      return [{ key, label, value: formatDate(fieldValue) }];
    }
    if ((key === "status" || key === "fromStatus" || key === "toStatus") && typeof fieldValue === "string") {
      return [{ key, label, value: businessStatusLabel(fieldValue) }];
    }
    if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") {
      return [{ key, label, value: scalar(fieldValue) }];
    }
    return [];
  });
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

const fundMethodLabels: Record<string, string> = {
  WECOM: "企业微信",
  BANK_TRANSFER: "银行转账",
  CASH: "现金",
  OTHER: "其他"
};

function fundMethodLabel(value: unknown): string {
  return typeof value === "string" && value.trim() ? fundMethodLabels[value] ?? "其他" : "历史未记录";
}

const freeStayCategoryLabels: Record<string, string> = {
  VOLUNTEER: "义工",
  RECEPTION: "接待"
};

export function freeStayCategoryLabel(code: unknown): string {
  return typeof code === "string" && code.trim() ? freeStayCategoryLabels[code] ?? code : "历史未记录";
}

function pricingFromEffect(effect: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(effect.pricing)) return effect.pricing;
  if (isRecord(effect.after) && isRecord(effect.after.pricing)) return effect.after.pricing;
  return undefined;
}

function localDateNightCount(arrivalDate: unknown, departureDate: unknown): number | undefined {
  const arrival = localDateEpoch(arrivalDate);
  const departure = localDateEpoch(departureDate);
  if (arrival === undefined || departure === undefined || departure <= arrival) return undefined;
  return Math.round((departure - arrival) / 86_400_000);
}

function nonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEffectHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function evidenceValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => evidenceValuesEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && evidenceValuesEqual(left[key], right[key]));
}

function optionalGuestEvidenceValueMatches(left: unknown, right: unknown): boolean {
  return left === right
    || ((left === null || left === undefined) && (right === null || right === undefined));
}

type EvidenceMoney = { minorUnits: number; currency: string };

function hasMoney(value: unknown): value is EvidenceMoney {
  return isRecord(value)
    && Number.isSafeInteger(value.minorUnits)
    && typeof value.currency === "string"
    && /^[A-Z]{3}$/.test(value.currency);
}

function moneyMatches(left: unknown, right: unknown): boolean {
  if (!hasMoney(left) || !hasMoney(right)) return false;
  return left.minorUnits === right.minorUnits && left.currency === right.currency;
}

function localDateEpoch(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) return undefined;
  return epoch;
}

function localDateRange(arrivalDate: string, departureDate: string): string[] | undefined {
  const arrival = localDateEpoch(arrivalDate);
  const departure = localDateEpoch(departureDate);
  if (arrival === undefined || departure === undefined || departure <= arrival) return undefined;
  const dates: string[] = [];
  for (let epoch = arrival; epoch < departure; epoch += 86_400_000) {
    dates.push(new Date(epoch).toISOString().slice(0, 10));
  }
  return dates.length <= 366 ? dates : undefined;
}

function exactDateList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => localDateEpoch(item) !== undefined)) return undefined;
  const dates = value as string[];
  return new Set(dates).size === dates.length ? dates : undefined;
}

function sameDateSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((date) => expected.includes(date));
}

export function planBDateChangeTimeline(
  beforeTimeline: readonly { serviceDate: string; inventoryUnitId: string }[],
  oldArrivalDate: string,
  oldDepartureDate: string,
  newArrivalDate: string,
  newDepartureDate: string
): Array<{ serviceDate: string; inventoryUnitId: string }> | undefined {
  const beforeDates = localDateRange(oldArrivalDate, oldDepartureDate);
  const afterDates = localDateRange(newArrivalDate, newDepartureDate);
  const oldArrivalEpoch = localDateEpoch(oldArrivalDate);
  const oldDepartureEpoch = localDateEpoch(oldDepartureDate);
  const newArrivalEpoch = localDateEpoch(newArrivalDate);
  const newDepartureEpoch = localDateEpoch(newDepartureDate);
  if (!beforeDates || !afterDates
    || oldArrivalEpoch === undefined || oldDepartureEpoch === undefined
    || newArrivalEpoch === undefined || newDepartureEpoch === undefined
    || beforeTimeline.length !== beforeDates.length
    || !beforeTimeline.every((item, index) => (
      item.serviceDate === beforeDates[index] && nonblankString(item.inventoryUnitId)
    ))) return undefined;

  const arrivalDelta = (newArrivalEpoch - oldArrivalEpoch) / 86_400_000;
  const departureDelta = (newDepartureEpoch - oldDepartureEpoch) / 86_400_000;
  if (arrivalDelta === departureDelta) {
    return afterDates.map((serviceDate, index) => ({
      serviceDate,
      inventoryUnitId: beforeTimeline[index]!.inventoryUnitId
    }));
  }

  const firstUnitId = beforeTimeline[0]?.inventoryUnitId;
  const lastUnitId = beforeTimeline.at(-1)?.inventoryUnitId;
  if (!firstUnitId || !lastUnitId) return undefined;
  const beforeByDate = new Map(beforeTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  return afterDates.map((serviceDate) => ({
    serviceDate,
    inventoryUnitId: serviceDate < oldArrivalDate
      ? firstUnitId
      : serviceDate >= oldDepartureDate
        ? lastUnitId
        : beforeByDate.get(serviceDate)!
  }));
}

function sameTimeline(
  actual: readonly { serviceDate: string; inventoryUnitId: string }[],
  expected: readonly { serviceDate: string; inventoryUnitId: string }[]
): boolean {
  return actual.length === expected.length && actual.every((item, index) => (
    item.serviceDate === expected[index]?.serviceDate
    && item.inventoryUnitId === expected[index]?.inventoryUnitId
  ));
}

function dateChangePreviewHasEvidence(
  commandType: "RESCHEDULE_STAY" | "EXTEND_STAY" | "SHORTEN_STAY",
  effect: Record<string, unknown>,
  input: Record<string, unknown>
): boolean {
  const shorten = commandType === "SHORTEN_STAY";
  const expectedKeys = shorten
    ? ["operation", "orderId", "stayId", "inventoryUnitId", "businessDate", "completionMode", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary", "refundReferenceAmount"]
    : ["operation", "orderId", "stayId", "inventoryUnitId", "before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary"];
  if (!hasExactKeys(effect, expectedKeys)
    || effect.operation !== commandType
    || !nonblankString(effect.orderId)
    || effect.orderId !== input.orderId
    || !nonblankString(effect.stayId)
    || !nonblankString(effect.inventoryUnitId)) return false;
  const before = isRecord(effect.before) ? effect.before : undefined;
  const after = isRecord(effect.after) ? effect.after : undefined;
  const decision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const inventory = isRecord(effect.inventoryChange) ? effect.inventoryChange : undefined;
  const entitlement = isRecord(shorten ? effect.entitlementSummary : effect.entitlementChange)
    ? (shorten ? effect.entitlementSummary : effect.entitlementChange) as Record<string, unknown>
    : undefined;
  const funds = isRecord(effect.fundsSummary) ? effect.fundsSummary : undefined;
  if (!before || !after || !decision || !inventory || !entitlement || !funds
    || !hasExactKeys(before, ["arrivalDate", "departureDate", "nights", "stayTimeline", "currentContractAmount"])
    || !hasExactKeys(after, ["arrivalDate", "departureDate", "nights", "stayTimeline", "pricing"])
    || !hasExactKeys(decision, ["pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy", "manualAdjustmentMinor", "differenceExceedsThreshold", "reason"])
    || !hasExactKeys(inventory, ["preservedDates", "releasedDates", "addedDates"])
    || !hasExactKeys(entitlement, shorten
      ? ["currentConsumedCoverageDates", "retainedHistoricalConsumedCoverageDates", "restoredFutureCoverageDates", "ledgerWriteCount"]
      : ["preservedCoverageDates", "releasedCoverageDates", "addedCoverageDates", "consumedCoverageDates"])
    || !hasExactKeys(funds, shorten
      ? ["netRecordedCollection", "collectionDifference", "factCount"]
      : ["netRecordedCollection", "collectionDifference"])) return false;

  const beforeDates = typeof before.arrivalDate === "string" && typeof before.departureDate === "string"
    ? localDateRange(before.arrivalDate, before.departureDate)
    : undefined;
  const afterDates = typeof after.arrivalDate === "string" && typeof after.departureDate === "string"
    ? localDateRange(after.arrivalDate, after.departureDate)
    : undefined;
  const businessDate = shorten && typeof effect.businessDate === "string" && localDateEpoch(effect.businessDate) !== undefined
    ? effect.businessDate
    : undefined;
  if (!beforeDates || !afterDates
    || before.nights !== beforeDates.length
    || after.nights !== afterDates.length
    || after.nights < 1
    || after.nights > 366
    || (commandType === "RESCHEDULE_STAY" && (after.arrivalDate !== input.newArrivalDate || after.departureDate !== input.newDepartureDate))
    || (commandType === "EXTEND_STAY" && (after.arrivalDate !== before.arrivalDate || after.departureDate !== input.newDepartureDate || String(after.departureDate) <= String(before.departureDate)))
    || (commandType === "SHORTEN_STAY" && (after.arrivalDate !== before.arrivalDate || after.departureDate !== input.newDepartureDate || String(after.departureDate) >= String(before.departureDate)))
    || (shorten && (!businessDate
      || (effect.completionMode === "EARLY_CHECK_OUT" && after.departureDate !== businessDate)
      || (effect.completionMode === "SHORTEN_IN_HOUSE" && String(after.departureDate) <= businessDate)
      || (effect.completionMode !== "SHORTEN_IN_HOUSE" && effect.completionMode !== "EARLY_CHECK_OUT")))) return false;

  const timeline = repriceStayTimeline(after.stayTimeline);
  if (!timeline || timeline.length !== afterDates.length
    || !timeline.every((item, index) => item.serviceDate === afterDates[index])) return false;
  const beforeTimeline = repriceStayTimeline(before.stayTimeline);
  if (!beforeTimeline
    || beforeTimeline.length !== beforeDates.length
    || !beforeTimeline.every((item, index) => item.serviceDate === beforeDates[index])) return false;
  const expectedTimeline = beforeTimeline
    ? planBDateChangeTimeline(
        beforeTimeline,
        String(before.arrivalDate),
        String(before.departureDate),
        String(after.arrivalDate),
        String(after.departureDate)
      )
    : undefined;
  if (!expectedTimeline || !sameTimeline(timeline, expectedTimeline)) return false;
  const timelineByDate = new Map(timeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const pricing = isRecord(after.pricing) ? after.pricing : undefined;
  if (!pricing || !hasExactKeys(pricing, ["coverageSet", "cashLines", "cashRemainder", "currentContractAmount"])) return false;

  const pricingBasis = decision.pricingBasis;
  if (pricingBasis !== "POLICY" && pricingBasis !== "CHANNEL_CONTRACT" && pricingBasis !== "MANUAL_ADJUSTMENT"
    && pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE") return false;
  const pricingReason = isRecord(decision.reason) ? decision.reason : undefined;
  const beforeAmount = before.currentContractAmount;
  const policyAmount = decision.policyBaseAmount;
  const targetAmount = decision.targetCurrentContractAmount;
  const difference = decision.differenceFromPolicy;
  const netCollection = funds.netRecordedCollection;
  const collectionDifference = funds.collectionDifference;
  if (!pricingReason || !hasExactKeys(pricingReason, ["code", "note"])
    || !nonblankString(pricingReason.code)
    || typeof pricingReason.note !== "string"
    || !hasMoney(beforeAmount) || !hasMoney(policyAmount) || !hasMoney(targetAmount) || !hasMoney(difference)
    || !hasMoney(pricing.cashRemainder) || !hasMoney(pricing.currentContractAmount)
    || !hasMoney(netCollection) || !hasMoney(collectionDifference)
    || [beforeAmount, policyAmount, difference, pricing.cashRemainder, pricing.currentContractAmount, netCollection, collectionDifference]
      .some((amount) => amount.currency !== targetAmount.currency)
    || targetAmount.minorUnits < 0
    || targetAmount.minorUnits > 2_147_483_600
    || targetAmount.minorUnits % 100 !== 0
    || difference.minorUnits !== targetAmount.minorUnits - policyAmount.minorUnits
    || !moneyMatches(pricing.currentContractAmount, targetAmount)
    || collectionDifference.minorUnits !== targetAmount.minorUnits - netCollection.minorUnits
    || !Number.isSafeInteger(decision.manualAdjustmentMinor)
    || (pricingBasis === "MANUAL_ADJUSTMENT"
      ? decision.manualAdjustmentMinor !== difference.minorUnits
      : decision.manualAdjustmentMinor !== 0)
    || typeof decision.differenceExceedsThreshold !== "boolean"
    || decision.differenceExceedsThreshold !== (Math.abs(difference.minorUnits) * 100 > policyAmount.minorUnits * 15)
    || (input.targetCurrentContractAmountMinor !== undefined && input.targetCurrentContractAmountMinor !== targetAmount.minorUnits)
    || !pricingCoverageHasEvidence(
      pricing.coverageSet,
      timelineByDate,
      shorten && pricingBasis === "MEMBER_ENTITLEMENT"
    )
    || !Array.isArray(pricing.cashLines)
    || !pricing.cashLines.every((line) => pricingCashLineHasEvidence(line, targetAmount.currency, timelineByDate))) return false;

  const preservedDates = exactDateList(inventory.preservedDates);
  const releasedDates = exactDateList(inventory.releasedDates);
  const addedDates = exactDateList(inventory.addedDates);
  const beforeTimelineByDate = new Map((beforeTimeline ?? []).map((item) => [item.serviceDate, item.inventoryUnitId]));
  const expectedPreserved = shorten
    ? beforeDates.filter((date) => afterDates.includes(date))
    : beforeDates.filter((date) => timelineByDate.get(date) === beforeTimelineByDate.get(date));
  const expectedReleased = shorten
    ? beforeDates.filter((date) => !afterDates.includes(date))
    : beforeDates.filter((date) => timelineByDate.get(date) !== beforeTimelineByDate.get(date));
  const expectedAdded = shorten
    ? afterDates.filter((date) => !beforeDates.includes(date))
    : afterDates.filter((date) => beforeTimelineByDate.get(date) !== timelineByDate.get(date));
  const changedInventoryDates = shorten ? [] : expectedReleased.filter((date) => expectedAdded.includes(date));
  if (!preservedDates || !releasedDates || !addedDates
    || !sameDateSet(preservedDates, expectedPreserved)
    || !sameDateSet(releasedDates, expectedReleased)
    || !sameDateSet(addedDates, expectedAdded)) return false;

  if (shorten) {
    const currentConsumedCoverageDates = exactDateList(entitlement.currentConsumedCoverageDates);
    const retainedHistoricalConsumedCoverageDates = exactDateList(entitlement.retainedHistoricalConsumedCoverageDates);
    const restoredFutureCoverageDates = exactDateList(entitlement.restoredFutureCoverageDates);
    const currentCoverageDates = Array.isArray(pricing.coverageSet)
      ? exactDateList(pricing.coverageSet.map((item) => isRecord(item) ? item.serviceDate : undefined))
      : undefined;
    const refundReferenceAmount = effect.refundReferenceAmount;
    if (!currentConsumedCoverageDates || !retainedHistoricalConsumedCoverageDates || !restoredFutureCoverageDates || !currentCoverageDates
      || !Number.isSafeInteger(entitlement.ledgerWriteCount)
      || entitlement.ledgerWriteCount !== restoredFutureCoverageDates.length
      || (restoredFutureCoverageDates.length > 0 && !sameDateSet(restoredFutureCoverageDates, releasedDates))
      || !Number.isSafeInteger(funds.factCount)
      || (funds.factCount as number) < 0
      || !sameDateSet(currentCoverageDates, currentConsumedCoverageDates)
      || !currentConsumedCoverageDates.every((date) => afterDates.includes(date))
      || !retainedHistoricalConsumedCoverageDates.every((date) => !afterDates.includes(date))
      || !hasMoney(refundReferenceAmount)
      || refundReferenceAmount.currency !== targetAmount.currency
      || refundReferenceAmount.minorUnits < 0
      || refundReferenceAmount.minorUnits > 2_147_483_647
      || refundReferenceAmount.minorUnits !== Math.max(0, netCollection.minorUnits - targetAmount.minorUnits)
      || (pricingBasis !== "MEMBER_ENTITLEMENT"
        && (currentConsumedCoverageDates.length > 0 || retainedHistoricalConsumedCoverageDates.length > 0))) return false;
    return true;
  }

  const preservedCoverageDates = exactDateList(entitlement.preservedCoverageDates);
  const releasedCoverageDates = exactDateList(entitlement.releasedCoverageDates);
  const addedCoverageDates = exactDateList(entitlement.addedCoverageDates);
  const consumedCoverageDates = exactDateList(entitlement.consumedCoverageDates);
  const currentCoverageDates = Array.isArray(pricing.coverageSet)
    ? exactDateList(pricing.coverageSet.map((item) => isRecord(item) ? item.serviceDate : undefined))
    : undefined;
  if (!preservedCoverageDates || !releasedCoverageDates || !addedCoverageDates || !consumedCoverageDates
    || !currentCoverageDates
    || !preservedCoverageDates.every((date) => expectedPreserved.includes(date))
    || !releasedCoverageDates.every((date) => expectedReleased.includes(date))
    || !addedCoverageDates.every((date) => expectedAdded.includes(date))
    || !sameDateSet(currentCoverageDates, [...preservedCoverageDates, ...addedCoverageDates])
    || releasedCoverageDates.some((date) => currentCoverageDates.includes(date) && !changedInventoryDates.includes(date))
    || (pricingBasis !== "MEMBER_ENTITLEMENT"
      && (currentCoverageDates.length > 0
        || preservedCoverageDates.length > 0
        || releasedCoverageDates.length > 0
        || addedCoverageDates.length > 0
        || consumedCoverageDates.length > 0))
    || (commandType === "RESCHEDULE_STAY"
      ? consumedCoverageDates.length > 0
      : !sameDateSet(consumedCoverageDates, addedCoverageDates))) return false;
  return true;
}

export interface StayDatePreviewPricingSummary {
  beforeArrivalDate: string;
  beforeDepartureDate: string;
  beforeNights: number;
  afterArrivalDate: string;
  afterDepartureDate: string;
  afterNights: number;
  afterTimeline: Array<{ serviceDate: string; inventoryUnitId: string }>;
  completionMode?: "SHORTEN_IN_HOUSE" | "EARLY_CHECK_OUT";
  beforeAmount: MoneyDto;
  policyBaseAmount: MoneyDto;
  targetAmount: MoneyDto;
  differenceFromPolicy: MoneyDto;
  netRecordedCollection: MoneyDto;
  collectionDifference: MoneyDto;
  refundReferenceAmount: MoneyDto;
  pricingBasis: "POLICY" | "CHANNEL_CONTRACT" | "MANUAL_ADJUSTMENT" | "MEMBER_ENTITLEMENT" | "FREE";
}

export interface MoveUnitPreviewSummary {
  effectiveDate: string;
  businessDate: string;
  beforeTimeline: Array<{ serviceDate: string; inventoryUnitId: string }>;
  afterTimeline: Array<{ serviceDate: string; inventoryUnitId: string }>;
  beforeAmount: MoneyDto;
  policyBaseAmount: MoneyDto;
  targetAmount: MoneyDto;
  differenceFromPolicy: MoneyDto;
  netRecordedCollection: MoneyDto;
  collectionDifference: MoneyDto;
  pricingBasis: "POLICY" | "CHANNEL_CONTRACT" | "MANUAL_ADJUSTMENT" | "MEMBER_ENTITLEMENT" | "FREE";
}

function moveInventoryUnitHasEvidence(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const required = ["id", "propertyId", "kind", "roomId", "code", "name", "catalogVersion", "buildingCode", "roomTypeCode", "pricingProductCode", "inventoryBasis", "codeProvenance", "physicalBedCount"];
  return hasOnlyKeys(value, required, ["occupancyCapacity"])
    && nonblankString(value.id)
    && nonblankString(value.propertyId)
    && (value.kind === "ROOM" || value.kind === "BED")
    && nonblankString(value.roomId)
    && nonblankString(value.code)
    && nonblankString(value.name)
    && ["catalogVersion", "buildingCode", "roomTypeCode", "pricingProductCode"].every((key) => value[key] === null || nonblankString(value[key]))
    && (value.inventoryBasis === null || value.inventoryBasis === "INDEPENDENT" || value.inventoryBasis === "WHOLE_ROOM_COMBINATION")
    && (value.codeProvenance === null || value.codeProvenance === "SOURCE_EXPLICIT" || value.codeProvenance === "USER_CONFIRMED_RENAMED" || value.codeProvenance === "PMS_GENERATED")
    && (value.physicalBedCount === null || (Number.isSafeInteger(value.physicalBedCount) && Number(value.physicalBedCount) >= 1 && Number(value.physicalBedCount) <= 4))
    && (value.occupancyCapacity === undefined || (Number.isSafeInteger(value.occupancyCapacity) && Number(value.occupancyCapacity) >= 1 && Number(value.occupancyCapacity) <= 1000));
}

function moveClaimList(value: unknown): Array<{ serviceDate: string; inventoryUnitId: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const claims: Array<{ serviceDate: string; inventoryUnitId: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, ["serviceDate", "inventoryUnitId"])
      || localDateEpoch(item.serviceDate) === undefined || !nonblankString(item.inventoryUnitId)) return undefined;
    claims.push({ serviceDate: item.serviceDate as string, inventoryUnitId: item.inventoryUnitId });
  }
  const keys = claims.map((claim) => `${claim.serviceDate}:${claim.inventoryUnitId}`);
  return new Set(keys).size === keys.length ? claims : undefined;
}

function sameClaims(
  actual: readonly { serviceDate: string; inventoryUnitId: string }[],
  expected: readonly { serviceDate: string; inventoryUnitId: string }[]
): boolean {
  const keys = new Set(expected.map((claim) => `${claim.serviceDate}:${claim.inventoryUnitId}`));
  return actual.length === expected.length
    && actual.every((claim) => keys.has(`${claim.serviceDate}:${claim.inventoryUnitId}`));
}

export function moveUnitPreviewHasEvidence(effect: Record<string, unknown>, input: Record<string, unknown>): boolean {
  const requiredEffectKeys = ["operation", "orderId", "stayId", "businessDate", "toInventoryUnit", "effectiveDate", "occupantCount", "occupancyCapacity", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary"];
  if (!hasExactKeys(effect, requiredEffectKeys)
    || effect.operation !== "MOVE_UNIT"
    || !nonblankString(effect.orderId) || effect.orderId !== input.orderId
    || !nonblankString(effect.stayId)
    || localDateEpoch(effect.businessDate) === undefined
    || localDateEpoch(effect.effectiveDate) === undefined
    || effect.effectiveDate !== input.effectiveDate
    || !Number.isSafeInteger(effect.occupantCount) || Number(effect.occupantCount) < 1 || Number(effect.occupantCount) > 1000
    || !Number.isSafeInteger(effect.occupancyCapacity) || Number(effect.occupancyCapacity) < 1 || Number(effect.occupancyCapacity) > 1000
    || Number(effect.occupantCount) > Number(effect.occupancyCapacity)
    || !moveInventoryUnitHasEvidence(effect.toInventoryUnit)
    || effect.toInventoryUnit.id !== input.newInventoryUnitId
    || effect.toInventoryUnit.propertyId !== input.propertyId
    || effect.toInventoryUnit.occupancyCapacity !== effect.occupancyCapacity) return false;

  const before = isRecord(effect.before) ? effect.before : undefined;
  const after = isRecord(effect.after) ? effect.after : undefined;
  const decision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const inventory = isRecord(effect.inventoryChange) ? effect.inventoryChange : undefined;
  const entitlement = isRecord(effect.entitlementSummary) ? effect.entitlementSummary : undefined;
  const funds = isRecord(effect.fundsSummary) ? effect.fundsSummary : undefined;
  if (!before || !after || !decision || !inventory || !entitlement || !funds
    || !hasExactKeys(before, ["arrivalDate", "departureDate", "nights", "currentContractAmount", "stayTimeline", "actualCurrentInventoryUnit", "effectiveDateInventoryUnit"])
    || !hasExactKeys(after, ["arrivalDate", "departureDate", "nights", "stayTimeline", "pricing"])
    || !hasExactKeys(decision, ["pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy", "manualAdjustmentMinor", "differenceExceedsThreshold", "reason"])
    || !hasExactKeys(inventory, ["preservedClaims", "releasedClaims", "addedClaims"])
    || !hasExactKeys(entitlement, ["preservedCoverageDates", "migratedHeldCoverageDates", "consumedCoverageDates", "convertedMembershipCoveragePreserved", "ledgerWriteCount"])
    || !hasExactKeys(funds, ["netRecordedCollection", "collectionDifference", "factCount"])
    || (before.actualCurrentInventoryUnit !== null && !moveInventoryUnitHasEvidence(before.actualCurrentInventoryUnit))
    || !moveInventoryUnitHasEvidence(before.effectiveDateInventoryUnit)
    || before.effectiveDateInventoryUnit.propertyId !== effect.toInventoryUnit.propertyId
    || (isRecord(before.actualCurrentInventoryUnit) && before.actualCurrentInventoryUnit.propertyId !== effect.toInventoryUnit.propertyId)) return false;

  const beforeDates = typeof before.arrivalDate === "string" && typeof before.departureDate === "string"
    ? localDateRange(before.arrivalDate, before.departureDate)
    : undefined;
  const afterDates = typeof after.arrivalDate === "string" && typeof after.departureDate === "string"
    ? localDateRange(after.arrivalDate, after.departureDate)
    : undefined;
  const beforeTimeline = repriceStayTimeline(before.stayTimeline);
  const afterTimeline = repriceStayTimeline(after.stayTimeline);
  if (!beforeDates || !afterDates || !beforeTimeline || !afterTimeline
    || before.arrivalDate !== after.arrivalDate || before.departureDate !== after.departureDate
    || before.nights !== beforeDates.length || after.nights !== afterDates.length
    || beforeTimeline.length !== beforeDates.length || afterTimeline.length !== afterDates.length
    || !beforeTimeline.every((item, index) => item.serviceDate === beforeDates[index])
    || !afterTimeline.every((item, index) => item.serviceDate === afterDates[index])
    || String(effect.effectiveDate) < String(before.arrivalDate)
    || String(effect.effectiveDate) >= String(before.departureDate)
    || before.effectiveDateInventoryUnit.id !== beforeTimeline.find((item) => item.serviceDate === effect.effectiveDate)?.inventoryUnitId
    || !afterTimeline.every((item, index) => (
      item.serviceDate < String(effect.effectiveDate)
        ? item.inventoryUnitId === beforeTimeline[index]?.inventoryUnitId
        : item.inventoryUnitId === input.newInventoryUnitId
    ))
    || beforeTimeline.every((item, index) => item.inventoryUnitId === afterTimeline[index]?.inventoryUnitId)) return false;

  const actualCurrentUnit = before.actualCurrentInventoryUnit;
  if (actualCurrentUnit === null) {
    if (String(effect.businessDate) > String(before.arrivalDate)) return false;
  } else if (String(effect.businessDate) < String(before.arrivalDate)
    || String(effect.businessDate) >= String(before.departureDate)
    || actualCurrentUnit.id !== beforeTimeline.find((item) => item.serviceDate === effect.businessDate)?.inventoryUnitId
    || String(effect.effectiveDate) < String(effect.businessDate)) {
    return false;
  }

  const expectedPreserved = beforeTimeline.filter((item, index) => item.inventoryUnitId === afterTimeline[index]?.inventoryUnitId);
  const expectedReleased = beforeTimeline.filter((item, index) => item.inventoryUnitId !== afterTimeline[index]?.inventoryUnitId);
  const expectedAdded = afterTimeline.filter((item, index) => item.inventoryUnitId !== beforeTimeline[index]?.inventoryUnitId);
  const preserved = moveClaimList(inventory.preservedClaims);
  const released = moveClaimList(inventory.releasedClaims);
  const added = moveClaimList(inventory.addedClaims);
  if (!preserved || !released || !added
    || !sameClaims(preserved, expectedPreserved)
    || !sameClaims(released, expectedReleased)
    || !sameClaims(added, expectedAdded)) return false;

  const pricing = isRecord(after.pricing) ? after.pricing : undefined;
  const beforeAmount = before.currentContractAmount;
  const policyAmount = decision.policyBaseAmount;
  const targetAmount = decision.targetCurrentContractAmount;
  const difference = decision.differenceFromPolicy;
  const pricingReason = isRecord(decision.reason) ? decision.reason : undefined;
  const netCollection = funds.netRecordedCollection;
  const collectionDifference = funds.collectionDifference;
  const pricingBasis = decision.pricingBasis;
  const afterTimelineByDate = new Map(afterTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const beforeTimelineByDate = new Map(beforeTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const preservedCoverage = exactDateList(entitlement.preservedCoverageDates);
  const migratedCoverage = exactDateList(entitlement.migratedHeldCoverageDates);
  const consumedCoverage = exactDateList(entitlement.consumedCoverageDates);
  const convertedMembershipCoveragePreserved = entitlement.convertedMembershipCoveragePreserved;
  if (!preservedCoverage || !migratedCoverage || !consumedCoverage
    || typeof convertedMembershipCoveragePreserved !== "boolean") return false;
  const historicalCoverageInventoryDates = new Set(consumedCoverage);
  if (!pricing || !hasExactKeys(pricing, ["coverageSet", "cashLines", "cashRemainder", "currentContractAmount"])
    || !pricingReason || !hasExactKeys(pricingReason, ["code", "note"]) || !nonblankString(pricingReason.code) || typeof pricingReason.note !== "string"
    || (pricingBasis !== "POLICY" && pricingBasis !== "CHANNEL_CONTRACT" && pricingBasis !== "MANUAL_ADJUSTMENT" && pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE")
    || !hasMoney(beforeAmount) || !hasMoney(policyAmount) || !hasMoney(targetAmount) || !hasMoney(difference)
    || !hasMoney(pricing.cashRemainder) || !hasMoney(pricing.currentContractAmount)
    || !hasMoney(netCollection) || !hasMoney(collectionDifference)
    || [beforeAmount, policyAmount, difference, pricing.cashRemainder, pricing.currentContractAmount, netCollection, collectionDifference]
      .some((amount) => amount.currency !== targetAmount.currency)
    || targetAmount.minorUnits < 0 || targetAmount.minorUnits > 2_147_483_600 || targetAmount.minorUnits % 100 !== 0
    || difference.minorUnits !== targetAmount.minorUnits - policyAmount.minorUnits
    || !moneyMatches(pricing.currentContractAmount, targetAmount)
    || collectionDifference.minorUnits !== targetAmount.minorUnits - netCollection.minorUnits
    || !Number.isSafeInteger(decision.manualAdjustmentMinor)
    || (pricingBasis === "MANUAL_ADJUSTMENT" ? decision.manualAdjustmentMinor !== difference.minorUnits : decision.manualAdjustmentMinor !== 0)
    || typeof decision.differenceExceedsThreshold !== "boolean"
    || decision.differenceExceedsThreshold !== (Math.abs(difference.minorUnits) * 100 > policyAmount.minorUnits * 15)
    || (input.targetCurrentContractAmountMinor !== undefined && input.targetCurrentContractAmountMinor !== targetAmount.minorUnits)
    || !pricingCoverageHasEvidence(pricing.coverageSet, afterTimelineByDate, historicalCoverageInventoryDates)
    || !(pricing.coverageSet as unknown[]).every((item) => !isRecord(item)
      || convertedMembershipCoveragePreserved
      || !consumedCoverage.includes(String(item.serviceDate))
      || beforeTimelineByDate.get(String(item.serviceDate)) === item.inventoryUnitId)
    || !Array.isArray(pricing.cashLines)
    || !pricing.cashLines.every((line) => pricingCashLineHasEvidence(line, targetAmount.currency, afterTimelineByDate))) return false;

  const inputTarget = input.targetCurrentContractAmountMinor;
  const inputChannelReason = input.channelPriceDifferenceReason === undefined
    ? ""
    : typeof input.channelPriceDifferenceReason === "string" ? input.channelPriceDifferenceReason.trim() : undefined;
  const inputManualReason = input.manualPriceAdjustmentReason === undefined
    ? ""
    : typeof input.manualPriceAdjustmentReason === "string" ? input.manualPriceAdjustmentReason.trim() : undefined;
  if (inputChannelReason === undefined || inputManualReason === undefined) return false;
  if (pricingBasis === "CHANNEL_CONTRACT") {
    if (!Number.isSafeInteger(inputTarget) || inputTarget !== targetAmount.minorUnits
      || inputManualReason !== ""
      || pricingReason.code !== "MOVE_UNIT_CHANNEL_CONTRACT"
      || pricingReason.note !== inputChannelReason
      || (decision.differenceExceedsThreshold && !nonblankString(pricingReason.note))) return false;
  } else if (pricingBasis === "MANUAL_ADJUSTMENT") {
    if (!Number.isSafeInteger(inputTarget) || inputTarget !== targetAmount.minorUnits
      || inputChannelReason !== "" || !inputManualReason
      || targetAmount.minorUnits === policyAmount.minorUnits
      || pricingReason.code !== "MOVE_UNIT_MANUAL_PRICE"
      || pricingReason.note !== inputManualReason) return false;
  } else if (pricingBasis === "POLICY") {
    if (inputTarget !== undefined || inputChannelReason || inputManualReason
      || !moneyMatches(targetAmount, policyAmount)
      || difference.minorUnits !== 0
      || pricingReason.code !== "MOVE_UNIT_POLICY"
      || pricingReason.note !== "") return false;
  } else if (pricingBasis === "MEMBER_ENTITLEMENT") {
    if (inputTarget !== undefined || inputChannelReason || inputManualReason
      || !moneyMatches(targetAmount, policyAmount) || difference.minorUnits !== 0
      || pricingReason.code !== "MOVE_UNIT_MEMBER" || pricingReason.note !== "") return false;
  } else if (pricingBasis === "FREE") {
    if (inputTarget !== undefined || inputChannelReason || inputManualReason
      || policyAmount.minorUnits !== 0 || targetAmount.minorUnits !== 0 || difference.minorUnits !== 0
      || pricingReason.code !== "MOVE_UNIT_FREE" || pricingReason.note !== "") return false;
  }

  const allCoverageDates = preservedCoverage && migratedCoverage && consumedCoverage
    ? [...preservedCoverage, ...migratedCoverage, ...consumedCoverage]
    : [];
  const pricingCoverageDates = Array.isArray(pricing.coverageSet)
    ? exactDateList(pricing.coverageSet.map((item) => isRecord(item) ? item.serviceDate : undefined))
    : undefined;
  const memberPricing = pricingBasis === "MEMBER_ENTITLEMENT";
  const freePricing = pricingBasis === "FREE";
  const memberInventoryKind = effect.toInventoryUnit.kind;
  const expectedMemberEntitlementKind = memberInventoryKind === "ROOM" ? "ROOM_NIGHT" : "BED_NIGHT";
  const memberInventoryKindsMatch = before.effectiveDateInventoryUnit.kind === memberInventoryKind
    && (before.actualCurrentInventoryUnit === null || before.actualCurrentInventoryUnit.kind === memberInventoryKind);
  const memberCoverageKindsMatch = Array.isArray(pricing.coverageSet)
    && pricing.coverageSet.every((item) => isRecord(item) && item.unitKind === expectedMemberEntitlementKind);
  const noMemberFacts = preservedCoverage.length === 0 && migratedCoverage.length === 0 && consumedCoverage.length === 0;
  const nightlyCashLines = Array.isArray(pricing.cashLines) && pricing.cashLines.every((line) => (
    isRecord(line) && (line.lineKind === undefined || line.lineKind === "NIGHT")
      && typeof line.serviceDate === "string" && hasMoney(line.amount)
  ))
    ? pricing.cashLines as Array<Record<string, unknown> & { serviceDate: string; amount: EvidenceMoney }>
    : undefined;
  const nightlyCashDates = nightlyCashLines ? exactDateList(nightlyCashLines.map((line) => line.serviceDate)) : undefined;
  const nightlyCashTotal = nightlyCashLines?.reduce((sum, line) => sum + line.amount.minorUnits, 0);
  const uncoveredDates = pricingCoverageDates
    ? afterDates.filter((date) => !pricingCoverageDates.includes(date))
    : [];
  const memberCashEvidence = nightlyCashLines !== undefined && nightlyCashDates !== undefined
    && sameDateSet(nightlyCashDates, uncoveredDates)
    && nightlyCashLines.every((line) => line.amount.currency === targetAmount.currency && line.amount.minorUnits > 0)
    && nightlyCashTotal === pricing.cashRemainder.minorUnits
    && moneyMatches(pricing.cashRemainder, policyAmount);
  const freeCashEvidence = nightlyCashLines !== undefined && nightlyCashDates !== undefined
    && sameDateSet(nightlyCashDates, afterDates)
    && nightlyCashLines.every((line) => line.amount.currency === targetAmount.currency && line.amount.minorUnits === 0)
    && pricing.cashRemainder.minorUnits === 0;
  const paidCashEvidence = !memberPricing && !freePricing
    && pricingCashLinesHaveCompletePaidEvidence(
      pricing.cashLines,
      targetAmount.currency,
      afterTimelineByDate,
      pricing.cashRemainder,
      policyAmount
    );
  return Boolean(pricingCoverageDates
    && new Set(allCoverageDates).size === allCoverageDates.length
    && sameDateSet(pricingCoverageDates, allCoverageDates)
    && (memberPricing || freePricing ? true : pricingCoverageDates.length === 0 && noMemberFacts)
    && (!memberPricing || (memberInventoryKindsMatch && memberCoverageKindsMatch))
    && (memberPricing ? memberCashEvidence : freePricing ? freeCashEvidence : paidCashEvidence)
    && (!freePricing || noMemberFacts)
    && Number.isSafeInteger(entitlement.ledgerWriteCount)
    && (convertedMembershipCoveragePreserved
      ? memberPricing && migratedCoverage.length === 0 && entitlement.ledgerWriteCount === 0
      : entitlement.ledgerWriteCount === migratedCoverage.length * 2)
    && Number.isSafeInteger(funds.factCount) && Number(funds.factCount) >= 0
    && allCoverageDates.every((date) => afterDates.includes(date))
    && preservedCoverage.every((date) => expectedPreserved.some((claim) => claim.serviceDate === date))
    && migratedCoverage.every((date) => expectedAdded.some((claim) => claim.serviceDate === date))
    && consumedCoverage.every((date) => !migratedCoverage.includes(date) && !preservedCoverage.includes(date)));
}

export function moveUnitReceiptHasEvidence(
  value: unknown,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  const resourceRefs = isRecord(value) && Array.isArray(value.resourceRefs) && value.resourceRefs.every(nonblankString)
    ? value.resourceRefs as string[]
    : undefined;
  if (!receiptExecutionSemanticsAreCoherent(value) || !isRecord(value)
    || value.executionStatus !== "EXECUTED" || value.businessCommitted !== true
    || !hasOnlyKeys(value, ["receiptId", "commandId", "executionStatus", "businessCommitted", "correlationId", "result", "resourceRefs", "factRefs", "committedAt"], ["error"])
    || !nonblankString(value.receiptId) || !nonblankString(value.commandId) || !nonblankString(value.correlationId)
    || typeof value.committedAt !== "string" || Number.isNaN(Date.parse(value.committedAt))
    || value.error !== undefined
    || !resourceRefs
    || !Array.isArray(value.factRefs) || !value.factRefs.every(nonblankString)
    || !isRecord(value.result)) return false;
  const result = value.result;
  const requiredResultKeys = ["orderId", "stayId", "amendmentId", "staySegmentId", "pricingRevisionId", "businessDate", "effectiveDate", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary", "effectHash"];
  if (!hasExactKeys(result, requiredResultKeys)
    || !isEffectHash(result.effectHash)
    || (expectedEffectHash !== undefined && result.effectHash !== expectedEffectHash)
    || !nonblankString(result.orderId) || (input.orderId !== undefined && result.orderId !== input.orderId)
    || !nonblankString(result.stayId) || !nonblankString(result.amendmentId)
    || !nonblankString(result.staySegmentId) || !nonblankString(result.pricingRevisionId)
    || localDateEpoch(result.businessDate) === undefined
    || localDateEpoch(result.effectiveDate) === undefined || (input.effectiveDate !== undefined && result.effectiveDate !== input.effectiveDate)
    || ![result.orderId, result.stayId, result.amendmentId, result.staySegmentId, result.pricingRevisionId]
      .every((id) => resourceRefs.includes(id as string))) return false;

  const before = isRecord(result.before) ? result.before : undefined;
  const after = isRecord(result.after) ? result.after : undefined;
  const decision = isRecord(result.pricingDecision) ? result.pricingDecision : undefined;
  const inventory = isRecord(result.inventoryChange) ? result.inventoryChange : undefined;
  const entitlement = isRecord(result.entitlementSummary) ? result.entitlementSummary : undefined;
  const funds = isRecord(result.fundsSummary) ? result.fundsSummary : undefined;
  if (!before || !after || !decision || !inventory || !entitlement || !funds
    || !hasExactKeys(before, ["arrivalDate", "departureDate", "nights", "currentContractAmount", "stayTimeline", "actualCurrentInventoryUnit", "effectiveDateInventoryUnit"])
    || !hasExactKeys(after, ["arrivalDate", "departureDate", "nights", "stayTimeline", "pricing"])
    || !hasExactKeys(decision, ["pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy", "manualAdjustmentMinor", "differenceExceedsThreshold", "reason"])
    || !hasExactKeys(inventory, ["preservedClaims", "releasedClaims", "addedClaims"])
    || !hasExactKeys(entitlement, ["preservedCoverageDates", "migratedHeldCoverageDates", "consumedCoverageDates", "convertedMembershipCoveragePreserved", "ledgerWriteCount"])
    || !hasExactKeys(funds, ["netRecordedCollection", "collectionDifference", "factCount"])) return false;

  const beforeDates = typeof before.arrivalDate === "string" && typeof before.departureDate === "string"
    ? localDateRange(before.arrivalDate, before.departureDate) : undefined;
  const afterDates = typeof after.arrivalDate === "string" && typeof after.departureDate === "string"
    ? localDateRange(after.arrivalDate, after.departureDate) : undefined;
  const beforeTimeline = repriceStayTimeline(before.stayTimeline);
  const afterTimeline = repriceStayTimeline(after.stayTimeline);
  const effectiveDateUnit = isRecord(before.effectiveDateInventoryUnit) ? before.effectiveDateInventoryUnit : undefined;
  const actualCurrentUnit = isRecord(before.actualCurrentInventoryUnit) ? before.actualCurrentInventoryUnit : undefined;
  if (!beforeDates || !afterDates || !beforeTimeline || !afterTimeline
    || before.arrivalDate !== after.arrivalDate || before.departureDate !== after.departureDate
    || before.nights !== beforeDates.length || after.nights !== afterDates.length
    || !beforeTimeline.every((item, index) => item.serviceDate === beforeDates[index])
    || !afterTimeline.every((item, index) => item.serviceDate === afterDates[index])
    || !effectiveDateUnit || !moveInventoryUnitHasEvidence(effectiveDateUnit)
    || effectiveDateUnit.id !== beforeTimeline.find((item) => item.serviceDate === result.effectiveDate)?.inventoryUnitId
    || (before.actualCurrentInventoryUnit !== null && (!actualCurrentUnit || !moveInventoryUnitHasEvidence(actualCurrentUnit)))
    || !afterTimeline.every((item, index) => (
      item.serviceDate < String(result.effectiveDate)
        ? item.inventoryUnitId === beforeTimeline[index]?.inventoryUnitId
        : input.newInventoryUnitId === undefined || item.inventoryUnitId === input.newInventoryUnitId
    ))
    || afterTimeline.some((item) => item.serviceDate >= String(result.effectiveDate)
      && item.inventoryUnitId !== afterTimeline.at(-1)?.inventoryUnitId)
    || beforeTimeline.every((item, index) => item.inventoryUnitId === afterTimeline[index]?.inventoryUnitId)) return false;

  const expectedPreserved = beforeTimeline.filter((item, index) => item.inventoryUnitId === afterTimeline[index]?.inventoryUnitId);
  const expectedReleased = beforeTimeline.filter((item, index) => item.inventoryUnitId !== afterTimeline[index]?.inventoryUnitId);
  const expectedAdded = afterTimeline.filter((item, index) => item.inventoryUnitId !== beforeTimeline[index]?.inventoryUnitId);
  const preserved = moveClaimList(inventory.preservedClaims);
  const released = moveClaimList(inventory.releasedClaims);
  const added = moveClaimList(inventory.addedClaims);
  const pricing = isRecord(after.pricing) ? after.pricing : undefined;
  const pricingReason = isRecord(decision.reason) ? decision.reason : undefined;
  const beforeAmount = before.currentContractAmount;
  const policyAmount = decision.policyBaseAmount;
  const targetAmount = decision.targetCurrentContractAmount;
  const difference = decision.differenceFromPolicy;
  const netCollection = funds.netRecordedCollection;
  const collectionDifference = funds.collectionDifference;
  if (!preserved || !released || !added
    || !sameClaims(preserved, expectedPreserved) || !sameClaims(released, expectedReleased) || !sameClaims(added, expectedAdded)
    || !pricing || !hasExactKeys(pricing, ["coverageSet", "cashLines", "cashRemainder", "currentContractAmount"])
    || !pricingReason || !hasExactKeys(pricingReason, ["code", "note"])
    || !nonblankString(pricingReason.code) || typeof pricingReason.note !== "string"
    || !hasMoney(beforeAmount) || !hasMoney(policyAmount)
    || !hasMoney(targetAmount) || !hasMoney(difference)
    || !hasMoney(pricing.cashRemainder) || !hasMoney(pricing.currentContractAmount)
    || !hasMoney(netCollection) || !hasMoney(collectionDifference)
    || [beforeAmount, policyAmount, difference, pricing.cashRemainder,
      pricing.currentContractAmount, netCollection, collectionDifference]
      .some((amount) => amount.currency !== targetAmount.currency)
    || targetAmount.minorUnits < 0
    || targetAmount.minorUnits > 2_147_483_600
    || targetAmount.minorUnits % 100 !== 0
    || !moneyMatches(pricing.currentContractAmount, targetAmount)
    || difference.minorUnits !== targetAmount.minorUnits - policyAmount.minorUnits
    || collectionDifference.minorUnits !== targetAmount.minorUnits - netCollection.minorUnits
    || !Number.isSafeInteger(decision.manualAdjustmentMinor)
    || typeof decision.differenceExceedsThreshold !== "boolean"
    || decision.differenceExceedsThreshold !== (Math.abs(difference.minorUnits) * 100 > policyAmount.minorUnits * 15)
    || !Number.isSafeInteger(entitlement.ledgerWriteCount) || !Number.isSafeInteger(funds.factCount)
    || Number(funds.factCount) < 0) return false;

  const pricingBasis = decision.pricingBasis;
  if (pricingBasis !== "POLICY" && pricingBasis !== "CHANNEL_CONTRACT" && pricingBasis !== "MANUAL_ADJUSTMENT"
    && pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE") return false;
  if ((pricingBasis === "MANUAL_ADJUSTMENT"
    ? decision.manualAdjustmentMinor !== difference.minorUnits
    : decision.manualAdjustmentMinor !== 0)
    || (pricingBasis === "CHANNEL_CONTRACT" && (pricingReason.code !== "MOVE_UNIT_CHANNEL_CONTRACT"
      || (decision.differenceExceedsThreshold && !nonblankString(pricingReason.note))))
    || (pricingBasis === "MANUAL_ADJUSTMENT" && (pricingReason.code !== "MOVE_UNIT_MANUAL_PRICE"
      || !nonblankString(pricingReason.note)
      || targetAmount.minorUnits === policyAmount.minorUnits))
    || (pricingBasis === "POLICY" && (pricingReason.code !== "MOVE_UNIT_POLICY" || pricingReason.note !== ""
      || !moneyMatches(targetAmount, policyAmount)))
    || (pricingBasis === "MEMBER_ENTITLEMENT" && (pricingReason.code !== "MOVE_UNIT_MEMBER" || pricingReason.note !== ""
      || !moneyMatches(targetAmount, policyAmount)))
    || (pricingBasis === "FREE" && (pricingReason.code !== "MOVE_UNIT_FREE" || pricingReason.note !== ""
      || policyAmount.minorUnits !== 0 || targetAmount.minorUnits !== 0))) return false;

  const preservedCoverage = exactDateList(entitlement.preservedCoverageDates);
  const migratedCoverage = exactDateList(entitlement.migratedHeldCoverageDates);
  const consumedCoverage = exactDateList(entitlement.consumedCoverageDates);
  const convertedMembershipCoveragePreserved = entitlement.convertedMembershipCoveragePreserved;
  if (!preservedCoverage || !migratedCoverage || !consumedCoverage
    || typeof convertedMembershipCoveragePreserved !== "boolean"
    || (convertedMembershipCoveragePreserved
      ? migratedCoverage.length !== 0 || entitlement.ledgerWriteCount !== 0 || (value.factRefs as string[]).length !== 0
      : entitlement.ledgerWriteCount !== migratedCoverage.length * 2 || (value.factRefs as string[]).length !== entitlement.ledgerWriteCount)) return false;
  const historicalCoverageDates = new Set(consumedCoverage);
  const afterTimelineByDate = new Map(afterTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  const beforeTimelineByDate = new Map(beforeTimeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
  if (!pricingCoverageHasEvidence(pricing.coverageSet, afterTimelineByDate, historicalCoverageDates)
    || !(pricing.coverageSet as unknown[]).every((item) => !isRecord(item)
      || convertedMembershipCoveragePreserved
      || !consumedCoverage.includes(String(item.serviceDate))
      || beforeTimelineByDate.get(String(item.serviceDate)) === item.inventoryUnitId)
    || !Array.isArray(pricing.cashLines)
    || !pricing.cashLines.every((line) => pricingCashLineHasEvidence(line, targetAmount.currency, afterTimelineByDate))) return false;
  const coverageDates = exactDateList((pricing.coverageSet as unknown[]).map((item) => isRecord(item) ? item.serviceDate : undefined));
  const allCoverageDates = [...preservedCoverage, ...migratedCoverage, ...consumedCoverage];
  const noMemberFacts = allCoverageDates.length === 0;
  const nightlyCashLines = pricing.cashLines.every((line) => isRecord(line)
    && (line.lineKind === undefined || line.lineKind === "NIGHT")
    && typeof line.serviceDate === "string" && hasMoney(line.amount))
    ? pricing.cashLines as Array<Record<string, unknown> & { serviceDate: string; amount: EvidenceMoney }>
    : undefined;
  const nightlyCashDates = nightlyCashLines ? exactDateList(nightlyCashLines.map((line) => line.serviceDate)) : undefined;
  const uncoveredDates = coverageDates ? afterDates.filter((date) => !coverageDates.includes(date)) : [];
  const memberCashEvidence = nightlyCashLines !== undefined && nightlyCashDates !== undefined
    && sameDateSet(nightlyCashDates, uncoveredDates)
    && nightlyCashLines.every((line) => line.amount.currency === targetAmount.currency && line.amount.minorUnits > 0)
    && nightlyCashLines.reduce((sum, line) => sum + line.amount.minorUnits, 0) === pricing.cashRemainder.minorUnits
    && moneyMatches(pricing.cashRemainder, policyAmount);
  const freeCashEvidence = nightlyCashLines !== undefined && nightlyCashDates !== undefined
    && sameDateSet(nightlyCashDates, afterDates)
    && nightlyCashLines.every((line) => line.amount.currency === targetAmount.currency && line.amount.minorUnits === 0)
    && pricing.cashRemainder.minorUnits === 0;
  if (!coverageDates || new Set(allCoverageDates).size !== allCoverageDates.length
    || !sameDateSet(coverageDates, allCoverageDates)
    || (pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE" && (!noMemberFacts || coverageDates.length > 0))
    || (pricingBasis === "MEMBER_ENTITLEMENT" ? !memberCashEvidence
      : pricingBasis === "FREE" ? !freeCashEvidence || !noMemberFacts
        : !moneyMatches(pricing.cashRemainder, policyAmount))
    || !allCoverageDates.every((date) => afterDates.includes(date))
    || !preservedCoverage.every((date) => expectedPreserved.some((claim) => claim.serviceDate === date))
    || !migratedCoverage.every((date) => expectedAdded.some((claim) => claim.serviceDate === date))
    || consumedCoverage.some((date) => preservedCoverage.includes(date) || migratedCoverage.includes(date))
    || (convertedMembershipCoveragePreserved && pricingBasis !== "MEMBER_ENTITLEMENT")) return false;

  if (previewEffect) {
    if (!moveUnitPreviewHasEvidence(previewEffect, input)) return false;
    for (const key of ["orderId", "stayId", "businessDate", "effectiveDate", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary"] as const) {
      if (!evidenceValuesEqual(result[key], previewEffect[key])) return false;
    }
  }
  return true;
}

export function moveUnitPreviewSummary(preview: PreviewDto, input: Record<string, unknown>): MoveUnitPreviewSummary | undefined {
  if (!moveUnitPreviewHasEvidence(preview.effect, input)) return undefined;
  const before = preview.effect.before as Record<string, unknown>;
  const after = preview.effect.after as Record<string, unknown>;
  const decision = preview.effect.pricingDecision as Record<string, unknown>;
  const funds = preview.effect.fundsSummary as Record<string, unknown>;
  const beforeTimeline = repriceStayTimeline(before.stayTimeline);
  const afterTimeline = repriceStayTimeline(after.stayTimeline);
  const beforeAmount = moneyFrom(before.currentContractAmount);
  const policyBaseAmount = moneyFrom(decision.policyBaseAmount);
  const targetAmount = moneyFrom(decision.targetCurrentContractAmount);
  const differenceFromPolicy = moneyFrom(decision.differenceFromPolicy);
  const netRecordedCollection = moneyFrom(funds.netRecordedCollection);
  const collectionDifference = moneyFrom(funds.collectionDifference);
  const pricingBasis = decision.pricingBasis;
  if (!beforeTimeline || !afterTimeline || !beforeAmount || !policyBaseAmount || !targetAmount || !differenceFromPolicy
    || !netRecordedCollection || !collectionDifference
    || (pricingBasis !== "POLICY" && pricingBasis !== "CHANNEL_CONTRACT" && pricingBasis !== "MANUAL_ADJUSTMENT" && pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE")) return undefined;
  return {
    effectiveDate: String(preview.effect.effectiveDate),
    businessDate: String(preview.effect.businessDate),
    beforeTimeline,
    afterTimeline,
    beforeAmount,
    policyBaseAmount,
    targetAmount,
    differenceFromPolicy,
    netRecordedCollection,
    collectionDifference,
    pricingBasis
  };
}

export function stayDatePreviewPricingSummary(
  commandType: "RESCHEDULE_STAY" | "EXTEND_STAY" | "SHORTEN_STAY",
  preview: PreviewDto,
  input: Record<string, unknown>
): StayDatePreviewPricingSummary | undefined {
  if (!dateChangePreviewHasEvidence(commandType, preview.effect, input)) return undefined;
  const before = isRecord(preview.effect.before) ? preview.effect.before : undefined;
  const decision = isRecord(preview.effect.pricingDecision) ? preview.effect.pricingDecision : undefined;
  const funds = isRecord(preview.effect.fundsSummary) ? preview.effect.fundsSummary : undefined;
  const beforeAmount = moneyFrom(before?.currentContractAmount);
  const policyBaseAmount = moneyFrom(decision?.policyBaseAmount);
  const targetAmount = moneyFrom(decision?.targetCurrentContractAmount);
  const differenceFromPolicy = moneyFrom(decision?.differenceFromPolicy);
  const netRecordedCollection = moneyFrom(funds?.netRecordedCollection);
  const collectionDifference = moneyFrom(funds?.collectionDifference);
  const refundReferenceAmount = commandType === "SHORTEN_STAY"
    ? moneyFrom(preview.effect.refundReferenceAmount)
    : { currency: targetAmount?.currency ?? "CNY", minorUnits: 0 };
  const pricingBasis = decision?.pricingBasis;
  const afterTimeline = repriceStayTimeline(isRecord(preview.effect.after) ? preview.effect.after.stayTimeline : undefined);
  if (!beforeAmount || !policyBaseAmount || !targetAmount || !differenceFromPolicy
    || !netRecordedCollection || !collectionDifference || !refundReferenceAmount || !afterTimeline
    || (pricingBasis !== "POLICY" && pricingBasis !== "CHANNEL_CONTRACT" && pricingBasis !== "MANUAL_ADJUSTMENT"
      && pricingBasis !== "MEMBER_ENTITLEMENT" && pricingBasis !== "FREE")) return undefined;
  return {
    beforeArrivalDate: String(before?.arrivalDate),
    beforeDepartureDate: String(before?.departureDate),
    beforeNights: Number(before?.nights),
    afterArrivalDate: String(isRecord(preview.effect.after) ? preview.effect.after.arrivalDate : ""),
    afterDepartureDate: String(isRecord(preview.effect.after) ? preview.effect.after.departureDate : ""),
    afterNights: Number(isRecord(preview.effect.after) ? preview.effect.after.nights : 0),
    afterTimeline,
    ...(commandType === "SHORTEN_STAY" ? { completionMode: preview.effect.completionMode as "SHORTEN_IN_HOUSE" | "EARLY_CHECK_OUT" } : {}),
    beforeAmount,
    policyBaseAmount,
    targetAmount,
    differenceFromPolicy,
    netRecordedCollection,
    collectionDifference,
    refundReferenceAmount,
    pricingBasis
  };
}

function repriceStayTimeline(value: unknown): Array<{ serviceDate: string; inventoryUnitId: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const timeline: Array<{ serviceDate: string; inventoryUnitId: string }> = [];
  let previousEpoch: number | undefined;
  for (const item of value) {
    if (!isRecord(item) || !nonblankString(item.serviceDate) || !nonblankString(item.inventoryUnitId)) return undefined;
    const epoch = localDateEpoch(item.serviceDate);
    if (epoch === undefined || (previousEpoch !== undefined && epoch !== previousEpoch + 86_400_000)) return undefined;
    timeline.push({ serviceDate: item.serviceDate, inventoryUnitId: item.inventoryUnitId });
    previousEpoch = epoch;
  }
  return timeline;
}

function pricingCoverageHasEvidence(
  value: unknown,
  timelineByDate: Map<string, string>,
  allowConsumedHistoricalInventoryUnit: boolean | ReadonlySet<string> = false
): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && nonblankString(item.serviceDate)
    && nonblankString(item.inventoryUnitId)
    && timelineByDate.has(item.serviceDate)
    && (timelineByDate.get(item.serviceDate) === item.inventoryUnitId
      || allowConsumedHistoricalInventoryUnit === true
      || (allowConsumedHistoricalInventoryUnit !== false && allowConsumedHistoricalInventoryUnit.has(item.serviceDate)))
    && (item.unitKind === "ROOM_NIGHT" || item.unitKind === "BED_NIGHT")
    && nonblankString(item.entitlementLotId));
}

function pricingCashLineHasEvidence(value: unknown, currency: string, timelineByDate: Map<string, string>): boolean {
  if (!isRecord(value) || !hasMoney(value.amount) || value.amount.currency !== currency
    || !nonblankString(value.inventoryUnitId) || !nonblankString(value.description)) return false;
  if (value.lineKind === "STAY_TOTAL") {
    if (!hasExactKeys(value, [
      "lineKind", "arrivalDate", "departureDate", "inventoryUnitId", "description",
      "pricingBandAnchorNights", "calculationSegments", "amount"
    ])
      || !hasExactKeys(value.amount, ["currency", "minorUnits"])
      || typeof value.arrivalDate !== "string"
      || typeof value.departureDate !== "string"
      || localDateNightCount(value.arrivalDate, value.departureDate) === undefined
      || (value.pricingBandAnchorNights !== 1 && value.pricingBandAnchorNights !== 7
        && value.pricingBandAnchorNights !== 14 && value.pricingBandAnchorNights !== 30)
      || !Array.isArray(value.calculationSegments)
      || value.calculationSegments.length === 0) return false;
    const stayDates = localDateRange(value.arrivalDate, value.departureDate);
    if (!stayDates || stayDates.length !== timelineByDate.size
      || !stayDates.every((date) => timelineByDate.has(date))
      || timelineByDate.get(stayDates[0]!) !== value.inventoryUnitId) return false;

    let nextSegmentArrival = value.arrivalDate;
    let totalNumerator = 0n;
    for (const rawSegment of value.calculationSegments) {
      if (!isRecord(rawSegment) || !hasExactKeys(rawSegment, [
        "inventoryUnitId", "pricingProductCode", "arrivalDate", "departureDate", "nights",
        "anchorAmountMinor", "numeratorMinor", "denominator"
      ])
        || !nonblankString(rawSegment.inventoryUnitId)
        || !nonblankString(rawSegment.pricingProductCode)
        || typeof rawSegment.arrivalDate !== "string"
        || typeof rawSegment.departureDate !== "string"
        || rawSegment.arrivalDate !== nextSegmentArrival
        || !Number.isSafeInteger(rawSegment.nights) || Number(rawSegment.nights) < 1
        || !Number.isSafeInteger(rawSegment.anchorAmountMinor) || Number(rawSegment.anchorAmountMinor) < 1
        || !Number.isSafeInteger(rawSegment.numeratorMinor) || Number(rawSegment.numeratorMinor) < 1
        || rawSegment.denominator !== value.pricingBandAnchorNights) return false;
      const segmentDates = localDateRange(rawSegment.arrivalDate, rawSegment.departureDate);
      if (!segmentDates || segmentDates.length !== rawSegment.nights
        || !segmentDates.every((date) => timelineByDate.get(date) === rawSegment.inventoryUnitId)) return false;
      const exactNumerator = BigInt(Number(rawSegment.nights)) * BigInt(Number(rawSegment.anchorAmountMinor));
      if (BigInt(Number(rawSegment.numeratorMinor)) !== exactNumerator) return false;
      totalNumerator += exactNumerator;
      nextSegmentArrival = rawSegment.departureDate;
    }
    if (nextSegmentArrival !== value.departureDate) return false;
    const denominatorMinor = BigInt(value.pricingBandAnchorNights) * 100n;
    const roundedMinor = ((totalNumerator * 2n + denominatorMinor) / (denominatorMinor * 2n)) * 100n;
    return BigInt(value.amount.minorUnits) === roundedMinor;
  }
  return (value.lineKind === undefined || value.lineKind === "NIGHT")
    && nonblankString(value.serviceDate)
    && timelineByDate.get(value.serviceDate) === value.inventoryUnitId;
}

function pricingCashLinesHaveCompletePaidEvidence(
  value: unknown,
  currency: string,
  timelineByDate: Map<string, string>,
  cashRemainder: unknown,
  policyBaseAmount: unknown
): boolean {
  if (!Array.isArray(value) || value.length === 0
    || !hasMoney(cashRemainder) || !hasMoney(policyBaseAmount)
    || cashRemainder.currency !== currency || policyBaseAmount.currency !== currency
    || !moneyMatches(cashRemainder, policyBaseAmount)) return false;

  const coveredDates: string[] = [];
  let authoritativeTotal = 0n;
  for (const line of value) {
    if (!pricingCashLineHasEvidence(line, currency, timelineByDate) || !isRecord(line) || !hasMoney(line.amount)
      || line.amount.minorUnits <= 0) return false;
    if (line.lineKind === "STAY_TOTAL") {
      const dates = typeof line.arrivalDate === "string" && typeof line.departureDate === "string"
        ? localDateRange(line.arrivalDate, line.departureDate)
        : undefined;
      if (!dates) return false;
      coveredDates.push(...dates);
    } else {
      const expectedKeys = line.lineKind === undefined
        ? ["serviceDate", "inventoryUnitId", "description", "amount"]
        : ["lineKind", "serviceDate", "inventoryUnitId", "description", "amount"];
      if (!hasExactKeys(line, expectedKeys)
        || !hasExactKeys(line.amount, ["currency", "minorUnits"])
        || typeof line.serviceDate !== "string") return false;
      coveredDates.push(line.serviceDate);
    }
    authoritativeTotal += BigInt(line.amount.minorUnits);
  }
  const exactCoveredDates = exactDateList(coveredDates);
  return exactCoveredDates !== undefined
    && sameDateSet(exactCoveredDates, [...timelineByDate.keys()])
    && authoritativeTotal === BigInt(cashRemainder.minorUnits);
}

type OrderLifecycleCommand = "CANCEL_ORDER" | "MARK_NO_SHOW" | "REVOKE_CHECK_IN";

function orderLifecycleExpectedTransition(commandType: OrderLifecycleCommand) {
  if (commandType === "CANCEL_ORDER") return { from: "RESERVED", to: "CANCELLED", entitlementFrom: "HELD", entitlementTo: "RELEASED" } as const;
  if (commandType === "MARK_NO_SHOW") return { from: "RESERVED", to: "NO_SHOW", entitlementFrom: "HELD", entitlementTo: "RELEASED" } as const;
  return { from: "CHECKED_IN", to: "CHECK_IN_REVOKED", entitlementFrom: "CONSUMED", entitlementTo: "RESTORED" } as const;
}

export function orderLifecyclePreviewHasEvidence(
  commandType: OrderLifecycleCommand,
  effect: Record<string, unknown>,
  input: Record<string, unknown> = {}
): boolean {
  const expectedKeys = commandType === "REVOKE_CHECK_IN"
    ? ["orderId", "fromStatus", "toStatus", "inventoryUnitId", "businessDate", "effectiveDate", "recordingMode", "currentContractAmount", "amounts", "entitlementTransition", "unusedRoomConfirmed", "pricingRevision"]
    : ["orderId", "fromStatus", "toStatus", "inventoryUnitId", "businessDate", "freeStayReason", "freeStayCategoryCode", "currentContractAmount", "amounts", "entitlementTransition", "pricingRevision"];
  if (!hasExactKeys(effect, expectedKeys)
    || !nonblankString(effect.orderId)
    || (input.orderId !== undefined && effect.orderId !== input.orderId)
    || !nonblankString(effect.inventoryUnitId)
    || localDateEpoch(effect.businessDate) === undefined
    || (commandType === "REVOKE_CHECK_IN" && (
      effect.effectiveDate !== effect.businessDate || effect.recordingMode !== "ON_SCHEDULE"
    ))
    || (commandType === "REVOKE_CHECK_IN" && (input.unusedRoomConfirmed !== true || effect.unusedRoomConfirmed !== true))) return false;

  const transition = orderLifecycleExpectedTransition(commandType);
  const currentContractAmount = moneyFrom(effect.currentContractAmount);
  const amounts = isRecord(effect.amounts) ? effect.amounts : undefined;
  const pricingRevision = isRecord(effect.pricingRevision) ? effect.pricingRevision : undefined;
  const entitlement = isRecord(effect.entitlementTransition) ? effect.entitlementTransition : undefined;
  if (effect.fromStatus !== transition.from || effect.toStatus !== transition.to
    || !currentContractAmount || currentContractAmount.minorUnits !== 0
    || !amounts || !hasExactKeys(amounts, ["currentContractAmount", "netRecordedCollection", "collectionDifference", "refundReferenceAmount"])
    || !pricingRevision || !hasExactKeys(pricingRevision, ["currentContractAmount", "pricingBasis"])
    || !entitlement || !hasExactKeys(entitlement, ["from", "to", "coverageCount"])) return false;

  const amountCurrent = moneyFrom(amounts.currentContractAmount);
  const netCollection = moneyFrom(amounts.netRecordedCollection);
  const collectionDifference = moneyFrom(amounts.collectionDifference);
  const refundReferenceAmount = moneyFrom(amounts.refundReferenceAmount);
  const revisionAmount = moneyFrom(pricingRevision.currentContractAmount);
  return Boolean(amountCurrent && netCollection && collectionDifference && refundReferenceAmount && revisionAmount
    && [amountCurrent, netCollection, collectionDifference, refundReferenceAmount, revisionAmount]
      .every((amount) => amount.currency === currentContractAmount.currency)
    && amountCurrent.minorUnits === 0
    && revisionAmount.minorUnits === 0
    && netCollection.minorUnits >= 0
    && collectionDifference.minorUnits === -netCollection.minorUnits
    && refundReferenceAmount.minorUnits === netCollection.minorUnits
    && typeof pricingRevision.pricingBasis === "string"
    && ["POLICY", "CHANNEL_CONTRACT", "MANUAL_ADJUSTMENT", "MEMBER_ENTITLEMENT", "FREE"].includes(pricingRevision.pricingBasis)
    && entitlement.from === transition.entitlementFrom
    && entitlement.to === transition.entitlementTo
    && Number.isSafeInteger(entitlement.coverageCount)
    && Number(entitlement.coverageCount) >= 0);
}

function exactNonblankStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(nonblankString) && new Set(value).size === value.length
    ? value as string[]
    : undefined;
}

function conversionIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replaceAll(/\s/g, "").toUpperCase()
    : undefined;
}

export function conversionPreviewHasEvidence(
  effect: Record<string, unknown>,
  input: Record<string, unknown>
): boolean {
  const expectedCollectionIds = exactNonblankStringList(input.collectionFactIds);
  const primaryOccupant = isRecord(effect.primaryOccupant) ? effect.primaryOccupant : undefined;
  const member = isRecord(effect.member) ? effect.member : undefined;
  const product = isRecord(effect.product) ? effect.product : undefined;
  const transfer = isRecord(effect.transfer) ? effect.transfer : undefined;
  const membershipPricing = isRecord(effect.membershipPricing) ? effect.membershipPricing : undefined;
  const entitlement = isRecord(effect.entitlement) ? effect.entitlement : undefined;
  const before = isRecord(effect.before) ? effect.before : undefined;
  const decision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const pricing = isRecord(effect.pricing) ? effect.pricing : undefined;
  if (effect.operation !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
    || !hasExactKeys(effect, ["operation", "orderId", "stayId", "primaryOccupant", "member", "product", "transfer", "membershipPricing", "remainingPayment", "entitlement", "before", "pricingDecision", "pricing"])
    || !nonblankString(effect.orderId) || effect.orderId !== input.orderId
    || !nonblankString(effect.stayId)
    || !expectedCollectionIds
    || !primaryOccupant || !member || !product || !transfer || !membershipPricing
    || !entitlement || !before || !decision || !pricing
    || !hasExactKeys(primaryOccupant, ["fullName", "nickname", "phone"])
    || !hasExactKeys(member, ["memberId", "fullName", "phone"])
    || !hasExactKeys(product, ["productId", "code", "version", "name", "entitlementUnitKind", "entitlementUnits", "allowedRoomTypeCode", "allowedInventoryKind"])
    || !hasExactKeys(transfer, ["collections", "total"])
    || !hasExactKeys(membershipPricing, ["listedPrice", "agreedPrice", "adjustment", "adjustmentReason"])
    || !hasExactKeys(entitlement, ["entitlementUnitKind", "entitlementUnits", "consumedUnits", "remainingUnits", "serviceDates", "validFrom", "validUntil"])
    || !hasExactKeys(before, ["currentContractAmount", "netRecordedCollection"])
    || !hasExactKeys(decision, ["pricingBasis", "policyBaseAmount", "targetCurrentContractAmount", "differenceFromPolicy", "manualAdjustmentMinor", "differenceExceedsThreshold", "reason"])
    || !hasExactKeys(pricing, ["coverageSet", "cashLines", "cashRemainder", "currentContractAmount"])
    || member.memberId !== input.memberId
    || product.productId !== input.membershipProductId
    || !nonblankString(member.fullName) || !nonblankString(member.phone)
    || !nonblankString(primaryOccupant.phone)
    || conversionIdentity(member.phone) !== conversionIdentity(primaryOccupant.phone)
    || !nonblankString(product.code) || !nonblankString(product.name)
    || !nonblankString(product.allowedRoomTypeCode)
    || (product.allowedInventoryKind !== "ROOM" && product.allowedInventoryKind !== "BED")
    || (product.entitlementUnitKind !== "ROOM_NIGHT" && product.entitlementUnitKind !== "BED_NIGHT")
    || product.entitlementUnitKind !== entitlement.entitlementUnitKind
    || !Number.isSafeInteger(product.version) || Number(product.version) < 1
    || !Number.isSafeInteger(product.entitlementUnits) || Number(product.entitlementUnits) < 1
    || product.entitlementUnits !== entitlement.entitlementUnits
    || !hasMoney(transfer.total)
    || !hasMoney(membershipPricing.listedPrice)
    || !hasMoney(membershipPricing.agreedPrice)
    || !hasMoney(membershipPricing.adjustment)
    || !hasMoney(before.currentContractAmount)
    || !hasMoney(before.netRecordedCollection)) return false;

  const transferCollections = Array.isArray(transfer.collections) ? transfer.collections : undefined;
  if (!transferCollections || transferCollections.length !== expectedCollectionIds.length) return false;
  let transferSum = 0;
  for (let index = 0; index < transferCollections.length; index += 1) {
    const collection = isRecord(transferCollections[index]) ? transferCollections[index] as Record<string, unknown> : undefined;
    if (!collection
      || !hasExactKeys(collection, ["factId", "amount", "transactionReference", "recordedAt"])
      || collection.factId !== expectedCollectionIds[index]
      || !hasMoney(collection.amount) || collection.amount.currency !== transfer.total.currency
      || collection.amount.minorUnits <= 0
      || !nonblankString(collection.transactionReference)
      || typeof collection.recordedAt !== "string" || Number.isNaN(Date.parse(collection.recordedAt))) return false;
    transferSum += collection.amount.minorUnits;
  }

  const listedPrice = membershipPricing.listedPrice;
  const agreedPrice = membershipPricing.agreedPrice;
  const adjustment = membershipPricing.adjustment;
  const agreedPriceInput = input.agreedPriceMinor;
  const expectedAdjustmentReason = typeof input.priceAdjustmentReason === "string" && input.priceAdjustmentReason.trim()
    ? input.priceAdjustmentReason.trim()
    : null;
  if (!Number.isSafeInteger(transferSum) || transferSum !== transfer.total.minorUnits
    || !Number.isSafeInteger(agreedPriceInput) || Number(agreedPriceInput) < transferSum
    || agreedPrice.minorUnits !== agreedPriceInput
    || listedPrice.currency !== agreedPrice.currency
    || adjustment.currency !== agreedPrice.currency
    || transfer.total.currency !== agreedPrice.currency
    || adjustment.minorUnits !== agreedPrice.minorUnits - listedPrice.minorUnits
    || membershipPricing.adjustmentReason !== expectedAdjustmentReason
    || !moneyMatches(before.netRecordedCollection, transfer.total)
    || before.currentContractAmount.currency !== agreedPrice.currency) return false;

  const remainingMinor = agreedPrice.minorUnits - transfer.total.minorUnits;
  const inputRemainingReference = typeof input.remainingPaymentTransactionReference === "string"
    ? input.remainingPaymentTransactionReference.trim()
    : "";
  const inputRemainingNote = typeof input.remainingPaymentNote === "string" ? input.remainingPaymentNote.trim() : "";
  if (remainingMinor === 0) {
    if (effect.remainingPayment !== null || inputRemainingReference) return false;
  } else {
    const remainingPayment = isRecord(effect.remainingPayment) ? effect.remainingPayment : undefined;
    if (!remainingPayment
      || !hasExactKeys(remainingPayment, ["amount", "transactionReference", "note"])
      || !moneyMatches(remainingPayment.amount, { currency: agreedPrice.currency, minorUnits: remainingMinor })
      || remainingPayment.transactionReference !== inputRemainingReference
      || remainingPayment.note !== inputRemainingNote) return false;
  }

  const serviceDates = exactNonblankStringList(entitlement.serviceDates);
  if (!serviceDates || serviceDates.some((date) => localDateEpoch(date) === undefined)
    || !Number.isSafeInteger(entitlement.consumedUnits) || Number(entitlement.consumedUnits) < 1
    || entitlement.consumedUnits !== serviceDates.length
    || !Number.isSafeInteger(entitlement.remainingUnits) || Number(entitlement.remainingUnits) < 0
    || Number(entitlement.entitlementUnits) - Number(entitlement.consumedUnits) !== entitlement.remainingUnits
    || localDateEpoch(entitlement.validFrom) === undefined
    || localDateEpoch(entitlement.validUntil) === undefined
    || Number(localDateEpoch(entitlement.validUntil)) <= Number(localDateEpoch(entitlement.validFrom))) return false;

  const reason = isRecord(decision.reason) ? decision.reason : undefined;
  return decision.pricingBasis === "MEMBER_ENTITLEMENT"
    && decision.manualAdjustmentMinor === 0
    && decision.differenceExceedsThreshold === false
    && reason?.code === "STAY_COLLECTION_TO_MEMBERSHIP"
    && reason.note === "升级会员，住宿金额归零"
    && [decision.policyBaseAmount, decision.targetCurrentContractAmount, decision.differenceFromPolicy, pricing.cashRemainder, pricing.currentContractAmount]
      .every((money) => hasMoney(money) && money.currency === agreedPrice.currency && money.minorUnits === 0)
    && Array.isArray(pricing.coverageSet) && pricing.coverageSet.length === 0
    && Array.isArray(pricing.cashLines) && pricing.cashLines.length === 0;
}

export function conversionReceiptHasEvidence(
  value: unknown,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  const expectedOrderId = nonblankString(input.orderId) ? input.orderId : undefined;
  const expectedMemberId = nonblankString(input.memberId) ? input.memberId : undefined;
  const expectedCollectionIds = exactNonblankStringList(input.collectionFactIds);
  const expectedAgreedPriceMinor = Number.isSafeInteger(input.agreedPriceMinor) && Number(input.agreedPriceMinor) >= 0
    ? Number(input.agreedPriceMinor)
    : undefined;
  const hasFullInput = expectedOrderId !== undefined
    && expectedMemberId !== undefined
    && expectedCollectionIds !== undefined
    && expectedAgreedPriceMinor !== undefined;
  const hasCurrentRecoveryInput = hasExactKeys(input, ["propertyId", "orderId", "memberId"])
    && nonblankString(input.propertyId)
    && expectedOrderId !== undefined
    && expectedMemberId !== undefined
    && isEffectHash(expectedEffectHash);
  const hasHistoricalRecoveryInput = hasExactKeys(input, ["propertyId", "orderId"])
    && nonblankString(input.propertyId)
    && expectedOrderId !== undefined
    && isEffectHash(expectedEffectHash);
  if (!hasFullInput && !hasCurrentRecoveryInput && !hasHistoricalRecoveryInput) return false;

  if (!receiptExecutionSemanticsAreCoherent(value) || !isRecord(value)
    || value.executionStatus !== "EXECUTED" || value.businessCommitted !== true
    || !hasOnlyKeys(value, ["receiptId", "commandId", "executionStatus", "businessCommitted", "correlationId", "result", "resourceRefs", "factRefs", "committedAt"], ["error", "protocolVersion", "recoveryMode"])
    || !nonblankString(value.receiptId) || !nonblankString(value.commandId) || !nonblankString(value.correlationId)
    || typeof value.committedAt !== "string" || Number.isNaN(Date.parse(value.committedAt))
    || value.error !== undefined || !isRecord(value.result)) return false;
  const historicalCompletedConversion = value.protocolVersion === "PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"
    && value.recoveryMode === "HISTORICAL_READ_ONLY";
  const currentConversion = value.protocolVersion === undefined && value.recoveryMode === undefined;
  if (!historicalCompletedConversion && !currentConversion) return false;
  const hasRecoveryInput = hasCurrentRecoveryInput
    || (historicalCompletedConversion && hasHistoricalRecoveryInput);
  if (!hasFullInput && !hasRecoveryInput) return false;
  const resourceRefs = exactNonblankStringList(value.resourceRefs);
  const factRefs = exactNonblankStringList(value.factRefs);
  const result = value.result;
  if (!resourceRefs || !factRefs
    || !hasExactKeys(result, ["orderId", "memberId", "amendmentId", "pricingRevisionId", "membershipOrderId", "status", "contractId", "entitlementLotId", "transferredCollectionFactIds", "lodgingReversalFactIds", "membershipPaymentFactIds", "transferIds", "conversionMode", "conversionCoverageIds", "conversionLedgerFactIds", "transferredAmount", "membershipAgreedPrice", "remainingPaymentAmount", "entitlementUnitKind", "convertedUnits", "remainingUnits", "effectHash"])
    || !nonblankString(result.orderId) || !nonblankString(result.memberId)
    || ((hasFullInput || hasRecoveryInput) && result.orderId !== expectedOrderId)
    || (expectedMemberId !== undefined && result.memberId !== expectedMemberId)
    || result.status !== "ACTIVE"
    || !nonblankString(result.amendmentId) || !nonblankString(result.pricingRevisionId)
    || !nonblankString(result.membershipOrderId) || !nonblankString(result.contractId)
    || !nonblankString(result.entitlementLotId)
    || (result.conversionMode !== "IN_HOUSE" && result.conversionMode !== "COMPLETED")
    || (historicalCompletedConversion && result.conversionMode !== "COMPLETED")
    || !isEffectHash(result.effectHash)
    || (expectedEffectHash !== undefined && result.effectHash !== expectedEffectHash)
    || !hasMoney(result.transferredAmount) || result.transferredAmount.minorUnits < 0
    || !hasMoney(result.membershipAgreedPrice)
    || !hasMoney(result.remainingPaymentAmount)
    || result.transferredAmount.currency !== result.membershipAgreedPrice.currency
    || result.remainingPaymentAmount.currency !== result.membershipAgreedPrice.currency
    || (hasFullInput && result.membershipAgreedPrice.minorUnits !== expectedAgreedPriceMinor)
    || result.transferredAmount.minorUnits + result.remainingPaymentAmount.minorUnits !== result.membershipAgreedPrice.minorUnits
    || (result.entitlementUnitKind !== "ROOM_NIGHT" && result.entitlementUnitKind !== "BED_NIGHT")
    || !Number.isSafeInteger(result.convertedUnits) || Number(result.convertedUnits) < 1
    || !Number.isSafeInteger(result.remainingUnits) || Number(result.remainingUnits) < 0) return false;

  const sourceIds = exactNonblankStringList(result.transferredCollectionFactIds);
  const reversalIds = exactNonblankStringList(result.lodgingReversalFactIds);
  const paymentIds = exactNonblankStringList(result.membershipPaymentFactIds);
  const transferIds = exactNonblankStringList(result.transferIds);
  const coverageIds = exactNonblankStringList(result.conversionCoverageIds);
  const ledgerIds = exactNonblankStringList(result.conversionLedgerFactIds);
  if (!sourceIds || !reversalIds || !paymentIds || !transferIds || !coverageIds || !ledgerIds
    || (hasFullInput && !evidenceValuesEqual(sourceIds, expectedCollectionIds))
    || reversalIds.length !== sourceIds.length
    || transferIds.length !== sourceIds.length
    || paymentIds.length !== sourceIds.length + (result.remainingPaymentAmount.minorUnits > 0 ? 1 : 0)
    || (result.conversionMode === "IN_HOUSE" && coverageIds.length !== result.convertedUnits)
    || (result.conversionMode === "COMPLETED" && coverageIds.length !== 0)
    || ledgerIds.length !== result.convertedUnits
    || new Set([...reversalIds, ...paymentIds, ...ledgerIds]).size !== reversalIds.length + paymentIds.length + ledgerIds.length
    || !evidenceValuesEqual(factRefs, [...reversalIds, ...paymentIds, ...ledgerIds])) return false;

  const requiredResources = [
    result.orderId,
    result.amendmentId,
    result.pricingRevisionId,
    result.membershipOrderId,
    result.contractId,
    result.entitlementLotId,
    ...transferIds,
    ...coverageIds
  ];
  if (!evidenceValuesEqual(resourceRefs, requiredResources)) return false;

  if (previewEffect) {
    if (!conversionPreviewHasEvidence(previewEffect, input)) return false;
    const transfer = previewEffect.transfer as Record<string, unknown>;
    const membershipPricing = previewEffect.membershipPricing as Record<string, unknown>;
    const entitlement = previewEffect.entitlement as Record<string, unknown>;
    const previewMember = previewEffect.member as Record<string, unknown>;
    const collections = transfer.collections as Array<Record<string, unknown>>;
    if (previewMember.memberId !== result.memberId
      || !evidenceValuesEqual(collections.map((collection) => collection.factId), sourceIds)
      || !moneyMatches(transfer.total, result.transferredAmount)
      || !moneyMatches(membershipPricing.agreedPrice, result.membershipAgreedPrice)
      || entitlement.entitlementUnitKind !== result.entitlementUnitKind
      || entitlement.consumedUnits !== result.convertedUnits
      || entitlement.remainingUnits !== result.remainingUnits) return false;
  }
  return true;
}

export function completedStayBackfillPreviewHasEvidence(
  effect: Record<string, unknown>,
  input: Record<string, unknown>
): boolean {
  if (input.backfill !== true) return false;
  const backfill = isRecord(effect.backfill) ? effect.backfill : undefined;
  const arrivalEpoch = localDateEpoch(effect.arrivalDate);
  const departureEpoch = localDateEpoch(effect.departureDate);
  const businessEpoch = localDateEpoch(backfill?.businessDate);
  const reason = typeof input.backfillReason === "string" ? input.backfillReason.trim() : "";
  const inputGuest = isRecord(input.primaryGuest) ? input.primaryGuest : undefined;
  const effectGuest = isRecord(effect.primaryGuest) ? effect.primaryGuest : undefined;
  const inputAdditionalGuests = Array.isArray(input.additionalGuests) ? input.additionalGuests : undefined;
  const effectOccupants = Array.isArray(effect.occupants) ? effect.occupants : undefined;
  if (!backfill
    || arrivalEpoch === undefined
    || departureEpoch === undefined
    || businessEpoch === undefined
    || arrivalEpoch >= departureEpoch
    || !reason
    || backfill.reason !== reason
    || !nonblankString(input.quoteId)
    || effect.quoteId !== input.quoteId
    || !inputGuest
    || !effectGuest
    || !nonblankString(inputGuest.fullName)
    || !nonblankString(inputGuest.nickname)
    || !evidenceValuesEqual(effectGuest, inputGuest)
    || !inputAdditionalGuests
    || !effectOccupants
    || effectOccupants.length !== inputAdditionalGuests.length + 1) return false;
  const completedBackfill = departureEpoch <= businessEpoch
    && backfill.resultingOrderStatus === "CHECKED_OUT"
    && backfill.resultingStayStatus === "COMPLETED";
  const inHouseBackfill = arrivalEpoch < businessEpoch
    && businessEpoch < departureEpoch
    && backfill.resultingOrderStatus === "CHECKED_IN"
    && backfill.resultingStayStatus === "IN_HOUSE";
  if (!completedBackfill && !inHouseBackfill) return false;

  const submittedGuests = [inputGuest, ...inputAdditionalGuests];
  if (!effectOccupants.every((value, index) => {
    const occupant = isRecord(value) ? value : undefined;
    const submitted = isRecord(submittedGuests[index]) ? submittedGuests[index] as Record<string, unknown> : undefined;
    if (!occupant || !submitted
      || occupant.ordinal !== index + 1
      || occupant.role !== (index === 0 ? "PRIMARY" : "ADDITIONAL")) return false;
    return ["fullName", "nickname", "phone", "documentNumber"].every((key) => (
      occupant[key] === submitted[key]
      || (occupant[key] === undefined && submitted[key] === undefined)
    ));
  })) return false;

  const bookingChannelCode = typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : null;
  const inputBookingChannelCode = typeof input.bookingChannelCode === "string" ? input.bookingChannelCode : null;
  const channelOrderReference = typeof effect.channelOrderReference === "string" ? effect.channelOrderReference : null;
  const inputChannelOrderReference = typeof input.channelOrderReference === "string" ? input.channelOrderReference : null;
  const externalChannel = Boolean(bookingChannelCode && externalBookingChannels.has(bookingChannelCode));
  const freeStay = effect.stayType === "FREE";
  if (backfill.externalChannel !== externalChannel
    || bookingChannelCode !== inputBookingChannelCode
    || channelOrderReference !== inputChannelOrderReference) return false;
  const inputCollection = isRecord(input.backfillCollection) ? input.backfillCollection : undefined;
  const effectCollection = isRecord(backfill.collection) ? backfill.collection : undefined;
  const pricingDecision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const targetAmount = pricingDecision ? moneyFrom(pricingDecision.targetCurrentContractAmount) : undefined;
  if (!targetAmount) return false;
  if (freeStay) {
    return input.bookingChannelCode === undefined
      && input.channelOrderReference === undefined
      && input.targetCurrentContractAmountMinor === undefined
      && (input.freeStayCategoryCode === "VOLUNTEER" || input.freeStayCategoryCode === "RECEPTION")
      && nonblankString(input.freeStayReason)
      && effect.freeStayCategoryCode === input.freeStayCategoryCode
      && effect.freeStayReason === input.freeStayReason
      && targetAmount.minorUnits === 0
      && inputCollection === undefined
      && effectCollection === undefined
      && backfill.collection === null
      && backfill.settlementStatus === "SETTLED"
      && backfill.collectedAmountMinor === 0
      && backfill.balanceDueMinor === 0;
  }
  if (effect.freeStayCategoryCode !== null || effect.freeStayReason !== null
    || input.freeStayCategoryCode !== undefined || input.freeStayReason !== undefined) return false;
  if (externalChannel) {
    return nonblankString(input.channelOrderReference)
      && Number.isSafeInteger(input.targetCurrentContractAmountMinor)
      && Number(input.targetCurrentContractAmountMinor) > 0
      && targetAmount.minorUnits === input.targetCurrentContractAmountMinor
      && inputCollection === undefined
      && effectCollection === undefined
      && backfill.collection === null
      && backfill.settlementStatus === "SETTLED"
      && backfill.collectedAmountMinor === 0
      && backfill.balanceDueMinor === 0;
  }
  if (bookingChannelCode !== "WECOM" || !inputCollection) return false;
  const amountMinor = inputCollection.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) < 0) return false;
  if (!Number.isSafeInteger(input.targetCurrentContractAmountMinor)
    || targetAmount.minorUnits !== input.targetCurrentContractAmountMinor
    || Number(amountMinor) > targetAmount.minorUnits) return false;
  const balanceDueMinor = targetAmount.minorUnits - Number(amountMinor);
  if (backfill.collectedAmountMinor !== amountMinor
    || backfill.balanceDueMinor !== balanceDueMinor
    || backfill.settlementStatus !== (balanceDueMinor > 0 ? "ARREARS" : "SETTLED")) return false;
  if (amountMinor === 0) {
    return inputCollection.method === "WECOM"
      && hasExactKeys(inputCollection, ["amountMinor", "method"])
      && effectCollection === undefined
      && backfill.collection === null;
  }
  if (!effectCollection
    || effectCollection.amountMinor !== amountMinor
    || effectCollection.method !== inputCollection.method) return false;
  if (inputCollection.method === "CASH") {
    return hasExactKeys(inputCollection, ["amountMinor", "method", "cashCollector", "note"])
      && nonblankString(inputCollection.cashCollector)
      && nonblankString(inputCollection.note)
      && effectCollection.cashCollector === inputCollection.cashCollector
      && effectCollection.note === inputCollection.note
      && effectCollection.transactionReference === undefined;
  }
  return (inputCollection.method === "WECOM" || inputCollection.method === "BANK_TRANSFER")
    && hasExactKeys(inputCollection, ["amountMinor", "method", "transactionReference"])
    && nonblankString(inputCollection.transactionReference)
    && effectCollection.transactionReference === inputCollection.transactionReference
    && effectCollection.cashCollector === undefined;
}

export function u1PreviewHasBusinessEvidence(
  commandType: U1CommandType,
  effect: Record<string, unknown>,
  input: Record<string, unknown> = {}
): boolean {
  const inventoryUnit = isRecord(effect.inventoryUnit) ? effect.inventoryUnit : undefined;
  const pricingDecision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const pricing = isRecord(effect.pricing) ? effect.pricing : undefined;
  const member = isRecord(effect.member) ? effect.member : undefined;
  const hasStayIdentity = (isRecord(effect.primaryGuest) && nonblankString(effect.primaryGuest.nickname))
    || (Array.isArray(effect.occupants) && effect.occupants.length > 0);
  switch (commandType) {
    case "CREATE_ORDER":
      return Boolean(inventoryUnit
        && nonblankString(inventoryUnit.code)
        && nonblankString(effect.arrivalDate)
        && nonblankString(effect.departureDate)
        && hasStayIdentity
        && (effect.stayType === "FREE"
          ? nonblankString(effect.freeStayCategoryCode) && nonblankString(effect.freeStayReason)
          : (pricingDecision && hasMoney(pricingDecision.policyBaseAmount) && hasMoney(pricingDecision.targetCurrentContractAmount))
            || (pricing && (hasMoney(pricing.currentContractAmount) || hasMoney(pricing.cashRemainder)))));
    case "CREATE_MEMBER":
      return Boolean(member
        && nonblankString(member.fullName)
        && nonblankString(member.nickname)
        && nonblankString(member.phone)
        && nonblankString(member.wechat));
    case "CREATE_MEMBERSHIP_ORDER":
      return Boolean(member && isRecord(effect.product) && isRecord(effect.pricing));
    case "RECORD_MEMBERSHIP_PAYMENT":
      return isRecord(effect.payment) && isRecord(effect.totals);
    case "CORRECT_MEMBERSHIP_PAYMENT":
      return isRecord(effect.original) && isRecord(effect.replacement) && isRecord(effect.totals);
    case "ACTIVATE_MEMBERSHIP_ORDER":
      return nonblankString(effect.memberName)
        && nonblankString(effect.productName)
        && nonblankString(effect.validFrom)
        && nonblankString(effect.validUntil)
        && typeof effect.entitlementUnits === "number"
        && hasMoney(effect.paymentTotal)
        && hasMoney(effect.agreedPrice);
    case "CORRECT_MEMBER_ENTITLEMENT_BALANCE":
      return typeof effect.availableBefore === "number"
        && typeof effect.availableAfter === "number"
        && typeof effect.quantityDelta === "number"
        && nonblankString(effect.unitKind)
        && nonblankString(effect.adjustmentReason);
    case "LOCK_MAINTENANCE":
      return Boolean(inventoryUnit
        && nonblankString(inventoryUnit.code)
        && nonblankString(effect.arrivalDate)
        && nonblankString(effect.departureDate)
        && nonblankString(effect.reason));
    case "RELEASE_MAINTENANCE":
      return Boolean(nonblankString(effect.maintenanceLockId)
        && effect.maintenanceLockId === input.maintenanceLockId
        && nonblankString(effect.inventoryUnitId)
        && localDateNightCount(effect.arrivalDate, effect.departureDate) !== undefined);
    case "CORRECT_ORDER_OCCUPANT":
      return isRecord(effect.before) && isRecord(effect.after);
    case "REPRICE_ORDER":
      {
        const policyBaseAmount = effect.policyBaseAmount;
        const targetAmount = effect.targetCurrentContractAmount;
        const currentContractAmount = pricing?.currentContractAmount;
        const before = isRecord(effect.before) ? effect.before : undefined;
        const timeline = repriceStayTimeline(effect.stayTimeline);
        if (!nonblankString(effect.orderId)
          || effect.orderId !== input.orderId
          || !nonblankString(effect.inventoryUnitId)
          || !pricing
          || !timeline
          || timeline.at(-1)?.inventoryUnitId !== effect.inventoryUnitId
          || !before
          || !hasMoney(before.currentContractAmount)
          || !hasMoney(policyBaseAmount)
          || policyBaseAmount.minorUnits < 0
          || !hasMoney(targetAmount)
          || targetAmount.minorUnits < 0
          || targetAmount.minorUnits % 100 !== 0
          || targetAmount.minorUnits !== input.targetCurrentContractAmountMinor
          || !moneyMatches(currentContractAmount, targetAmount)
          || before.currentContractAmount.currency !== targetAmount.currency
          || policyBaseAmount.currency !== targetAmount.currency
          || !hasMoney(pricing.cashRemainder)
          || pricing.cashRemainder.currency !== targetAmount.currency
          || !Number.isSafeInteger(effect.manualAdjustmentMinor)
          || effect.manualAdjustmentMinor !== targetAmount.minorUnits - policyBaseAmount.minorUnits) return false;
        const timelineByDate = new Map(timeline.map((item) => [item.serviceDate, item.inventoryUnitId]));
        return pricingCoverageHasEvidence(pricing.coverageSet, timelineByDate)
          && Array.isArray(pricing.cashLines)
          && pricing.cashLines.every((line) => pricingCashLineHasEvidence(line, targetAmount.currency, timelineByDate));
      }
    case "RESCHEDULE_STAY":
    case "EXTEND_STAY":
    case "SHORTEN_STAY":
      return dateChangePreviewHasEvidence(commandType, effect, input);
    case "MOVE_UNIT":
      return moveUnitPreviewHasEvidence(effect, input);
    case "CANCEL_ORDER":
    case "MARK_NO_SHOW":
    case "REVOKE_CHECK_IN":
      return orderLifecyclePreviewHasEvidence(commandType, effect, input);
    case "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP":
      return conversionPreviewHasEvidence(effect, input);
    case "CHECK_IN":
    case "CHECK_OUT":
      return fulfillmentTransitionIsExpected(commandType, effect);
  }
}

export function receiptTransactionReferenceLabel(result: Record<string, unknown>): string {
  if (result.factType === "REVERSAL") return "不适用";
  if (result.factType === "REFUND" && result.method === "WECOM" && typeof result.transactionReference !== "string") return "沿用原收款交易单号";
  return typeof result.transactionReference === "string" ? result.transactionReference : "历史未记录";
}

function timelineDisplayRuns(timeline: readonly { serviceDate: string; inventoryUnitId: string }[]) {
  return timeline.reduce<Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }>>((runs, item) => {
    const epoch = localDateEpoch(item.serviceDate);
    const departureDate = epoch === undefined ? item.serviceDate : new Date(epoch + 86_400_000).toISOString().slice(0, 10);
    const last = runs.at(-1);
    if (last?.inventoryUnitId === item.inventoryUnitId && last.departureDate === item.serviceDate) {
      last.departureDate = departureDate;
    } else {
      runs.push({ inventoryUnitId: item.inventoryUnitId, arrivalDate: item.serviceDate, departureDate });
    }
    return runs;
  }, []);
}

export function StayTimelineDisplay({ timeline, labels, testId }: {
  timeline: readonly { serviceDate: string; inventoryUnitId: string }[];
  labels?: Readonly<Record<string, string>>;
  testId: string;
}) {
  const fallbackOrder = new Map<string, number>();
  for (const item of timeline) {
    if (!fallbackOrder.has(item.inventoryUnitId)) fallbackOrder.set(item.inventoryUnitId, fallbackOrder.size + 1);
  }
  return <ol className="move-unit-timeline" data-testid={testId}>
    {timelineDisplayRuns(timeline).map((run) => <li key={`${run.inventoryUnitId}:${run.arrivalDate}`}>
      <strong>{labels?.[run.inventoryUnitId] ?? `第 ${fallbackOrder.get(run.inventoryUnitId)} 个住宿房源`}</strong>
      <span>{formatDate(run.arrivalDate)} 至 {formatDate(run.departureDate)}</span>
    </li>)}
  </ol>;
}

export function EffectSummary({ preview, fulfillment = false, businessCommand, reasonNote, commandTitle, bookingChannelCode: stableBookingChannelCode, inventoryUnitLabels, orderLifecycleContext, commandInput }: { preview: PreviewDto; fulfillment?: boolean; businessCommand?: CommandType; reasonNote?: string; commandTitle?: string; bookingChannelCode?: string | null; inventoryUnitLabels?: Record<string, string>; orderLifecycleContext?: { guestName: string; arrivalDate: string; departureDate: string }; commandInput?: Record<string, unknown> }) {
  const effect = preview.effect;
  const before = isRecord(effect.before) ? effect.before : undefined;
  const after = isRecord(effect.after) ? effect.after : undefined;
  const pricing = pricingFromEffect(effect);
  const createPricingDecision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
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
  const pricingDecision = isRecord(effect.pricingDecision) ? effect.pricingDecision : undefined;
  const pricingReason = pricingDecision && isRecord(pricingDecision.reason) ? pricingDecision.reason : undefined;
  const pricingBasis = pricingDecision && typeof pricingDecision.pricingBasis === "string" ? pricingDecision.pricingBasis : undefined;
  const policyBaseAmount = moneyFrom(pricingDecision?.policyBaseAmount ?? effect.policyBaseAmount);
  const targetCurrentContractAmount = moneyFrom(pricingDecision?.targetCurrentContractAmount ?? effect.targetCurrentContractAmount);
  const differenceFromPolicy = moneyFrom(pricingDecision?.differenceFromPolicy);
  const manualAdjustmentMinor = typeof pricingDecision?.manualAdjustmentMinor === "number"
    ? pricingDecision.manualAdjustmentMinor
    : typeof effect.manualAdjustmentMinor === "number" ? effect.manualAdjustmentMinor : undefined;
  const coverage = pricing && Array.isArray(pricing.coverageSet) ? pricing.coverageSet : [];
  const cashLines = pricing && Array.isArray(pricing.cashLines) ? pricing.cashLines : [];

  if (tokenBusinessCommands.has(preview.commandType)) {
    const label = typeof effect.label === "string" && effect.label.trim()
      ? effect.label.trim()
      : typeof commandInput?.label === "string" && commandInput.label.trim() ? commandInput.label.trim() : "未填写";
    const tokenId = typeof effect.tokenId === "string" && effect.tokenId.trim()
      ? effect.tokenId.trim()
      : typeof commandInput?.tokenId === "string" && commandInput.tokenId.trim() ? commandInput.tokenId.trim() : undefined;
    const accessCeiling = effect.accessCeiling ?? commandInput?.accessCeiling;
    const expiresAt = typeof effect.expiresAt === "string" ? effect.expiresAt : typeof commandInput?.expiresAt === "string" ? commandInput.expiresAt : undefined;
    const outcome = preview.commandType === "ISSUE_TOKEN"
      ? "新 Token 会立即生效。"
      : preview.commandType === "ROTATE_TOKEN"
        ? "旧 Token 会立即失效，新 Token 会立即生效。"
        : "该 Token 会立即失效。";
    return <div className="effect-summary token-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="token-command-summary-heading">
        <h3 id="token-command-summary-heading">请核对{tokenCommandLabel(preview.commandType)}</h3>
        <dl className="difference-grid">
          <dt>Token 标签</dt><dd><strong>{label}</strong></dd>
          {tokenId ? <><dt>当前 Token</dt><dd><code>{tokenId}</code></dd></> : null}
          <dt>权限</dt><dd>{tokenAccessCeilingLabel(accessCeiling)}</dd>
          {expiresAt ? <><dt>过期时间</dt><dd>{formatDateTime(expiresAt)}</dd></> : null}
          <dt>确认后</dt><dd>{outcome}</dd>
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "RECORD_COLLECTION" || businessCommand === "RECORD_REFUND") {
    const amountMinor = typeof effect.amountMinor === "number" ? effect.amountMinor : undefined;
    const currency = typeof effect.currency === "string" ? effect.currency : "CNY";
    const transactionReference = typeof effect.transactionReference === "string" ? effect.transactionReference : undefined;
    const referencesFactId = typeof effect.referencesFactId === "string" ? effect.referencesFactId : undefined;
    const noteLabel = businessCommand === "RECORD_REFUND" ? "退款原因"
      : effect.method === "CASH" ? "收款人"
        : effect.method === "OTHER" ? "其他收款说明" : "备注";
    return <div className="effect-summary funds-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="funds-command-summary-heading">
        <h3 id="funds-command-summary-heading">请核对{businessCommand === "RECORD_REFUND" ? "退款" : "收款"}信息</h3>
        <dl className="difference-grid">
          <dt>金额</dt><dd><strong>{amountMinor === undefined ? "-" : formatMinor(amountMinor, currency)}</strong></dd>
          <dt>{businessCommand === "RECORD_REFUND" ? "退款方式" : "收款方式"}</dt><dd>{fundMethodLabel(effect.method)}</dd>
          {transactionReference ? <><dt>{effect.method === "WECOM" ? "企业微信交易单号" : "交易单号 / 流水号"}</dt><dd>{transactionReference}</dd></> : null}
          {businessCommand === "RECORD_REFUND" && effect.method === "WECOM" && !transactionReference ? <><dt>企业微信交易单号</dt><dd>原路退回，沿用原收款交易单号</dd></> : null}
          {businessCommand === "RECORD_REFUND" ? <><dt>对应原收款</dt><dd>{referencesFactId ? "已选择同订单原收款" : "未选择"}</dd></> : null}
          <dt>{noteLabel}</dt><dd>{reasonNote?.trim() || (businessCommand === "RECORD_REFUND" ? "未填写" : "未填写备注")}</dd>
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    const conversionMember = isRecord(effect.member) ? effect.member : undefined;
    const primaryOccupant = isRecord(effect.primaryOccupant) ? effect.primaryOccupant : undefined;
    const product = isRecord(effect.product) ? effect.product : undefined;
    const transfer = isRecord(effect.transfer) ? effect.transfer : undefined;
    const membershipPricing = isRecord(effect.membershipPricing) ? effect.membershipPricing : undefined;
    const remainingPayment = effect.remainingPayment === null ? null : isRecord(effect.remainingPayment) ? effect.remainingPayment : undefined;
    const entitlement = isRecord(effect.entitlement) ? effect.entitlement : undefined;
    const transferTotal = moneyFrom(transfer?.total);
    const transferCollections = Array.isArray(transfer?.collections)
      ? transfer.collections
        .map((value) => isRecord(value) ? value : undefined)
        .filter((value): value is Record<string, unknown> => Boolean(value))
      : [];
    const listedPrice = moneyFrom(membershipPricing?.listedPrice);
    const agreedPrice = moneyFrom(membershipPricing?.agreedPrice);
    const remainingAmount = remainingPayment ? moneyFrom(remainingPayment.amount) : undefined;
    const consumedUnits = typeof entitlement?.consumedUnits === "number" ? entitlement.consumedUnits : undefined;
    const remainingUnits = typeof entitlement?.remainingUnits === "number" ? entitlement.remainingUnits : undefined;
    const unitLabel = entitlement?.entitlementUnitKind === "BED_NIGHT" ? "床夜" : "间夜";
    const serviceDates = Array.isArray(entitlement?.serviceDates)
      ? entitlement.serviceDates.filter((value): value is string => typeof value === "string" && value.trim().length > 0).sort()
      : [];
    const firstServiceDate = serviceDates[0];
    const lastServiceDate = serviceDates[serviceDates.length - 1];
    const servicePeriod = firstServiceDate && lastServiceDate
      ? `${formatDate(firstServiceDate)} 至 ${formatDate(nextLocalDate(lastServiceDate))}`
      : undefined;
    const primaryOccupantName = typeof primaryOccupant?.fullName === "string" && primaryOccupant.fullName.trim()
      ? primaryOccupant.fullName
      : typeof primaryOccupant?.nickname === "string" && primaryOccupant.nickname.trim()
        ? primaryOccupant.nickname
        : undefined;
    return <div className="effect-summary conversion-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-label="升级会员核对">
        <dl className="difference-grid">
          {servicePeriod ? <><dt>本次住宿</dt><dd>{servicePeriod}</dd></> : null}
          {primaryOccupant ? <><dt>主要居住人</dt><dd><strong>{primaryOccupantName ?? "未填写姓名"}</strong></dd></> : null}
          {conversionMember ? <><dt>目标会员</dt><dd><strong>{scalar(conversionMember.fullName)}</strong></dd></> : null}
          {product ? <><dt>会员产品</dt><dd>{scalar(product.name)}</dd></> : null}
          {transferTotal ? <><dt>用于升级的住宿收款</dt><dd><strong>{formatMoney(transferTotal)}</strong></dd></> : null}
          {transferCollections.length ? <><dt>住宿收款明细</dt><dd><ol className="effect-inline-list">{transferCollections.map((collection, index) => {
            const amount = moneyFrom(collection.amount);
            const transactionReference = typeof collection.transactionReference === "string" ? collection.transactionReference : "未记录交易单号";
            return <li key={`${transactionReference}-${index}`}><span>第 {index + 1} 笔</span><strong>{amount ? formatMoney(amount) : "-"}</strong><small>{transactionReference}</small></li>;
          })}</ol></dd></> : null}
          {listedPrice ? <><dt>会员标价</dt><dd>{formatMoney(listedPrice)}</dd></> : null}
          {agreedPrice ? <><dt>会员成交价</dt><dd><strong>{formatMoney(agreedPrice)}</strong></dd></> : null}
          {remainingPayment === null ? <><dt>差额企微收款</dt><dd>无差额</dd></> : null}
          {remainingAmount ? <><dt>差额企微收款</dt><dd><strong>{formatMoney(remainingAmount)}</strong></dd></> : null}
          {remainingPayment && typeof remainingPayment.transactionReference === "string" ? <><dt>新增差额交易单号</dt><dd>{remainingPayment.transactionReference}</dd></> : null}
          {consumedUnits !== undefined ? <><dt>本次住宿核销</dt><dd>{consumedUnits} {unitLabel}</dd></> : null}
          {remainingUnits !== undefined ? <><dt>预计剩余权益</dt><dd><strong>{remainingUnits} {unitLabel}</strong></dd></> : null}
          <dt>住宿金额</dt><dd><strong>调整为 ¥0.00</strong></dd>
          <dt>住宿收款处理</dt><dd>{transferTotal && transferTotal.minorUnits > 0
            ? "保留收退款记录，将当前住宿净收款作为会员订单已收款来源；住宿订单不再重复计入。"
            : "当前住宿净收款为 ¥0.00；本次不创建住宿收款转入或 0 元收款事实。"}</dd>
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "CANCEL_ORDER" || businessCommand === "MARK_NO_SHOW" || businessCommand === "REVOKE_CHECK_IN") {
    if (!orderLifecyclePreviewHasEvidence(businessCommand, effect, commandInput ?? {})) {
      return <div className="effect-summary lifecycle-command-summary" data-testid="command-effect">
        <section className="effect-section" aria-labelledby="lifecycle-command-summary-heading">
          <h3 id="lifecycle-command-summary-heading">无法核对本次订单处理</h3>
          <p>服务端返回的状态、库存、权益或金额信息不完整，不能确认。请关闭后刷新订单状态。</p>
        </section>
      </div>;
    }
    const amounts = effect.amounts as Record<string, unknown>;
    const lifecycleEntitlement = effect.entitlementTransition as Record<string, unknown>;
    const lifecycleCurrentAmount = moneyFrom(amounts.currentContractAmount)!;
    const lifecycleNetCollection = moneyFrom(amounts.netRecordedCollection)!;
    const lifecycleRefundReference = moneyFrom(amounts.refundReferenceAmount)!;
    const inventoryUnitId = String(effect.inventoryUnitId);
    const unitLabel = inventoryUnitLabels?.[inventoryUnitId] ?? "当前住宿房源";
    const coverageCount = Number(lifecycleEntitlement.coverageCount);
    const revoked = businessCommand === "REVOKE_CHECK_IN";
    return <div className="effect-summary lifecycle-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="lifecycle-command-summary-heading">
        <h3 id="lifecycle-command-summary-heading">请核对{commandShellLabel(businessCommand)}</h3>
        <dl className="difference-grid">
          {orderLifecycleContext ? <><dt>住客</dt><dd><strong>{orderLifecycleContext.guestName}</strong></dd></> : null}
          {orderLifecycleContext ? <><dt>住宿日期</dt><dd>{formatDate(orderLifecycleContext.arrivalDate)} 至 {formatDate(orderLifecycleContext.departureDate)}</dd></> : null}
          <dt>住宿状态</dt><dd>{businessStatusLabel(String(effect.fromStatus))} <ChevronRight aria-label="变更为" size={15} /> <strong>{businessStatusLabel(String(effect.toStatus))}</strong></dd>
          <dt>住宿位置</dt><dd>{unitLabel}</dd>
          <dt>办理营业日</dt><dd>{formatDate(String(effect.businessDate))}</dd>
          <dt>库存安排</dt><dd><strong>{revoked ? "当天及以后住宿库存立即恢复可售" : "当前及后续住宿库存立即恢复可售"}</strong></dd>
          <dt>会员权益</dt><dd>{coverageCount > 0
            ? revoked ? `补偿恢复本次入住已核销的 ${coverageCount} 晚权益` : `释放 ${coverageCount} 晚已冻结权益`
            : "本次不涉及会员权益"}</dd>
          <dt>保留记录</dt><dd>{revoked ? "保留原入住记录和原会员核销历史，另行追加撤销与补偿记录" : "保留原预订、计价和变更历史"}</dd>
          <dt>处理后订单金额</dt><dd><strong>{formatMoney(lifecycleCurrentAmount)}</strong></dd>
          <dt>已登记净收款</dt><dd>{formatMoney(lifecycleNetCollection)}</dd>
          <dt>退款参考</dt><dd><strong>{formatMoney(lifecycleRefundReference)}</strong></dd>
          <dt>{revoked ? "撤销原因" : businessCommand === "CANCEL_ORDER" ? "取消原因" : "未到说明"}</dt><dd>{reasonNote?.trim() || "未填写"}</dd>
        </dl>
        <p className="muted compact">退款参考仅用于后续人工登记。目前尚未登记退款，本次操作不会自动退款、登记平台结算或新增资金记录。</p>
      </section>
    </div>;
  }

  if (businessCommand === "RESCHEDULE_STAY" || businessCommand === "EXTEND_STAY" || businessCommand === "SHORTEN_STAY") {
    const beforeNights = before && typeof before.nights === "number" ? before.nights : undefined;
    const afterNights = after && typeof after.nights === "number" ? after.nights : undefined;
    const funds = isRecord(effect.fundsSummary) ? effect.fundsSummary : undefined;
    const netCollection = moneyFrom(funds?.netRecordedCollection);
    const collectionDifference = moneyFrom(funds?.collectionDifference);
    const refundReferenceAmount = businessCommand === "SHORTEN_STAY" ? moneyFrom(effect.refundReferenceAmount) : undefined;
    const memberPricing = pricingBasis === "MEMBER_ENTITLEMENT";
    const previewBookingChannelCode = stableBookingChannelCode
      ?? (typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : undefined);
    const showFunds = stayDateFundsAreOperatorFacing(previewBookingChannelCode, pricingBasis);
    const earlyCheckout = businessCommand === "SHORTEN_STAY" && effect.completionMode === "EARLY_CHECK_OUT";
    const uncoveredNights = afterNights === undefined ? undefined : Math.max(0, afterNights - coverage.length);
    const afterTimeline = repriceStayTimeline(after?.stayTimeline);
    return <div className="effect-summary stay-date-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="stay-date-command-summary-heading">
        <h3 id="stay-date-command-summary-heading">请核对{earlyCheckout ? "提前退房" : commandShellLabel(businessCommand)}</h3>
        {afterTimeline ? <div className="stay-date-timeline-review">
          <h4>调整后完整住宿安排</h4>
          <StayTimelineDisplay timeline={afterTimeline} {...(inventoryUnitLabels ? { labels: inventoryUnitLabels } : {})} testId="stay-date-review-timeline" />
        </div> : null}
        <dl className="difference-grid">
          {before ? <><dt>原住宿日期</dt><dd>{formatDate(String(before.arrivalDate))} 至 {formatDate(String(before.departureDate))}</dd></> : null}
          {after ? <><dt>新住宿日期</dt><dd><strong>{formatDate(String(after.arrivalDate))} 至 {formatDate(String(after.departureDate))}</strong></dd></> : null}
          {beforeNights !== undefined ? <><dt>原住宿晚数</dt><dd>{beforeNights} 晚</dd></> : null}
          {afterNights !== undefined ? <><dt>完整新晚数</dt><dd>{afterNights} 晚{beforeNights !== undefined ? `（${afterNights - beforeNights >= 0 ? "+" : ""}${afterNights - beforeNights}）` : ""}</dd></> : null}
          {showFunds && before && moneyFrom(before.currentContractAmount) ? <><dt>原合同金额</dt><dd>{formatMoney(moneyFrom(before.currentContractAmount))}</dd></> : null}
          {policyBaseAmount ? <><dt>政策基础金额</dt><dd>{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>{showFunds ? "订单新金额" : "本单渠道应结金额"}</dt><dd><strong>{formatMoney(targetCurrentContractAmount)}</strong></dd></> : null}
          {differenceFromPolicy ? <><dt>与政策基础金额差额</dt><dd>{formatMoney(differenceFromPolicy)}</dd></> : null}
          {!showFunds ? <><dt>渠道价格差异说明</dt><dd>{pricingReason && typeof pricingReason.note === "string" && pricingReason.note.trim() ? pricingReason.note.trim() : "无"}</dd></> : pricingReason && typeof pricingReason.note === "string" && pricingReason.note ? <>
            <dt>{pricingBasis === "MANUAL_ADJUSTMENT" ? "人工调价原因" : "计价说明"}</dt><dd>{pricingReason.note}</dd>
          </> : null}
          {showFunds && netCollection ? <><dt>已登记净收款</dt><dd>{formatMoney(netCollection)}</dd></> : null}
          {showFunds && collectionDifference ? <><dt>{collectionDifference.minorUnits > 0 ? "待补收参考" : collectionDifference.minorUnits < 0 ? "多收差额" : "当前记录无差额"}</dt><dd>{formatMoney({ ...collectionDifference, minorUnits: Math.abs(collectionDifference.minorUnits) })}</dd></> : null}
          {showFunds && refundReferenceAmount && refundReferenceAmount.minorUnits > 0 ? <><dt>建议退款</dt><dd><strong>{formatMoney(refundReferenceAmount)}</strong></dd></> : null}
          {memberPricing ? <><dt>会员权益覆盖</dt><dd>{coverage.length} 晚</dd>{uncoveredNights !== undefined ? <><dt>未覆盖晚数</dt><dd>{uncoveredNights} 晚</dd></> : null}<dt>未覆盖金额</dt><dd>{formatMoney(pricing ? moneyFrom(pricing.cashRemainder) : undefined)}</dd></> : null}
          <dt>{earlyCheckout ? "提前离店原因" : "住宿日期变更原因"}</dt><dd>{reasonNote?.trim() || "未填写"}</dd>
        </dl>
        {showFunds && refundReferenceAmount && refundReferenceAmount.minorUnits > 0
          ? <p className="muted compact">该金额仅供工作人员办理退款参考，目前尚未登记退款。</p>
          : showFunds ? <p className="muted compact">差额只作补收参考；确认不会自动登记收款或结清。</p> : null}
      </section>
    </div>;
  }

  if (businessCommand === "MOVE_UNIT") {
    const summary = moveUnitPreviewSummary(preview, commandInput ?? {
      propertyId: isRecord(toUnit) ? toUnit.propertyId : undefined,
      orderId: effect.orderId,
      newInventoryUnitId: toUnit?.id,
      effectiveDate: effect.effectiveDate,
      ...(targetCurrentContractAmount ? { targetCurrentContractAmountMinor: targetCurrentContractAmount.minorUnits } : {})
    });
    if (!summary || !toUnit || !before) {
      return <div className="effect-summary move-unit-command-summary" data-testid="command-effect">
        <section className="effect-section" aria-labelledby="move-unit-command-summary-heading">
          <h3 id="move-unit-command-summary-heading">无法核对换房</h3>
          <p>服务端返回的换房安排、库存或金额信息不完整，不能确认。请返回修改后重新核对。</p>
        </section>
      </div>;
    }
    const effectiveDateUnit = isRecord(before.effectiveDateInventoryUnit) ? before.effectiveDateInventoryUnit : undefined;
    const actualUnit = isRecord(before.actualCurrentInventoryUnit) ? before.actualCurrentInventoryUnit : undefined;
    const inventoryChange = isRecord(effect.inventoryChange) ? effect.inventoryChange : undefined;
    const entitlement = isRecord(effect.entitlementSummary) ? effect.entitlementSummary : undefined;
    const previewBookingChannelCode = stableBookingChannelCode
      ?? (typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : undefined);
    const showFunds = stayDateFundsAreOperatorFacing(previewBookingChannelCode, summary.pricingBasis);
    const amountChange = {
      currency: summary.targetAmount.currency,
      minorUnits: summary.targetAmount.minorUnits - summary.beforeAmount.minorUnits
    };
    return <div className="effect-summary move-unit-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="move-unit-command-summary-heading">
        <h3 id="move-unit-command-summary-heading">请核对办理换房</h3>
        <div className="move-unit-preview">
          <div className="move-unit-preview-side"><h4>换房前完整安排</h4><StayTimelineDisplay timeline={summary.beforeTimeline} {...(inventoryUnitLabels ? { labels: inventoryUnitLabels } : {})} testId="move-unit-review-before-timeline" /></div>
          <div className="move-unit-preview-side"><h4>换房后完整安排</h4><StayTimelineDisplay timeline={summary.afterTimeline} {...(inventoryUnitLabels ? { labels: inventoryUnitLabels } : {})} testId="move-unit-review-after-timeline" /></div>
        </div>
        <dl className="difference-grid">
          {actualUnit ? <><dt>当前所在位置</dt><dd>{scalar(actualUnit.code)} · {scalar(actualUnit.name)}</dd></> : null}
          {effectiveDateUnit ? <><dt>生效日原计划位置</dt><dd>{scalar(effectiveDateUnit.code)} · {scalar(effectiveDateUnit.name)}</dd></> : null}
          <dt>换房生效日期</dt><dd>{formatDate(summary.effectiveDate)}</dd>
          <dt>目标房源</dt><dd><strong>{scalar(toUnit.code)} · {scalar(toUnit.name)}</strong></dd>
          <dt>完整住宿周期</dt><dd>{formatDate(String(before.arrivalDate))} 至 {formatDate(String(before.departureDate))}</dd>
          <dt>原安排晚数</dt><dd>{summary.beforeTimeline.length} 晚</dd>
          <dt>换房后安排晚数</dt><dd>{summary.afterTimeline.length} 晚</dd>
          <dt>库存变更</dt><dd>保留 {Array.isArray(inventoryChange?.preservedClaims) ? inventoryChange.preservedClaims.length : 0} 晚 · 释放并迁移 {Array.isArray(inventoryChange?.releasedClaims) ? inventoryChange.releasedClaims.length : 0} 晚</dd>
          {showFunds ? <><dt>原订单金额</dt><dd>{formatMoney(summary.beforeAmount)}</dd></> : null}
          <dt>政策基础金额</dt><dd>{formatMoney(summary.policyBaseAmount)}</dd>
          <dt>{showFunds ? "换房后订单金额" : "本单渠道应结金额"}</dt><dd><strong>{formatMoney(summary.targetAmount)}</strong></dd>
          {showFunds ? <><dt>订单金额变化</dt><dd><strong>{formatMoney(amountChange)}</strong></dd></> : null}
          <dt>与政策基础金额差额</dt><dd>{formatMoney(summary.differenceFromPolicy)}</dd>
          {!showFunds ? <><dt>渠道价格差异说明</dt><dd>{pricingReason && typeof pricingReason.note === "string" && pricingReason.note.trim() ? pricingReason.note : "无"}</dd></> : null}
          {summary.pricingBasis === "MANUAL_ADJUSTMENT" ? <><dt>人工调价原因</dt><dd>{pricingReason && typeof pricingReason.note === "string" ? pricingReason.note : "未填写"}</dd></> : null}
          {summary.pricingBasis === "MEMBER_ENTITLEMENT" ? <><dt>会员权益</dt><dd>保留已使用权益；迁移 {Array.isArray(entitlement?.migratedHeldCoverageDates) ? entitlement.migratedHeldCoverageDates.length : 0} 晚未使用冻结权益</dd></> : null}
          <dt>换房原因</dt><dd>{reasonNote?.trim() || "未填写"}</dd>
        </dl>
        <p className="muted compact">确认只办理本次换房并更新完整住宿安排，不会自动登记收款或退款。</p>
      </section>
    </div>;
  }
  const hasBookingChannel = Object.hasOwn(effect, "bookingChannelCode");
  const bookingChannelCode = typeof effect.bookingChannelCode === "string" ? effect.bookingChannelCode : null;
  const channelOrderReference = typeof effect.channelOrderReference === "string" ? effect.channelOrderReference : null;
  const hasTransactionReference = Object.hasOwn(effect, "transactionReference");
  const isFreeStay = effect.stayType === "FREE";
  const freeStayCategoryCode = typeof effect.freeStayCategoryCode === "string" ? effect.freeStayCategoryCode : null;
  const freeStayReason = typeof effect.freeStayReason === "string" ? effect.freeStayReason : null;

  if (preview.commandType === "CREATE_ORDER" && commandInput?.backfill === true) {
    if (!completedStayBackfillPreviewHasEvidence(effect, commandInput)) {
      return <div className="effect-summary backfill-command-summary" data-testid="command-effect">
        <section className="effect-section" aria-labelledby="completed-backfill-summary-heading">
          <h3 id="completed-backfill-summary-heading">无法核对住宿补录</h3>
          <p>服务端返回的日期、履约状态或收款事实与本次填写不一致，不能确认。请返回房态后重新核对。</p>
        </section>
      </div>;
    }
    const backfill = effect.backfill as Record<string, unknown>;
    const inHouseBackfill = backfill.resultingOrderStatus === "CHECKED_IN" && backfill.resultingStayStatus === "IN_HOUSE";
    const collection = isRecord(backfill.collection) ? backfill.collection : undefined;
    const collectionAmountMinor = typeof collection?.amountMinor === "number" ? collection.amountMinor : 0;
    const contractAmount = moneyFrom(createPricingDecision?.targetCurrentContractAmount ?? pricing?.currentContractAmount);
    const externalChannel = backfill.externalChannel === true;
    const settled = inHouseBackfill || isFreeStay || externalChannel || Boolean(contractAmount && collectionAmountMinor >= contractAmount.minorUnits);
    const outstandingAmount = contractAmount
      ? { ...contractAmount, minorUnits: Math.max(0, contractAmount.minorUnits - collectionAmountMinor) }
      : undefined;
    return <div className="effect-summary backfill-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="completed-backfill-summary-heading">
        <h3 id="completed-backfill-summary-heading">{inHouseBackfill ? "请核对在住住宿补录" : "请核对已完成住宿补录"}</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>住客昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要住客姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {inventoryUnit ? <><dt>住宿位置</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          <dt>实际住宿日期</dt><dd>{formatDate(String(effect.arrivalDate))} 至 {formatDate(String(effect.departureDate))}</dd>
          {isFreeStay ? <>
            <dt>免费入住类型</dt><dd>{freeStayCategoryLabel(freeStayCategoryCode)}</dd>
            <dt>免费入住原因</dt><dd>{freeStayReason}</dd>
          </> : <>
            <dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "未记录"}</dd>
            {externalChannel ? <>
              <dt>渠道订单号</dt><dd>{channelOrderReference}</dd>
              {contractAmount ? <><dt>本单渠道应结金额</dt><dd><strong>{formatMoney(contractAmount)}</strong></dd></> : null}
              <dt>资金处理</dt><dd>不登记门店单笔收款，后续按渠道总账核对。</dd>
            </> : <>
              {contractAmount ? <><dt>订单金额</dt><dd><strong>{formatMoney(contractAmount)}</strong></dd></> : null}
              <dt>{inHouseBackfill ? "已发生实收" : "补录实收"}</dt><dd><strong>{formatMinor(collectionAmountMinor, contractAmount?.currency ?? "CNY")}</strong></dd>
              {collection ? <>
                <dt>收款方式</dt><dd>{fundMethodLabel(collection.method)}</dd>
                {collection.method === "CASH" ? <>
                  <dt>收款人</dt><dd>{scalar(collection.cashCollector)}</dd>
                  <dt>现金备注</dt><dd>{scalar(collection.note)}</dd>
                </> : <><dt>{collection.method === "WECOM" ? "企业微信交易单号" : "银行转账单号 / 流水号"}</dt><dd>{scalar(collection.transactionReference)}</dd></>}
              </> : null}
              {!inHouseBackfill && !settled && outstandingAmount ? <><dt>尚欠金额</dt><dd><strong>{formatMoney(outstandingAmount)}</strong></dd></> : null}
            </>}
          </>}
          <dt>补录原因</dt><dd>{String(backfill.reason)}</dd>
          <dt>确认后</dt><dd><strong>{inHouseBackfill ? "提交后直接成为在住" : settled ? "提交后直接成为已结单" : "提交后直接成为欠款"}</strong></dd>
        </dl>
        <p className="muted compact">{inHouseBackfill ? "一次确认会原子写入订单、历史入住、完整住宿区间库存占用及本次真实收款；后续可继续续住、缩短、换房和退房。" : "一次确认会原子写入订单、历史入住、历史退房及本次真实收款；无需再逐步处理履约状态。"}</p>
      </section>
    </div>;
  }

  if (preview.commandType === "COMPLETE_STAY") {
    const completeStay = effect as Record<string, unknown>;
    const amounts = isRecord(completeStay.amounts) ? completeStay.amounts : undefined;
    const collection = isRecord(completeStay.collection) ? completeStay.collection : undefined;
    const collectionAmountMinor = typeof collection?.amountMinor === "number" ? collection.amountMinor : 0;
    const contractAmount = moneyFrom(amounts?.currentContractAmount);
    const netRecorded = moneyFrom(amounts?.netRecordedCollection);
    const balanceDue = moneyFrom(amounts?.collectionDifference);
    const entitlementTransition = isRecord(completeStay.entitlementTransition) ? completeStay.entitlementTransition : undefined;
    const coverageCount = typeof entitlementTransition?.coverageCount === "number" ? entitlementTransition.coverageCount : 0;
    const settled = completeStay.settlementStatus === "SETTLED";
    const reasonNote = typeof completeStay.reasonNote === "string" ? completeStay.reasonNote : "";
    return <div className="effect-summary complete-stay-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="complete-stay-summary-heading">
        <h3 id="complete-stay-summary-heading">请核对完成住宿</h3>
        <dl className="difference-grid">
          <dt>住宿日期</dt><dd>{formatDate(String(completeStay.arrivalDate))} 至 {formatDate(String(completeStay.departureDate))}</dd>
          <dt>办理营业日</dt><dd>{formatDate(String(completeStay.businessDate))}</dd>
          {contractAmount ? <><dt>订单金额</dt><dd><strong>{formatMoney(contractAmount)}</strong></dd></> : null}
          {netRecorded ? <><dt>已记录净收款</dt><dd>{formatMoney(netRecorded)}</dd></> : null}
          <dt>本次补记实收</dt><dd><strong>{formatMinor(collectionAmountMinor, contractAmount?.currency ?? "CNY")}</strong></dd>
          {collection ? <>
            <dt>收款方式</dt><dd>{fundMethodLabel(collection.method)}</dd>
            {collection.method === "CASH" ? <>
              <dt>收款人</dt><dd>{scalar(collection.cashCollector)}</dd>
              <dt>现金备注</dt><dd>{scalar(collection.note)}</dd>
            </> : <><dt>{collection.method === "WECOM" ? "企业微信交易单号" : "银行转账单号 / 流水号"}</dt><dd>{scalar(collection.transactionReference)}</dd></>}
          </> : null}
          {balanceDue && balanceDue.minorUnits > 0 ? <><dt>尚欠金额</dt><dd><strong>{formatMoney(balanceDue)}</strong></dd></> : null}
          {coverageCount > 0 ? <><dt>会员权益核销</dt><dd>{coverageCount} 晚冻结权益将转为已核销</dd></> : null}
          <dt>说明</dt><dd>{reasonNote || "未填写"}</dd>
          <dt>确认后</dt><dd><strong>{settled ? "订单直接成为已结单" : "订单显示欠款"}</strong></dd>
        </dl>
        <p className="muted compact">确认后，订单将直接完成；已收清显示“已结单”，未收清显示“欠款”。已有收款不会重复登记。</p>
      </section>
    </div>;
  }

  if (fulfillment) {
    if (!fulfillmentTransitionIsExpected(preview.commandType, effect)) {
      return <div className="effect-summary fulfillment-command-summary" data-testid="command-effect">
        <section className="effect-section" aria-labelledby="fulfillment-command-summary-heading">
          <h3 id="fulfillment-command-summary-heading">无法核对本次履约操作</h3>
          <p>服务端返回的状态变化与当前操作不一致，不能确认。请关闭后刷新订单状态。</p>
        </section>
      </div>;
    }
    const coverageCount = entitlementTransition && typeof entitlementTransition.coverageCount === "number"
      ? entitlementTransition.coverageCount
      : 0;
    return <div className="effect-summary fulfillment-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="fulfillment-command-summary-heading">
        <h3 id="fulfillment-command-summary-heading">请核对{fulfillmentCommandLabel(preview.commandType)}</h3>
        <dl className="difference-grid">
          {preview.commandType === "CHECK_IN" ? <>
            <dt>住宿状态</dt><dd>{businessStatusLabel(String(effect.fromStatus))} <ChevronRight aria-label="变更为" size={15} /> <strong>{businessStatusLabel(String(effect.toStatus))}</strong></dd>
            <dt>办理方式</dt><dd><strong>{effect.recordingMode === "LATE_RECORDED" ? "迟录入住" : "按计划办理入住"}</strong></dd>
            <dt>计划入住日</dt><dd>{formatDate(String(effect.effectiveDate))}</dd>
            <dt>办理营业日</dt><dd>{formatDate(String(effect.businessDate))}</dd>
            <dt>会员权益</dt><dd>{coverageCount > 0 ? `本次核销 ${coverageCount} 晚已冻结权益` : "本次不涉及会员权益"}</dd>
          </> : null}
          {preview.commandType === "CHECK_OUT" ? <>
            <dt>住宿状态</dt><dd>{businessStatusLabel(String(effect.fromStatus))} <ChevronRight aria-label="变更为" size={15} /> <strong>{businessStatusLabel(String(effect.toStatus))}</strong></dd>
            <dt>办理方式</dt><dd><strong>{effect.recordingMode === "LATE_RECORDED" ? "迟录退房" : "按计划办理退房"}</strong></dd>
            <dt>计划退房日</dt><dd>{formatDate(String(effect.effectiveDate))}</dd>
            <dt>办理营业日</dt><dd>{formatDate(String(effect.businessDate))}</dd>
            <dt>库存安排</dt><dd><strong>退房后释放后续住宿库存</strong></dd>
            <dt>订单金额</dt><dd>保持不变</dd>
            <dt>会员权益</dt><dd>退房不重复核销</dd>
          </> : null}
          {currentReleaseFeatures.cleaningWorkflow && preview.commandType === "COMPLETE_CLEANING" ? <>
            <dt>清洁状态</dt><dd>{businessStatusLabel(String(effect.fromStatus))} <ChevronRight aria-label="变更为" size={15} /> <strong>{businessStatusLabel(String(effect.toStatus))}</strong></dd>
            {typeof effect.serviceDate === "string" ? <><dt>清洁日期</dt><dd>{formatDate(effect.serviceDate)}</dd></> : null}
            <dt>住宿历史</dt><dd>保持不变</dd>
          </> : null}
        </dl>
      </section>
    </div>;
  }

  if (preview.commandType === "CREATE_MEMBER" && member) {
    return <div className="effect-summary member-create-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="member-create-summary-heading">
        <h3 id="member-create-summary-heading">请核对会员资料</h3>
        <dl className="difference-grid">
          <dt>姓名</dt><dd>{scalar(member.fullName)}</dd>
          <dt>昵称</dt><dd>{scalar(member.nickname)}</dd>
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

  if (preview.commandType === "CREATE_ORDER" && bookingChannelCode) {
    const channelContract = pricingBasis === "CHANNEL_CONTRACT";
    const manualAdjustment = pricingBasis === "MANUAL_ADJUSTMENT";
    return <div className="effect-summary membership-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="paid-stay-summary-heading">
        <h3 id="paid-stay-summary-heading">请核对住宿订单</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {inventoryUnit ? <><dt>住宿位置</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>住宿日期</dt><dd>{formatDate(effect.arrivalDate)} 至 {formatDate(effect.departureDate)}</dd></> : null}
          <dt>订单来源渠道</dt><dd>{bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode}</dd>
          <dt>渠道订单号</dt><dd>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? "未填写"}</dd>
          {policyBaseAmount ? <><dt>政策基础金额</dt><dd data-testid="preview-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>{channelContract ? "本单渠道应结金额" : "订单合同金额"}</dt><dd data-testid="preview-target-contract-amount"><strong>{formatMoney(targetCurrentContractAmount)}</strong></dd></> : null}
          {differenceFromPolicy && differenceFromPolicy.minorUnits !== 0 ? <><dt>{channelContract ? "与政策基础金额差额" : "人工调价差额"}</dt><dd data-testid={manualAdjustment ? "preview-manual-adjustment" : "preview-channel-contract-difference"}>{formatMoney(differenceFromPolicy)}</dd></> : null}
          {pricingReason && typeof pricingReason.note === "string" && pricingReason.note ? <><dt>{channelContract ? "渠道价格差异说明" : "人工调价原因"}</dt><dd>{pricingReason.note}</dd></> : null}
        </dl>
        <p className="muted compact">确认后，订单合同金额与首条计价记录将在同一事务中写入。</p>
      </section>
    </div>;
  }

  if (preview.commandType === "CREATE_ORDER") {
    const policyBase = createPricingDecision ? moneyFrom(createPricingDecision.policyBaseAmount) : pricing ? moneyFrom(pricing.cashRemainder) : undefined;
    const targetAmount = createPricingDecision ? moneyFrom(createPricingDecision.targetCurrentContractAmount) : pricing ? moneyFrom(pricing.currentContractAmount) : undefined;
    const difference = createPricingDecision ? moneyFrom(createPricingDecision.differenceFromPolicy) : undefined;
    const pricingReason = createPricingDecision && isRecord(createPricingDecision.reason) ? createPricingDecision.reason : undefined;
    const pricingBasis = createPricingDecision?.pricingBasis;
    const pricingBasisLabel = pricingBasis === "CHANNEL_CONTRACT"
      ? "本单渠道应结金额"
      : pricingBasis === "MANUAL_ADJUSTMENT"
        ? "人工调价"
        : pricingBasis === "FREE"
          ? "免费入住"
          : "政策价";
    return <div className="effect-summary lodging-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="create-order-summary-heading">
        <h3 id="create-order-summary-heading">请核对{isFreeStay ? "免费住宿" : "住宿订单"}</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>住客昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要住客姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {inventoryUnit ? <><dt>住宿位置</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>住宿日期</dt><dd>{formatDate(effect.arrivalDate)} 至 {formatDate(effect.departureDate)}</dd></> : null}
          {isFreeStay ? <>
            <dt>免费入住类型</dt><dd>{freeStayCategoryLabel(freeStayCategoryCode)}</dd>
            <dt>免费入住原因</dt><dd>{freeStayReason ?? "历史未记录"}</dd>
          </> : <>
            <dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd>
            <dt>渠道订单号</dt><dd>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? "未填写"}</dd>
          </>}
          <dt>计价依据</dt><dd>{pricingBasisLabel}</dd>
          {policyBase ? <><dt>政策基础金额</dt><dd>{formatMoney(policyBase)}</dd></> : null}
          {targetAmount ? <><dt>{pricingBasis === "CHANNEL_CONTRACT" ? "本单渠道应结金额" : "订单合同金额"}</dt><dd><strong>{formatMoney(targetAmount)}</strong></dd></> : null}
          {difference ? <><dt>与政策基础金额差额</dt><dd>{formatMoney(difference)}</dd></> : null}
          {pricingReason && typeof pricingReason.note === "string" && pricingReason.note ? <><dt>{pricingBasis === "CHANNEL_CONTRACT" ? "渠道价格差异说明" : "人工调价原因"}</dt><dd>{pricingReason.note}</dd></> : null}
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "LOCK_MAINTENANCE" || businessCommand === "RELEASE_MAINTENANCE") {
    return <div className="effect-summary maintenance-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="maintenance-command-summary-heading">
        <h3 id="maintenance-command-summary-heading">请核对{commandShellLabel(businessCommand)}</h3>
        <dl className="difference-grid">
          {inventoryUnit ? <><dt>房源</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>日期</dt><dd>{formatDate(effect.arrivalDate)} 至 {formatDate(effect.departureDate)}</dd></> : null}
          {businessCommand === "LOCK_MAINTENANCE" ? <>
            <dt>维修原因</dt><dd>{scalar(effect.reason)}</dd>
            <dt>房态变化</dt><dd><strong>该区间将设为维修锁房</strong></dd>
          </> : <>
            <dt>目标房源</dt><dd><strong>{commandTitle ?? scalar(effect.inventoryUnitId)}</strong></dd>
            <dt>释放范围</dt><dd><strong>完整释放这条维修锁房及对应库存占用</strong></dd>
            <dt>历史记录</dt><dd>保留</dd>
          </>}
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "CORRECT_ORDER_OCCUPANT") {
    const fieldLabels: Record<string, string> = { nickname: "昵称", fullName: "姓名", phone: "联系电话", documentNumber: "证件号码" };
    return <div className="effect-summary occupant-correction-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="occupant-correction-summary-heading">
        <h3 id="occupant-correction-summary-heading">请核对住宿人资料更正</h3>
        <dl className="difference-grid">
          {before && after ? Object.keys(fieldLabels).flatMap((key) => {
            if (before[key] === after[key]) return [];
            return [<div className="difference-row" key={key}><dt>{fieldLabels[key]}</dt><dd>{scalar(before[key])} <ChevronRight aria-label="更正为" size={15} /> <strong>{scalar(after[key])}</strong></dd></div>];
          }) : null}
          <dt>更正原因</dt><dd>{reasonNote?.trim() || "未填写"}</dd>
          <dt>记录方式</dt><dd>保留原资料并追加更正历史</dd>
        </dl>
      </section>
    </div>;
  }

  if (businessCommand === "REPRICE_ORDER") {
    return <div className="effect-summary reprice-command-summary" data-testid="command-effect">
      <section className="effect-section" aria-labelledby="reprice-command-summary-heading">
        <h3 id="reprice-command-summary-heading">请核对订单金额调整</h3>
        <dl className="difference-grid">
          {policyBaseAmount ? <><dt>政策基础金额</dt><dd>{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>调整后订单金额</dt><dd><strong>{formatMoney(targetCurrentContractAmount)}</strong></dd></> : null}
          {manualAdjustmentMinor !== undefined ? <><dt>与政策基础金额差额</dt><dd>{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount?.currency ?? "CNY")}</dd></> : null}
          <dt>调价原因</dt><dd>{reasonNote?.trim() || "未填写"}</dd>
          <dt>记录方式</dt><dd>追加新的计价记录，保留原金额</dd>
        </dl>
      </section>
    </div>;
  }

  return (
    <div className="effect-summary" data-testid="command-effect">
      <div className="preview-meta">
        <span><Clock3 aria-hidden="true" size={15} />有效至 {formatDateTime(preview.expiresAt)}</span>
      </div>

      <section className="effect-section" aria-labelledby="effect-difference-heading">
        <h3 id="effect-difference-heading">请核对{commandBusinessLabels[preview.commandType] ?? "本次操作"}</h3>
        <dl className="difference-grid">
          {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={effect.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : guest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(guest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(guest.fullName)}</dd></> : null}
          {member ? <><dt>会员档案动作</dt><dd>{scalar(effect.operation)}</dd><dt>会员姓名</dt><dd>{scalar(member.fullName)}</dd><dt>手机号 / 微信号</dt><dd>{scalar(member.phone)} · {scalar(member.wechat)}</dd></> : null}
          {submittedProfile && effect.profileMatch === false ? <><dt>申请资料差异</dt><dd>申请资料与现有档案不一致；本命令保留现有档案，仅关联申请记录。</dd></> : null}
          {memberContract ? <><dt>会员合同动作</dt><dd>{scalar(memberContract.operation)}</dd><dt>合同周期</dt><dd>{scalar(memberContract.validFrom)} 至 {scalar(memberContract.validUntil)}</dd></> : null}
          {externalReference ? <><dt>外部申请关联</dt><dd>{scalar(externalReference.operation)} · {scalar(externalReference.provider)} · <code>{scalar(externalReference.externalRecordId)}</code></dd></> : null}
          {hasBookingChannel && !isFreeStay ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd></> : null}
          {hasBookingChannel && !isFreeStay ? <><dt>渠道订单号</dt><dd>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</dd></> : null}
          {isFreeStay ? <><dt>免费入住类型</dt><dd>{freeStayCategoryLabel(freeStayCategoryCode)}</dd><dt>免费入住原因</dt><dd>{freeStayReason ?? "历史未记录"}</dd></> : null}
          {inventoryUnit ? <><dt>库存单元</dt><dd>{scalar(inventoryUnit.code)} · {scalar(inventoryUnit.name)}</dd></> : null}
          {typeof effect.arrivalDate === "string" && typeof effect.departureDate === "string" ? <><dt>住宿日期</dt><dd>{formatDate(effect.arrivalDate)} 至 {formatDate(effect.departureDate)}</dd></> : null}
          {typeof effect.serviceDate === "string" ? <><dt>营业日期</dt><dd>{formatDate(effect.serviceDate)}</dd></> : null}
          {typeof effect.reason === "string" ? <><dt>业务原因</dt><dd>{effect.reason}</dd></> : null}
          {fromUnit && toUnit ? <><dt>换房</dt><dd>{scalar(fromUnit.code)} <ChevronRight aria-label="变更为" size={15} /> {scalar(toUnit.code)}</dd></> : null}
          {before ? operatorDifferenceEntries(before).map((entry) => (
            <div className="difference-row" key={`before-${entry.key}`}>
              <dt>{entry.label}</dt><dd><span className="before-value">{entry.value}</span></dd>
            </div>
          )) : null}
          {after ? operatorDifferenceEntries(after).map((entry) => (
            <div className="difference-row" key={`after-${entry.key}`}>
              <dt>{entry.label}（变更后）</dt><dd><span className="after-value">{entry.value}</span></dd>
            </div>
          )) : null}
          {typeof effect.amountMinor === "number" && typeof effect.currency === "string" ? <><dt>事实金额</dt><dd>{formatMoney({ currency: effect.currency, minorUnits: effect.amountMinor })}</dd></> : null}
          {hasTransactionReference ? <><dt>外部交易单号</dt><dd>{typeof effect.transactionReference === "string" ? effect.transactionReference : "历史未记录"}</dd></> : null}
          {typeof effect.fromStatus === "string" && typeof effect.toStatus === "string" ? <><dt>状态</dt><dd>{businessStatusLabel(effect.fromStatus)} <ChevronRight aria-label="变更为" size={15} /> {businessStatusLabel(effect.toStatus)}</dd></> : null}
          {entitlementTransition ? <><dt>权益状态变化</dt><dd>{scalar(entitlementTransition.from)} <ChevronRight aria-label="变更为" size={15} /> {scalar(entitlementTransition.to)} · {scalar(entitlementTransition.coverageCount)} 晚</dd></> : null}
          {policyBaseAmount ? <><dt>政策基础金额</dt><dd data-testid="preview-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
          {targetCurrentContractAmount ? <><dt>订单金额</dt><dd data-testid="preview-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
          {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>与政策基础金额差额</dt><dd data-testid="preview-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
          {!before && !after && !guest && !inventoryUnit && !fromUnit && typeof effect.amountMinor !== "number" && typeof effect.fromStatus !== "string"
            ? <><dt>操作</dt><dd>{commandBusinessLabels[preview.commandType] ?? "业务操作"}</dd></> : null}
        </dl>
      </section>

      {pricing ? (
        <section className="effect-section" aria-labelledby="effect-pricing-heading">
          <h3 id="effect-pricing-heading">计价结果</h3>
          <div className="preview-amounts">
            <div><span>会员权益覆盖</span><strong>{coverage.length} 晚</strong></div>
            <div><span>未覆盖金额</span><strong>{formatMoney(moneyFrom(pricing.cashRemainder))}</strong></div>
            <div><span>订单金额</span><strong>{formatMoney(moneyFrom(pricing.currentContractAmount))}</strong></div>
          </div>
          {cashLines.length ? <p className="muted compact">现金计价行：{cashLines.length}</p> : null}
        </section>
      ) : null}

    </div>
  );
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

export function ReceiptPanel({ receipt, onNavigateToResource, businessCommand, commandType, memberStay = false, backfillStay = false, completeStay = false, bookingChannelCode: requestBookingChannelCode }: {
  receipt: ReceiptDto;
  onNavigateToResource?: () => void;
  businessCommand?: CommandType;
  commandType?: CommandType;
  memberStay?: boolean;
  backfillStay?: boolean;
  completeStay?: boolean;
  bookingChannelCode?: string | null;
}) {
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  const orderId = result && typeof result.orderId === "string" ? result.orderId : undefined;
  const primaryGuest = result && isRecord(result.primaryGuest) ? result.primaryGuest : undefined;
  const occupants = occupantSummaryItems(result?.occupants);
  const hasBookingChannel = Boolean(result && Object.hasOwn(result, "bookingChannelCode"));
  const bookingChannelCode = result && typeof result.bookingChannelCode === "string" ? result.bookingChannelCode : null;
  const channelOrderReference = result && typeof result.channelOrderReference === "string" ? result.channelOrderReference : null;
  const hasTransactionReference = Boolean(result && Object.hasOwn(result, "transactionReference"));
  const freeStayCategoryCode = result && typeof result.freeStayCategoryCode === "string" ? result.freeStayCategoryCode : null;
  const freeStayReason = result && typeof result.freeStayReason === "string" ? result.freeStayReason : null;
  const isFreeStay = Boolean(freeStayCategoryCode || freeStayReason);
  const memberId = result && typeof result.memberId === "string" ? result.memberId : undefined;
  const memberContractId = result && typeof result.memberContractId === "string" ? result.memberContractId : undefined;
  const memberExternalReferenceId = result && typeof result.memberExternalReferenceId === "string" ? result.memberExternalReferenceId : undefined;
  const pricingDecision = result && isRecord(result.pricingDecision) ? result.pricingDecision : undefined;
  const policyBaseAmount = result ? moneyFrom(pricingDecision?.policyBaseAmount ?? result.policyBaseAmount) : undefined;
  const targetCurrentContractAmount = result ? moneyFrom(pricingDecision?.targetCurrentContractAmount ?? result.targetCurrentContractAmount) : undefined;
  const manualAdjustmentMinor = typeof pricingDecision?.manualAdjustmentMinor === "number"
    ? pricingDecision.manualAdjustmentMinor
    : result && typeof result.manualAdjustmentMinor === "number" ? result.manualAdjustmentMinor : undefined;
  const differenceFromPolicy = result ? moneyFrom(pricingDecision?.differenceFromPolicy) : undefined;
  const pricingReason = pricingDecision && isRecord(pricingDecision.reason) ? pricingDecision.reason : undefined;
  const committed = receipt.businessCommitted;
  if (backfillStay && commandType === "CREATE_ORDER") {
    const backfillResult = result && isRecord(result.backfill) ? result.backfill : undefined;
    const inHouse = result?.status === "CHECKED_IN" || backfillResult?.checkOutAmendmentId === null;
    const arrears = backfillResult?.settlementStatus === "ARREARS";
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "住宿补录已完成" : "住宿补录未完成"}</h3>
          <p>{committed
            ? inHouse
              ? "历史入住已经记录，订单已在住。"
              : arrears
                ? "历史入住和退房已经记录，当前订单仍有欠款。"
                : "历史入住和退房已经记录，订单已结单。"
            : "本次操作没有写入订单、履约或收款事实。"}</p>
        </div>
      </div>
      {committed ? <dl className="receipt-grid">
        <dt>当前状态</dt><dd><strong>{inHouse ? "订单已在住" : arrears ? "欠款" : "已结单"}</strong></dd>
        {!inHouse && typeof backfillResult?.balanceDueMinor === "number" && backfillResult.balanceDueMinor > 0
          ? <><dt>尚欠金额</dt><dd><strong>{formatMinor(backfillResult.balanceDueMinor, "CNY")}</strong></dd></>
          : null}
      </dl> : null}
      {!committed && receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
      {orderId && committed ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>;
  }
  if (completeStay && commandType === "COMPLETE_STAY") {
    const arrears = result && result.settlementStatus === "ARREARS";
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "完成住宿已记录" : "完成住宿未记录"}</h3>
          <p>{committed
            ? arrears
              ? "历史入住和退房已经记录，订单仍有欠款。"
              : "历史入住和退房已经记录，订单已结单。"
            : "本次操作没有写入入住、退房或收款事实。"}</p>
        </div>
      </div>
      {committed ? <dl className="receipt-grid">
        <dt>当前状态</dt><dd><strong>{arrears ? "欠款" : "已结单"}</strong></dd>
        {result && isRecord(result.fulfillmentTiming) && typeof result.fulfillmentTiming.recordedBusinessDate === "string"
          ? <><dt>办理营业日</dt><dd>{formatDate(result.fulfillmentTiming.recordedBusinessDate)}</dd></>
          : null}
      </dl> : null}
      {!committed && receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
      {orderId && committed ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>;
  }
  if (businessCommand && fulfillmentBusinessCommands.has(businessCommand)) {
    const entitlementTransition = result && isRecord(result.entitlementTransition) ? result.entitlementTransition : undefined;
    const consumedCoverageCount = entitlementTransition && typeof entitlementTransition.coverageCount === "number" ? entitlementTransition.coverageCount : 0;
    const timingValue = result && isRecord(result.fulfillmentTiming) ? result.fulfillmentTiming : undefined;
    const fulfillmentTiming = timingValue
      && typeof timingValue.effectiveDate === "string"
      && typeof timingValue.recordedBusinessDate === "string"
      && (timingValue.recordingMode === "ON_SCHEDULE" || timingValue.recordingMode === "LATE_RECORDED")
      ? {
        effectiveDate: timingValue.effectiveDate,
        recordedBusinessDate: timingValue.recordedBusinessDate,
        recordingMode: timingValue.recordingMode === "ON_SCHEDULE" ? "ON_SCHEDULE" as const : "LATE_RECORDED" as const
      }
      : undefined;
    const copy = fulfillmentReceiptCopy(businessCommand, committed, consumedCoverageCount, fulfillmentTiming);
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{copy.heading}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
      {receipt.error ? <div className="receipt-error"><p>{receipt.error.code === "AUTHENTICATION_REQUIRED"
        || receipt.error.code === "INSUFFICIENT_ACCESS"
        || receipt.error.code === "RESOURCE_SCOPE_DENIED"
        || receipt.error.code === "SUBJECT_DISABLED"
        ? "当前账号无权完成这项操作，本次没有写入。"
        : receipt.error.code === "PREVIEW_STALE" || receipt.error.code === "INVALID_ORDER_STATE" || receipt.error.code === "AGGREGATE_VERSION_CONFLICT"
          ? "当前业务状态已经变化，本次没有写入。请刷新后重新核对。"
          : "本次操作未完成，住宿和清洁记录没有变化。"}</p></div> : null}
    </section>;
  }
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
  if (businessCommand && tokenBusinessCommands.has(businessCommand)) {
    const label = tokenCommandLabel(businessCommand);
    const tokenReceiptErrorMessage = receipt.error
      ? receipt.error.code === "COMMAND_INTERRUPTED" || receipt.error.code === "COMMAND_STATUS_UNKNOWN"
        ? `${label} 结果暂时不确定，请查询刚才的结果。`
        : /[\u3400-\u9fff]/.test(receipt.error.message)
          ? receipt.error.message
          : `${label} 未完成，请稍后重新处理。`
      : undefined;
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? `${label} 已完成` : `${label} 未完成`}</h3>
          <p>{committed
            ? businessCommand === "ISSUE_TOKEN"
              ? "Token 已生效。请确认外围客户端已保存一次性 secret。"
              : businessCommand === "ROTATE_TOKEN"
                ? "旧 Token 已失效，新 Token 已生效。请确认外围客户端已保存一次性 secret。"
                : "Token 已撤销，外围客户端不能再使用它访问系统。"
            : "本次 Token 操作没有写入。"}</p>
        </div>
      </div>
      {tokenReceiptErrorMessage ? <div className="receipt-error"><p>{tokenReceiptErrorMessage}</p></div> : null}
    </section>;
  }
  if (businessCommand === "RECORD_COLLECTION" || businessCommand === "RECORD_REFUND") {
    const label = businessCommand === "RECORD_REFUND" ? "退款" : "收款";
    const transactionReference = result && typeof result.transactionReference === "string" ? result.transactionReference : undefined;
    const receiptErrorMessage = receipt.error
      ? receipt.error.code === "COMMAND_INTERRUPTED" || receipt.error.code === "COMMAND_STATUS_UNKNOWN"
        ? `本次${label}没有登记。请返回订单后重新登记，系统不会重复写入。`
        : /[\u3400-\u9fff]/.test(receipt.error.message)
          ? receipt.error.message
          : `本次${label}没有登记。请返回修改后重新核对。`
      : undefined;
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? `${label}已登记` : `${label}未登记`}</h3>
          <p>{committed ? "已登记净收款与差额已在订单中更新。" : `本次${label}没有写入。`}</p>
        </div>
      </div>
      {committed && transactionReference ? <dl className="receipt-grid">
        <dt>交易单号</dt><dd>{transactionReference}</dd>
      </dl> : null}
      {receiptErrorMessage ? <div className="receipt-error"><p>{receiptErrorMessage}</p></div> : null}
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
      {!memberStay && committed && policyBaseAmount && targetCurrentContractAmount ? <dl className="receipt-grid">
        <dt>政策基础金额</dt><dd data-testid="receipt-policy-base-amount">{formatMoney(policyBaseAmount)}</dd>
        <dt>{pricingDecision?.pricingBasis === "CHANNEL_CONTRACT" ? "本单渠道应结金额" : "订单合同金额"}</dt><dd data-testid="receipt-target-contract-amount"><strong>{formatMoney(targetCurrentContractAmount)}</strong></dd>
      </dl> : null}
      {orderId && committed ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>;
  }
  if (businessCommand === "RESCHEDULE_STAY" || businessCommand === "EXTEND_STAY" || businessCommand === "SHORTEN_STAY") {
    const arrivalDate = result && typeof result.arrivalDate === "string" ? result.arrivalDate : undefined;
    const departureDate = result && typeof result.departureDate === "string" ? result.departureDate : undefined;
    const funds = result && isRecord(result.fundsSummary) ? result.fundsSummary : undefined;
    const difference = moneyFrom(funds?.collectionDifference);
    const refundReferenceAmount = businessCommand === "SHORTEN_STAY" ? moneyFrom(result?.refundReferenceAmount) : undefined;
    const showFunds = stayDateFundsAreOperatorFacing(
      requestBookingChannelCode ?? bookingChannelCode,
      typeof pricingDecision?.pricingBasis === "string" ? pricingDecision.pricingBasis : undefined
    );
    const completionMode = result?.completionMode;
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? `${businessCommand === "SHORTEN_STAY" && completionMode === "EARLY_CHECK_OUT" ? "提前退房" : commandShellLabel(businessCommand)}已完成` : `${commandShellLabel(businessCommand)}未执行`}</h3>
          <p>{committed
            ? businessCommand === "SHORTEN_STAY" && completionMode === "EARLY_CHECK_OUT"
              ? "提前退房已完成，订单、住宿状态和房态已刷新。"
              : commandShellSuccessMessage(businessCommand)
            : commandShellNotExecutedMessage(businessCommand)}</p>
        </div>
      </div>
      {committed && arrivalDate && departureDate ? <dl className="receipt-grid">
        <dt>当前住宿日期</dt><dd>{formatDate(arrivalDate)} 至 {formatDate(departureDate)}</dd>
        {!showFunds && policyBaseAmount ? <><dt>政策基础金额</dt><dd>{formatMoney(policyBaseAmount)}</dd></> : null}
        {!showFunds && targetCurrentContractAmount ? <><dt>本单渠道应结金额</dt><dd><strong>{formatMoney(targetCurrentContractAmount)}</strong></dd></> : null}
        {!showFunds && differenceFromPolicy ? <><dt>与政策基础金额差额</dt><dd>{formatMoney(differenceFromPolicy)}</dd></> : null}
        {!showFunds ? <><dt>渠道价格差异说明</dt><dd>{typeof pricingReason?.note === "string" && pricingReason.note.trim() ? pricingReason.note.trim() : "无"}</dd></> : null}
        {showFunds && difference ? <><dt>{difference.minorUnits > 0 ? "待补收参考" : difference.minorUnits < 0 ? "多收差额" : "当前记录无差额"}</dt><dd>{formatMoney({ ...difference, minorUnits: Math.abs(difference.minorUnits) })}</dd></> : null}
        {showFunds && refundReferenceAmount && refundReferenceAmount.minorUnits > 0 ? <><dt>建议退款</dt><dd><strong>{formatMoney(refundReferenceAmount)}</strong></dd><dt>退款状态</dt><dd>该金额仅供工作人员办理退款参考，目前尚未登记退款。</dd></> : null}
      </dl> : null}
      {!committed && receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
    </section>;
  }
  if (businessCommand === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    const membershipOrderId = result && typeof result.membershipOrderId === "string" ? result.membershipOrderId : undefined;
    const conversionMemberId = result && typeof result.memberId === "string" ? result.memberId : undefined;
    const transferredAmount = result ? moneyFrom(result.transferredAmount) : undefined;
    const membershipAgreedPrice = result ? moneyFrom(result.membershipAgreedPrice) : undefined;
    const remainingPaymentAmount = result ? moneyFrom(result.remainingPaymentAmount) : undefined;
    const convertedUnits = result && typeof result.convertedUnits === "number" ? result.convertedUnits : undefined;
    const remainingUnits = result && typeof result.remainingUnits === "number" ? result.remainingUnits : undefined;
    const unitLabel = result?.entitlementUnitKind === "BED_NIGHT" ? "床夜" : "间夜";
    const transferredPositive = (transferredAmount?.minorUnits ?? 0) > 0;
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "升级会员已完成" : "升级会员未执行"}</h3>
          <p>{committed
            ? transferredPositive
              ? "住宿净收款已转入会员订单，住宿金额已调整为 0。"
              : "住宿净收款为 0，未创建转入事实；住宿金额已调整为 0。"
            : commandShellNotExecutedMessage(businessCommand)}</p>
        </div>
      </div>
      {committed ? <dl className="receipt-grid">
        {transferredAmount ? <><dt>用于升级的住宿收款</dt><dd><strong>{formatMoney(transferredAmount)}</strong></dd></> : null}
        {membershipAgreedPrice ? <><dt>会员成交价</dt><dd>{formatMoney(membershipAgreedPrice)}</dd></> : null}
        {remainingPaymentAmount ? <><dt>差额企微收款</dt><dd>{remainingPaymentAmount.minorUnits > 0 ? formatMoney(remainingPaymentAmount) : "无差额"}</dd></> : null}
        {convertedUnits !== undefined ? <><dt>本次住宿核销</dt><dd>{convertedUnits} {unitLabel}</dd></> : null}
        {remainingUnits !== undefined ? <><dt>会员剩余权益</dt><dd><strong>{remainingUnits} {unitLabel}</strong></dd></> : null}
      </dl> : null}
      {!committed && receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
      {committed && membershipOrderId ? <Link className="button button-secondary" to={`/members?${conversionMemberId ? `memberId=${encodeURIComponent(conversionMemberId)}&` : ""}membershipOrderId=${encodeURIComponent(membershipOrderId)}`} onClick={onNavigateToResource}>查看会员订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>;
  }
  if (businessCommand && isU1CommandType(businessCommand)) {
    const label = commandShellLabel(businessCommand);
    return <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? `${label}已完成` : `${label}未执行`}</h3>
          <p>{committed ? commandShellSuccessMessage(businessCommand) : commandShellNotExecutedMessage(businessCommand)}</p>
        </div>
      </div>
      {!committed && receipt.error?.message ? <div className="receipt-error"><p>{receipt.error.message}</p></div> : null}
    </section>;
  }
  return (
    <section className={`receipt-panel ${committed ? "receipt-success" : "receipt-rejected"}`} data-testid="command-receipt" aria-labelledby="receipt-heading">
      <div className="receipt-title-row">
        <span className="receipt-icon" aria-hidden="true">{committed ? <Check size={20} /> : <AlertCircle size={20} />}</span>
        <div>
          <h3 id="receipt-heading">{committed ? "操作已完成" : "操作未完成"}</h3>
          <p>{committed ? "业务结果已经记录。" : "本次操作没有写入业务结果。"}</p>
        </div>
      </div>
      {receipt.error ? <div className="receipt-error"><strong>{receipt.error.code}</strong><p>{receipt.error.message}</p></div> : null}
      <dl className="receipt-grid">
        {occupants.length ? <><dt>住宿人</dt><dd><OccupantSummary value={result?.occupants} /></dd><dt>住宿人数</dt><dd>{occupants.length} 人</dd></> : primaryGuest ? <><dt>居住人昵称</dt><dd>{guestNicknameLabel(primaryGuest)}</dd><dt>主要居住人姓名</dt><dd>{scalar(primaryGuest.fullName)}</dd></> : null}
        {hasBookingChannel && !isFreeStay ? <><dt>订单来源渠道</dt><dd>{bookingChannelCode ? bookingChannelLabels[bookingChannelCode] ?? bookingChannelCode : "历史未记录"}</dd><dt>渠道订单号</dt><dd><code>{bookingChannelCode === "WECOM" ? "不适用" : channelOrderReference ?? (bookingChannelCode ? "未填写" : "历史未记录")}</code></dd></> : null}
        {isFreeStay ? <><dt>免费入住类型</dt><dd>{freeStayCategoryLabel(freeStayCategoryCode)}</dd><dt>免费入住原因</dt><dd>{freeStayReason ?? "历史未记录"}</dd></> : null}
        {hasTransactionReference && result ? <><dt>外部交易单号</dt><dd><code>{receiptTransactionReferenceLabel(result)}</code></dd></> : null}
        {memberId ? <><dt>会员住宿</dt><dd>已关联会员权益</dd>{memberExternalReferenceId ? <><dt>外部申请</dt><dd>已关联</dd></> : null}</> : null}
        {policyBaseAmount ? <><dt>政策基础金额</dt><dd data-testid="receipt-policy-base-amount">{formatMoney(policyBaseAmount)}</dd></> : null}
        {targetCurrentContractAmount ? <><dt>{pricingDecision?.pricingBasis === "CHANNEL_CONTRACT" ? "本单渠道应结金额" : "订单金额"}</dt><dd data-testid="receipt-target-contract-amount">{formatMoney(targetCurrentContractAmount)}</dd></> : null}
        {manualAdjustmentMinor !== undefined && (policyBaseAmount || targetCurrentContractAmount) ? <><dt>与政策基础金额差额</dt><dd data-testid="receipt-manual-adjustment">{formatMinor(manualAdjustmentMinor, policyBaseAmount?.currency ?? targetCurrentContractAmount!.currency)}</dd></> : null}
      </dl>
      {orderId ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(orderId)}`} onClick={onNavigateToResource}>查看订单 <ChevronRight aria-hidden="true" size={17} /></Link> : null}
    </section>
  );
}

interface CommandDialogProps {
  request: CommandRequest;
  onClose: (context?: CommandDialogCloseContext) => void;
  onCommitted?: (receipt: ReceiptDto) => void | Promise<void>;
  onBusinessSuccess?: (message: string, receipt: ReceiptDto) => void;
  onBusinessNotExecuted?: (message: string) => void;
  onReturnToEdit?: (request: CommandRequest) => void;
  initialPreviewMetadata?: ClientCommandMetadata;
  initialConfirmationKey?: string;
  initialReceipt?: ReceiptDto;
  writeBlocked?: boolean;
  writeBlockedReason?: string;
  onProgress?: (progress: CommandDialogProgress) => boolean | Promise<boolean> | void;
}

export interface CommandDialogCloseContext {
  receipt: ReceiptDto;
}

export function knownCommittedCommandMessage(
  commandType: U1CommandType,
  receipt: ReceiptDto,
  outcome: "REFRESHED" | "REFRESH_FAILED"
): string {
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  const earlyCheckout = commandType === "SHORTEN_STAY" && result?.completionMode === "EARLY_CHECK_OUT";
  if (outcome === "REFRESH_FAILED") {
    return earlyCheckout
      ? "提前退房已完成，但页面刷新失败。请点击页面上的刷新按钮查看最新结果。"
      : commandShellRefreshFailedMessage(commandType);
  }
  return earlyCheckout
    ? "提前退房已完成，订单、住宿状态和房态已刷新。"
    : commandShellSuccessMessage(commandType);
}

export async function notifyKnownCommittedCommand(input: {
  commandType: U1CommandType;
  receipt: ReceiptDto;
  onCommitted?: (receipt: ReceiptDto) => void | Promise<void>;
  onBusinessSuccess?: (message: string, receipt: ReceiptDto) => void;
}): Promise<"REFRESHED" | "REFRESH_FAILED"> {
  let outcome: "REFRESHED" | "REFRESH_FAILED" = "REFRESHED";
  try {
    await input.onCommitted?.(input.receipt);
  } catch {
    outcome = "REFRESH_FAILED";
  }
  input.onBusinessSuccess?.(
    knownCommittedCommandMessage(input.commandType, input.receipt, outcome),
    input.receipt
  );
  return outcome;
}

export type CommandDialogProgress =
  | { state: "PREVIEWING"; previewMetadata: ClientCommandMetadata; executePreview?: () => Promise<void> }
  | { state: "PREVIEW_UNKNOWN"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEW_FAILED"; previewMetadata: ClientCommandMetadata }
  | { state: "PREVIEWED"; previewId: string; previewMetadata: ClientCommandMetadata }
  | { state: "CONFIRMING"; previewId: string; confirmationKey: string; effectHash?: string; isAttemptActive?: () => boolean }
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
  presentation?: "MEMBER_STAY" | "BACKFILL_STAY" | "COMPLETE_STAY" | "FULFILLMENT" | "STAY_DATES" | "MOVE_UNIT" | "ORDER_LIFECYCLE";
  effectHash?: string;
  state: PersistedCommandRecoveryState;
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
const QUOTE_RECOVERY_STORAGE_PREFIX = "qintopia.quote-command-recovery.v1";
const SHARED_RECOVERY_MARKER_PREFIX = "qintopia.recovery-coordination.v1";
const SHARED_RECOVERY_MARKER_VALUE = "AUTHORITATIVE";
const SHARED_RECOVERY_MARKER_VALUE_PREFIX = `${SHARED_RECOVERY_MARKER_VALUE}:`;
const SHARED_RECOVERY_LOCK_PREFIX = "qintopia.recovery-lock.v1";
export const RECOVERY_STORAGE_SYNC_EVENT = "qintopia:recovery-storage-sync";

class CorruptCommandRecoveryStorageError extends Error {}
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
const recoveryReferenceKeySet = new Set<string>(recoveryReferenceKeys);

function parsedRecoveryTargetRefs(targetRefs: readonly string[]): Record<string, string> | undefined {
  if (targetRefs.length > recoveryReferenceKeys.length) return undefined;
  const parsed: Record<string, string> = {};
  for (const reference of targetRefs) {
    const separator = reference.indexOf("=");
    const key = separator > 0 ? reference.slice(0, separator) : "";
    const value = separator > 0 ? reference.slice(separator + 1) : "";
    if (!recoveryReferenceKeySet.has(key)
      || !value
      || value !== value.trim()
      || Object.hasOwn(parsed, key)) return undefined;
    parsed[key] = value;
  }
  return parsed;
}

function recoveryTargetRefsAreValid(commandType: unknown, targetRefs: readonly string[]): boolean {
  const parsed = parsedRecoveryTargetRefs(targetRefs);
  if (!parsed) return false;
  if (commandType === "COMPLETE_STAY") {
    return targetRefs.length === 1 && typeof parsed.orderId === "string";
  }
  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
    return typeof parsed.orderId === "string"
      && typeof parsed.memberId === "string"
      && targetRefs.length === 2
      && Object.keys(parsed).every((key) => key === "orderId" || key === "memberId");
  }
  return true;
}

function requiredRecoveryPresentation(commandType: HistoricalCommandType): PersistedCommandRecovery["presentation"] | undefined {
  if (commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY" || commandType === "SHORTEN_STAY") return "STAY_DATES";
  if (commandType === "MOVE_UNIT") return "MOVE_UNIT";
  if (commandType === "CANCEL_ORDER" || commandType === "MARK_NO_SHOW" || commandType === "REVOKE_CHECK_IN") return "ORDER_LIFECYCLE";
  if (commandType === "COMPLETE_STAY") return "COMPLETE_STAY";
  return undefined;
}

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

export function receiptExecutionSemanticsAreCoherent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.executionStatus === "EXECUTED" && value.businessCommitted === true)
    || (value.executionStatus === "NOT_EXECUTED" && value.businessCommitted === false)
    || (value.executionStatus === "UNKNOWN" && value.businessCommitted === false);
}

function terminalReceiptHasDurableIdentity(value: ReceiptDto): boolean {
  if (value.executionStatus === "UNKNOWN") return true;
  if (!nonblankString(value.receiptId)
    || !nonblankString(value.commandId)
    || !nonblankString(value.correlationId)
    || typeof value.committedAt !== "string"
    || Number.isNaN(Date.parse(value.committedAt))
    || !Array.isArray(value.resourceRefs)
    || !value.resourceRefs.every(nonblankString)
    || new Set(value.resourceRefs).size !== value.resourceRefs.length
    || !Array.isArray(value.factRefs)
    || !value.factRefs.every(nonblankString)
    || new Set(value.factRefs).size !== value.factRefs.length) return false;
  if (value.executionStatus === "EXECUTED") {
    return isRecord(value.result) && value.error === undefined;
  }
  return value.result === undefined
    && isRecord(value.error)
    && nonblankString(value.error.code)
    && nonblankString(value.error.message)
    && value.error.correlationId === value.correlationId
    && value.error.commandId === value.commandId
    && value.error.receiptId === value.receiptId
    && typeof value.error.retryable === "boolean";
}

function dateChangeReceiptHasEvidence(
  commandType: "RESCHEDULE_STAY" | "EXTEND_STAY" | "SHORTEN_STAY",
  value: unknown,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  if (!isRecord(value)
    || value.executionStatus !== "EXECUTED" || value.businessCommitted !== true
    || !hasOnlyKeys(value, ["receiptId", "commandId", "executionStatus", "businessCommitted", "correlationId", "result", "resourceRefs", "factRefs", "committedAt"], ["error"])
    || !nonblankString(value.receiptId) || !nonblankString(value.commandId) || !nonblankString(value.correlationId)
    || typeof value.committedAt !== "string" || Number.isNaN(Date.parse(value.committedAt))
    || value.error !== undefined
    || !Array.isArray(value.resourceRefs) || !value.resourceRefs.every(nonblankString)
    || new Set(value.resourceRefs).size !== value.resourceRefs.length
    || !Array.isArray(value.factRefs) || !value.factRefs.every(nonblankString)
    || new Set(value.factRefs).size !== value.factRefs.length
    || !isRecord(value.result)) return false;

  const result = value.result;
  const shorten = commandType === "SHORTEN_STAY";
  const requiredResultKeys = shorten
    ? ["orderId", "stayId", "arrangementAmendmentId", "checkoutAmendmentId", "staySegmentId", "pricingRevisionId", "completionMode", "businessDate", "arrivalDate", "departureDate", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary", "refundReferenceAmount", "fulfillmentTiming", "effectHash"]
    : ["orderId", "stayId", "amendmentId", "staySegmentId", "pricingRevisionId", "arrivalDate", "departureDate", "before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary", "effectHash"];
  if (!hasExactKeys(result, requiredResultKeys)
    || !isEffectHash(result.effectHash)
    || (expectedEffectHash !== undefined && result.effectHash !== expectedEffectHash)
    || !nonblankString(result.orderId)
    || (input.orderId !== undefined && result.orderId !== input.orderId)
    || !nonblankString(result.stayId)
    || !nonblankString(result.staySegmentId)
    || !nonblankString(result.pricingRevisionId)) return false;

  const resourceRefs = value.resourceRefs as string[];
  const requiredResourceIds = [result.orderId, result.stayId, result.staySegmentId, result.pricingRevisionId];
  if (shorten) {
    if (!nonblankString(result.arrangementAmendmentId)
      || (result.checkoutAmendmentId !== null && !nonblankString(result.checkoutAmendmentId))) return false;
    requiredResourceIds.push(result.arrangementAmendmentId);
    if (typeof result.checkoutAmendmentId === "string") requiredResourceIds.push(result.checkoutAmendmentId);
  } else {
    if (!nonblankString(result.amendmentId)) return false;
    requiredResourceIds.push(result.amendmentId);
  }
  if (!requiredResourceIds.every((id) => resourceRefs.includes(id as string))) return false;

  const before = isRecord(result.before) ? result.before : undefined;
  const after = isRecord(result.after) ? result.after : undefined;
  const afterTimeline = after ? repriceStayTimeline(after.stayTimeline) : undefined;
  if (!before || !after || !afterTimeline || afterTimeline.length < 1
    || result.arrivalDate !== after.arrivalDate || result.departureDate !== after.departureDate) return false;

  const validationInput: Record<string, unknown> = {
    ...input,
    orderId: result.orderId,
    newDepartureDate: input.newDepartureDate ?? after.departureDate,
    ...(commandType === "RESCHEDULE_STAY"
      ? { newArrivalDate: input.newArrivalDate ?? after.arrivalDate }
      : {})
  };
  const effect = {
    operation: commandType,
    orderId: result.orderId,
    stayId: result.stayId,
    inventoryUnitId: afterTimeline.at(-1)!.inventoryUnitId,
    ...(shorten ? {
      businessDate: result.businessDate,
      completionMode: result.completionMode,
      entitlementSummary: result.entitlementSummary,
      refundReferenceAmount: result.refundReferenceAmount
    } : { entitlementChange: result.entitlementChange }),
    before,
    after,
    pricingDecision: result.pricingDecision,
    inventoryChange: result.inventoryChange,
    fundsSummary: result.fundsSummary
  };
  if (!dateChangePreviewHasEvidence(commandType, effect, validationInput)) return false;

  if (shorten) {
    const entitlement = isRecord(result.entitlementSummary) ? result.entitlementSummary : undefined;
    const restoredFutureCoverageDates = entitlement ? exactDateList(entitlement.restoredFutureCoverageDates) : undefined;
    if (!restoredFutureCoverageDates || restoredFutureCoverageDates.length !== value.factRefs.length) return false;
    if (result.completionMode === "EARLY_CHECK_OUT") {
      const timing = isRecord(result.fulfillmentTiming) ? result.fulfillmentTiming : undefined;
      if (!timing || !hasExactKeys(timing, ["effectiveDate", "recordedBusinessDate", "recordingMode"])
        || timing.effectiveDate !== result.departureDate
        || timing.recordedBusinessDate !== result.businessDate
        || timing.recordingMode !== "ON_SCHEDULE"
        || !nonblankString(result.checkoutAmendmentId)) return false;
    } else if (result.completionMode !== "SHORTEN_IN_HOUSE"
      || result.checkoutAmendmentId !== null || result.fulfillmentTiming !== null) return false;
  }

  if (previewEffect) {
    if (!dateChangePreviewHasEvidence(commandType, previewEffect, validationInput)) return false;
    const comparableKeys = shorten
      ? ["orderId", "stayId", "completionMode", "businessDate", "before", "after", "pricingDecision", "inventoryChange", "entitlementSummary", "fundsSummary", "refundReferenceAmount"] as const
      : ["orderId", "stayId", "before", "after", "pricingDecision", "inventoryChange", "entitlementChange", "fundsSummary"] as const;
    if (!comparableKeys.every((key) => evidenceValuesEqual(result[key], previewEffect[key]))) return false;
  }
  return true;
}

function orderLifecycleReceiptHasEvidence(
  commandType: OrderLifecycleCommand,
  value: unknown,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  if (!isRecord(value)
    || value.executionStatus !== "EXECUTED" || value.businessCommitted !== true
    || !hasOnlyKeys(value, ["receiptId", "commandId", "executionStatus", "businessCommitted", "correlationId", "result", "resourceRefs", "factRefs", "committedAt"], ["error"])
    || !nonblankString(value.receiptId) || !nonblankString(value.commandId) || !nonblankString(value.correlationId)
    || typeof value.committedAt !== "string" || Number.isNaN(Date.parse(value.committedAt))
    || value.error !== undefined
    || !Array.isArray(value.resourceRefs) || !value.resourceRefs.every(nonblankString)
    || new Set(value.resourceRefs).size !== value.resourceRefs.length
    || !Array.isArray(value.factRefs) || !value.factRefs.every(nonblankString)
    || new Set(value.factRefs).size !== value.factRefs.length
    || !isRecord(value.result)) return false;

  const result = value.result;
  const expectedResultKeys = commandType === "REVOKE_CHECK_IN"
    ? ["orderId", "amendmentId", "status", "pricingRevisionId", "effectHash", "fulfillmentTiming", "entitlementTransition"]
    : ["orderId", "amendmentId", "status", "pricingRevisionId", "effectHash", "entitlementTransition"];
  const transition = orderLifecycleExpectedTransition(commandType);
  const entitlement = isRecord(result.entitlementTransition) ? result.entitlementTransition : undefined;
  if (!hasExactKeys(result, expectedResultKeys)
    || !nonblankString(result.orderId)
    || (input.orderId !== undefined && result.orderId !== input.orderId)
    || !nonblankString(result.amendmentId)
    || !nonblankString(result.pricingRevisionId)
    || !isEffectHash(result.effectHash)
    || result.status !== transition.to
    || !entitlement || !hasExactKeys(entitlement, ["from", "to", "coverageCount"])
    || entitlement.from !== transition.entitlementFrom || entitlement.to !== transition.entitlementTo
    || !Number.isSafeInteger(entitlement.coverageCount) || Number(entitlement.coverageCount) < 0) return false;

  if (commandType === "REVOKE_CHECK_IN") {
    const timing = isRecord(result.fulfillmentTiming) ? result.fulfillmentTiming : undefined;
    if (!timing || !hasExactKeys(timing, ["effectiveDate", "recordedBusinessDate", "recordingMode"])
      || timing.recordingMode !== "ON_SCHEDULE"
      || timing.effectiveDate !== timing.recordedBusinessDate) return false;
  }

  const resourceRefs = value.resourceRefs as string[];
  if (![result.orderId, result.amendmentId, result.pricingRevisionId]
    .every((id) => resourceRefs.includes(id as string))) return false;
  if (expectedEffectHash !== undefined && (!isEffectHash(expectedEffectHash) || result.effectHash !== expectedEffectHash)) return false;
  if (previewEffect) {
    if (!orderLifecyclePreviewHasEvidence(commandType, previewEffect, input)
      || previewEffect.toStatus !== result.status
      || !evidenceValuesEqual(previewEffect.entitlementTransition, result.entitlementTransition)) return false;
    if (commandType === "REVOKE_CHECK_IN") {
      const timing = result.fulfillmentTiming as Record<string, unknown>;
      if (previewEffect.effectiveDate !== timing.effectiveDate
        || previewEffect.businessDate !== timing.recordedBusinessDate
        || previewEffect.recordingMode !== timing.recordingMode) return false;
    }
  }
  return true;
}

export function completedStayBackfillReceiptHasEvidence(
  value: ReceiptDto,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  if (input.backfill !== true
    || !isEffectHash(expectedEffectHash)
    || !receiptExecutionSemanticsAreCoherent(value)
    || !terminalReceiptHasDurableIdentity(value)
    || value.executionStatus !== "EXECUTED"
    || value.businessCommitted !== true
    || !hasOnlyKeys(value as unknown as Record<string, unknown>, ["receiptId", "commandId", "executionStatus", "businessCommitted", "correlationId", "result", "resourceRefs", "factRefs", "committedAt"], ["error"])
    || value.error !== undefined
    || !isRecord(value.result)) return false;

  const result = value.result;
  if (!hasExactKeys(result, [
    "orderId",
    "stayId",
    "segmentId",
    "pricingRevisionId",
    "pricingPolicyVersionId",
    "primaryGuest",
    "occupants",
    "bookingChannelCode",
    "channelOrderReference",
    "freeStayReason",
    "freeStayCategoryCode",
    "pricingDecision",
    "status",
    "backfill",
    "effectHash"
  ])
    || !nonblankString(result.orderId)
    || !nonblankString(result.stayId)
    || !nonblankString(result.segmentId)
    || !nonblankString(result.pricingRevisionId)
    || !nonblankString(result.pricingPolicyVersionId)
    || !isEffectHash(result.effectHash)
    || result.effectHash !== expectedEffectHash
    || (result.status !== "CHECKED_OUT" && result.status !== "CHECKED_IN")
    || !isRecord(result.primaryGuest)
    || !Array.isArray(result.occupants)
    || result.occupants.length < 1
    || !isRecord(result.pricingDecision)
    || !isRecord(result.backfill)) return false;

  const backfill = result.backfill;
  const targetAmount = moneyFrom(result.pricingDecision.targetCurrentContractAmount);
  if (!hasExactKeys(backfill, [
    "businessDate",
    "checkInAmendmentId",
    "checkOutAmendmentId",
    "settlementStatus",
    "collectedAmountMinor",
    "balanceDueMinor",
    "collectionFactId"
  ])
    || localDateEpoch(backfill.businessDate) === undefined
    || !nonblankString(backfill.checkInAmendmentId)
    || (backfill.settlementStatus !== "SETTLED" && backfill.settlementStatus !== "ARREARS")
    || !Number.isSafeInteger(backfill.collectedAmountMinor)
    || Number(backfill.collectedAmountMinor) < 0
    || !Number.isSafeInteger(backfill.balanceDueMinor)
    || Number(backfill.balanceDueMinor) < 0
    || !targetAmount) return false;
  const completedBackfill = result.status === "CHECKED_OUT" && nonblankString(backfill.checkOutAmendmentId);
  const inHouseBackfill = result.status === "CHECKED_IN" && backfill.checkOutAmendmentId === null;
  if (!completedBackfill && !inHouseBackfill) return false;

  const occupants = result.occupants as unknown[];
  const occupantIds: string[] = [];
  for (let index = 0; index < occupants.length; index += 1) {
    const occupant = isRecord(occupants[index]) ? occupants[index] as Record<string, unknown> : undefined;
    if (!occupant
      || !nonblankString(occupant.id)
      || occupant.orderId !== result.orderId
      || occupant.ordinal !== index + 1
      || occupant.role !== (index === 0 ? "PRIMARY" : "ADDITIONAL")
      || !nonblankString(occupant.fullName)
      || !nonblankString(occupant.nickname)) return false;
    occupantIds.push(occupant.id);
  }
  if (new Set(occupantIds).size !== occupantIds.length) return false;

  const resourceRefs = value.resourceRefs;
  const requiredResourceRefs = [
    result.orderId,
    result.stayId,
    result.segmentId,
    result.pricingRevisionId,
    backfill.checkInAmendmentId,
    ...(completedBackfill ? [backfill.checkOutAmendmentId] : []),
    ...occupantIds
  ];
  if (!evidenceValuesEqual(resourceRefs, requiredResourceRefs)) return false;

  const bookingChannelCode = typeof result.bookingChannelCode === "string" ? result.bookingChannelCode : null;
  const externalChannel = Boolean(bookingChannelCode && externalBookingChannels.has(bookingChannelCode));
  const freeStay = result.freeStayCategoryCode !== null || result.freeStayReason !== null;
  const collectedAmountMinor = Number(backfill.collectedAmountMinor);
  const balanceDueMinor = Number(backfill.balanceDueMinor);
  if (freeStay) {
    if (bookingChannelCode !== null
      || result.channelOrderReference !== null
      || (result.freeStayCategoryCode !== "VOLUNTEER" && result.freeStayCategoryCode !== "RECEPTION")
      || !nonblankString(result.freeStayReason)
      || targetAmount.minorUnits !== 0
      || collectedAmountMinor !== 0
      || balanceDueMinor !== 0
      || backfill.settlementStatus !== "SETTLED") return false;
  } else if (externalChannel) {
    if (!nonblankString(result.channelOrderReference)
      || result.freeStayCategoryCode !== null
      || result.freeStayReason !== null
      || targetAmount.minorUnits <= 0
      || collectedAmountMinor !== 0
      || balanceDueMinor !== 0
      || backfill.settlementStatus !== "SETTLED") return false;
  } else if (bookingChannelCode !== "WECOM"
    || result.channelOrderReference !== null
    || result.freeStayCategoryCode !== null
    || result.freeStayReason !== null
    || collectedAmountMinor + balanceDueMinor !== targetAmount.minorUnits
    || backfill.settlementStatus !== (balanceDueMinor > 0 ? "ARREARS" : "SETTLED")) return false;

  if (collectedAmountMinor > 0) {
    if (!nonblankString(backfill.collectionFactId)
      || value.factRefs.length !== 1
      || value.factRefs[0] !== backfill.collectionFactId) return false;
  } else if (backfill.collectionFactId !== null || value.factRefs.length !== 0) return false;

  const fullInput = nonblankString(input.quoteId) && isRecord(input.primaryGuest) && Array.isArray(input.additionalGuests);
  if (fullInput) {
    const submittedGuests = [input.primaryGuest, ...(input.additionalGuests as unknown[])];
    if (!evidenceValuesEqual(result.primaryGuest, input.primaryGuest)
      || submittedGuests.length !== occupants.length
      || !occupants.every((value, index) => {
        const occupant = value as Record<string, unknown>;
        const guest = isRecord(submittedGuests[index]) ? submittedGuests[index] as Record<string, unknown> : undefined;
        return Boolean(guest
          && ["fullName", "nickname"].every((key) => occupant[key] === guest[key])
          && ["phone", "documentNumber"].every((key) => optionalGuestEvidenceValueMatches(occupant[key], guest[key])));
      })) return false;
    const inputBookingChannelCode = typeof input.bookingChannelCode === "string" ? input.bookingChannelCode : null;
    const inputChannelOrderReference = typeof input.channelOrderReference === "string" ? input.channelOrderReference : null;
    if (bookingChannelCode !== inputBookingChannelCode || result.channelOrderReference !== inputChannelOrderReference) return false;
    if (freeStay) {
      if (result.freeStayCategoryCode !== input.freeStayCategoryCode
        || result.freeStayReason !== input.freeStayReason) return false;
    } else if (!Number.isSafeInteger(input.targetCurrentContractAmountMinor)
      || targetAmount.minorUnits !== input.targetCurrentContractAmountMinor) return false;
  }

  if (previewEffect) {
    const previewBackfill = isRecord(previewEffect.backfill) ? previewEffect.backfill : undefined;
    const previewOccupants = Array.isArray(previewEffect.occupants) ? previewEffect.occupants : undefined;
    if (!completedStayBackfillPreviewHasEvidence(previewEffect, input)
      || !previewBackfill
      || !previewOccupants
      || previewOccupants.length !== occupants.length
      || result.primaryGuest === null
      || !evidenceValuesEqual(result.primaryGuest, previewEffect.primaryGuest)
      || result.bookingChannelCode !== previewEffect.bookingChannelCode
      || result.channelOrderReference !== previewEffect.channelOrderReference
      || result.freeStayReason !== previewEffect.freeStayReason
      || result.freeStayCategoryCode !== previewEffect.freeStayCategoryCode
      || result.pricingPolicyVersionId !== previewEffect.pricingPolicyVersionId
      || !evidenceValuesEqual(result.pricingDecision, previewEffect.pricingDecision)
      || result.status !== previewBackfill.resultingOrderStatus
      || backfill.businessDate !== previewBackfill.businessDate
      || backfill.settlementStatus !== previewBackfill.settlementStatus
      || backfill.collectedAmountMinor !== previewBackfill.collectedAmountMinor
      || backfill.balanceDueMinor !== previewBackfill.balanceDueMinor
      || !previewOccupants.every((value, index) => {
        const previewOccupant = isRecord(value) ? value as Record<string, unknown> : undefined;
        const resultOccupant = occupants[index] as Record<string, unknown>;
        return Boolean(previewOccupant
          && resultOccupant.id === previewOccupant.id
          && ["fullName", "nickname", "ordinal", "role"].every((key) => resultOccupant[key] === previewOccupant[key])
          && ["phone", "documentNumber"].every((key) => optionalGuestEvidenceValueMatches(resultOccupant[key], previewOccupant[key])));
      })) return false;
  }
  return true;
}

export function receiptHasCommandEvidence(
  commandType: HistoricalCommandType,
  receipt: ReceiptDto,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  if (!receiptExecutionSemanticsAreCoherent(receipt) || !terminalReceiptHasDurableIdentity(receipt)) return false;
  if (commandType === "CREATE_ORDER" && input.backfill === true) {
    if (receipt.businessCommitted) {
      return completedStayBackfillReceiptHasEvidence(receipt, input, previewEffect, expectedEffectHash);
    }
    if (receipt.executionStatus === "UNKNOWN") {
      return hasExactKeys(receipt as unknown as Record<string, unknown>, [
        "receiptId",
        "commandId",
        "executionStatus",
        "businessCommitted",
        "correlationId",
        "resourceRefs",
        "factRefs"
      ])
        && receipt.resourceRefs.length === 0
        && receipt.factRefs.length === 0;
    }
    return receipt.executionStatus === "NOT_EXECUTED"
      && hasExactKeys(receipt as unknown as Record<string, unknown>, [
        "receiptId",
        "commandId",
        "executionStatus",
        "businessCommitted",
        "correlationId",
        "error",
        "resourceRefs",
        "factRefs",
        "committedAt"
      ])
      && receipt.resourceRefs.length === 0
      && receipt.factRefs.length === 0;
  }
  if ((commandType === "RESCHEDULE_STAY" || commandType === "EXTEND_STAY" || commandType === "SHORTEN_STAY")
    && receipt.businessCommitted) {
    return dateChangeReceiptHasEvidence(commandType, receipt, input, previewEffect, expectedEffectHash);
  }
  if (commandType === "MOVE_UNIT" && receipt.businessCommitted) {
    return moveUnitReceiptHasEvidence(receipt, input, previewEffect, expectedEffectHash);
  }
  if ((commandType === "CANCEL_ORDER" || commandType === "MARK_NO_SHOW" || commandType === "REVOKE_CHECK_IN")
    && receipt.businessCommitted) {
    return orderLifecycleReceiptHasEvidence(commandType, receipt, input, previewEffect, expectedEffectHash);
  }
  if (commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" && receipt.businessCommitted) {
    return conversionReceiptHasEvidence(receipt, input, previewEffect, expectedEffectHash);
  }
  if (commandType === "COMPLETE_STAY" && receipt.businessCommitted) {
    return completeStayReceiptHasEvidence(receipt, input, previewEffect, expectedEffectHash);
  }
  return true;
}

function completeStayReceiptHasEvidence(
  receipt: ReceiptDto,
  input: Record<string, unknown>,
  previewEffect?: Record<string, unknown>,
  expectedEffectHash?: string
): boolean {
  const value = receipt as unknown as Record<string, unknown>;
  const result = isRecord(receipt.result) ? receipt.result : undefined;
  if (!result || result.orderId !== input.orderId) return false;
  if (!nonblankString(result.stayId)
    || !nonblankString(result.checkInAmendmentId)
    || !nonblankString(result.checkOutAmendmentId)) return false;
  if (![result.orderId, result.stayId, result.checkInAmendmentId, result.checkOutAmendmentId]
    .every((reference) => typeof reference === "string" && receipt.resourceRefs.includes(reference))) return false;
  if (result.status !== "CHECKED_OUT"
    || (result.settlementStatus !== "SETTLED" && result.settlementStatus !== "ARREARS")) return false;
  const timing = isRecord(result.fulfillmentTiming) ? result.fulfillmentTiming : undefined;
  if (!timing
    || typeof timing.effectiveDate !== "string"
    || typeof timing.recordedBusinessDate !== "string"
    || (timing.recordingMode !== "ON_SCHEDULE" && timing.recordingMode !== "LATE_RECORDED")) return false;
  const inputCollection = isRecord(input.collection) ? input.collection : undefined;
  const previewCollection = previewEffect && isRecord(previewEffect.collection) ? previewEffect.collection : undefined;
  if (!previewEffect && !isEffectHash(expectedEffectHash)) return false;
  if (inputCollection || previewCollection) {
    if (typeof result.collectionFactId !== "string" || !result.collectionFactId) return false;
    if (!Array.isArray(value.factRefs) || !value.factRefs.includes(result.collectionFactId)) return false;
  } else if (previewEffect) {
    if (result.collectionFactId !== null) return false;
  } else if (result.collectionFactId !== null
    && (!nonblankString(result.collectionFactId)
      || !Array.isArray(value.factRefs)
      || !value.factRefs.includes(result.collectionFactId))) return false;
  if (!isEffectHash(result.effectHash)
    || (expectedEffectHash !== undefined
      && (!isEffectHash(expectedEffectHash) || result.effectHash !== expectedEffectHash))) return false;
  if (previewEffect) {
    const previewCheckOut = isRecord(previewEffect.checkOut) ? previewEffect.checkOut : undefined;
    if (previewEffect.operation !== "COMPLETE_STAY"
      || previewEffect.settlementStatus !== result.settlementStatus
      || !previewCheckOut
      || previewCheckOut.effectiveDate !== timing.effectiveDate
      || previewCheckOut.businessDate !== timing.recordedBusinessDate
      || previewCheckOut.recordingMode !== timing.recordingMode
      || previewEffect.reasonNote !== input.reasonNote) return false;
  }
  return true;
}

export function sharedRecoveryMarkerKey(storageKey: string): string {
  return `${SHARED_RECOVERY_MARKER_PREFIX}:${encodeURIComponent(storageKey)}`;
}

function sharedRecoveryMarkerValue(serialized: string): string {
  return `${SHARED_RECOVERY_MARKER_VALUE_PREFIX}${serialized}`;
}

function sharedRecoveryMarkerPayload(marker: string): string | undefined {
  return marker.startsWith(SHARED_RECOVERY_MARKER_VALUE_PREFIX)
    ? marker.slice(SHARED_RECOVERY_MARKER_VALUE_PREFIX.length)
    : undefined;
}

function serializedRecoveriesShareCommandIdentity(left: string, right: string): boolean {
  try {
    const leftValue: unknown = JSON.parse(left);
    const rightValue: unknown = JSON.parse(right);
    if (!isRecord(leftValue)
      || !isRecord(rightValue)
      || leftValue.version !== 1
      || rightValue.version !== 1
      || leftValue.subjectId !== rightValue.subjectId
      || leftValue.propertyId !== rightValue.propertyId) return false;
    const generalCommandIdentity = leftValue.scopeId === rightValue.scopeId
      && leftValue.commandType === rightValue.commandType
      && leftValue.confirmationKey === rightValue.confirmationKey
      && nonblankString(leftValue.scopeId)
      && nonblankString(leftValue.commandType)
      && nonblankString(leftValue.confirmationKey);
    const leftMetadata = isRecord(leftValue.metadata) ? leftValue.metadata : undefined;
    const rightMetadata = isRecord(rightValue.metadata) ? rightValue.metadata : undefined;
    const quoteCommandIdentity = leftMetadata !== undefined
      && rightMetadata !== undefined
      && nonblankString(leftMetadata.idempotencyKey)
      && leftMetadata.idempotencyKey === rightMetadata.idempotencyKey
      && leftValue.inputSignature === rightValue.inputSignature;
    return generalCommandIdentity || quoteCommandIdentity;
  } catch {
    return false;
  }
}

export function createSharedCommandRecoveryStorage(
  authoritativeStorage: CommandRecoveryStorage,
  compatibilityStorage: CommandRecoveryStorage
): CommandRecoveryStorage {
  return {
    getItem(key) {
      const markerKey = sharedRecoveryMarkerKey(key);
      const authoritativeValue = authoritativeStorage.getItem(key);
      const marker = authoritativeStorage.getItem(markerKey);
      const compatibilityValue = compatibilityStorage.getItem(key);
      if (marker !== null
        && marker !== SHARED_RECOVERY_MARKER_VALUE
        && !marker.startsWith(SHARED_RECOVERY_MARKER_VALUE_PREFIX)) {
        throw new CorruptCommandRecoveryStorageError("恢复记录协调标记无效");
      }
      if (authoritativeValue !== null) {
        const expectedMarker = sharedRecoveryMarkerValue(authoritativeValue);
        if (marker !== null && marker !== SHARED_RECOVERY_MARKER_VALUE && marker !== expectedMarker) {
          const markerPayload = sharedRecoveryMarkerPayload(marker);
          if (markerPayload === undefined
            || !serializedRecoveriesShareCommandIdentity(authoritativeValue, markerPayload)) {
            throw new CorruptCommandRecoveryStorageError("共享恢复记录与协调标记不一致；写入口继续暂停");
          }
        }
        if (compatibilityValue !== null && compatibilityValue !== authoritativeValue) {
          if (!serializedRecoveriesShareCommandIdentity(authoritativeValue, compatibilityValue)) {
            throw new Error("当前标签保留着另一笔未决操作；请先在原标签依次恢复，系统不会覆盖任一幂等键");
          }
          compatibilityStorage.setItem(key, authoritativeValue);
        }
        if (marker !== expectedMarker) authoritativeStorage.setItem(markerKey, expectedMarker);
        if (compatibilityValue === null) compatibilityStorage.setItem(key, authoritativeValue);
        return authoritativeValue;
      }
      if (compatibilityValue === null) return null;
      if (marker !== null && marker.startsWith(SHARED_RECOVERY_MARKER_VALUE_PREFIX)) {
        const markerPayload = sharedRecoveryMarkerPayload(marker);
        if (markerPayload === compatibilityValue
          || (markerPayload !== undefined && serializedRecoveriesShareCommandIdentity(markerPayload, compatibilityValue))) {
          compatibilityStorage.removeItem(key);
          return null;
        }
      }
      authoritativeStorage.setItem(key, compatibilityValue);
      authoritativeStorage.setItem(markerKey, sharedRecoveryMarkerValue(compatibilityValue));
      return compatibilityValue;
    },
    setItem(key, value) {
      const authoritativeValue = authoritativeStorage.getItem(key);
      const compatibilityValue = compatibilityStorage.getItem(key);
      if (authoritativeValue !== null
        && compatibilityValue !== null
        && authoritativeValue !== compatibilityValue) {
        throw new Error("当前标签保留着另一笔未决操作；系统不会覆盖任一幂等键");
      }
      authoritativeStorage.setItem(key, value);
      authoritativeStorage.setItem(sharedRecoveryMarkerKey(key), sharedRecoveryMarkerValue(value));
      compatibilityStorage.setItem(key, value);
    },
    removeItem(key) {
      const authoritativeValue = authoritativeStorage.getItem(key);
      const compatibilityValue = compatibilityStorage.getItem(key);
      if (authoritativeValue !== null) {
        authoritativeStorage.setItem(sharedRecoveryMarkerKey(key), sharedRecoveryMarkerValue(authoritativeValue));
      } else {
        authoritativeStorage.removeItem(sharedRecoveryMarkerKey(key));
      }
      authoritativeStorage.removeItem(key);
      if (authoritativeValue === null
        || (compatibilityValue !== null && compatibilityValue === authoritativeValue)) {
        compatibilityStorage.removeItem(key);
      }
    }
  };
}

export function recoveryStorageEventMatchesScope(
  event: Pick<StorageEvent, "key" | "storageArea">,
  storageScope: string,
  authoritativeStorage: Storage
): boolean {
  return event.key === storageScope && event.storageArea === authoritativeStorage;
}

export function recoveryStorageSyncEventMatchesScope(
  event: { detail?: unknown },
  storageScopes: string | readonly string[]
): boolean {
  const detail = isRecord(event.detail) ? event.detail : undefined;
  if (!detail || typeof detail.storageKey !== "string") return false;
  const scopes = typeof storageScopes === "string" ? [storageScopes] : storageScopes;
  return scopes.includes(detail.storageKey);
}

function notifyRecoveryStorageChange(storageKey: string): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(RECOVERY_STORAGE_SYNC_EVENT, {
    detail: { storageKey }
  }));
}

export async function withRecoveryStorageLock<T>(storageScope: string, action: () => T | Promise<T>): Promise<T> {
  if (typeof window === "undefined") return action();
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("浏览器不支持安全的跨标签恢复协调");
  return navigator.locks.request(
    `${SHARED_RECOVERY_LOCK_PREFIX}:${encodeURIComponent(storageScope)}`,
    { mode: "exclusive" },
    () => action()
  );
}

export function browserCommandRecoveryStorage():
  | { kind: "AVAILABLE"; storage: CommandRecoveryStorage; authoritativeStorage: Storage }
  | { kind: "READ_ERROR"; error: Error } {
  if (typeof window === "undefined") return { kind: "READ_ERROR", error: new Error("浏览器恢复存储不可用") };
  try {
    const authoritativeStorage = window.localStorage;
    const compatibilityStorage = window.sessionStorage;
    const sharedStorage = createSharedCommandRecoveryStorage(authoritativeStorage, compatibilityStorage);
    const storage: CommandRecoveryStorage = {
      getItem: (key) => sharedStorage.getItem(key),
      setItem: (key, value) => {
        sharedStorage.setItem(key, value);
        notifyRecoveryStorageChange(key);
      },
      removeItem: (key) => {
        sharedStorage.removeItem(key);
        notifyRecoveryStorageChange(key);
      }
    };
    return {
      kind: "AVAILABLE",
      storage,
      authoritativeStorage
    };
  } catch {
    return { kind: "READ_ERROR", error: new Error("无法访问本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
}

export function commandRecoveryStorageKey(subjectId: string, scopeId: string): string {
  return `${COMMAND_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(scopeId)}`;
}

export function quoteRecoveryStorageKey(subjectId: string, propertyId: string): string {
  return `${QUOTE_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

export function propertyRecoveryCoordinationScope(subjectId: string, propertyId: string): string {
  return `property-recovery:${encodeURIComponent(subjectId)}:${encodeURIComponent(propertyId)}`;
}

function recoveryScopePropertyId(scopeId: string): string | undefined {
  const prefix = "property:";
  if (!scopeId.startsWith(prefix)) return undefined;
  const propertyId = scopeId.slice(prefix.length);
  return propertyId || undefined;
}

export function commandRecoveryConflictStorageKeys(
  subjectId: string,
  scopeId: string,
  additionalKeys: readonly string[] = []
): string[] {
  const propertyId = recoveryScopePropertyId(scopeId);
  return [...new Set([
    ...(propertyId ? [quoteRecoveryStorageKey(subjectId, propertyId)] : []),
    ...additionalKeys
  ])];
}

export function commandRecoveryStorageHasConflict(
  storage: CommandRecoveryStorage,
  subjectId: string,
  scopeId: string,
  additionalKeys: readonly string[] = []
): boolean {
  return commandRecoveryConflictStorageKeys(subjectId, scopeId, additionalKeys)
    .some((key) => storage.getItem(key) !== null);
}

export type CommandRecoveryConflictReadResult =
  | { kind: "ABSENT" }
  | { kind: "PRESENT"; storageKey: string }
  | { kind: "READ_ERROR"; error: Error };

export function readCommandRecoveryConflict(
  storage: CommandRecoveryStorage,
  subjectId: string,
  scopeId: string,
  additionalKeys: readonly string[] = []
): CommandRecoveryConflictReadResult {
  try {
    const storageKey = commandRecoveryConflictStorageKeys(subjectId, scopeId, additionalKeys)
      .find((key) => storage.getItem(key) !== null);
    return storageKey ? { kind: "PRESENT", storageKey } : { kind: "ABSENT" };
  } catch {
    return {
      kind: "READ_ERROR",
      error: new Error("无法核对本物业的其他恢复记录；为避免重复写入，写入口继续暂停")
    };
  }
}

export function commandRecoverySnapshotIsBlocked(
  read: CommandRecoveryReadResult,
  conflict: CommandRecoveryConflictReadResult
): boolean {
  return read.kind !== "ABSENT" || conflict.kind !== "ABSENT";
}

export type RecoveryCoordinatedPreviewRunner = <T>(execute: () => Promise<T>) => Promise<T>;

export type RecoveryStorageLock = <T>(
  storageScope: string,
  action: () => T | Promise<T>
) => Promise<T>;

export type RecoveryCheckedPreviewResult<T> =
  | {
      kind: "EXECUTED";
      value: T;
      read: { kind: "ABSENT" };
      conflict: { kind: "ABSENT" };
    }
  | {
      kind: "BLOCKED";
      read: CommandRecoveryReadResult;
      conflict: CommandRecoveryConflictReadResult;
      error: Error;
    };

export async function runRecoveryCheckedPreview<T>({
  storage,
  subjectId,
  scopeId,
  conflictingStorageKeys = [],
  execute,
  lock = withRecoveryStorageLock
}: {
  storage: CommandRecoveryStorage;
  subjectId: string;
  scopeId: string;
  conflictingStorageKeys?: readonly string[];
  execute: () => Promise<T>;
  lock?: RecoveryStorageLock;
}): Promise<RecoveryCheckedPreviewResult<T>> {
  const propertyId = recoveryScopePropertyId(scopeId);
  const coordinationScope = propertyId
    ? propertyRecoveryCoordinationScope(subjectId, propertyId)
    : commandRecoveryStorageKey(subjectId, scopeId);
  return lock(coordinationScope, async () => {
    const read = readPersistedCommandRecovery(storage, subjectId, scopeId);
    const conflict = readCommandRecoveryConflict(storage, subjectId, scopeId, conflictingStorageKeys);
    if (read.kind !== "ABSENT" || conflict.kind !== "ABSENT") {
      const error = read.kind === "CORRUPT" || read.kind === "READ_ERROR"
        ? read.error
        : read.kind === "VALID"
          ? new Error("本物业另有未收口的操作；请先核对原操作结果，本次核对尚未开始")
          : conflict.kind === "READ_ERROR"
            ? conflict.error
            : new Error("本物业另有未收口的报价操作；请先核对原报价结果，本次核对尚未开始");
      return { kind: "BLOCKED", read, conflict, error };
    }
    const value = await execute();
    return { kind: "EXECUTED", value, read, conflict };
  });
}

export function readPersistedCommandRecovery(storage: CommandRecoveryStorage, subjectId: string, scopeId: string): CommandRecoveryReadResult {
  let serialized: string | null;
  try {
    serialized = storage.getItem(commandRecoveryStorageKey(subjectId, scopeId));
  } catch (error) {
    return error instanceof CorruptCommandRecoveryStorageError
      ? { kind: "CORRUPT", error }
      : { kind: "READ_ERROR", error: new Error("无法读取本地命令恢复记录；为避免重复写入，已暂停本物业写命令") };
  }
  if (serialized === null) return { kind: "ABSENT" };

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录已损坏；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  const scopedPropertyId = recoveryScopePropertyId(scopeId);
  if (!isRecord(value)
    || value.version !== 1
    || value.subjectId !== subjectId
    || value.scopeId !== scopeId
    || scopedPropertyId === undefined
    || typeof value.propertyId !== "string"
    || value.propertyId !== scopedPropertyId
    || !isReadableRecoveryCommandType(value.commandType)
    || typeof value.confirmationKey !== "string"
    || !value.confirmationKey
    || value.confirmationKey !== value.confirmationKey.trim()
    || value.confirmationKey.length > 160
    || !Array.isArray(value.targetRefs)
    || !value.targetRefs.every((item) => typeof item === "string")
    || !recoveryTargetRefsAreValid(value.commandType, value.targetRefs as string[])
    || (value.presentation !== undefined && value.presentation !== "MEMBER_STAY" && value.presentation !== "BACKFILL_STAY" && value.presentation !== "COMPLETE_STAY" && value.presentation !== "FULFILLMENT" && value.presentation !== "STAY_DATES" && value.presentation !== "MOVE_UNIT" && value.presentation !== "ORDER_LIFECYCLE")
    || (value.presentation === "MEMBER_STAY" && value.commandType !== "CREATE_ORDER")
    || (value.presentation === "BACKFILL_STAY" && value.commandType !== "CREATE_ORDER")
    || (value.presentation === "COMPLETE_STAY" && value.commandType !== "COMPLETE_STAY")
    || (value.presentation === "FULFILLMENT" && !isFulfillmentBusinessCommand(value.commandType))
    || (value.presentation === "STAY_DATES" && value.commandType !== "RESCHEDULE_STAY" && value.commandType !== "EXTEND_STAY" && value.commandType !== "SHORTEN_STAY")
    || (value.presentation === "MOVE_UNIT" && value.commandType !== "MOVE_UNIT")
    || (value.presentation === "ORDER_LIFECYCLE" && value.commandType !== "CANCEL_ORDER" && value.commandType !== "MARK_NO_SHOW" && value.commandType !== "REVOKE_CHECK_IN")
    || (requiredRecoveryPresentation(value.commandType) !== undefined
      && value.presentation !== requiredRecoveryPresentation(value.commandType))
    || ((value.presentation === "BACKFILL_STAY"
      || value.presentation === "COMPLETE_STAY"
      || value.presentation === "STAY_DATES"
      || value.presentation === "MOVE_UNIT"
      || value.presentation === "ORDER_LIFECYCLE"
      || value.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") && !isEffectHash(value.effectHash))
    || (value.effectHash !== undefined && !isEffectHash(value.effectHash))
    || (value.state !== "CONFIRMING" && value.state !== "UNKNOWN" && value.state !== "EXECUTED" && value.state !== "NOT_EXECUTED")
    || typeof value.updatedAt !== "string") {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录版本或结构无效；无法确认原命令是否执行，已暂停本物业写命令") };
  }
  if (Object.hasOwn(value, "receipt")) {
    return { kind: "CORRUPT", error: new Error("本地命令恢复记录包含不应持久化的业务结果；已暂停本物业写命令") };
  }
  return { kind: "VALID", recovery: value as unknown as PersistedCommandRecovery };
}

export function savePersistedCommandRecovery(storage: CommandRecoveryStorage, recovery: PersistedCommandRecovery): boolean {
  if (recoveryScopePropertyId(recovery.scopeId) !== recovery.propertyId
    || !recoveryTargetRefsAreValid(recovery.commandType, recovery.targetRefs)) return false;
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

export function clearPersistedCommandRecoveryIfMatches(
  storage: CommandRecoveryStorage,
  expected: PersistedCommandRecovery
): boolean {
  try {
    const key = commandRecoveryStorageKey(expected.subjectId, expected.scopeId);
    if (storage.getItem(key) !== JSON.stringify(expected)) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function clearTerminalPersistedCommandRecoveryIfPresent(
  storage: CommandRecoveryStorage,
  subjectId: string,
  scopeId: string
): CommandRecoveryReadResult {
  const current = readPersistedCommandRecovery(storage, subjectId, scopeId);
  if (current.kind !== "VALID" || !isTerminalCommandRecovery(current.recovery.state)) return current;
  if (clearPersistedCommandRecoveryIfMatches(storage, current.recovery)) return { kind: "ABSENT" };
  return readPersistedCommandRecovery(storage, subjectId, scopeId);
}

export function clearCorruptPersistedCommandRecovery(
  storage: CommandRecoveryStorage,
  subjectId: string,
  scopeId: string
): boolean {
  const current = readPersistedCommandRecovery(storage, subjectId, scopeId);
  return current.kind === "CORRUPT"
    && clearPersistedCommandRecovery(storage, subjectId, scopeId);
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
    const targetRefs = recoveryTargetRefs(context.request.input);
    const requiredPresentation = requiredRecoveryPresentation(context.request.commandType);
    const strictRecoveryEvidence = context.request.presentation === "BACKFILL_STAY"
      || requiredPresentation !== undefined
      || context.request.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP";
    if (!isPersistableCommandType(context.request.commandType) || typeof propertyId !== "string" || !propertyId) {
      return { accepted: false, recovery: current };
    }
    if (requiredPresentation !== undefined && context.request.presentation !== requiredPresentation) {
      return { accepted: false, recovery: current };
    }
    if (!recoveryTargetRefsAreValid(context.request.commandType, targetRefs)) return { accepted: false, recovery: current };
    if (strictRecoveryEvidence && !isEffectHash(progress.effectHash)) return { accepted: false, recovery: current };
    if (current && current.confirmationKey !== progress.confirmationKey) return { accepted: false, recovery: current };
    if (current?.effectHash !== undefined && current.effectHash !== progress.effectHash) return { accepted: false, recovery: current };
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
        targetRefs,
        ...(context.request.presentation ? { presentation: context.request.presentation } : {}),
        ...(strictRecoveryEvidence ? { effectHash: progress.effectHash } : {}),
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
    recovery: { ...current, state: progress.receipt.executionStatus, updatedAt }
  };
}

export function recoveryCommandRequest(recovery: PersistedCommandRecovery): CommandRequest {
  const memberStay = recovery.presentation === "MEMBER_STAY";
  const backfillStay = recovery.presentation === "BACKFILL_STAY";
  const completeStay = recovery.presentation === "COMPLETE_STAY";
  const fulfillment = recovery.presentation === "FULFILLMENT";
  const stayDates = recovery.presentation === "STAY_DATES";
  const moveUnit = recovery.presentation === "MOVE_UNIT";
  const orderLifecycle = recovery.presentation === "ORDER_LIFECYCLE";
  const commandType = isExecutableCommandType(recovery.commandType) ? recovery.commandType : undefined;
  const u1CommandType = isU1CommandType(recovery.commandType) ? recovery.commandType : undefined;
  const restoreTargetInputs = completeStay
    || stayDates
    || moveUnit
    || orderLifecycle
    || recovery.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP";
  const targetInputs = restoreTargetInputs ? parsedRecoveryTargetRefs(recovery.targetRefs) ?? {} : {};
  return {
    commandType: recovery.commandType,
    title: memberStay
      ? "恢复会员住宿结果"
      : backfillStay
        ? "恢复补录住宿结果"
      : completeStay
        ? "恢复完成住宿结果"
      : fulfillment && commandType
        ? `恢复${fulfillmentCommandLabel(commandType)}结果`
        : stayDates && u1CommandType
          ? `恢复${commandShellLabel(u1CommandType)}结果`
        : orderLifecycle && u1CommandType
          ? `恢复${commandShellLabel(u1CommandType)}结果`
        : moveUnit && u1CommandType
          ? `恢复${commandShellLabel(u1CommandType)}结果`
        : u1CommandType
          ? `查询${commandShellLabel(u1CommandType)}结果`
        : `${recovery.commandType} · 原命令恢复`,
    description: memberStay
      ? "系统只查询原住宿办理结果，不会重复创建订单或冻结会员权益。"
      : backfillStay
        ? "系统只查询原补录住宿结果，不会重复创建订单、退房记录或收款事实。"
      : completeStay
        ? "系统只查询刚才的办理结果，不会重复完成订单或重复登记收款。"
      : fulfillment
        ? "系统只查询刚才的操作结果，不会重复办理。"
        : stayDates && u1CommandType
          ? `系统只查询刚才的${commandShellLabel(u1CommandType)}结果，不会重复提交。`
        : orderLifecycle && u1CommandType
          ? `系统只查询刚才的${commandShellLabel(u1CommandType)}结果，不会重复提交。`
        : moveUnit && u1CommandType
          ? `系统只查询刚才的${commandShellLabel(u1CommandType)}结果，不会重复提交。`
        : u1CommandType
          ? `系统只查询刚才的${commandShellLabel(u1CommandType)}结果，不会重复提交。`
        : "仅使用已保存的原幂等键查询服务端命令结果，不会发起新的业务写入。",
    ...(recovery.presentation ? { presentation: recovery.presentation } : {}),
    ...(recovery.effectHash ? { recoveryEffectHash: recovery.effectHash } : {}),
    input: {
      ...targetInputs,
      propertyId: recovery.propertyId,
      ...(backfillStay ? { backfill: true } : {}),
      ...(completeStay ? { actualStayCompletedConfirmed: true } : {}),
      ...(orderLifecycle && recovery.commandType === "REVOKE_CHECK_IN" ? { unusedRoomConfirmed: true } : {})
    }
  };
}

class RecoveryPreviewBlockedError extends Error {}

export function usePersistentCommandRecovery({
  subjectId,
  scopeId,
  conflictingStorageKeys = []
}: {
  subjectId: string;
  scopeId: string;
  conflictingStorageKeys?: readonly string[];
}) {
  const storageScope = commandRecoveryStorageKey(subjectId, scopeId);
  const scopedPropertyId = recoveryScopePropertyId(scopeId);
  const effectiveConflictingStorageKeys = commandRecoveryConflictStorageKeys(subjectId, scopeId, conflictingStorageKeys);
  const watchedStorageScopes = [storageScope, ...effectiveConflictingStorageKeys];
  const snapshotScope = JSON.stringify(watchedStorageScopes);
  const coordinationScope = scopedPropertyId
    ? propertyRecoveryCoordinationScope(subjectId, scopedPropertyId)
    : storageScope;
  const activeSnapshotScopeRef = useRef(snapshotScope);
  const initialTerminalCleanupScopeRef = useRef<string | undefined>(undefined);
  activeSnapshotScopeRef.current = snapshotScope;

  function readBrowserSnapshot(): {
    snapshotScope: string;
    read: CommandRecoveryReadResult;
    conflict: CommandRecoveryConflictReadResult;
  } {
    const access = browserCommandRecoveryStorage();
    const read = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readPersistedCommandRecovery(access.storage, subjectId, scopeId)
        : access;
    const conflict = !scopeId
      ? { kind: "ABSENT" } as const
      : access.kind === "AVAILABLE"
        ? readCommandRecoveryConflict(access.storage, subjectId, scopeId, conflictingStorageKeys)
        : { kind: "READ_ERROR", error: access.error } as const;
    return { snapshotScope, read, conflict };
  }

  const [snapshot, setSnapshot] = useState(readBrowserSnapshot);
  const [operationError, setOperationError] = useState<Error>();

  function currentConflictRead(): CommandRecoveryConflictReadResult {
    const access = browserCommandRecoveryStorage();
    if (!scopeId) return { kind: "ABSENT" };
    return access.kind === "AVAILABLE"
      ? readCommandRecoveryConflict(access.storage, subjectId, scopeId, conflictingStorageKeys)
      : { kind: "READ_ERROR", error: access.error };
  }

  function setActiveSnapshot(
    read: CommandRecoveryReadResult,
    conflict: CommandRecoveryConflictReadResult = currentConflictRead()
  ): void {
    if (activeSnapshotScopeRef.current === snapshotScope) {
      setSnapshot({ snapshotScope, read, conflict });
    }
  }

  function refreshActiveSnapshot(): void {
    const next = readBrowserSnapshot();
    if (activeSnapshotScopeRef.current === next.snapshotScope) setSnapshot(next);
  }

  useEffect(() => {
    refreshActiveSnapshot();
    setOperationError(undefined);
  }, [scopeId, snapshotScope, subjectId]);

  useEffect(() => {
    if (!scopeId) return;
    const access = browserCommandRecoveryStorage();
    if (access.kind !== "AVAILABLE") return;
    const handleStorage = (event: StorageEvent) => {
      if (!watchedStorageScopes.some((scope) => recoveryStorageEventMatchesScope(event, scope, access.authoritativeStorage))) return;
      refreshActiveSnapshot();
      setOperationError(undefined);
    };
    const handleSync = (event: Event) => {
      if (!recoveryStorageSyncEventMatchesScope(event as CustomEvent<unknown>, watchedStorageScopes)) return;
      refreshActiveSnapshot();
      setOperationError(undefined);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(RECOVERY_STORAGE_SYNC_EVENT, handleSync);
    };
  }, [scopeId, snapshotScope, subjectId]);

  const ready = snapshot.snapshotScope === snapshotScope;
  const read = ready ? snapshot.read : { kind: "READ_ERROR", error: new Error("正在核对本地命令恢复记录") } as const;
  const conflict = ready ? snapshot.conflict : { kind: "READ_ERROR", error: new Error("正在核对本物业的其他恢复记录") } as const;
  const pending = read.kind === "VALID" ? read.recovery : undefined;
  const error = operationError
    ?? (read.kind === "CORRUPT" || read.kind === "READ_ERROR" ? read.error : undefined)
    ?? (conflict.kind === "READ_ERROR" ? conflict.error : undefined);
  const blocked = !ready || commandRecoverySnapshotIsBlocked(read, conflict);

  useEffect(() => {
    if (!ready || initialTerminalCleanupScopeRef.current === snapshotScope) return;
    initialTerminalCleanupScopeRef.current = snapshotScope;
    if (read.kind !== "VALID" || !isTerminalCommandRecovery(read.recovery.state)) return;
    let current = true;
    void withRecoveryStorageLock(coordinationScope, () => {
      const access = browserCommandRecoveryStorage();
      if (access.kind === "READ_ERROR" || !scopeId) {
        return access.kind === "READ_ERROR"
          ? access
          : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") } as const;
      }
      return clearTerminalPersistedCommandRecoveryIfPresent(access.storage, subjectId, scopeId);
    }).then((nextRead) => {
      if (!current) return;
      setActiveSnapshot(nextRead);
      if (nextRead.kind === "VALID" && isTerminalCommandRecovery(nextRead.recovery.state)) {
        setOperationError(new Error("无法清除已收口的本地命令恢复记录；写入口继续暂停"));
      } else if (nextRead.kind === "CORRUPT" || nextRead.kind === "READ_ERROR") {
        setOperationError(nextRead.error);
      } else {
        setOperationError(undefined);
      }
    }).catch(() => {
      if (!current) return;
      setOperationError(new Error("无法取得跨标签恢复协调锁；写入口继续暂停"));
    });
    return () => { current = false; };
  }, [coordinationScope, ready, scopeId, snapshotScope, subjectId]);

  async function runPreview<T>(execute: () => Promise<T>): Promise<T> {
    const access = browserCommandRecoveryStorage();
    if (access.kind === "READ_ERROR" || !scopeId) {
      const nextError = access.kind === "READ_ERROR"
        ? access.error
        : new Error("命令恢复作用域不可用");
      setActiveSnapshot({ kind: "READ_ERROR", error: nextError });
      setOperationError(nextError);
      throw new RecoveryPreviewBlockedError(nextError.message);
    }
    let executeStarted = false;
    try {
      const result = await runRecoveryCheckedPreview({
        storage: access.storage,
        subjectId,
        scopeId,
        conflictingStorageKeys,
        execute: async () => {
          executeStarted = true;
          return execute();
        }
      });
      setActiveSnapshot(result.read, result.conflict);
      if (result.kind === "BLOCKED") {
        setOperationError(result.error);
        throw new RecoveryPreviewBlockedError(result.error.message);
      }
      setOperationError(undefined);
      return result.value;
    } catch (nextError) {
      if (nextError instanceof RecoveryPreviewBlockedError || executeStarted) throw nextError;
      const lockError = new Error("无法取得跨标签恢复协调锁；写入口继续暂停");
      setActiveSnapshot({ kind: "READ_ERROR", error: lockError });
      setOperationError(lockError);
      throw new RecoveryPreviewBlockedError(lockError.message);
    }
  }

  function track(request: CommandRequest, progress: CommandDialogProgress): boolean | Promise<boolean> {
    if (progress.state !== "PREVIEWING" && progress.state !== "CONFIRMING" && progress.state !== "FAILED_NOT_EXECUTED" && progress.state !== "UNKNOWN" && progress.state !== "RESOLVED") return true;
    if (progress.state === "PREVIEWING" && progress.executePreview) {
      return runPreview(progress.executePreview)
        .then(() => true)
        .catch((nextError) => {
          if (nextError instanceof RecoveryPreviewBlockedError) return false;
          throw nextError;
        });
    }
    const persistProgress = (): boolean => {
      if (progress.state === "CONFIRMING" && progress.isAttemptActive && !progress.isAttemptActive()) return false;
      const access = browserCommandRecoveryStorage();
      if (access.kind === "READ_ERROR" || !scopeId) {
        setActiveSnapshot(access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") });
        return false;
      }
      const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
      if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") {
        setActiveSnapshot(currentRead);
        return false;
      }
      const currentConflict = readCommandRecoveryConflict(access.storage, subjectId, scopeId, conflictingStorageKeys);
      if (progress.state === "PREVIEWING") {
        setActiveSnapshot(currentRead, currentConflict);
        if (currentRead.kind !== "ABSENT") {
          setOperationError(new Error("本物业另有未收口的操作；请先核对原操作结果，本次核对尚未开始"));
          return false;
        }
        if (currentConflict.kind === "PRESENT") {
          setOperationError(new Error("本物业另有未收口的报价操作；请先核对原报价结果，本次核对尚未开始"));
          return false;
        }
        if (currentConflict.kind === "READ_ERROR") {
          setOperationError(currentConflict.error);
          return false;
        }
        setOperationError(undefined);
        return true;
      }
      if (progress.state === "CONFIRMING" && currentRead.kind === "ABSENT") {
        setActiveSnapshot(currentRead, currentConflict);
        if (currentConflict.kind === "PRESENT") {
          setOperationError(new Error("本物业另有未收口的报价操作；请先核对原报价结果，本次操作尚未发送"));
          return false;
        }
        if (currentConflict.kind === "READ_ERROR") {
          setOperationError(currentConflict.error);
          return false;
        }
        setOperationError(undefined);
      }
      const current = currentRead.kind === "VALID" ? currentRead.recovery : undefined;
      const transition = transitionPersistedCommandRecovery(current, { subjectId, scopeId, request }, progress);
      if (!transition.accepted) return false;
      if (progress.state === "FAILED_NOT_EXECUTED" && current && transition.recovery === undefined) {
        if (!clearPersistedCommandRecoveryIfMatches(access.storage, current)) {
          const latestRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
          setActiveSnapshot(latestRead);
          if (latestRead.kind === "ABSENT") return true;
          if (latestRead.kind === "VALID" && latestRead.recovery.confirmationKey !== current.confirmationKey) {
            setOperationError(undefined);
            return false;
          }
          setOperationError(new Error("命令已明确未执行，但无法清除对应的本地恢复记录；写入口继续暂停"));
          return false;
        }
        setOperationError(undefined);
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
    };
    return withRecoveryStorageLock(coordinationScope, persistProgress).catch(() => {
      setActiveSnapshot({ kind: "READ_ERROR", error: new Error("无法取得跨标签恢复协调锁；写入口继续暂停") });
      return false;
    });
  }

  async function clearResolved(): Promise<boolean> {
    try {
      return await withRecoveryStorageLock(coordinationScope, () => {
        const access = browserCommandRecoveryStorage();
        if (access.kind === "READ_ERROR" || !scopeId) {
          setActiveSnapshot(access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") });
          return false;
        }
        const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
        if (currentRead.kind === "ABSENT") {
          setOperationError(undefined);
          setActiveSnapshot(currentRead);
          return true;
        }
        if (currentRead.kind !== "VALID" || !isTerminalCommandRecovery(currentRead.recovery.state)) {
          if (currentRead.kind === "CORRUPT" || currentRead.kind === "READ_ERROR") setActiveSnapshot(currentRead);
          return false;
        }
        if (!clearPersistedCommandRecoveryIfMatches(access.storage, currentRead.recovery)) {
          const latestRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
          if (latestRead.kind === "ABSENT") {
            setOperationError(undefined);
            setActiveSnapshot(latestRead);
            return true;
          }
          if (latestRead.kind === "VALID" && latestRead.recovery.confirmationKey !== currentRead.recovery.confirmationKey) {
            setOperationError(undefined);
            setActiveSnapshot(latestRead);
            return false;
          }
          if (latestRead.kind === "CORRUPT" || latestRead.kind === "READ_ERROR") setActiveSnapshot(latestRead);
          setOperationError(new Error("无法清除已收口的本地命令恢复记录；写入口继续暂停，可再次打开原结果重试收口"));
          return false;
        }
        setOperationError(undefined);
        setActiveSnapshot({ kind: "ABSENT" });
        return true;
      });
    } catch {
      setOperationError(new Error("无法取得跨标签恢复协调锁；写入口继续暂停"));
      return false;
    }
  }

  async function discardCorruptAfterReview(): Promise<boolean> {
    try {
      return await withRecoveryStorageLock(coordinationScope, () => {
        const access = browserCommandRecoveryStorage();
        if (access.kind === "READ_ERROR" || !scopeId) {
          setActiveSnapshot(access.kind === "READ_ERROR" ? access : { kind: "READ_ERROR", error: new Error("命令恢复作用域不可用") });
          return false;
        }
        const currentRead = readPersistedCommandRecovery(access.storage, subjectId, scopeId);
        if (currentRead.kind === "ABSENT") {
          setOperationError(undefined);
          setActiveSnapshot(currentRead);
          return true;
        }
        if (currentRead.kind !== "CORRUPT") {
          setActiveSnapshot(currentRead);
          return false;
        }
        if (!clearCorruptPersistedCommandRecovery(access.storage, subjectId, scopeId)) {
          setOperationError(new Error("无法清除损坏的本地恢复记录；写入口继续暂停，请联系管理员处理浏览器存储权限"));
          return false;
        }
        setOperationError(undefined);
        setActiveSnapshot({ kind: "ABSENT" });
        return true;
      });
    } catch {
      setOperationError(new Error("无法取得跨标签恢复协调锁；写入口继续暂停"));
      return false;
    }
  }

  return {
    ready,
    pending,
    error,
    blocked,
    conflict,
    canDiscardCorrupt: ready && read.kind === "CORRUPT",
    runPreview,
    track,
    clearResolved,
    discardCorruptAfterReview
  };
}

export function DamagedCommandRecoveryNotice({ error, onDiscard, testId = "damaged-command-recovery" }: {
  error: unknown;
  onDiscard: () => void | Promise<unknown>;
  testId?: string;
}) {
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  return (
    <section className="recovery-bar recovery-damaged" role="alert" data-testid={testId}>
      <div className="recovery-damaged-copy">
        <strong>本地操作记录需要人工核对</strong>
        <p>{errorMessage(error)}</p>
        <ol>
          <li>先在当前业务页面核对订单、房态或会员记录，确认刚才的操作是否已经生效。</li>
          <li>已经生效时不要重复办理；确认未生效后，才能清除本物业的损坏记录并重新操作。</li>
        </ol>
      </div>
      <div className="recovery-damaged-actions">
        <label>
          <input
            type="checkbox"
            checked={reviewConfirmed}
            onChange={(event) => setReviewConfirmed(event.target.checked)}
          />
          <span>我已核对服务端业务记录，并确认不会直接重复刚才的操作</span>
        </label>
        <button
          className="button button-secondary"
          type="button"
          disabled={!reviewConfirmed}
          onClick={() => {
            void onDiscard();
            setReviewConfirmed(false);
          }}
        >清除本物业损坏记录</button>
      </div>
    </section>
  );
}

export function QuoteRecoveryConflictNotice({ conflict, testId = "quote-recovery-conflict" }: {
  conflict: CommandRecoveryConflictReadResult;
  testId?: string;
}) {
  if (conflict.kind !== "PRESENT") return null;
  return (
    <section className="recovery-bar" role="status" aria-live="polite" data-testid={testId}>
      <div>
        <strong>报价结果尚未收口</strong>
        <p>本门店有一笔住宿报价需要先核对。处理完成前，会员和订单写操作会保持暂停。</p>
      </div>
      <Link className="button button-secondary" to="/">
        <ChevronRight aria-hidden="true" size={17} />返回房态处理
      </Link>
    </section>
  );
}

export function CommandRecoveryBar({ recovery, onOpen, testId = "command-recovery", businessFacing = false }: {
  recovery: PersistedCommandRecovery;
  onOpen: () => void;
  testId?: string;
  businessFacing?: boolean;
}) {
  const resolved = isTerminalCommandRecovery(recovery.state);
  const submitting = recovery.state === "CONFIRMING";
  const memberStay = recovery.presentation === "MEMBER_STAY";
  const backfillStay = recovery.presentation === "BACKFILL_STAY";
  const completeStay = recovery.presentation === "COMPLETE_STAY";
  const fulfillment = recovery.presentation === "FULFILLMENT";
  const fundBusiness = recovery.commandType === "RECORD_COLLECTION" || recovery.commandType === "RECORD_REFUND";
  const tokenBusiness = tokenBusinessCommands.has(recovery.commandType as CommandType);
  const u1CommandType = isU1CommandType(recovery.commandType) ? recovery.commandType : undefined;
  const businessMode = businessFacing || memberStay || backfillStay || completeStay || fulfillment || fundBusiness || tokenBusiness || Boolean(u1CommandType);
  const memberRegistration = businessMode && recovery.commandType === "CREATE_MEMBER";
  const fulfillmentLabel = isExecutableCommandType(recovery.commandType) ? fulfillmentCommandLabel(recovery.commandType) : "履约操作";
  const u1Label = u1CommandType ? commandShellLabel(u1CommandType) : undefined;
  const fundLabel = fundBusiness ? (recovery.commandType === "RECORD_REFUND" ? "登记退款" : "登记收款") : undefined;
  const tokenLabel = tokenBusiness ? tokenCommandLabel(recovery.commandType) : undefined;
  return (
    <section className="recovery-bar" role="status" aria-live="polite" aria-label={memberRegistration ? "待恢复会员建档" : memberStay ? "待恢复会员住宿" : backfillStay ? "待恢复补录住宿" : completeStay ? "待恢复完成住宿" : fulfillment ? `待恢复${fulfillmentLabel}` : u1Label ? `待恢复${u1Label}` : fundLabel ? `待恢复${fundLabel}` : tokenLabel ? `待恢复${tokenLabel}` : businessMode ? "待恢复会员操作" : "待恢复命令"} data-testid={testId}>
      <div>
        <strong>{submitting
          ? "原操作正在提交"
          : businessMode
          ? memberRegistration
            ? (resolved ? "原建档结果已确认" : "会员建档结果需要恢复查询")
            : memberStay
              ? (resolved ? "原会员住宿结果已确认" : "会员住宿结果需要恢复查询")
              : backfillStay
                ? (resolved ? "原补录住宿结果已确认" : "补录住宿结果需要查询")
              : completeStay
                ? (resolved ? "原完成住宿结果已确认" : "完成住宿结果需要查询")
              : fulfillment
                ? (resolved ? `原${fulfillmentLabel}结果已确认` : `${fulfillmentLabel}结果需要恢复查询`)
                : u1Label
                  ? (resolved ? `${u1Label}结果已确认` : `${u1Label}结果需要恢复查询`)
                : fundLabel
                  ? (resolved ? `${fundLabel}结果已确认` : `${fundLabel}结果需要恢复查询`)
                : tokenLabel
                  ? (resolved ? `${tokenLabel}结果已确认` : `${tokenLabel}结果需要查询`)
              : (resolved ? "原会员操作结果已确认" : "会员操作结果需要恢复查询")
          : (resolved ? "原命令结果已确认" : "原命令执行状态需要恢复查询")}</strong>
        {!businessMode ? <>
          <p><code>{recovery.commandType}</code> · {recovery.state} · Property <code>{recovery.propertyId}</code></p>
          {recovery.targetRefs.length ? <p>业务目标 {recovery.targetRefs.map((reference) => <code key={reference}>{reference}</code>)}</p> : null}
          <p>原幂等键 <code>{recovery.confirmationKey}</code></p>
        </> : null}
        <p>{submitting
          ? "新的写入已暂停。可以等待原标签完成；如果原标签已经关闭，可核对原操作结果，系统会阻止迟到请求重复写入。"
          : businessMode
          ? memberRegistration
            ? (resolved ? "查看并关闭原建档结果后，可继续新建会员。" : "新的会员建档已暂停，请先恢复查询原结果。")
            : memberStay
              ? (resolved ? "查看并关闭原住宿结果后，可继续办理住宿。" : "新的会员住宿已暂停，请先恢复查询原结果。")
              : backfillStay
                ? (resolved ? "查看并关闭原补录结果后，可继续办理住宿。" : "新的住宿写入已暂停，请先查询原补录结果。")
              : completeStay
                ? (resolved ? "查看并关闭原完成住宿结果后，可继续办理住宿。" : "新的住宿写入已暂停，请先查询原完成住宿结果。")
              : fulfillment
                ? (resolved ? `查看并关闭原${fulfillmentLabel}结果后，可继续操作。` : `新的${fulfillmentLabel}操作已暂停，请先查询刚才的结果。`)
                : u1Label
                  ? (resolved ? `${u1Label}结果已经确认，打开后将刷新当前页面。` : `新的${u1Label}已暂停，请先查询刚才的结果。`)
                : fundLabel
                  ? (resolved ? `${fundLabel}结果已经确认，打开后将刷新当前页面。` : `新的${fundLabel}已暂停，请先查询刚才的结果。`)
                : tokenLabel
                  ? (resolved ? `${tokenLabel}结果已经确认，打开后将刷新 Token 列表。` : `新的 Token 操作已暂停，请先查询刚才的结果。`)
              : (resolved ? "查看并关闭原操作结果后，可继续处理会员业务。" : "新的会员操作已暂停，请先恢复查询原结果。")
          : (resolved ? "查看并关闭 Receipt 后恢复新的业务写入。" : "新的业务写入已暂停，必须继续查询原命令。")}</p>
      </div>
      <button className="button button-secondary" type="button" onClick={onOpen} data-testid={`${testId}-open`}>
        <RefreshCw aria-hidden="true" size={17} />{businessMode
          ? memberRegistration
            ? (resolved ? "查看建档结果" : "恢复建档结果")
            : memberStay
              ? (resolved ? "查看住宿结果" : "恢复住宿结果")
              : backfillStay
                ? (resolved ? "查看补录结果" : "查询补录结果")
              : completeStay
                ? (resolved ? "查看完成住宿结果" : "查询完成住宿结果")
              : fulfillment
                ? (resolved ? `查看${fulfillmentLabel}结果` : `查询${fulfillmentLabel}结果`)
                : u1Label
                  ? (resolved ? `刷新${u1Label}结果` : `查询${u1Label}结果`)
                : fundLabel
                  ? (resolved ? `刷新${fundLabel}结果` : `查询${fundLabel}结果`)
                : tokenLabel
                  ? (resolved ? `刷新${tokenLabel}结果` : `查询${tokenLabel}结果`)
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
  onBusinessSuccess,
  onBusinessNotExecuted,
  onReturnToEdit,
  initialPreviewMetadata,
  initialConfirmationKey,
  initialReceipt,
  writeBlocked = false,
  writeBlockedReason = "当前事实不再满足安全写入条件。请关闭后刷新并重新生成 Preview。",
  onProgress
}: CommandDialogProps) {
  const backfillStay = request.commandType === "CREATE_ORDER" && request.presentation === "BACKFILL_STAY";
  const completeStay = request.commandType === "COMPLETE_STAY" && request.presentation === "COMPLETE_STAY";
  const initialReceiptHasEvidence = (!backfillStay && !completeStay)
    || !initialReceipt
    || receiptHasCommandEvidence(request.commandType, initialReceipt, request.input, undefined, request.recoveryEffectHash);
  const [preview, setPreview] = useState<PreviewDto>();
  const [receipt, setReceipt] = useState<ReceiptDto | undefined>(initialReceiptHasEvidence ? initialReceipt : undefined);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const executableCommandType = isExecutableCommandType(request.commandType) ? request.commandType : undefined;
  const u1CommandType = !backfillStay && isU1CommandType(request.commandType) ? request.commandType : undefined;
  const memberProfile = request.commandType === "CREATE_MEMBER";
  const membershipBusiness = Boolean(executableCommandType && membershipBusinessCommands.has(executableCommandType));
  const createOrderBusiness = request.commandType === "CREATE_ORDER";
  const memberLodging = request.commandType === "CREATE_ORDER" && request.presentation === "MEMBER_STAY";
  const fundBusiness = request.commandType === "RECORD_COLLECTION" || request.commandType === "RECORD_REFUND";
  const tokenBusiness = Boolean(executableCommandType && tokenBusinessCommands.has(executableCommandType));
  const stayDates = request.presentation === "STAY_DATES"
    && (request.commandType === "RESCHEDULE_STAY" || request.commandType === "EXTEND_STAY" || request.commandType === "SHORTEN_STAY");
  const moveUnit = request.presentation === "MOVE_UNIT" && request.commandType === "MOVE_UNIT";
  const orderLifecycle = request.presentation === "ORDER_LIFECYCLE"
    && (request.commandType === "CANCEL_ORDER" || request.commandType === "MARK_NO_SHOW" || request.commandType === "REVOKE_CHECK_IN");
  const requestBookingChannelValue = request.input.bookingChannelCode;
  const requestBookingChannelCode = typeof requestBookingChannelValue === "string" || requestBookingChannelValue === null
    ? requestBookingChannelValue
    : undefined;
  const fulfillment = Boolean(executableCommandType && fulfillmentBusinessCommands.has(executableCommandType) && request.presentation === "FULFILLMENT");
  const lodgingFulfillment = fulfillment && (request.commandType === "CHECK_IN" || request.commandType === "CHECK_OUT");
  const businessFacing = Boolean(u1CommandType) || memberProfile || membershipBusiness || createOrderBusiness || completeStay || fulfillment || fundBusiness || tokenBusiness;
  const [reasonCode, setReasonCode] = useState(request.initialReason?.code ?? (createOrderBusiness ? "CREATE_STANDARD_ORDER" : memberProfile ? "CREATE_MEMBER_PROFILE" : membershipBusiness ? request.commandType : completeStay ? "COMPLETE_STAY" : fulfillment && executableCommandType ? executableCommandType : fundBusiness ? request.commandType : tokenBusiness ? request.commandType : "OPERATOR_CONFIRMED"));
  const [reasonNote, setReasonNote] = useState(request.initialReason?.note ?? (createOrderBusiness || lodgingFulfillment || completeStay ? "" : memberProfile ? "创建会员档案" : membershipBusiness && executableCommandType ? membershipCommandLabel(executableCommandType) : fulfillment && executableCommandType ? fulfillmentCommandLabel(executableCommandType) : fundBusiness ? (request.commandType === "RECORD_REFUND" ? "" : "登记收款") : tokenBusiness ? tokenCommandLabel(request.commandType) : u1CommandType ? commandShellLabel(u1CommandType) : ""));
  const [confirmationKey, setConfirmationKey] = useState(initialConfirmationKey);
  const recoveryOnlyRequest = Boolean(initialConfirmationKey);
  const [networkUncertain, setNetworkUncertain] = useState(Boolean(initialConfirmationKey && (!initialReceipt || !initialReceiptHasEvidence)));
  const [failedNotExecuted, setFailedNotExecuted] = useState(Boolean(initialReceiptHasEvidence && initialReceipt && initialReceipt.executionStatus === "NOT_EXECUTED"));
  const [returnedOriginalReceipt, setReturnedOriginalReceipt] = useState(Boolean(initialReceiptHasEvidence && initialReceipt));
  const [expiryClock, setExpiryClock] = useState(() => Date.now());
  const [previewMetadata, setPreviewMetadata] = useState<ClientCommandMetadata>(() => initialPreviewMetadata ?? api.commandMetadata(`preview-${request.commandType.toLowerCase()}`));
  const automaticPreviewStarted = useRef(false);
  const shellAttemptIdRef = useRef(1);
  const [shellState, setShellState] = useState(() => initialCommandShellState({
    attemptId: shellAttemptIdRef.current,
    ...(initialConfirmationKey ? { confirmationKey: initialConfirmationKey } : {}),
    succeeded: initialReceiptHasEvidence && initialReceipt?.businessCommitted === true,
    notExecuted: Boolean(initialReceiptHasEvidence && initialReceipt && initialReceipt.executionStatus !== "UNKNOWN" && !initialReceipt.businessCommitted)
  }));
  const requestLeaseRef = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const successFinalizedRef = useRef(false);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const expiryErrorRef = useRef<HTMLDivElement>(null);
  const notExecutedMessage = u1CommandType
    ? recoveryOnlyRequest
      ? `${commandShellLabel(u1CommandType)}未写入；原操作已安全收口，可以关闭后重新发起。`
      : commandShellNotExecutedMessage(u1CommandType)
    : "本次操作未执行。";
  const summaryBusinessCommand = u1CommandType ?? ((fundBusiness || tokenBusiness) && executableCommandType ? executableCommandType : undefined);
  const deterministicPreviewFailure = Boolean(error && !preview && !receipt && !commandPreviewFailureCanReload(error));

  function applyShellEvent(event: CommandShellEvent): boolean {
    let accepted = false;
    setShellState((current) => {
      const transition = transitionCommandShell(current, event);
      accepted = transition.accepted;
      return transition.state;
    });
    return accepted;
  }

  function beginRequestLease(): { id: number; controller: AbortController } {
    requestLeaseRef.current.controller?.abort();
    const next = { id: requestLeaseRef.current.id + 1, controller: new AbortController() };
    requestLeaseRef.current = next;
    return next;
  }

  function leaseIsActive(lease: { id: number; controller: AbortController }): boolean {
    return requestLeaseRef.current.id === lease.id && !lease.controller.signal.aborted;
  }

  useEffect(() => () => {
    requestLeaseRef.current.controller?.abort();
    requestLeaseRef.current = { id: requestLeaseRef.current.id + 1 };
  }, []);

  const previewExpiry = preview ? Date.parse(preview.expiresAt) : Number.POSITIVE_INFINITY;
  const previewExpired = Boolean(preview && (!Number.isFinite(previewExpiry) || expiryClock >= previewExpiry));
  const canConfirm = Boolean(preview
    && reasonCode.trim()
    && (createOrderBusiness || lodgingFulfillment || tokenBusiness || (fundBusiness && (request.commandType === "RECORD_COLLECTION" || reasonNote.trim())) || reasonNote.trim())
    && !busy
    && !writeBlocked
    && !previewExpired
    && !networkUncertain
    && !confirmationKey
    && (!u1CommandType || u1PreviewHasBusinessEvidence(u1CommandType, preview.effect, request.input))
    && (!backfillStay || completedStayBackfillPreviewHasEvidence(preview.effect, request.input))
    && (!fulfillment || fulfillmentTransitionIsExpected(preview.commandType, preview.effect)));
  const dialogCloseDisabled = busy && (!u1CommandType || Boolean(confirmationKey) || shellState.phase === "CONFIRMING");
  const currentKey = useMemo(() => confirmationKey ?? api.recoveryKey(request.commandType), [confirmationKey, request.commandType]);

  useEffect(() => {
    if (!preview || receipt || !Number.isFinite(previewExpiry)) return;
    const delay = Math.max(0, previewExpiry - Date.now() + 20);
    const timer = window.setTimeout(() => setExpiryClock(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [preview, previewExpiry, receipt]);

  useEffect(() => {
    if (!u1CommandType || !previewExpired || shellState.phase !== "READY_TO_CONFIRM") return;
    applyShellEvent({ type: "PREVIEW_EXPIRED", attemptId: shellAttemptIdRef.current });
  }, [previewExpired, shellState.phase, u1CommandType]);

  useEffect(() => {
    if (!u1CommandType) return;
    if (shellState.phase === "READY_TO_CONFIRM") reviewHeadingRef.current?.focus();
    if (shellState.phase === "PREVIEW_EXPIRED") expiryErrorRef.current?.focus();
  }, [shellState.phase, u1CommandType]);

  async function loadPreview(metadata = previewMetadata, attempt = 0) {
    if (writeBlocked) return;
    if (!isExecutableCommandType(request.commandType)) {
      setError(new Error("该历史操作只支持查询原结果"));
      return;
    }
    setBusy(true);
    setError(undefined);
    setFailedNotExecuted(false);
    if (u1CommandType) applyShellEvent({ type: "PREVIEW_STARTED", attemptId: shellAttemptIdRef.current });
    const lease = beginRequestLease();
    let previewRequestStarted = false;
    let response: Awaited<ReturnType<typeof api.preview>> | undefined;
    const executePreview = async () => {
      if (previewRequestStarted) return;
      previewRequestStarted = true;
      response = await api.preview(
        { commandType: request.commandType as ExecutableCommandType, input: request.input },
        metadata,
        lease.controller.signal
      );
    };
    try {
      const accepted = await onProgress?.({ state: "PREVIEWING", previewMetadata: metadata, executePreview });
      if (!leaseIsActive(lease)) return;
      if (accepted === false) {
        setError(new Error("当前门店还有一项操作结果需要先核对，本次核对尚未开始。"));
        onProgress?.({ state: "PREVIEW_FAILED", previewMetadata: metadata });
        if (u1CommandType) applyShellEvent({ type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current });
        setBusy(false);
        return;
      }
      if (!previewRequestStarted) await executePreview();
      if (!leaseIsActive(lease)) return;
      if (!response) throw new Error("Preview 请求没有返回可核对结果");
      setPreview(response.preview);
      setReceipt(undefined);
      setExpiryClock(Date.now());
      if (u1CommandType) applyShellEvent({ type: "PREVIEW_READY", attemptId: shellAttemptIdRef.current, previewId: response.preview.previewId });
      onProgress?.({ state: "PREVIEWED", previewId: response.preview.previewId, previewMetadata: metadata });
    } catch (nextError) {
      if (!leaseIsActive(lease) || (nextError instanceof DOMException && nextError.name === "AbortError")) return;
      if (!previewRequestStarted) {
        setError(new Error("无法安全核对当前门店的操作恢复状态，本次核对尚未开始。"));
        onProgress?.({ state: "PREVIEW_FAILED", previewMetadata: metadata });
        if (u1CommandType) applyShellEvent({ type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current });
        return;
      }
      if (nextError instanceof ApiError && nextError.code === "COMMAND_STATUS_UNKNOWN" && attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
        if (!leaseIsActive(lease)) return;
        await loadPreview(metadata, attempt + 1);
        return;
      }
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      onProgress?.({ state: uncertain ? "PREVIEW_UNKNOWN" : "PREVIEW_FAILED", previewMetadata: metadata });
      if (u1CommandType) applyShellEvent({ type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current });
    } finally {
      if (leaseIsActive(lease)) setBusy(false);
    }
  }

  useEffect(() => {
    if (!businessFacing || receipt || confirmationKey || writeBlocked || automaticPreviewStarted.current) return;
    automaticPreviewStarted.current = true;
    const metadata = initialPreviewMetadata ?? api.commandMetadata(`preview-${request.commandType.toLowerCase()}`);
    setPreviewMetadata(metadata);
    void loadPreview(metadata);
    return () => {
      automaticPreviewStarted.current = false;
    };
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

  function returnToEdit() {
    if (dialogCloseDisabled) return;
    requestLeaseRef.current.controller?.abort();
    if (u1CommandType && fulfillment) {
      const nextAttemptId = shellAttemptIdRef.current + 1;
      shellAttemptIdRef.current = nextAttemptId;
      setPreview(undefined);
      setReceipt(undefined);
      setError(undefined);
      setConfirmationKey(undefined);
      setNetworkUncertain(false);
      setFailedNotExecuted(false);
      setShellState({ phase: "EDITING", attemptId: nextAttemptId });
      return;
    }
    if (u1CommandType) applyShellEvent({ type: "RETURN_TO_EDIT", attemptId: shellAttemptIdRef.current });
    const draftRequest: CommandRequest = {
      ...request,
      initialReason: { code: reasonCode.trim(), note: reasonNote }
    };
    onClose();
    onReturnToEdit?.(draftRequest);
  }

  function closeCommandDialog() {
    if (u1CommandType
      && !lodgingFulfillment
      && !networkUncertain
      && !recoveryOnlyRequest
      && (shellState.phase === "READY_TO_CONFIRM" || shellState.phase === "PREVIEW_EXPIRED" || shellState.phase === "NOT_EXECUTED")) {
      returnToEdit();
      return;
    }
    onClose();
  }

  async function recordPostSendProgress(progress: CommandDialogProgress): Promise<boolean> {
    try {
      const accepted = await onProgress?.(progress);
      if (accepted === false) {
        setError(new Error("无法安全保存本次操作的恢复状态；请继续查询原操作结果。"));
        setNetworkUncertain(true);
        return false;
      }
      return true;
    } catch {
      setError(new Error("无法安全保存本次操作的恢复状态；请继续查询原操作结果。"));
      setNetworkUncertain(true);
      return false;
    }
  }

  async function finalizeCommitted(receiptValue: ReceiptDto) {
    if (successFinalizedRef.current) return;
    successFinalizedRef.current = true;
    if (u1CommandType) {
      await notifyKnownCommittedCommand({
        commandType: u1CommandType,
        receipt: receiptValue,
        ...(onCommitted ? { onCommitted } : {}),
        ...(onBusinessSuccess ? { onBusinessSuccess } : {})
      });
      onClose({ receipt: receiptValue });
    } else {
      await onCommitted?.(receiptValue);
    }
  }

  useEffect(() => {
    if (!initialReceipt?.businessCommitted || (!u1CommandType && !backfillStay && !completeStay)) return;
    if (!receiptHasCommandEvidence(request.commandType, initialReceipt, request.input, preview?.effect, request.recoveryEffectHash ?? preview?.effectHash)) {
      setReceipt(undefined);
      setError(new Error("服务端返回的操作结果无法核对；系统将只查询原操作结果，不会重复提交。"));
      setNetworkUncertain(true);
      return;
    }
    void finalizeCommitted(initialReceipt);
  }, []);

  async function confirm() {
    if (!preview || !reasonCode.trim()
      || (!createOrderBusiness && !lodgingFulfillment && !tokenBusiness && !(fundBusiness && (request.commandType === "RECORD_COLLECTION" || reasonNote.trim())) && !reasonNote.trim())
      || writeBlocked || previewExpired || networkUncertain || confirmationKey) return;
    if (backfillStay && !completedStayBackfillPreviewHasEvidence(preview.effect, request.input)) {
      setError(new Error("补录日期、退房状态或收款事实与本次填写不一致，本次没有提交。"));
      return;
    }
    if (!isExecutableCommandType(request.commandType)) {
      setError(new Error("该历史操作不能重新确认"));
      return;
    }
    const propertyId = request.input.propertyId;
    if (typeof propertyId !== "string" || !propertyId) {
      setError(new Error(businessFacing ? "当前门店范围缺失，本次操作未发送。" : "Command property scope is missing"));
      return;
    }
    const key = currentKey;
    setConfirmationKey(key);
    setBusy(true);
    setError(undefined);
    setNetworkUncertain(false);
    setFailedNotExecuted(false);
    const lease = beginRequestLease();
    try {
      const accepted = await onProgress?.({
        state: "CONFIRMING",
        previewId: preview.previewId,
        confirmationKey: key,
        effectHash: preview.effectHash,
        isAttemptActive: () => leaseIsActive(lease)
      });
      if (!leaseIsActive(lease)) return;
      if (accepted === false) {
        setError(new Error("无法安全保存本次确认的恢复信息，命令尚未发送"));
        setConfirmationKey(undefined);
        setBusy(false);
        return;
      }
      if (u1CommandType) applyShellEvent({ type: "CONFIRM_STARTED", attemptId: shellAttemptIdRef.current, confirmationKey: key });
    } catch (progressError) {
      if (!leaseIsActive(lease)) return;
      setError(progressError);
      setConfirmationKey(undefined);
      setBusy(false);
      return;
    }
    let result: ReceiptDto;
    try {
      const confirmedReasonNote = lodgingFulfillment
        ? fulfillmentAuditNote(request.commandType as "CHECK_IN" | "CHECK_OUT", preview.effect, reasonNote)
        : reasonNote.trim();
      result = await api.confirm(preview.previewId, propertyId, request.commandType, preview.effectHash, {
        code: reasonCode.trim(),
        note: confirmedReasonNote
      }, key, lease.controller.signal);
      if (!leaseIsActive(lease)) return;
    } catch (nextError) {
      if (!leaseIsActive(lease) || (nextError instanceof DOMException && nextError.name === "AbortError")) return;
      setError(nextError);
      const uncertain = !(nextError instanceof ApiError)
        || nextError.status >= 500
        || nextError.code === "COMMAND_STATUS_UNKNOWN";
      setNetworkUncertain(uncertain);
      setFailedNotExecuted(!uncertain);
      const progressRecorded = await recordPostSendProgress(uncertain
        ? { state: "UNKNOWN", confirmationKey: key }
        : { state: "FAILED_NOT_EXECUTED", confirmationKey: key });
      if (!progressRecorded) {
        setFailedNotExecuted(false);
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey: key });
        if (leaseIsActive(lease)) setBusy(false);
        return;
      }
      if (u1CommandType) applyShellEvent(uncertain
        ? { type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey: key }
        : { type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current, confirmationKey: key });
      if (!uncertain) {
        setPreview(undefined);
        setConfirmationKey(undefined);
        if (u1CommandType) onBusinessNotExecuted?.(commandShellNotExecutedMessage(u1CommandType));
      }
      if (leaseIsActive(lease)) setBusy(false);
      return;
    }

    try {
      if (!receiptHasCommandEvidence(request.commandType, result, request.input, preview.effect, preview.effectHash)) {
        setReceipt(undefined);
        setError(new Error("服务端返回的操作结果无法核对；系统将只查询原操作结果，不会重复提交。"));
        setNetworkUncertain(true);
        await recordPostSendProgress({ state: "UNKNOWN", confirmationKey: key });
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey: key });
        return;
      }
      if (result.executionStatus === "UNKNOWN") {
        setReceipt(undefined);
        setReturnedOriginalReceipt(false);
        setNetworkUncertain(true);
        await recordPostSendProgress({ state: "UNKNOWN", confirmationKey: key });
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey: key });
        return;
      }
      const progressRecorded = await recordPostSendProgress({ state: "RESOLVED", confirmationKey: key, receipt: result });
      if (!progressRecorded) {
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey: key });
        return;
      }
      if (!u1CommandType) setReceipt(result);
      setReturnedOriginalReceipt(false);
      if (u1CommandType) {
        applyShellEvent(result.businessCommitted
          ? { type: "SUCCEEDED", attemptId: shellAttemptIdRef.current, confirmationKey: key }
          : { type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current, confirmationKey: key });
      }
      if (result.businessCommitted) await finalizeCommitted(result);
      else if (u1CommandType) {
        setFailedNotExecuted(true);
        onBusinessNotExecuted?.(notExecutedMessage);
      }
    } finally {
      if (leaseIsActive(lease)) setBusy(false);
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
      setError(new Error(businessFacing ? "当前门店范围缺失，无法查询原操作结果。" : "Command property scope is missing"));
      return;
    }
    setBusy(true);
    setError(undefined);
    const lease = beginRequestLease();
    let result: ReceiptDto;
    try {
      result = await api.resolveCommandResult(propertyId, request.commandType, confirmationKey, lease.controller.signal);
      if (!leaseIsActive(lease)) return;
    } catch (nextError) {
      if (!leaseIsActive(lease) || (nextError instanceof DOMException && nextError.name === "AbortError")) return;
      setError(nextError);
      setNetworkUncertain(true);
      await recordPostSendProgress({ state: "UNKNOWN", confirmationKey });
      if (leaseIsActive(lease)) setBusy(false);
      return;
    }

    try {
      if (!receiptHasCommandEvidence(request.commandType, result, request.input, preview?.effect, request.recoveryEffectHash ?? preview?.effectHash)) {
        setReceipt(undefined);
        setError(new Error("服务端返回的操作结果无法核对；请继续查询原操作结果。"));
        setNetworkUncertain(true);
        await recordPostSendProgress({ state: "UNKNOWN", confirmationKey });
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey });
        return;
      }
      setNetworkUncertain(result.executionStatus === "UNKNOWN");
      if (result.executionStatus === "UNKNOWN") {
        setReceipt(undefined);
        setReturnedOriginalReceipt(false);
        await recordPostSendProgress({ state: "UNKNOWN", confirmationKey });
        if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey });
      } else {
        const progressRecorded = await recordPostSendProgress({ state: "RESOLVED", confirmationKey, receipt: result });
        if (!progressRecorded) {
          if (u1CommandType) applyShellEvent({ type: "RESULT_UNKNOWN", attemptId: shellAttemptIdRef.current, confirmationKey });
          return;
        }
        if (!u1CommandType) setReceipt(result);
        setReturnedOriginalReceipt(true);
        if (u1CommandType && !result.businessCommitted) setFailedNotExecuted(true);
        if (u1CommandType) applyShellEvent(result.businessCommitted
          ? { type: "SUCCEEDED", attemptId: shellAttemptIdRef.current, confirmationKey }
          : { type: "NOT_EXECUTED", attemptId: shellAttemptIdRef.current, confirmationKey });
      }
      if (result.businessCommitted) await finalizeCommitted(result);
      else if (result.executionStatus !== "UNKNOWN" && u1CommandType) onBusinessNotExecuted?.(notExecutedMessage);
    } finally {
      if (leaseIsActive(lease)) setBusy(false);
    }
  }

  return (
    <Modal
      title={request.title}
      onClose={closeCommandDialog}
      size={stayDates || moveUnit || orderLifecycle ? "drawer" : "wide"}
      closeDisabled={dialogCloseDisabled}
      footer={
        <>
          <button
            className="button button-secondary"
            type="button"
            onClick={u1CommandType && !lodgingFulfillment && !networkUncertain && !recoveryOnlyRequest ? returnToEdit : () => onClose()}
            disabled={dialogCloseDisabled}
            data-testid={u1CommandType ? (lodgingFulfillment || networkUncertain || recoveryOnlyRequest ? "command-close" : "command-return-to-edit") : undefined}
          >
            {u1CommandType
              ? networkUncertain || recoveryOnlyRequest
                ? "关闭"
                : lodgingFulfillment
                  ? "取消"
                : shellState.phase === "AUTO_PREVIEWING"
                  ? "取消核对"
                  : request.commandType === "CORRECT_ORDER_OCCUPANT" ? "返回修改资料" : "返回修改"
              : receipt ? "完成" : backfillStay ? "返回修改" : "取消"}
          </button>
          {!preview && !receipt && !networkUncertain && !deterministicPreviewFailure && (!businessFacing || Boolean(error) || shellState.phase === "EDITING") ? <button className="button button-primary" type="button" onClick={() => void loadPreview()} disabled={busy || writeBlocked} data-testid="create-command-preview">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : null}{shellState.phase === "EDITING" ? "继续核对" : businessFacing ? "重新载入核对信息" : "生成服务端预览"}
          </button> : null}
          {preview && previewExpired && !receipt && !confirmationKey && !networkUncertain ? <button className="button button-primary" type="button" onClick={regeneratePreview} disabled={busy || writeBlocked} data-testid="regenerate-command-preview">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <RefreshCw aria-hidden="true" size={17} />}{businessFacing ? "重新载入核对信息" : "重新生成服务端预览"}
          </button> : null}
          {preview && !previewExpired && !receipt && !confirmationKey && !networkUncertain ? <button className={`button ${businessFacing ? "button-primary" : "button-danger"} command-confirm-button`} type="button" onClick={() => void confirm()} disabled={!canConfirm} data-testid="confirm-command">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" size={17} /> : <Check aria-hidden="true" size={17} />}{memberProfile ? "确认创建会员档案" : membershipBusiness && executableCommandType ? `确认${membershipCommandLabel(executableCommandType)}` : memberLodging ? "确认创建会员住宿订单" : backfillStay ? "确认补录住宿" : completeStay ? "确认完成住宿" : createOrderBusiness ? "确认创建住宿订单" : fulfillment && executableCommandType ? `确认${fulfillmentCommandLabel(executableCommandType)}` : fundBusiness ? `确认${request.commandType === "RECORD_REFUND" ? "登记退款" : "登记收款"}` : tokenBusiness ? `确认${tokenCommandLabel(request.commandType)}` : u1CommandType ? `确认${commandShellLabel(u1CommandType)}` : `确认提交：${request.title}`}
          </button> : null}
        </>
      }
    >
      {request.description ? <p className="command-description" data-command-shell-state={u1CommandType ? shellState.phase : undefined}>{request.description}</p> : null}
      <div aria-live="polite" className="sr-status">{busy ? "正在处理" : receipt ? (receipt.businessCommitted ? "操作已完成" : "操作未完成") : ""}</div>
      <InlineError
        error={error && businessFacing ? new Error(fulfillment && networkUncertain
          ? "暂时无法确认本次操作结果。请使用下方按钮查询刚才的结果，系统不会重复办理。"
          : commandDialogBusinessErrorMessage(request.commandType, error)) : error}
        title={failedNotExecuted ? "操作未执行" : deterministicPreviewFailure ? "填写内容需要修改" : "操作处理失败"}
        hideTechnicalDetails={businessFacing}
      />
      {u1CommandType && failedNotExecuted && !error ? <InlineError
        error={new Error(notExecutedMessage)}
        title="操作未执行"
        hideTechnicalDetails
      /> : null}
      <InlineError error={writeBlocked && !receipt ? new Error(writeBlockedReason) : undefined} title="写入已暂停" />
      {previewExpired && !receipt ? <div ref={expiryErrorRef} tabIndex={-1} data-testid={u1CommandType ? "command-preview-expired" : undefined}>
        <InlineError
          error={new Error(businessFacing ? "本次核对已失效，请重新载入核对信息。" : "Preview 已过期。库存或授权可能已经变化，请关闭后刷新并重新生成 Preview。")}
          title={businessFacing ? "核对已失效" : "Preview 已过期"}
        />
      </div> : null}
      {u1CommandType && shellState.phase === "CONFIRMING" ? <div className="command-shell-progress" role="status" aria-live="polite" data-testid="command-shell-progress">
        <LoaderCircle className="spin" aria-hidden="true" size={19} />
        <div><strong>正在提交{commandShellLabel(u1CommandType)}</strong><p>请勿关闭页面或重复操作。</p></div>
      </div> : null}
      {!preview && !receipt ? (
        <div className="command-pending">
          {businessFacing ? <p>{deterministicPreviewFailure
            ? request.commandType === "CORRECT_ORDER_OCCUPANT" ? "请返回修改住宿人资料后重新核对。" : "请返回修改填写内容后重新核对。"
            : busy ? (memberProfile ? "正在检查手机号并载入会员资料。" : memberLodging ? "正在载入会员住宿核对信息。" : backfillStay ? "正在载入已完成住宿补录核对信息。" : completeStay ? "正在载入完成住宿核对信息。" : createOrderBusiness ? "正在载入住宿订单核对信息。" : fulfillment ? "正在载入本次履约核对信息。" : fundBusiness ? `正在载入${request.commandType === "RECORD_REFUND" ? "退款" : "收款"}核对信息。` : tokenBusiness ? "正在核对 Token 操作。" : u1CommandType ? `正在载入${commandShellLabel(u1CommandType)}核对信息。` : "正在载入本次会员操作的核对信息。") : (memberProfile ? "系统会先检查手机号是否已登记，再显示本次要创建的会员资料。" : memberLodging ? "系统将重新载入会员住宿核对信息。" : backfillStay ? "系统将重新载入原补录住宿核对信息。" : completeStay ? "系统将重新载入完成住宿核对信息。" : createOrderBusiness ? "系统将重新载入住宿订单核对信息。" : fulfillment ? "系统将重新载入本次履约核对信息。" : fundBusiness ? `系统将重新载入${request.commandType === "RECORD_REFUND" ? "退款" : "收款"}核对信息。` : tokenBusiness ? "系统将核对本次 Token 操作。" : u1CommandType ? `系统将重新载入${commandShellLabel(u1CommandType)}核对信息。` : "系统将重新载入本次会员操作的核对信息。")}</p> : <>
            <p>命令类型</p>
            <code>{request.commandType}</code>
            <details className="raw-details">
              <summary>请求输入</summary>
              <pre>{JSON.stringify(displayCommandInput(request.input), null, 2)}</pre>
            </details>
          </>}
        </div>
      ) : null}
      {u1CommandType && fulfillment && !lodgingFulfillment && shellState.phase === "EDITING" && !preview && !receipt ? <section className="reason-section" aria-labelledby="fulfillment-edit-reason-heading">
        <h3 id="fulfillment-edit-reason-heading">修改办理原因</h3>
        <div className="form-grid">
          <label className="span-two">填写后会记录在本次变更历史中
            <textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} required maxLength={1000} rows={2} data-testid="reason-note" />
          </label>
        </div>
      </section> : null}
      {preview && !receipt ? (
        <>
          {u1CommandType && u1CommandType !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" ? <h3 className="command-shell-review-heading" ref={reviewHeadingRef} tabIndex={-1} data-testid="command-review-heading">请核对{commandShellLabel(u1CommandType)}</h3> : null}
          <EffectSummary
            preview={preview}
            fulfillment={fulfillment}
            commandTitle={request.title}
            commandInput={request.input}
            {...(request.inventoryUnitLabels ? { inventoryUnitLabels: request.inventoryUnitLabels } : {})}
            {...(request.orderLifecycleContext ? { orderLifecycleContext: request.orderLifecycleContext } : {})}
            {...(requestBookingChannelCode !== undefined ? { bookingChannelCode: requestBookingChannelCode } : {})}
            {...(request.initialReason?.note ? { reasonNote: request.initialReason.note } : {})}
            {...(summaryBusinessCommand ? { businessCommand: summaryBusinessCommand } : {})}
          />
          {!businessFacing ? <section className="reason-section" aria-labelledby="reason-heading">
            <h3 id="reason-heading">确认原因</h3>
            <div className="form-grid form-grid-two">
              <label>原因代码<input value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required maxLength={80} data-testid="reason-code" /></label>
              <label className="span-two">原因说明<textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} required maxLength={1000} rows={3} placeholder="记录本次人工确认依据" data-testid="reason-note" /></label>
            </div>
          </section> : null}
          {fulfillment ? <section className="reason-section" aria-labelledby="fulfillment-reason-heading">
            <h3 id="fulfillment-reason-heading">{lodgingFulfillment ? "办理备注" : "办理原因"}</h3>
            <div className="form-grid">
              <label className="span-two">{lodgingFulfillment ? "办理备注（选填）" : "填写后会记录在本次变更历史中"}
                <textarea value={reasonNote} onChange={(event) => setReasonNote(event.target.value)} required={!lodgingFulfillment} maxLength={1000} rows={2} placeholder={lodgingFulfillment ? "可补充本次办理情况" : "记录本次人工确认依据"} data-testid="reason-note" />
              </label>
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
          <p>{memberProfile ? "系统返回了原来的建档结果，没有重复创建会员。" : membershipBusiness ? "系统返回了原来的操作结果，没有重复写入会员订单或收款。" : memberLodging ? "系统返回了原来的住宿结果，没有重复创建订单或冻结会员权益。" : backfillStay ? "系统返回了原补录住宿结果，没有重复创建订单、退房记录或收款事实。" : completeStay ? "系统返回了刚才的办理结果，没有重复完成订单或重复登记收款。" : createOrderBusiness ? "系统返回了原来的住宿订单结果，没有重复创建订单。" : fulfillment ? "系统返回了刚才的操作结果，没有重复办理。" : tokenBusiness ? "系统返回了原来的 Token 操作结果，没有重复提交。" : u1CommandType ? `系统返回了原来的${commandShellLabel(u1CommandType)}结果，没有重复提交。` : "服务端按原幂等键解析既有结果，没有重复执行业务命令。"}</p>
        </div>
      ) : null}
      {receipt && !u1CommandType ? <ReceiptPanel
        receipt={receipt}
        onNavigateToResource={onClose}
        memberStay={memberLodging}
        backfillStay={backfillStay}
        completeStay={completeStay}
        {...(requestBookingChannelCode !== undefined ? { bookingChannelCode: requestBookingChannelCode } : {})}
        {...(executableCommandType ? { commandType: executableCommandType } : {})}
        {...(businessFacing && executableCommandType ? { businessCommand: executableCommandType } : {})}
      /> : null}
      {networkUncertain && confirmationKey ? (
        <div className="recovery-bar">
          <div><strong>{memberProfile ? "建档结果需要恢复查询" : membershipBusiness ? "会员操作结果需要恢复查询" : memberLodging ? "会员住宿结果需要恢复查询" : backfillStay ? "补录住宿结果需要恢复查询" : completeStay ? "完成住宿结果需要恢复查询" : createOrderBusiness ? "住宿订单结果需要恢复查询" : fulfillment ? "刚才的操作结果需要查询" : tokenBusiness ? "Token 操作结果需要查询" : u1CommandType ? `${commandShellLabel(u1CommandType)}结果需要查询` : "执行状态需要恢复查询"}</strong><p>{memberProfile ? "系统会查询原建档结果，不会重复创建会员。" : membershipBusiness ? "系统会查询原操作结果，不会重复写入会员订单或收款。" : memberLodging ? "系统会查询原住宿结果，不会重复创建订单或冻结会员权益。" : backfillStay ? "系统会查询原补录结果，不会重复创建订单、退房记录或收款事实。" : completeStay ? "系统只查询刚才的办理结果，不会重复完成订单或重复登记收款。" : createOrderBusiness ? "系统会查询原住宿订单结果，不会重复创建订单。" : fulfillment ? "系统会查询刚才的操作结果，不会重复办理。" : tokenBusiness ? "系统会查询刚才的 Token 操作结果，不会重复提交。" : u1CommandType ? "系统只查询原操作使用的幂等身份，不会重复提交。" : "使用原幂等键查询，不会发起新的业务命令。"}</p></div>
          <button className="button button-secondary" type="button" onClick={() => void recover()} disabled={busy}>
            <RefreshCw aria-hidden="true" size={17} />{memberProfile ? "查询建档结果" : membershipBusiness ? "查询会员操作结果" : memberLodging ? "查询住宿结果" : backfillStay ? "查询补录结果" : completeStay ? "查询完成住宿结果" : createOrderBusiness ? "查询订单结果" : fulfillment ? "查询操作结果" : tokenBusiness ? "查询 Token 结果" : u1CommandType ? "查询原操作结果" : "查询命令结果"}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
