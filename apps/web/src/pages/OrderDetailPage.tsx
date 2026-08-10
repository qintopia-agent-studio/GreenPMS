import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CalendarRange,
  CircleDollarSign,
  LogIn,
  LogOut,
  Pencil,
  Sparkles,
  Undo2,
  UserX,
  XCircle
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  currentReleaseFeatures,
  type CommandType,
  type MoneyDto,
  type OrderActionCode,
  type OrderAllowedActionDto,
  type OrderArrangementDto,
  type OrderArrangementHistoryItemDto,
  type OrderEffectiveArrangementPresentation,
  type OrderFulfillmentRecordDto
} from "@qintopia/contracts";
import { api } from "../api";
import { accommodationPositionItems, type AccommodationPositionItem } from "../components/AccommodationPositionSummary";
import { correctionDraftMatchesOccupant, OrderOccupantCorrectionDialog } from "../components/OrderOccupantCorrectionDialog";
import { MoveUnitDrawer } from "../components/MoveUnitDrawer";
import {
  OrderLifecycleActionDrawer,
  type OrderLifecycleAction
} from "../components/OrderLifecycleActionDrawer";
import {
  StayDateChangeDrawer,
  stayDateChangeActionState,
  type StayDateChangeAction,
  type StayDateChangeMode
} from "../components/StayDateChangeDrawer";
import { useWorkspace } from "../session";
import type { CollectionFactDto, CommandRequest, InventoryUnitDto, MemberDto, MembershipProductDto, OrderViewDto, PricingRevisionDto } from "../types";
import {
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  CommandRecoveryBar,
  DamagedCommandRecoveryNotice,
  businessStatusLabel,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMinor,
  formatMoney,
  guestName,
  InlineError,
  InfoHint,
  LoadingBlock,
  Modal,
  isTerminalCommandRecovery,
  recoveryCommandRequest,
  stayDateFundsAreOperatorFacing,
  usePersistentCommandRecovery,
  StatusBadge
} from "../ui";

type FormAction = "RECORD_COLLECTION" | "RECORD_REFUND" | "SHORTEN_STAY" | "EXTEND_STAY" | "REPRICE_ORDER" | "RESOLVE_MIGRATED_OVERDUE_STAY";
const ORDER_DETAIL_POLL_MS = 4_000;

export function orderViewPayloadChanged(previous: OrderViewDto, next: OrderViewDto): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export function orderRefreshMustCloseEditor(
  previous: OrderViewDto,
  next: OrderViewDto,
  editorIsOpen: boolean
): boolean {
  return editorIsOpen && orderViewPayloadChanged(previous, next);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function initialRepriceTargetYuan(currentContractAmountMinor: number, draftTargetMinor: unknown): string {
  const validDraftTarget = typeof draftTargetMinor === "number"
    && Number.isSafeInteger(draftTargetMinor)
    && draftTargetMinor >= 0
    && draftTargetMinor % 100 === 0;
  return String((validDraftTarget ? draftTargetMinor : currentContractAmountMinor) / 100);
}

export function wholeYuanAmountMinor(value: string): number | undefined {
  const targetYuan = Number(value);
  return Number.isSafeInteger(targetYuan) && targetYuan >= 0
    ? targetYuan * 100
    : undefined;
}

export function orderStayDateRequestIsCompatible(
  openedAction: StayDateChangeAction,
  mode: StayDateChangeMode,
  requestCommandType: CommandRequest["commandType"]
): boolean {
  return mode === "ADJUST_DEPARTURE"
    ? requestCommandType === "EXTEND_STAY" || requestCommandType === "SHORTEN_STAY"
    : requestCommandType === openedAction;
}

const formTitles: Record<FormAction, string> = {
  RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  RESOLVE_MIGRATED_OVERDUE_STAY: "确认历史在住处理",
  REPRICE_ORDER: "调整订单金额"
};

const MAX_AMOUNT_MINOR = 2_147_483_647;

const bookingChannelLabels = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
} as const;
const externalBookingChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const terminalOrderStatuses = new Set(["CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"]);
const preArrivalTerminalActionCodes: readonly OrderActionCode[] = [
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "RESCHEDULE_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CHECK_IN",
  "CANCEL_ORDER",
  "MARK_NO_SHOW"
];
const inHouseTerminalActionCodes: readonly OrderActionCode[] = [
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CHECK_OUT",
  "REVOKE_CHECK_IN"
];

const occupantFieldLabels: Record<string, string> = {
  nickname: "昵称",
  fullName: "姓名",
  phone: "联系电话",
  documentNumber: "证件号码"
};

type OrderOccupant = OrderViewDto["occupants"][number];

export function enabledOrderActionCodes(actions: readonly OrderAllowedActionDto[]): OrderActionCode[] {
  return actions.filter((action) => action.enabled).map((action) => action.code);
}

export interface OrderFulfillmentNotice {
  action: "CHECK_IN" | "CHECK_OUT";
  title: string;
  body: string;
}

export function orderFulfillmentNotice(actions: readonly OrderAllowedActionDto[]): OrderFulfillmentNotice | undefined {
  const checkIn = actions.find((action) => action.code === "CHECK_IN");
  if (checkIn?.disabledReason === "ARRIVAL_DATE_NOT_REACHED") {
    return {
      action: "CHECK_IN",
      title: "暂不能办理入住",
      body: "尚未到计划到店日，请在计划到店日办理。"
    };
  }
  if (checkIn?.disabledReason === "ARRIVAL_DATE_PASSED") {
    return {
      action: "CHECK_IN",
      title: checkIn.enabled ? "已超过计划到店日" : "暂不能办理入住",
      body: checkIn.enabled
        ? "可办理迟录入住，也可办理改期或标记未到。"
        : "已超过计划到店日，可办理改期或标记未到。"
    };
  }
  const checkout = actions.find((action) => action.code === "CHECK_OUT");
  if (checkout?.disabledReason === "DEPARTURE_DATE_NOT_REACHED") {
    const shorten = actions.find((action) => action.code === "SHORTEN_STAY");
    if (shorten) return undefined;
    return {
      action: "CHECK_OUT",
      title: "暂不能办理退房",
      body: "尚未到计划退房日，暂不能办理退房。"
    };
  }
  return undefined;
}

export function orderRefundUnavailableReason(actions: readonly OrderAllowedActionDto[]): string | undefined {
  const refund = actions.find((action) => action.code === "RECORD_REFUND");
  if (refund?.disabledReason !== "NO_REFUNDABLE_COLLECTION") return undefined;
  return "当前没有可退款的收款记录。需要先有未被冲销、且仍有可退余额的原收款，才能登记退款。";
}

export function orderStatusIsTerminal(status: string): boolean {
  return terminalOrderStatuses.has(status);
}

export function terminalOrderActionCodes(status: string): readonly OrderActionCode[] {
  if (status === "CANCELLED" || status === "NO_SHOW") return preArrivalTerminalActionCodes;
  if (status === "CHECKED_OUT" || status === "CHECK_IN_REVOKED") return inHouseTerminalActionCodes;
  return [];
}

export function orderActionDisabledReasonText(action: OrderAllowedActionDto | undefined): string | undefined {
  if (!action || action.enabled) return undefined;
  const reason = action.disabledReason?.trim();
  if (!reason) return "当前操作不可用。";
  if (reason === "ORDER_STATE_NOT_ALLOWED") return "当前订单状态不允许执行此操作。";
  if (reason === "NO_REFUNDABLE_COLLECTION") return orderRefundUnavailableReason([action]);
  if (reason === "NO_TRANSFERABLE_COLLECTION") return "当前订单没有可整笔用于升级会员的企业微信住宿收款。";
  if (reason === "ARRIVAL_DATE_NOT_REACHED") return "尚未到计划到店日，请在计划到店日办理。";
  if (reason === "ARRIVAL_DATE_PASSED") return "已超过计划到店日，可办理改期或标记未到。";
  if (reason === "DEPARTURE_DATE_NOT_REACHED") return "尚未到计划退房日，暂不能办理退房。";
  return reason;
}

export function orderActionHelpRequired(
  actions: readonly OrderAllowedActionDto[],
  visibleActionCodes: readonly OrderActionCode[]
): boolean {
  const visibleCodes = new Set(visibleActionCodes);
  return actions.some((action) => visibleCodes.has(action.code) && !action.enabled);
}

export function orderDetailBackTarget(state: unknown): "/" | "/orders" {
  if (!state || typeof state !== "object") return "/orders";
  const source = state as Record<string, unknown>;
  return source.fromRoomStatus === true
    || source.source === "room-status"
    || source.returnTo === "/"
    ? "/"
    : "/orders";
}

export function requestedOrderAction(search: string, actions: readonly OrderAllowedActionDto[]): OrderActionCode | undefined {
  const requested = new URLSearchParams(search).get("action");
  return actions.find((action) => action.enabled && action.code === requested)?.code;
}

export function remainingRefundableMinor(facts: readonly CollectionFactDto[], collection: CollectionFactDto): number {
  if (collection.fact_type !== "COLLECTION" || facts.some((fact) => fact.reverses_fact_id === collection.fact_id)) return 0;
  const activeRefunded = facts
    .filter((fact) => fact.fact_type === "REFUND" && fact.references_fact_id === collection.fact_id)
    .filter((refund) => !facts.some((fact) => fact.reverses_fact_id === refund.fact_id))
    .reduce((sum, refund) => sum + refund.amount_minor, 0);
  return Math.max(0, collection.amount_minor - activeRefunded);
}

export function collectionFactTransactionReferenceLabel(facts: readonly CollectionFactDto[], fact: CollectionFactDto): string {
  if (fact.fact_type === "REVERSAL") return "不适用";
  if (fact.transaction_reference) return fact.transaction_reference;
  if (fact.fact_type === "REFUND" && fact.method === "WECOM") {
    const original = facts.find((item) => item.fact_id === fact.references_fact_id);
    return original?.transaction_reference ? `${original.transaction_reference}（原路退回）` : "沿用原收款交易单号";
  }
  return fact.method === "CASH" || fact.method === "OTHER" ? "不适用" : "历史未记录";
}

export function orderViewMatchesPrincipalScope(loadedScope: string | undefined, currentScope: string): boolean {
  return loadedScope === currentScope;
}

export function orderedOrderOccupants(occupants: readonly OrderOccupant[]): OrderOccupant[] {
  return [...occupants].sort((left, right) => left.ordinal - right.ordinal);
}

export function primaryOrderOccupant(occupants: readonly OrderOccupant[]): OrderOccupant | undefined {
  return occupants.find((occupant) => occupant.role === "PRIMARY") ?? orderedOrderOccupants(occupants)[0];
}

export function occupantSnapshotEntries(snapshot: Pick<OrderOccupant, "nickname" | "fullName" | "phone" | "documentNumber">): Array<[string, unknown]> {
  const canonicalKeys = ["nickname", "fullName", "phone", "documentNumber"] as const;
  const canonical = canonicalKeys.map((key): [string, unknown] => [
    occupantFieldLabels[key]!,
    key === "nickname" && (typeof snapshot[key] !== "string" || !snapshot[key].trim())
      ? "历史未记录"
      : snapshot[key] ?? "-"
  ]);
  return canonical;
}

export function fulfillmentResultLabel(record: OrderFulfillmentRecordDto): string {
  if (record.recordingMode === "LEGACY_UNCLASSIFIED") return "历史记录未分类";
  if (record.recordingMode === "LATE_RECORDED") return record.type === "CHECK_IN" ? "迟录入住" : "迟录退房";
  if (record.type === "CHECK_IN") return "按计划办理入住";
  return record.type === "REVOKE_CHECK_IN" ? "撤销误办入住" : "按计划办理退房";
}

export function effectiveArrangementTitle(presentation: OrderEffectiveArrangementPresentation): string {
  switch (presentation) {
    case "CURRENT": return "当前住宿安排";
    case "LAST": return "最后住宿安排";
    case "BEFORE_CANCELLATION": return "取消前安排";
    case "NO_SHOW_ORDER": return "未到订单安排";
    case "BEFORE_CHECK_IN_REVOCATION": return "撤销入住前安排";
  }
}

export function arrangementChangeLabel(type: OrderArrangementHistoryItemDto["type"]): string {
  switch (type) {
    case "INITIAL_BOOKING": return "创建预订";
    case "MIGRATED_SNAPSHOT": return "历史导入快照";
    case "RESCHEDULE": return "调整预订日期";
    case "EXTENSION": return "延长住宿";
    case "SHORTENING": return "缩短住宿";
    case "MOVE": return "更换房源";
    case "EARLY_CHECK_OUT": return "提前退房";
  }
}

export function collectionFactTypeLabel(type: CollectionFactDto["fact_type"]): string {
  if (type === "COLLECTION") return "收款";
  if (type === "REFUND") return "退款";
  return "冲销";
}

export function collectionMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    CASH: "现金",
    BANK_TRANSFER: "银行转账",
    CARD: "银行卡",
    WECOM: "企业微信",
    WECHAT: "微信",
    ALIPAY: "支付宝",
    OTHER: "其他方式"
  };
  return labels[method] ?? "其他方式";
}

export function pricingBasisLabel(basis: PricingRevisionDto["pricing_basis"]): string {
  switch (basis) {
    case "CHANNEL_CONTRACT": return "本单渠道应结金额";
    case "MANUAL_ADJUSTMENT": return "人工调价";
    case "MEMBER_ENTITLEMENT": return "会员权益计价";
    case "FREE": return "免费入住";
    case "POLICY": return "政策价";
  }
}

export function collectionDifferencePresentation(amount: MoneyDto): {
  label: "差额";
  amount: MoneyDto;
} {
  return {
    label: "差额",
    amount
  };
}

export function collectionAmountYuanInputToMinor(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuanPart, fractionPart = ""] = normalized.split(".");
  const minor = BigInt(yuanPart!) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (minor <= 0n || minor > BigInt(MAX_AMOUNT_MINOR)) return undefined;
  return Number(minor);
}

export function nonNegativeYuanInputToMinor(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuanPart, fractionPart = ""] = normalized.split(".");
  const minor = BigInt(yuanPart!) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  if (minor > BigInt(MAX_AMOUNT_MINOR)) return undefined;
  return Number(minor);
}

function nonNegativeMinorToYuanInput(minorUnits: unknown): string {
  return typeof minorUnits === "number" && Number.isSafeInteger(minorUnits) && minorUnits >= 0
    ? String(minorUnits / 100)
    : "0";
}

export function collectionAmountMinorToYuanInput(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) return "";
  const yuan = Math.trunc(minorUnits / 100);
  const cents = minorUnits % 100;
  return cents === 0 ? String(yuan) : `${yuan}.${String(cents).padStart(2, "0")}`;
}

export function arrangementUnitLabel(units: ReadonlyMap<string, Pick<InventoryUnitDto, "code" | "name" | "building_code">>, inventoryUnitId: string): string {
  const unit = units.get(inventoryUnitId);
  if (!unit) return "房源名称暂不可用";
  return [unit.building_code ? `${unit.building_code}栋` : null, unit.name].filter(Boolean).join(" ");
}

function ArrangementDetails({ arrangement, units, omitIntervals = false, positionItems }: {
  arrangement: OrderArrangementDto;
  units: ReadonlyMap<string, Pick<InventoryUnitDto, "code" | "name" | "building_code">>;
  omitIntervals?: boolean;
  positionItems?: AccommodationPositionItem[];
}) {
  const positions = positionItems ?? [];
  return <dl className="detail-list" {...(positions.length ? { "data-testid": "accommodation-position-summary" } : {})}>
    {positions.map((item) => <div key={`position:${item.label}:${item.effectiveDate}:${item.inventoryUnitId}`}>
      <dt>{item.label}</dt>
      <dd><strong>{arrangementUnitLabel(units, item.inventoryUnitId)}</strong>{item.label === "当前住宿位置" ? <small> · 营业日 {formatDate(item.effectiveDate)}</small> : positions.length > 1 ? <small> · {formatDate(item.effectiveDate)} 起</small> : null}</dd>
    </div>)}
    <div><dt>整体周期</dt><dd>{formatDate(arrangement.arrivalDate)} 至 {formatDate(arrangement.departureDate)}</dd></div>
    {omitIntervals ? null : arrangement.intervals.map((interval, index) => <div key={`${interval.inventoryUnitId}:${interval.arrivalDate}:${interval.departureDate}`}>
      <dt>{arrangement.intervals.length > 1 ? `第 ${index + 1} 段房源` : "住宿房源"}</dt>
      <dd><strong>{arrangementUnitLabel(units, interval.inventoryUnitId)}</strong>{arrangement.intervals.length > 1 ? <small> · {formatDate(interval.arrivalDate)} 至 {formatDate(interval.departureDate)}</small> : null}</dd>
    </div>)}
  </dl>;
}

function ArrangementHistoryAmounts({ item, showPerOrderFunds, isLatest = false }: {
  item: OrderArrangementHistoryItemDto;
  showPerOrderFunds: boolean;
  isLatest?: boolean;
}) {
  const difference = collectionDifferencePresentation(item.fundsSummary.collectionDifference);
  const contractAmountLabel = showPerOrderFunds ? "订单金额" : isLatest ? "本单渠道应结金额" : "当时应结金额";
  return <dl className="detail-list">
    <div><dt>计价来源</dt><dd>{item.pricingSummary.policyBaseAmount ? "有政策基础金额" : "历史实价（无历史政策基准）"}</dd></div>
    {item.pricingSummary.policyBaseAmount ? <div><dt>政策基础金额</dt><dd>{formatMoney(item.pricingSummary.policyBaseAmount)}</dd></div> : null}
    <div><dt>{contractAmountLabel}{!showPerOrderFunds && !isLatest ? <span className="superseded-tag">已被后续调整取代</span> : null}</dt><dd>{formatMoney(item.pricingSummary.currentContractAmount)}</dd></div>
    {item.pricingSummary.differenceFromPolicy ? <div><dt>与政策基础金额差额</dt><dd>{formatMoney(item.pricingSummary.differenceFromPolicy)}</dd></div> : null}
    {showPerOrderFunds ? <>
      <div><dt>已记录净收款</dt><dd>{formatMoney(item.fundsSummary.netRecordedCollection)}</dd></div>
      <div><dt>{difference.label}</dt><dd>{formatMoney(difference.amount)}</dd></div>
    </> : null}
    {showPerOrderFunds && item.fundsSummary.refundReferenceAmount.minorUnits > 0 ? <>
      <div><dt>退款参考</dt><dd><strong>{formatMoney(item.fundsSummary.refundReferenceAmount)}</strong></dd></div>
      <div><dt>退款状态</dt><dd>该金额仅供工作人员办理退款参考，目前尚未登记退款。</dd></div>
    </> : null}
  </dl>;
}

export function OrderLifecycleSections({ view, inventoryUnits, showPerOrderFunds = true, channelPriceDifferenceReason }: {
  view: Pick<OrderViewDto, "originalArrangement" | "effectiveArrangement" | "fulfillment" | "arrangementHistory">;
  inventoryUnits: Array<Pick<InventoryUnitDto, "id" | "code" | "name" | "building_code">>;
  showPerOrderFunds?: boolean;
  channelPriceDifferenceReason?: string | undefined;
}) {
  const units = new Map(inventoryUnits.map((unit) => [unit.id, unit]));
  return <>
    <div className="detail-grid" data-testid="order-arrangements">
      <section className="detail-section" aria-labelledby="original-arrangement-heading">
        <div className="section-title-row"><h2 id="original-arrangement-heading">原始预订安排</h2></div>
        <ArrangementDetails arrangement={view.originalArrangement} units={units} />
      </section>
      <section className="detail-section" aria-labelledby="effective-arrangement-heading">
        <div className="section-title-row"><h2 id="effective-arrangement-heading">{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</h2></div>
        <ArrangementDetails
          arrangement={view.effectiveArrangement}
          units={units}
          omitIntervals={view.effectiveArrangement.intervals.length === 1 && accommodationPositionItems(view).length > 0}
          positionItems={accommodationPositionItems(view)}
        />
      </section>
    </div>

    <section className="detail-section full-detail" aria-labelledby="fulfillment-heading" data-testid="order-fulfillment">
      <div className="section-title-row">
        <h2 id="fulfillment-heading">入住与退房结果</h2>
        <InfoHint text="这里显示的是系统办理营业日和记录时间，不代表住客实际到店或离店的精确时刻。" />
      </div>
      <div className="amendment-list">
        <FulfillmentResult type="CHECK_IN" record={view.fulfillment.checkIn} />
        <FulfillmentResult type="CHECK_OUT" record={view.fulfillment.checkOut} />
        {view.fulfillment.checkInRevocation
          ? <FulfillmentResult type="REVOKE_CHECK_IN" record={view.fulfillment.checkInRevocation} />
          : null}
      </div>
    </section>

    <section className="detail-section full-detail" aria-labelledby="arrangement-history-heading" data-testid="arrangement-history">
      <div className="section-title-row"><h2 id="arrangement-history-heading">住宿安排变更历史</h2><span>{view.arrangementHistory.length} 条</span></div>
      {!showPerOrderFunds && channelPriceDifferenceReason?.trim() ? <p className="muted compact">渠道价格差异说明：{channelPriceDifferenceReason.trim()}</p> : null}
      <div className="amendment-list">{view.arrangementHistory.map((item, index) => {
        const isCreation = !item.before;
        const reasonNote = item.reason.note.trim();
        return <article key={`${item.type}:${item.recordedAt}:${index}`}>
          <header className="amendment-head">
            <strong>第 {index + 1} 条 · {arrangementChangeLabel(item.type)}</strong>
            <span>{item.actor?.displayName ?? "历史未记录操作人"} · {formatDateTime(item.recordedAt)}</span>
          </header>
          {!isCreation || reasonNote ? <p className="amendment-reason">{reasonNote || "未填写变更说明"}</p> : null}
          <div className="amendment-columns">
            <div className="amendment-arrangements">
              {isCreation ? (
                <div>
                  <span className="amendment-col-title">住宿安排</span>
                  <ArrangementDetails arrangement={item.after} units={units} />
                </div>
              ) : (
                <>
                  <div>
                    <span className="amendment-col-title">变更前</span>
                    <ArrangementDetails arrangement={item.before!} units={units} />
                  </div>
                  <div>
                    <span className="amendment-col-title">变更后</span>
                    <ArrangementDetails arrangement={item.after} units={units} />
                  </div>
                </>
              )}
            </div>
            <div className="amendment-amounts">
              <span className="amendment-col-title">{isCreation ? "创建时金额" : "变更时金额"}</span>
              <ArrangementHistoryAmounts item={item} showPerOrderFunds={showPerOrderFunds} isLatest={index === view.arrangementHistory.length - 1} />
            </div>
          </div>
        </article>;
      })}</div>
    </section>
  </>;
}

export function OrderAmountStrip({ amounts, pricingRevision, bookingChannelCode }: {
  amounts: OrderViewDto["amounts"];
  pricingRevision?: PricingRevisionDto | undefined;
  bookingChannelCode?: string | null;
}) {
  const showPerOrderFunds = stayDateFundsAreOperatorFacing(bookingChannelCode, pricingRevision?.pricing_basis);
  const difference = collectionDifferencePresentation(amounts.collectionDifference);
  if (pricingRevision?.pricing_origin !== undefined && pricingRevision.pricing_origin !== "STANDARD") {
    const originLabel = pricingRevision.pricing_origin === "MIGRATED_ACTUAL"
      ? "历史实价（无历史政策基准）"
      : "历史实价 + 切换后续住金额";
    return <section className="amount-strip amount-strip-channel" aria-label="历史导入金额" data-testid="order-amounts">
      <div><span>计价来源</span><strong>{originLabel}</strong></div>
      <div><span>订单金额</span><strong>{formatMoney(amounts.currentContractAmount)}</strong></div>
      <div><span>说明</span><strong className="amount-strip-note">历史导入金额不按当前政策重算</strong></div>
    </section>;
  }
  if (!showPerOrderFunds && pricingRevision) {
    return <section className="amount-strip amount-strip-channel" aria-label="订单可复算金额" data-testid="order-amounts">
      <div><span>政策基础金额</span><strong>{formatMinor(pricingRevision.policy_base_amount_minor!, pricingRevision.currency)}</strong></div>
      <div><span>本单渠道应结金额</span><strong>{formatMoney(amounts.currentContractAmount)}</strong></div>
      <div><span>与政策基础金额差额</span><strong>{formatMinor(pricingRevision.difference_from_policy_minor!, pricingRevision.currency)}</strong></div>
      <div><span>渠道价格差异说明</span><strong className="amount-strip-note">{pricingRevision.reason.note.trim() || "无"}</strong></div>
    </section>;
  }
  return <section className="amount-strip" aria-label="订单可复算金额" data-testid="order-amounts">
    <div><span>住宿金额</span><strong>{formatMoney(amounts.currentContractAmount)}</strong></div>
    <div><span>已记录净收款</span><strong>{formatMoney(amounts.netRecordedCollection)}</strong></div>
    <div><span>{difference.label}</span><strong>{formatMoney(difference.amount)}</strong></div>
    {amounts.refundReferenceAmount.minorUnits > 0 ? <div><span>退款参考</span><strong>{formatMoney(amounts.refundReferenceAmount)}</strong><small>尚未登记退款</small></div> : null}
  </section>;
}

function FulfillmentResult({ type, record }: {
  type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN";
  record: OrderFulfillmentRecordDto | null;
}) {
  const isCheckIn = type === "CHECK_IN";
  const isRevocation = type === "REVOKE_CHECK_IN";
  const heading = isCheckIn ? "入住结果" : isRevocation ? "撤销入住结果" : "退房结果";
  return (
    <article data-testid={isCheckIn ? "check-in-result" : isRevocation ? "check-in-revocation-result" : "check-out-result"}>
      <div>
        <strong>{heading}</strong>
        <span>{record ? fulfillmentResultLabel(record) : `未办理${isCheckIn ? "入住" : isRevocation ? "撤销入住" : "退房"}`}</span>
      </div>
      {record ? <dl className="detail-list">
        <div><dt>{isCheckIn || isRevocation ? "计划入住日" : "计划退房日"}</dt><dd>{formatDate(record.plannedBusinessDate)}</dd></div>
        <div><dt>办理营业日</dt><dd>{record.recordedBusinessDate ? formatDate(record.recordedBusinessDate) : "历史未记录"}</dd></div>
        <div><dt>记录时间</dt><dd>{formatDateTime(record.recordedAt)}</dd></div>
        <div><dt>操作人</dt><dd>{record.actor?.displayName ?? "历史未记录"}</dd></div>
        <div><dt>办理备注</dt><dd>{record.reason.note.trim() || fulfillmentResultLabel(record)}</dd></div>
      </dl> : null}
    </article>
  );
}

function normalizeIdentityCard(value: string | null | undefined): string {
  return value?.replace(/\s+/g, "").toUpperCase() ?? "";
}

function conversionTransferableCollections(facts: readonly CollectionFactDto[]): CollectionFactDto[] {
  const reversed = new Set(facts.filter((fact) => fact.fact_type === "REVERSAL" && fact.reverses_fact_id).map((fact) => fact.reverses_fact_id!));
  return facts.filter((fact) => fact.fact_type === "COLLECTION"
    && fact.method === "WECOM"
    && Boolean(fact.transaction_reference)
    && !fact.transfer
    && !reversed.has(fact.fact_id)
    && remainingRefundableMinor(facts, fact) === fact.amount_minor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface StayConversionEntitlementDisplay {
  serviceStart: string;
  serviceEnd: string;
  consumedUnits: number;
  unitLabel: "间夜" | "床夜";
  memberName?: string;
  productName?: string;
  memberId?: string;
  membershipOrderId?: string;
}

export function stayConversionEntitlementDisplay(view: OrderViewDto): StayConversionEntitlementDisplay | undefined {
  const conversion = [...view.amendments].reverse().find((amendment) => amendment.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP");
  if (!conversion || !isRecord(conversion.payload)) return undefined;
  const entitlement = isRecord(conversion.payload.entitlement) ? conversion.payload.entitlement : undefined;
  const serviceDates = Array.isArray(entitlement?.serviceDates)
    ? entitlement.serviceDates.filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()
    : [];
  const consumedUnits = typeof entitlement?.consumedUnits === "number" && Number.isSafeInteger(entitlement.consumedUnits) && entitlement.consumedUnits > 0
    ? entitlement.consumedUnits
    : serviceDates.length;
  if (consumedUnits <= 0) return undefined;
  const serviceStart = serviceDates[0] ?? view.order.arrival_date;
  const serviceEnd = serviceDates.length ? shiftDate(serviceDates[serviceDates.length - 1]!, 1) : view.order.departure_date;
  const member = isRecord(conversion.payload.member) ? conversion.payload.member : undefined;
  const product = isRecord(conversion.payload.product) ? conversion.payload.product : undefined;
  const transferredFact = view.collectionFacts.find((fact) => fact.transfer);
  const memberId = typeof member?.memberId === "string" ? member.memberId : transferredFact?.transfer?.memberId;
  const membershipOrderId = transferredFact?.transfer?.membershipOrderId;
  return {
    serviceStart,
    serviceEnd,
    consumedUnits,
    unitLabel: entitlement?.entitlementUnitKind === "BED_NIGHT" ? "床夜" : "间夜",
    ...(typeof member?.fullName === "string" && member.fullName.trim() ? { memberName: member.fullName } : {}),
    ...(typeof product?.name === "string" && product.name.trim() ? { productName: product.name } : {}),
    ...(memberId ? { memberId } : {}),
    ...(membershipOrderId ? { membershipOrderId } : {})
  };
}

export function OrderMembershipCoverageSection({ view, unitMap }: {
  view: OrderViewDto;
  unitMap: ReadonlyMap<string, InventoryUnitDto>;
}) {
  const conversionEntitlement = stayConversionEntitlementDisplay(view);
  const coverageDisplayCount = view.coverageSet.length ? view.coverageSet.length : conversionEntitlement ? 1 : 0;
  return (
    <section className="detail-section full-detail" aria-labelledby="coverage-table-heading">
      <div className="section-title-row"><h2 id="coverage-table-heading">会员权益覆盖</h2><span>{coverageDisplayCount}</span></div>
      {view.coverageSet.length ? (
        <div className="table-region" role="region" aria-label="会员覆盖" tabIndex={0}>
          <table className="data-table compact-table">
            <thead><tr><th scope="col">服务日期</th><th scope="col">住宿位置</th><th scope="col">权益类型</th><th scope="col">状态</th></tr></thead>
            <tbody>{view.coverageSet.map((coverage) => <tr key={coverage.id}><td>{coverage.service_date}</td><td>{unitMap.get(coverage.inventory_unit_id)?.code ?? "房源"}</td><td>{coverage.unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜"}</td><td><StatusBadge value={coverage.status} label={businessStatusLabel(coverage.status)} /></td></tr>)}</tbody>
          </table>
        </div>
      ) : conversionEntitlement ? (
        <div className="table-region" role="region" aria-label="升级会员核销" tabIndex={0}>
          <table className="data-table compact-table">
            <thead><tr><th scope="col">来源</th><th scope="col">住宿期间</th><th scope="col">核销权益</th><th scope="col">会员产品</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>
              <tr>
                <th scope="row">升级会员核销</th>
                <td>{formatDate(conversionEntitlement.serviceStart)} 至 {formatDate(conversionEntitlement.serviceEnd)}</td>
                <td>{conversionEntitlement.consumedUnits} {conversionEntitlement.unitLabel}</td>
                <td>
                  {conversionEntitlement.productName ?? "会员产品"}
                  {conversionEntitlement.memberName ? <small>{conversionEntitlement.memberName}</small> : null}
                </td>
                <td><StatusBadge value="CONSUMED" label="已核销" /></td>
                <td>{conversionEntitlement.memberId && conversionEntitlement.membershipOrderId
                  ? <Link className="inline-link" to={`/members?memberId=${encodeURIComponent(conversionEntitlement.memberId)}&membershipOrderId=${encodeURIComponent(conversionEntitlement.membershipOrderId)}`}>查看会员订单</Link>
                  : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : <EmptyState title="没有会员覆盖" detail="此订单未使用会员住宿权益。" />}
    </section>
  );
}

function CollectionFactNote({ fact }: { fact: CollectionFactDto }) {
  if (fact.transfer) {
    return <span className="fact-transfer-note">
      已用于升级会员
      <Link className="inline-link" to={`/members?memberId=${encodeURIComponent(fact.transfer.memberId)}&membershipOrderId=${encodeURIComponent(fact.transfer.membershipOrderId)}`}>查看会员订单</Link>
    </span>;
  }
  return <>{fact.note || "未填写"}</>;
}

function productMatchesCurrentStay(product: MembershipProductDto, view: OrderViewDto, unitMap: ReadonlyMap<string, InventoryUnitDto>): boolean {
  const unitIds = [...new Set(view.effectiveArrangement.intervals.map((interval) => interval.inventoryUnitId))];
  if (!unitIds.length) return false;
  return unitIds.every((unitId) => {
    const unit = unitMap.get(unitId);
    return unit
      && unit.kind === product.allowed_inventory_kind
      && unit.room_type_code === product.allowed_room_type_code
      && (unit.kind === "ROOM" ? product.entitlement_unit_kind === "ROOM_NIGHT" : product.entitlement_unit_kind === "BED_NIGHT");
  });
}

function membershipProductOptionLabel(product: MembershipProductDto): string {
  const unit = product.entitlement_unit_kind === "ROOM_NIGHT" ? "间夜" : "床夜";
  return `${product.name} · ${product.entitlement_units} ${unit} · ${formatMinor(product.list_price_minor, product.currency)}`;
}

function memberOptionLabel(member: MemberDto): string {
  return `${member.full_name} · ${member.identity_card_number}`;
}

function conversionCollectionTimeLabel(value: string): string {
  return formatDateTime(value).replace(/\s+/g, " ");
}

function StayCollectionConversionDialog({ view, members, membershipProducts, unitMap, draft, onClose, onSubmit }: {
  view: OrderViewDto;
  members: readonly MemberDto[];
  membershipProducts: readonly MembershipProductDto[];
  unitMap: ReadonlyMap<string, InventoryUnitDto>;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const primary = primaryOrderOccupant(orderedOrderOccupants(view.occupants));
  const primaryIdentity = normalizeIdentityCard(primary?.documentNumber);
  const matchedMembers = primaryIdentity
    ? members.filter((member) => normalizeIdentityCard(member.identity_card_number) === primaryIdentity)
    : [];
  const eligibleProducts = membershipProducts.filter((product) => productMatchesCurrentStay(product, view, unitMap));
  const transferableCollections = conversionTransferableCollections(view.collectionFacts);
  const transferTotalMinor = transferableCollections.reduce((sum, fact) => sum + fact.amount_minor, 0);
  const draftInput = draft?.input ?? {};
  const draftMemberId = typeof draftInput.memberId === "string" ? draftInput.memberId : undefined;
  const draftProductId = typeof draftInput.membershipProductId === "string" ? draftInput.membershipProductId : undefined;
  const initialProduct = eligibleProducts.find((product) => product.id === draftProductId) ?? eligibleProducts[0];
  const [memberId, setMemberId] = useState(draftMemberId && matchedMembers.some((member) => member.id === draftMemberId) ? draftMemberId : matchedMembers[0]?.id ?? "");
  const [productId, setProductId] = useState(initialProduct?.id ?? "");
  const selectedProduct = eligibleProducts.find((product) => product.id === productId);
  const [agreedPriceYuan, setAgreedPriceYuan] = useState(() => {
    const draftPrice = typeof draftInput.agreedPriceMinor === "number" ? draftInput.agreedPriceMinor : undefined;
    return String((draftPrice ?? initialProduct?.list_price_minor ?? 0) / 100);
  });
  const [priceAdjustmentReason, setPriceAdjustmentReason] = useState(typeof draftInput.priceAdjustmentReason === "string" ? draftInput.priceAdjustmentReason : "");
  const [remainingPaymentTransactionReference, setRemainingPaymentTransactionReference] = useState(typeof draftInput.remainingPaymentTransactionReference === "string" ? draftInput.remainingPaymentTransactionReference : "");
  const [remainingPaymentNote, setRemainingPaymentNote] = useState(typeof draftInput.remainingPaymentNote === "string" ? draftInput.remainingPaymentNote : "");
  const [validationError, setValidationError] = useState<unknown>();
  const agreedPriceMinor = wholeYuanAmountMinor(agreedPriceYuan);
  const remainingMinor = agreedPriceMinor === undefined ? undefined : agreedPriceMinor - transferTotalMinor;
  const netRecordedMinor = view.amounts.netRecordedCollection.minorUnits;
  const sourceTransactionReferences = new Set(view.collectionFacts
    .filter((fact) => fact.fact_type === "COLLECTION")
    .map((fact) => fact.transaction_reference)
    .filter((value): value is string => Boolean(value)));
  const disabledReason = !primaryIdentity ? "主要住宿人缺少身份证号，不能升级会员。"
    : matchedMembers.length === 0 ? "没有找到身份证号一致的会员，请先创建或核对会员档案。"
      : eligibleProducts.length === 0 ? "当前住宿房型没有匹配的会员产品。"
        : transferableCollections.length === 0 ? "当前订单没有可用于升级会员的企业微信住宿收款。"
          : transferTotalMinor !== netRecordedMinor ? "当前可转入企微收款无法覆盖全部已记录净收款，请先核对住宿收退款记录。"
            : undefined;

  useEffect(() => {
    if (!selectedProduct) return;
    if (draft?.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") return;
    setAgreedPriceYuan(String(selectedProduct.list_price_minor / 100));
    setPriceAdjustmentReason("");
    setRemainingPaymentTransactionReference("");
    setRemainingPaymentNote("");
    setValidationError(undefined);
  }, [selectedProduct?.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    if (disabledReason) {
      setValidationError(new Error(disabledReason));
      return;
    }
    if (!memberId) {
      setValidationError(new Error("请选择身份证号一致的会员"));
      return;
    }
    if (!selectedProduct) {
      setValidationError(new Error("请选择匹配的会员产品"));
      return;
    }
    if (agreedPriceMinor === undefined) {
      setValidationError(new Error("会员成交价必须是大于或等于零的整元金额"));
      return;
    }
    if (agreedPriceMinor < transferTotalMinor) {
      setValidationError(new Error("会员成交价不能低于本次用于升级的住宿收款合计"));
      return;
    }
    if (agreedPriceMinor !== selectedProduct.list_price_minor && !priceAdjustmentReason.trim()) {
      setValidationError(new Error("修改会员成交价时必须填写调价原因"));
      return;
    }
    if (agreedPriceMinor === selectedProduct.list_price_minor && priceAdjustmentReason.trim()) {
      setValidationError(new Error("未修改会员成交价时不需要填写调价原因"));
      return;
    }
    const remaining = agreedPriceMinor - transferTotalMinor;
    if (remaining > 0 && !remainingPaymentTransactionReference.trim()) {
      setValidationError(new Error("会员成交价高于转入住宿收款时，必须填写差额企业微信交易单号"));
      return;
    }
    if (remaining === 0 && remainingPaymentTransactionReference.trim()) {
      setValidationError(new Error("没有差额收款时不需要填写差额企业微信交易单号"));
      return;
    }
    if (remainingPaymentTransactionReference.trim() && sourceTransactionReferences.has(remainingPaymentTransactionReference.trim())) {
      setValidationError(new Error("差额收款必须填写新的企业微信交易单号，不能重复使用住宿收款的交易单号"));
      return;
    }
    onSubmit({
      commandType: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
      title: "升级会员",
      description: "",
      input: {
        propertyId: view.order.property_id,
        orderId: view.order.id,
        memberId,
        membershipProductId: selectedProduct.id,
        collectionFactIds: transferableCollections.map((fact) => fact.fact_id),
        agreedPriceMinor,
        ...(priceAdjustmentReason.trim() ? { priceAdjustmentReason: priceAdjustmentReason.trim() } : {}),
        ...(remaining > 0 ? { remainingPaymentTransactionReference: remainingPaymentTransactionReference.trim() } : {}),
        ...(remaining > 0 && remainingPaymentNote.trim() ? { remainingPaymentNote: remainingPaymentNote.trim() } : {})
      },
      initialReason: { code: "STAY_COLLECTION_TO_MEMBERSHIP", note: "升级会员" }
    });
  }

  return <Modal title="升级会员" onClose={onClose} footer={null}>
    <form className="modal-form" onSubmit={submit} noValidate>
      <InlineError error={validationError} title="无法继续" />
      {disabledReason ? <div className="form-field-note" role="status"><strong>当前暂不能升级会员</strong><span>{disabledReason}</span></div> : null}
      <div className="form-grid form-grid-two">
        <label className="span-two">目标会员
          <select value={memberId} onChange={(event) => { setMemberId(event.target.value); setValidationError(undefined); }} disabled={Boolean(disabledReason) || matchedMembers.length === 0} required>
            {matchedMembers.map((member) => <option key={member.id} value={member.id}>{memberOptionLabel(member)}</option>)}
          </select>
        </label>
        <label className="span-two">会员产品
          <select value={productId} onChange={(event) => { setProductId(event.target.value); setValidationError(undefined); }} disabled={Boolean(disabledReason) || eligibleProducts.length === 0} required>
            {eligibleProducts.map((product) => <option key={product.id} value={product.id}>{membershipProductOptionLabel(product)}</option>)}
          </select>
        </label>
        <div className="span-two conversion-transfer-card">
          <div className="conversion-transfer-heading">
            <div>
              <strong>用于升级的住宿收款</strong>
              <span>以下住宿收款将作为会员订单已收款，住宿订单不再重复计入。</span>
            </div>
            <strong>{formatMinor(transferTotalMinor, view.amounts.netRecordedCollection.currency)}</strong>
          </div>
          {transferableCollections.length ? <ol className="conversion-transfer-list">
            {transferableCollections.map((fact, index) => <li key={fact.fact_id}>
              <span>第 {index + 1} 笔</span>
              <strong>{formatMinor(fact.amount_minor, fact.currency)}</strong>
              <small>企业微信交易单号：{collectionFactTransactionReferenceLabel(view.collectionFacts, fact)}</small>
              <small>登记时间：{conversionCollectionTimeLabel(fact.created_at)}</small>
            </li>)}
          </ol> : <span className="muted">没有可用于升级会员的企业微信住宿收款。</span>}
        </div>
        <label>会员成交价（元）<input type="number" min="0" step="1" inputMode="numeric" value={agreedPriceYuan} onChange={(event) => { setAgreedPriceYuan(event.target.value); setValidationError(undefined); }} required disabled={Boolean(disabledReason)} /></label>
        <div className="form-calculated-field"><span>差额企微收款</span><strong>{remainingMinor === undefined ? "-" : formatMinor(Math.max(0, remainingMinor), view.amounts.netRecordedCollection.currency)}</strong></div>
        {selectedProduct && agreedPriceMinor !== undefined && agreedPriceMinor !== selectedProduct.list_price_minor ? <label className="span-two">调价原因<textarea rows={2} value={priceAdjustmentReason} onChange={(event) => { setPriceAdjustmentReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} /></label> : null}
        {remainingMinor !== undefined && remainingMinor > 0 ? <>
          <label className="span-two">差额企业微信交易单号<input value={remainingPaymentTransactionReference} onChange={(event) => { setRemainingPaymentTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="conversion-remaining-payment-reference" /><small className="form-field-help">差额是本次新收的会员款，请填写新的企业微信交易单号；住宿收款原单号只保留追溯。</small></label>
          <label className="span-two">差额收款备注（选填）<textarea rows={2} value={remainingPaymentNote} onChange={(event) => setRemainingPaymentNote(event.target.value)} maxLength={1000} /></label>
        </> : null}
      </div>
      <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={Boolean(disabledReason)}>下一步</button></div>
    </form>
  </Modal>;
}

function ActionFormDialog({ action, view, initialFactId, draft, onClose, onSubmit }: {
  action: FormAction;
  view: OrderViewDto;
  initialFactId?: string;
  draft?: CommandRequest;
  onClose: () => void;
  onSubmit: (request: CommandRequest) => void;
}) {
  const collections = view.collectionFacts.filter((fact) => fact.fact_type === "COLLECTION");
  const refundableCollections = collections.filter((fact) => remainingRefundableMinor(view.collectionFacts, fact) > 0);
  const initialSelectedFactId = initialFactId ?? refundableCollections[0]?.fact_id ?? "";
  const recordedExcessMinor = view.amounts.refundReferenceAmount.minorUnits;
  function selectedRefundCollectionFor(collectionFactId: string): CollectionFactDto | undefined {
    return collections.find((fact) => fact.fact_id === collectionFactId);
  }
  function suggestedRefundFor(collectionFactId: string): number {
    const collection = selectedRefundCollectionFor(collectionFactId);
    if (!collection) return 0;
    return Math.min(recordedExcessMinor, remainingRefundableMinor(view.collectionFacts, collection));
  }
  const initialSuggestedRefund = action === "RECORD_REFUND" ? suggestedRefundFor(initialSelectedFactId) : 0;
  const initialRefundMethod = action === "RECORD_REFUND" ? selectedRefundCollectionFor(initialSelectedFactId)?.method ?? "WECOM" : "WECOM";
  const [amountYuan, setAmountYuan] = useState(initialSuggestedRefund > 0 ? collectionAmountMinorToYuanInput(initialSuggestedRefund) : "");
  const [method, setMethod] = useState(initialRefundMethod);
  const [note, setNote] = useState("");
  const [transactionReference, setTransactionReference] = useState("");
  const [factId, setFactId] = useState(initialSelectedFactId);
  const selectedRefundCollection = action === "RECORD_REFUND" ? selectedRefundCollectionFor(factId) : undefined;
  const selectedRefundRemainingMinor = selectedRefundCollection ? remainingRefundableMinor(view.collectionFacts, selectedRefundCollection) : 0;
  const transactionReferenceRequired = action === "RECORD_COLLECTION"
    ? method === "WECOM" || method === "BANK_TRANSFER"
    : method === "BANK_TRANSFER";
  const [newDepartureDate, setNewDepartureDate] = useState(() => {
    const draftDate = typeof draft?.input.newDepartureDate === "string" ? draft.input.newDepartureDate : undefined;
    if (action === "RESOLVE_MIGRATED_OVERDUE_STAY") return draftDate ?? shiftDate(view.migrationOverdueHold?.startsOn ?? view.order.departure_date, 1);
    return action === "SHORTEN_STAY" ? shiftDate(view.order.departure_date, -1) : shiftDate(view.order.departure_date, 1);
  });
  const [postCutoverIncrementYuan, setPostCutoverIncrementYuan] = useState(() => nonNegativeMinorToYuanInput(draft?.input.postCutoverIncrementAmountMinor));
  const [migratedOverdueReason, setMigratedOverdueReason] = useState(draft?.initialReason?.note ?? "");
  const [targetContractYuan, setTargetContractYuan] = useState(() => initialRepriceTargetYuan(
    view.amounts.currentContractAmount.minorUnits,
    draft?.input.targetCurrentContractAmountMinor
  ));
  const [repriceReason, setRepriceReason] = useState(draft?.initialReason?.note ?? "");
  const [validationError, setValidationError] = useState<unknown>();

  useEffect(() => {
    if (action !== "RECORD_REFUND") return;
    const suggested = suggestedRefundFor(factId);
    setAmountYuan(suggested > 0 ? collectionAmountMinorToYuanInput(suggested) : "");
  }, [action, factId, recordedExcessMinor]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(undefined);
    const base: Record<string, unknown> = { propertyId: view.order.property_id, orderId: view.order.id };
    let description = "请核对本次操作信息。";
    if (action === "RECORD_COLLECTION" || action === "RECORD_REFUND") {
      if (action === "RECORD_REFUND" && refundableCollections.length === 0) {
        setValidationError(new Error("该订单当前没有可退款的收款记录，不能登记退款"));
        return;
      }
      if (action === "RECORD_REFUND" && !factId) {
        setValidationError(new Error("请选择要退款的原收款"));
        return;
      }
      const trimmedNote = note.trim();
      if (action === "RECORD_REFUND" && !trimmedNote) {
        setValidationError(new Error("必须填写退款原因"));
        return;
      }
      if (action === "RECORD_COLLECTION" && !trimmedNote && (method === "CASH" || method === "OTHER")) {
        setValidationError(new Error(method === "CASH" ? "必须填写收款人" : "必须填写其他收款说明"));
        return;
      }
      const parsedAmount = collectionAmountYuanInputToMinor(amountYuan);
      if (parsedAmount === undefined) {
        setValidationError(new Error("金额必须按人民币元填写，大于 0 且最多保留两位小数"));
        return;
      }
      if (action === "RECORD_REFUND" && parsedAmount > selectedRefundRemainingMinor) {
        setValidationError(new Error(`退款金额不能超过所选原收款的剩余可退金额（最多可退 ${formatMinor(selectedRefundRemainingMinor, selectedRefundCollection?.currency ?? "CNY")}）。如需退多笔原收款，请分多次办理。`));
        return;
      }
      if (transactionReferenceRequired && !transactionReference.trim()) {
        setValidationError(new Error(method === "WECOM" ? "必须填写企业微信交易单号" : "必须填写交易单号或流水号"));
        return;
      }
      Object.assign(base, { amountMinor: parsedAmount, method, note: trimmedNote });
      if (transactionReference.trim()) Object.assign(base, { transactionReference: transactionReference.trim() });
      if (action === "RECORD_REFUND") {
        Object.assign(base, { referencesFactId: factId });
      }
      description = "";
    }
    if (action === "SHORTEN_STAY" || action === "EXTEND_STAY") {
      Object.assign(base, { newDepartureDate });
      description = "订单金额将按原房价标准重新计算，并保留调整记录。";
    }
    if (action === "RESOLVE_MIGRATED_OVERDUE_STAY") {
      const hold = view.migrationOverdueHold;
      if (!hold) {
        setValidationError(new Error("这笔历史在住订单的占房信息已变化，请刷新后重新核对。"));
        return;
      }
      if (!newDepartureDate || newDepartureDate <= hold.startsOn) {
        setValidationError(new Error("实际离店日期必须晚于历史占房开始日期。"));
        return;
      }
      const increment = nonNegativeYuanInputToMinor(postCutoverIncrementYuan);
      if (increment === undefined) {
        setValidationError(new Error("切换后续住金额必须按人民币元填写，可以为 0，且最多保留两位小数。"));
        return;
      }
      if (!migratedOverdueReason.trim()) {
        setValidationError(new Error("请填写确认依据。"));
        return;
      }
      Object.assign(base, {
        holdId: hold.id,
        newDepartureDate,
        postCutoverIncrementAmountMinor: increment
      });
      description = "请核对历史实价、切换后续住金额和实际离店日期。确认后会解除这笔历史占房锁。";
    }
    if (action === "REPRICE_ORDER") {
      const targetCurrentContractAmountMinor = wholeYuanAmountMinor(targetContractYuan);
      if (targetCurrentContractAmountMinor === undefined) {
        setValidationError(new Error("指定最终总价必须是大于或等于零的整元金额"));
        return;
      }
      if (!repriceReason.trim()) {
        setValidationError(new Error("必须填写订单金额更正原因"));
        return;
      }
      Object.assign(base, { targetCurrentContractAmountMinor });
      description = "订单金额将更新为指定总价，并保留更正记录。";
    }
    onSubmit({
      commandType: action,
      title: formTitles[action],
      description,
      input: base,
      ...((action === "REPRICE_ORDER" || action === "RESOLVE_MIGRATED_OVERDUE_STAY") ? {
        initialReason: {
          code: action,
          note: action === "REPRICE_ORDER" ? repriceReason.trim() : migratedOverdueReason.trim()
        }
      } : {}),
      ...((action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? {
        initialReason: {
          code: action,
          note: action === "RECORD_REFUND" ? note.trim() : note.trim() || "登记收款"
        }
      } : {})
    });
  }

  return (
    <Modal title={formTitles[action]} onClose={onClose} footer={null}>
      <form className="modal-form" onSubmit={submit} noValidate>
        <InlineError error={validationError} title="无法继续" />
        {(action === "RECORD_COLLECTION" || action === "RECORD_REFUND") ? (
          <div className="form-grid form-grid-two">
            {action === "RECORD_REFUND" && refundableCollections.length === 0 ? (
              <div className="span-two form-field-note" role="status">
                <strong>该订单当前没有可退款的收款记录</strong>
                <span>需要先有未被冲销、且仍有可退余额的原收款，才能登记退款。</span>
              </div>
            ) : null}
            {action === "RECORD_REFUND" && refundableCollections.length > 0 ? <label className="span-two">选择原收款<select value={factId} onChange={(event) => {
              const nextFactId = event.target.value;
              const nextFact = selectedRefundCollectionFor(nextFactId);
              setFactId(nextFactId);
              if (nextFact?.method) setMethod(nextFact.method);
              setTransactionReference("");
              setValidationError(undefined);
            }} required>{refundableCollections.map((fact) => <option key={fact.fact_id} value={fact.fact_id}>{formatDateTime(fact.created_at)} · {collectionFactTransactionReferenceLabel(view.collectionFacts, fact)} · 可退 {formatMinor(remainingRefundableMinor(view.collectionFacts, fact), fact.currency)} · {collectionMethodLabel(fact.method)}</option>)}</select></label> : null}
            <label>金额（元）<input type="text" value={amountYuan} onChange={(event) => { setAmountYuan(event.target.value); setValidationError(undefined); }} required inputMode="decimal" placeholder="例如 1280.50" data-testid="fact-amount-yuan" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label>
            <label>{action === "RECORD_REFUND" ? "退款方式" : "收款方式"}<select value={method} onChange={(event) => { setMethod(event.target.value); setTransactionReference(""); setValidationError(undefined); }} disabled={(action === "RECORD_REFUND" && refundableCollections.length === 0) || selectedRefundCollection?.method === "WECOM"}><option value="WECOM">企业微信</option><option value="BANK_TRANSFER">银行转账</option><option value="CASH">现金</option><option value="OTHER">其他</option></select></label>
            {action === "RECORD_REFUND" && method === "WECOM" ? <div className="span-two form-field-note" role="status">
              <strong>企业微信原路退回</strong>
              <span>沿用所选原收款的企业微信交易单号，不需要另填退款单号。</span>
            </div> : null}
            {transactionReferenceRequired ? <label className="span-two">{method === "WECOM" ? "企业微信交易单号" : "交易单号 / 流水号"}<input value={transactionReference} onChange={(event) => { setTransactionReference(event.target.value); setValidationError(undefined); }} required maxLength={200} data-testid="transaction-reference" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0} /></label> : null}
            <label className="span-two">{action === "RECORD_REFUND" ? "退款原因" : method === "CASH" ? "收款人" : method === "OTHER" ? "其他收款说明" : "备注（选填）"}<textarea rows={3} value={note} onChange={(event) => { setNote(event.target.value); setValidationError(undefined); }} required={action === "RECORD_REFUND" || method === "CASH" || method === "OTHER"} maxLength={1000} data-testid={action === "RECORD_REFUND" ? "refund-reason" : "collection-note"} /></label>
          </div>
        ) : null}
        {(action === "SHORTEN_STAY" || action === "EXTEND_STAY") ? (
          <div className="form-grid">
            <label>新离店日期<input type="date" value={newDepartureDate} min={view.order.arrival_date} onChange={(event) => setNewDepartureDate(event.target.value)} required data-testid="new-departure-date" /></label>
          </div>
        ) : null}
        {action === "RESOLVE_MIGRATED_OVERDUE_STAY" ? (
          <div className="form-grid">
            <div className="form-field-note" role="status"><strong>确认真实在住信息</strong><span>确认后会按实际离店日期保留本次住宿，并解除这笔历史占房锁。</span></div>
            <label>实际离店日期<input type="date" value={newDepartureDate} min={view.migrationOverdueHold?.startsOn} onChange={(event) => { setNewDepartureDate(event.target.value); setValidationError(undefined); }} required data-testid="migrated-overdue-departure-date" /></label>
            <label>切换后续住金额（元）<input type="text" value={postCutoverIncrementYuan} onChange={(event) => { setPostCutoverIncrementYuan(event.target.value); setValidationError(undefined); }} required inputMode="decimal" placeholder="例如 0 或 1280.50" data-testid="migrated-overdue-increment-yuan" /></label>
            <label className="span-two">确认依据<textarea value={migratedOverdueReason} onChange={(event) => { setMigratedOverdueReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} rows={3} data-testid="migrated-overdue-reason" /></label>
          </div>
        ) : null}
        {action === "REPRICE_ORDER" ? (
          <div className="form-grid">
            <label>指定最终总价（元）<input type="number" min="0" step="1" value={targetContractYuan} onChange={(event) => { setTargetContractYuan(event.target.value); setValidationError(undefined); }} required inputMode="numeric" data-testid="reprice-target-yuan" /></label>
            <label>金额更正原因<textarea value={repriceReason} onChange={(event) => { setRepriceReason(event.target.value); setValidationError(undefined); }} required maxLength={1000} rows={3} data-testid="reprice-reason" /></label>
          </div>
        ) : null}
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>取消</button><button type="submit" className="button button-primary" disabled={action === "RECORD_REFUND" && refundableCollections.length === 0}>{action === "RECORD_COLLECTION" || action === "RECORD_REFUND" ? "下一步" : "继续核对"}</button></div>
      </form>
    </Modal>
  );
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function FactActions({ fact, canRefund, disabled, onRefund }: { fact: CollectionFactDto; canRefund: boolean; disabled: boolean; onRefund: () => void }) {
  return (
    <div className="row-actions">
      {canRefund && fact.fact_type === "COLLECTION" ? <button className="button button-secondary fact-refund-button" type="button" onClick={onRefund} disabled={disabled} aria-label={`为 ${fact.transaction_reference ?? "这笔收款"} 记录退款`} data-order-action="RECORD_REFUND">退款</button> : null}
    </div>
  );
}

function OrderActionButton({ action, blocked, showWhenDisabled = false, className = "button button-secondary", dataOrderAction, testId, onClick, children }: {
  action?: OrderAllowedActionDto | undefined;
  blocked: boolean;
  showWhenDisabled?: boolean;
  className?: string;
  dataOrderAction?: string;
  testId?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  if (!action || (!action.enabled && !showWhenDisabled)) return null;
  return (
    <button
      className={className}
      type="button"
      onClick={onClick}
      disabled={blocked || !action.enabled}
      data-order-action={dataOrderAction ?? action.code}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </button>
  );
}

export function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { meta, principal, propertyId } = useWorkspace();
  const recoveryScope = propertyId ? `property:${propertyId}` : "";
  const principalOrderScope = `${principal.subjectId}:${principal.credentialType}:${principal.propertyAccess[propertyId] ?? "NONE"}`;
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: recoveryScope });
  const [view, setView] = useState<OrderViewDto>();
  const [loadedPrincipalOrderScope, setLoadedPrincipalOrderScope] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [formAction, setFormAction] = useState<FormAction>();
  const [stayDateAction, setStayDateAction] = useState<StayDateChangeAction>();
  const [movingUnit, setMovingUnit] = useState(false);
  const [convertingToMembership, setConvertingToMembership] = useState(false);
  const [lifecycleAction, setLifecycleAction] = useState<OrderLifecycleAction>();
  const [stayDateMode, setStayDateMode] = useState<StayDateChangeMode>("DATE_CHANGE");
  const [correctingOccupant, setCorrectingOccupant] = useState<OrderOccupant>();
  const [initialFactId, setInitialFactId] = useState<string>();
  const [command, setCommand] = useState<CommandRequest>();
  const [commandDraft, setCommandDraft] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshNotice, setRefreshNotice] = useState<string>();
  const [commandNotice, setCommandNotice] = useState<string>();
  const viewRef = useRef<OrderViewDto | undefined>(undefined);
  const editorIsOpenRef = useRef(false);
  const focusedActionKeyRef = useRef<string | undefined>(undefined);

  editorIsOpenRef.current = Boolean(formAction || stayDateAction || movingUnit || convertingToMembership || correctingOccupant || lifecycleAction);

  const pendingRecovery = commandRecovery.pending;
  const orderActionsBlocked = commandRecovery.blocked;
  const enabledActions = useMemo(() => new Set(enabledOrderActionCodes(view?.allowedActions ?? [])), [view]);
  const actionByCode = useMemo(() => new Map((view?.allowedActions ?? []).map((action) => [action.code, action])), [view]);
  const fulfillmentNotice = useMemo(() => orderFulfillmentNotice(view?.allowedActions ?? []), [view]);
  const requestedAction = useMemo(() => requestedOrderAction(location.search, view?.allowedActions ?? []), [location.search, view]);
  const requestedRawAction = useMemo(() => new URLSearchParams(location.search).get("action"), [location.search]);
  const backTarget = orderDetailBackTarget(location.state);

  useEffect(() => {
    setRecoveryError(undefined);
    setFormAction(undefined);
    setStayDateAction(undefined);
    setMovingUnit(false);
    setConvertingToMembership(false);
    setLifecycleAction(undefined);
    setStayDateMode("DATE_CHANGE");
    setCorrectingOccupant(undefined);
    setInitialFactId(undefined);
    setCommand(undefined);
    setCommandDraft(undefined);
    setLoadedPrincipalOrderScope(undefined);
    setRecoveryDialogOpen(false);
    setRefreshNotice(undefined);
    setCommandNotice(undefined);
  }, [orderId, principalOrderScope, recoveryScope]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") setRefreshToken((value) => value + 1);
    };
    const interval = window.setInterval(refreshVisible, ORDER_DETAIL_POLL_MS);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    let current = true;
    const prior = viewRef.current;
    if (!prior) setLoading(true);
    setError(undefined);
    api.order(orderId)
      .then((response) => {
        if (!current) return;
        const payloadChanged = !prior || orderViewPayloadChanged(prior, response);
        if (prior && orderRefreshMustCloseEditor(prior, response, editorIsOpenRef.current)) {
          editorIsOpenRef.current = false;
          setFormAction(undefined);
          setStayDateAction(undefined);
          setMovingUnit(false);
          setConvertingToMembership(false);
          setLifecycleAction(undefined);
          setCorrectingOccupant(undefined);
          setInitialFactId(undefined);
          setCommandDraft(undefined);
          setRefreshNotice("订单已被其他操作刷新。为避免使用旧数据，原编辑表单已关闭；请重新打开后核对。");
        }
        if (payloadChanged) {
          setView(response);
          viewRef.current = response;
        }
        setLoadedPrincipalOrderScope(principalOrderScope);
      })
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [orderId, principalOrderScope, refreshToken]);

  useEffect(() => {
    if (view && view.order.property_id !== propertyId) navigate("/orders", { replace: true });
  }, [navigate, propertyId, view]);

  useEffect(() => {
    if (!view || requestedRawAction !== "CHECK_OUT") return;
    const checkoutEnabled = view.allowedActions.some((action) => action.code === "CHECK_OUT" && action.enabled);
    const shortenEnabled = view.allowedActions.some((action) => action.code === "SHORTEN_STAY" && action.enabled);
    const focusKey = `${orderId}:EARLY_CHECK_OUT`;
    if (checkoutEnabled || !shortenEnabled || focusedActionKeyRef.current === focusKey) return;
    focusedActionKeyRef.current = focusKey;
    setCommandDraft(undefined);
    setStayDateMode("EARLY_CHECK_OUT");
    setStayDateAction("SHORTEN_STAY");
  }, [orderId, requestedRawAction, view]);

  useEffect(() => {
    if (!requestedAction) return;
    const focusKey = `${orderId}:${requestedAction}`;
    if (focusedActionKeyRef.current === focusKey) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-order-action="${requestedAction}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "nearest" });
      target.focus({ preventScroll: true });
      focusedActionKeyRef.current = focusKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [orderId, requestedAction, view]);

  const unitMap = useMemo(() => new Map(meta.inventoryUnits.map((unit) => [unit.id, unit])), [meta.inventoryUnits]);

  function openForm(action: FormAction, factId?: string) {
    if (orderActionsBlocked || !enabledActions.has(action)) return;
    setInitialFactId(factId);
    setFormAction(action);
    setCommandDraft(undefined);
  }

  function directCommand(commandType: CommandType, title: string, description: string) {
    if (!view || orderActionsBlocked || !enabledActions.has(commandType as OrderActionCode)) return;
    setRecoveryDialogOpen(false);
    setCommand({
      commandType,
      title,
      description,
      ...((commandType === "CHECK_IN" || commandType === "CHECK_OUT") ? { presentation: "FULFILLMENT" as const } : {}),
      input: { propertyId: view.order.property_id, orderId: view.order.id }
    });
  }

  function openLifecycleAction(action: OrderLifecycleAction) {
    if (orderActionsBlocked || !enabledActions.has(action)) return;
    setCommandDraft(undefined);
    setLifecycleAction(action);
  }

  function openRecoveryDialog() {
    if (!pendingRecovery) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(pendingRecovery));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    if (context || (pendingRecovery && isTerminalCommandRecovery(pendingRecovery.state))) {
      if (await commandRecovery.clearResolved()) {
        setRecoveryError(undefined);
      } else {
        setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复写入，订单命令继续保持暂停"));
      }
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRefreshToken((value) => value + 1);
  }

  function returnCommandToEdit(request: CommandRequest) {
    setCommandDraft(request);
    if (request.commandType === "CANCEL_ORDER" || request.commandType === "MARK_NO_SHOW" || request.commandType === "REVOKE_CHECK_IN") {
      setLifecycleAction(request.commandType);
      return;
    }
    if (request.commandType === "RESCHEDULE_STAY" || request.commandType === "EXTEND_STAY" || request.commandType === "SHORTEN_STAY") {
      setStayDateAction(request.commandType);
      setStayDateMode(viewRef.current?.order.status === "CHECKED_IN" ? "ADJUST_DEPARTURE" : "DATE_CHANGE");
      return;
    }
    if (request.commandType === "MOVE_UNIT") {
      setMovingUnit(true);
      return;
    }
    if (request.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP") {
      setConvertingToMembership(true);
      return;
    }
    if (request.commandType === "REPRICE_ORDER") {
      setFormAction("REPRICE_ORDER");
      return;
    }
    if (request.commandType === "RESOLVE_MIGRATED_OVERDUE_STAY") {
      setFormAction("RESOLVE_MIGRATED_OVERDUE_STAY");
      return;
    }
    if (request.commandType === "CORRECT_ORDER_OCCUPANT") {
      const occupantId = request.input.occupantId;
      const occupant = typeof occupantId === "string" ? viewRef.current?.occupants.find((item) => item.id === occupantId) : undefined;
      if (occupant) setCorrectingOccupant(occupant);
    }
  }

  if (loading) return <LoadingBlock label="正在载入订单详情" />;
  if (view && !orderViewMatchesPrincipalScope(loadedPrincipalOrderScope, principalOrderScope)) return <LoadingBlock label="正在切换订单访问权限" />;
  if (error || !view) return <div><Link className="back-link" to={backTarget} state={backTarget === "/" ? location.state : undefined}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link><InlineError error={error ?? new Error("Order not found")} title="无法载入订单" /></div>;

  const occupants = orderedOrderOccupants(view.occupants);
  const primaryOccupant = primaryOrderOccupant(occupants);
  const visibleArrangementUnits = [...new Set(view.effectiveArrangement.intervals.map((interval) => arrangementUnitLabel(unitMap, interval.inventoryUnitId)))];
  const currentPricingRevision = view.pricingRevisions.find((revision) => revision.id === view.order.current_revision_id)
    ?? view.pricingRevisions[view.pricingRevisions.length - 1];
  const showPerOrderFunds = stayDateFundsAreOperatorFacing(view.order.booking_channel_code, currentPricingRevision?.pricing_basis);
  const rescheduleState = stayDateChangeActionState(view, "RESCHEDULE_STAY");
  const extendState = stayDateChangeActionState(view, "EXTEND_STAY");
  const shortenState = stayDateChangeActionState(view, "SHORTEN_STAY");
  const departureAdjustmentAction = view.order.status === "CHECKED_IN"
    ? extendState?.enabled ? "EXTEND_STAY" : shortenState?.enabled ? "SHORTEN_STAY" : undefined
    : undefined;
  const blockedStayDateState = view.order.status === "RESERVED" ? rescheduleState : shortenState;
  const refundUnavailableReason = orderRefundUnavailableReason(view.allowedActions);
  const externalChannelFunds = Boolean(view.order.booking_channel_code && externalBookingChannelCodes.has(view.order.booking_channel_code));
  const terminalActions = terminalOrderActionCodes(view.order.status);
  const showDisabledTerminalActions = terminalActions.length > 0 && view.allowedActions.length > 0;
  const terminalActionVisible = (code: OrderActionCode): boolean => showDisabledTerminalActions && terminalActions.includes(code);
  const actionVisible = (code: OrderActionCode): boolean => Boolean(actionByCode.get(code)?.enabled || terminalActionVisible(code));
  const refundActionVisible = actionVisible("RECORD_REFUND") || Boolean(refundUnavailableReason);
  const departureAdjustmentDisabledAction = terminalActionVisible("EXTEND_STAY")
    ? actionByCode.get("EXTEND_STAY")
    : terminalActionVisible("SHORTEN_STAY")
      ? actionByCode.get("SHORTEN_STAY")
      : undefined;
  const visibleDepartureAdjustmentAction = departureAdjustmentAction
    ? actionByCode.get(departureAdjustmentAction)
    : departureAdjustmentDisabledAction;
  const showDepartureAdjustmentButton = Boolean(departureAdjustmentAction || departureAdjustmentDisabledAction);
  const showLifecycleSeparator = actionVisible("CANCEL_ORDER") || actionVisible("MARK_NO_SHOW") || actionVisible("REVOKE_CHECK_IN");
  const visibleActionCodes: OrderActionCode[] = ([
    "RECORD_COLLECTION",
    "RECORD_REFUND",
    "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    "RESCHEDULE_STAY",
    "MOVE_UNIT",
    "REPRICE_ORDER",
    "CHECK_IN",
    "CHECK_OUT",
    "CANCEL_ORDER",
    "MARK_NO_SHOW",
    "REVOKE_CHECK_IN"
  ] as const).filter((code) => actionVisible(code) || (code === "RECORD_REFUND" && refundActionVisible));
  const showOrderActionHelp = orderActionHelpRequired(view.allowedActions, visibleActionCodes);

  return (
    <div className="order-detail-page">
      <Link className="back-link" to={backTarget} state={backTarget === "/" ? location.state : undefined}><ArrowLeft aria-hidden="true" size={17} />{backTarget === "/" ? "返回房态" : "返回订单"}</Link>
      <header className="order-heading">
        <div><div className="order-title-row"><h1>{guestName(primaryOccupant ? { nickname: primaryOccupant.nickname, fullName: primaryOccupant.fullName } : view.order.primary_guest_snapshot)}</h1><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div></div>
        <div className="order-unit"><span>{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</span><strong>{visibleArrangementUnits.join("、")}</strong></div>
      </header>

      <OrderAmountStrip amounts={view.amounts} pricingRevision={currentPricingRevision} bookingChannelCode={view.order.booking_channel_code} />

      <InlineError error={recoveryError} title="恢复记录未收口" />
      {commandRecovery.canDiscardCorrupt
        ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="order-damaged-command-recovery" />
        : <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />}
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      {refreshNotice ? <div className="room-status-return-notice" role="alert">{refreshNotice}</div> : null}
      {pendingRecovery ? <CommandRecoveryBar recovery={pendingRecovery} onOpen={openRecoveryDialog} testId="order-command-recovery" /> : null}

      <section className="action-band" aria-labelledby="order-actions-heading">
        <h2 id="order-actions-heading">订单操作</h2>
        <div className="action-band-content">
          {externalChannelFunds ? (
            <div className="channel-funds-notice" role="status" data-testid="external-channel-funds-notice">
              <strong>渠道订单不登记单笔收退款</strong>
              <span>请核对渠道订单号和本单渠道应结金额；后续由财务按渠道总账核对。</span>
            </div>
          ) : null}
          <div className="action-toolbar">
            {fulfillmentNotice ? (
              <span className="action-notice" role="status" data-testid="fulfillment-date-notice" data-action={fulfillmentNotice.action}>
                <AlertTriangle aria-hidden="true" size={14} />
                {fulfillmentNotice.title}
                <InfoHint text={fulfillmentNotice.body} />
              </span>
            ) : null}
            {blockedStayDateState && !blockedStayDateState.enabled && blockedStayDateState.reason ? (
              <span className="action-notice" role="status" data-testid="stay-date-action-notice">
                <AlertTriangle aria-hidden="true" size={14} />
                {view.order.status === "RESERVED" ? "暂不能调整预订日期" : "暂不能缩短住宿或提前退房"}
                <InfoHint text={blockedStayDateState.reason} />
              </span>
            ) : null}
            <OrderActionButton action={actionByCode.get("RECORD_COLLECTION")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("RECORD_COLLECTION")} onClick={() => openForm("RECORD_COLLECTION")} testId="record-collection"><CircleDollarSign aria-hidden="true" size={17} />收款</OrderActionButton>
            <OrderActionButton action={actionByCode.get("RECORD_REFUND")} blocked={orderActionsBlocked} showWhenDisabled={refundActionVisible} onClick={() => openForm("RECORD_REFUND")}><Undo2 aria-hidden="true" size={17} />退款</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")} blocked={orderActionsBlocked} showWhenDisabled={actionVisible("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")} onClick={() => { if (!enabledActions.has("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")) return; setCommandDraft(undefined); setConvertingToMembership(true); }} testId="convert-stay-collections-to-membership"><Sparkles aria-hidden="true" size={17} />升级会员</OrderActionButton>
            <OrderActionButton action={actionByCode.get("RESCHEDULE_STAY")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("RESCHEDULE_STAY")} onClick={() => { setCommandDraft(undefined); setStayDateMode("DATE_CHANGE"); setStayDateAction("RESCHEDULE_STAY"); }}><CalendarRange aria-hidden="true" size={17} />调整预订日期</OrderActionButton>
            {showDepartureAdjustmentButton ? <OrderActionButton action={visibleDepartureAdjustmentAction} blocked={orderActionsBlocked} showWhenDisabled={Boolean(departureAdjustmentDisabledAction)} dataOrderAction="ADJUST_DEPARTURE" onClick={() => { if (!departureAdjustmentAction) return; setCommandDraft(undefined); setStayDateMode("ADJUST_DEPARTURE"); setStayDateAction(departureAdjustmentAction); }}><CalendarRange aria-hidden="true" size={17} />调整退房日期</OrderActionButton> : null}
            <OrderActionButton action={actionByCode.get("MOVE_UNIT")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("MOVE_UNIT")} onClick={() => { setCommandDraft(undefined); setMovingUnit(true); }}><ArrowRightLeft aria-hidden="true" size={17} />换房</OrderActionButton>
            <OrderActionButton action={actionByCode.get("REPRICE_ORDER")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("REPRICE_ORDER")} onClick={() => openForm("REPRICE_ORDER")} testId="reprice-order"><CircleDollarSign aria-hidden="true" size={17} />调整金额</OrderActionButton>
            <OrderActionButton action={actionByCode.get("RESOLVE_MIGRATED_OVERDUE_STAY")} blocked={orderActionsBlocked} onClick={() => openForm("RESOLVE_MIGRATED_OVERDUE_STAY")} testId="resolve-migrated-overdue-stay"><CalendarRange aria-hidden="true" size={17} />确认历史在住</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CHECK_IN")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CHECK_IN")} className="button button-primary" onClick={() => directCommand("CHECK_IN", "办理入住", "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。")} testId="check-in"><LogIn aria-hidden="true" size={17} />入住</OrderActionButton>
            <OrderActionButton action={actionByCode.get("CHECK_OUT")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CHECK_OUT")} className="button button-primary" onClick={() => directCommand("CHECK_OUT", "办理退房", "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。")} testId="check-out"><LogOut aria-hidden="true" size={17} />退房</OrderActionButton>
            {showLifecycleSeparator ? <div className="action-separator" aria-hidden="true" /> : null}
            <OrderActionButton action={actionByCode.get("CANCEL_ORDER")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("CANCEL_ORDER")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("CANCEL_ORDER")}><XCircle aria-hidden="true" size={18} />取消订单</OrderActionButton>
            <OrderActionButton action={actionByCode.get("MARK_NO_SHOW")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("MARK_NO_SHOW")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("MARK_NO_SHOW")}><UserX aria-hidden="true" size={18} />标记未到</OrderActionButton>
            <OrderActionButton action={actionByCode.get("REVOKE_CHECK_IN")} blocked={orderActionsBlocked} showWhenDisabled={terminalActionVisible("REVOKE_CHECK_IN")} className="button button-secondary danger-button" onClick={() => openLifecycleAction("REVOKE_CHECK_IN")}><Undo2 aria-hidden="true" size={18} />撤销入住</OrderActionButton>
            {showOrderActionHelp ? <span className="action-help-hint"><InfoHint text="灰色按钮表示当前条件下暂不可用。" label="订单操作说明" /></span> : null}
            {enabledActions.size === 0 ? <span>当前没有可执行操作</span> : null}
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="detail-section order-occupants-section" aria-labelledby="guest-snapshot-heading">
          <div className="section-title-row"><h2 id="guest-snapshot-heading">住宿人</h2><span>{occupants.length} 人</span></div>
          <ol className="order-occupant-list">
            {occupants.map((occupant) => (
              <li key={occupant.id} data-occupant-id={occupant.id} data-testid="order-occupant">
                <div className="order-occupant-heading">
                  <span className="order-occupant-role">{occupant.role === "PRIMARY" ? "主要联系人" : `同行人 ${occupant.ordinal - 1}`}</span>
                  <strong>{occupant.nickname?.trim() || "历史未记录"}</strong>
                  {enabledActions.has("CORRECT_ORDER_OCCUPANT") ? <button className="button button-secondary" type="button" onClick={() => setCorrectingOccupant(occupant)} disabled={orderActionsBlocked} data-order-action="CORRECT_ORDER_OCCUPANT" data-testid={`correct-occupant-${occupant.id}`}><Pencil aria-hidden="true" size={16} />更正资料</button> : null}
                </div>
                <dl className="detail-list">{occupantSnapshotEntries(occupant).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
              </li>
            ))}
          </ol>
        </section>
        <section className="detail-section" aria-labelledby="stay-heading"><div className="section-title-row"><h2 id="stay-heading">住宿状态</h2><StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} /></div><dl className="detail-list"><div><dt>{effectiveArrangementTitle(view.effectiveArrangement.presentation)}</dt><dd>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</dd></div><div><dt>住宿类型</dt><dd>{view.order.stay_type === "FREE" ? "免费住宿" : view.order.member_id || view.order.member_contract_id ? "会员住宿" : "普通住宿"}</dd></div>{view.order.stay_type === "FREE" ? <><div><dt>免费入住类型</dt><dd>{view.order.free_stay_category_code === "VOLUNTEER" ? "义工" : view.order.free_stay_category_code === "RECEPTION" ? "接待" : "历史未记录"}</dd></div><div><dt>免费入住原因</dt><dd>{view.order.free_stay_reason}</dd></div></> : view.order.member_id || view.order.member_contract_id ? <div><dt>住宿来源</dt><dd>会员权益</dd></div> : <><div><dt>订单来源渠道</dt><dd>{view.order.booking_channel_code ? bookingChannelLabels[view.order.booking_channel_code] : "历史未记录"}</dd></div><div><dt>渠道订单号</dt><dd>{view.order.booking_channel_code === "WECOM" ? "不适用" : view.order.channel_order_reference ?? (view.order.booking_channel_code ? "未填写" : "历史未记录")}</dd></div></>}</dl></section>
      </div>

      <OrderLifecycleSections
        view={view}
        inventoryUnits={meta.inventoryUnits}
        showPerOrderFunds={showPerOrderFunds}
        channelPriceDifferenceReason={currentPricingRevision?.reason.note}
      />

      {currentReleaseFeatures.cleaningWorkflow && view.cleaningTasks.length ? <section className="detail-section full-detail" aria-labelledby="cleaning-heading" data-testid="order-cleaning-tasks">
        <div className="section-title-row"><h2 id="cleaning-heading"><Sparkles aria-hidden="true" size={18} />清洁任务</h2><span>{view.cleaningTasks.length}</span></div>
        <ol className="amendment-list">{view.cleaningTasks.map((task) => {
          const unit = unitMap.get(task.inventoryUnitId);
          return <li key={task.id} data-testid="order-cleaning-task">
            <div><strong>{unit ? `${unit.code} · ${unit.name}` : "退房房源"}</strong><StatusBadge value={task.status} label={businessStatusLabel(task.status)} /></div>
            <div><span>清洁日期：{formatDate(task.serviceDate)}</span><small>生成：{task.createdBy?.displayName ?? "系统记录"} · {formatDateTime(task.createdAt)}</small></div>
            {task.status === "COMPLETED" ? <div><span>清洁已完成</span><small>{task.completedBy?.displayName ?? "系统记录"} · {formatDateTime(task.completedAt ?? undefined)}</small></div> : <p>等待工作人员完成清洁。</p>}
          </li>;
        })}</ol>
      </section> : null}

      <section className="detail-section full-detail" aria-labelledby="occupant-corrections-heading">
        <div className="section-title-row"><h2 id="occupant-corrections-heading">住宿人资料更正记录</h2><span>{view.occupantCorrections.length}</span></div>
        {view.occupantCorrections.length ? <div className="amendment-list" data-testid="occupant-correction-history">{view.occupantCorrections.map((correction) => {
          const occupant = occupants.find((candidate) => candidate.id === correction.occupantId);
          return <article key={correction.id} data-testid="occupant-correction-history-item">
            <div><strong>第 {correction.sequence} 次 · {correction.correctedSnapshot.nickname || `住宿人 ${occupant?.ordinal ?? "资料"}`}</strong><span>{correction.actor.displayName} · {formatDateTime(correction.createdAt)}</span><p>{correction.reason.note.trim() || "未填写更正说明"}</p></div>
            <div><span>更正前</span><dl className="detail-list">{occupantSnapshotEntries(correction.priorSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
            <div><span>更正后</span><dl className="detail-list">{occupantSnapshotEntries(correction.correctedSnapshot).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl></div>
          </article>;
        })}</div> : <EmptyState title="尚无资料更正" detail="住宿人创建时的原始资料保持不变；人工更正会在此追加审计记录。" />}
      </section>

      <section className="detail-section full-detail" aria-labelledby="revisions-heading">
        <div className="section-title-row"><h2 id="revisions-heading">计价记录</h2><span>{view.pricingRevisions.length}</span></div>
        <div className="table-region" role="region" aria-label="计价记录表格" tabIndex={0}>
          <table className="data-table compact-table">
            <thead><tr><th scope="col">计价记录</th><th scope="col">锁定政策</th><th scope="col">周期</th><th scope="col">权益覆盖</th><th scope="col">政策基础金额</th><th scope="col">与政策基础金额差额</th><th scope="col">订单金额</th><th scope="col">计价方式与说明</th></tr></thead>
            <tbody>{view.pricingRevisions.map((revision) => {
              return <tr key={revision.id}>
                <th scope="row">第 {revision.revision_no} 次计价</th>
                <td>{meta.pricingPolicyVersions.some((policy) => policy.id === revision.policy_version_id) ? "已锁定政策" : "历史锁定政策"}</td>
                <td>{formatDate(revision.arrival_date)} 至 {formatDate(revision.departure_date)}</td>
                <td>{countArray(revision.coverage_set)}</td>
                <td>{revision.policy_base_amount_minor === null ? "无历史政策基准" : formatMinor(revision.policy_base_amount_minor, revision.currency)}</td>
                <td><strong>{revision.difference_from_policy_minor === null ? "不适用" : formatMinor(revision.difference_from_policy_minor, revision.currency)}</strong></td>
                <td><strong>{formatMinor(revision.current_contract_amount_minor, revision.currency)}</strong></td>
                <td><strong>{revision.pricing_origin === "MIGRATED_ACTUAL"
                  ? "历史实价"
                  : revision.pricing_origin === "MIGRATED_ACTUAL_PLUS_POST_CUTOVER"
                    ? "历史实价 + 切换后续住金额"
                    : pricingBasisLabel(revision.pricing_basis)}</strong><small>{revision.reason.note || "无需说明"}</small></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </section>

      <OrderMembershipCoverageSection view={view} unitMap={unitMap} />

      <section className="detail-section full-detail" aria-labelledby="facts-heading"><div className="section-title-row"><h2 id="facts-heading">收退款与冲销记录</h2><span>{view.collectionFacts.length}</span></div>{view.collectionFacts.length ? <div className="table-region" role="region" aria-label="收退款与冲销记录表格" tabIndex={0}><table className="data-table compact-table"><thead><tr><th scope="col">序号</th><th scope="col">类型</th><th scope="col">金额</th><th scope="col">净影响</th><th scope="col">外部交易单号</th><th scope="col">收退款方式</th><th scope="col">备注 / 退款原因</th><th scope="col">记录时间</th><th scope="col" className="fact-actions-col">操作</th></tr></thead><tbody>{view.collectionFacts.map((fact, index) => <tr key={fact.fact_id}><td><span className="fact-sequence">{index + 1}</span></td><th scope="row"><StatusBadge value={fact.fact_type} label={collectionFactTypeLabel(fact.fact_type)} /></th><td>{formatMinor(fact.amount_minor, fact.currency)}</td><td>{formatMinor(fact.net_effect_minor, fact.currency)}</td><td>{collectionFactTransactionReferenceLabel(view.collectionFacts, fact)}</td><td>{collectionMethodLabel(fact.method)}</td><td><CollectionFactNote fact={fact} /></td><td>{formatDateTime(fact.created_at)}</td><td><FactActions fact={fact} canRefund={enabledActions.has("RECORD_REFUND") && remainingRefundableMinor(view.collectionFacts, fact) > 0} disabled={orderActionsBlocked} onRefund={() => openForm("RECORD_REFUND", fact.fact_id)} /></td></tr>)}</tbody></table></div> : <EmptyState title="尚无收退款记录" detail={externalChannelFunds ? "渠道订单不在 PMS 登记单笔收退款。" : "使用订单操作记录第一笔独立收款。"} />}</section>

      {formAction ? <ActionFormDialog action={formAction} view={view} {...(initialFactId ? { initialFactId } : {})} {...(commandDraft?.commandType === formAction ? { draft: commandDraft } : {})} onClose={() => { setFormAction(undefined); setInitialFactId(undefined); setCommandDraft(undefined); }} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has(formAction)) return; setFormAction(undefined); setInitialFactId(undefined); setCommandDraft(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {convertingToMembership ? <StayCollectionConversionDialog
        view={view}
        members={meta.members}
        membershipProducts={meta.membershipProducts}
        unitMap={unitMap}
        {...(commandDraft?.commandType === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP" ? { draft: commandDraft } : {})}
        onClose={() => { setConvertingToMembership(false); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")) return;
          setConvertingToMembership(false);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {stayDateAction ? <StayDateChangeDrawer
        action={stayDateAction}
        mode={stayDateMode}
        view={view}
        inventoryUnitLabel={visibleArrangementUnits.join(" → ")}
        inventoryUnits={meta.inventoryUnits}
        writeBlocked={orderActionsBlocked}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === stayDateAction ? { draft: commandDraft } : {})}
        onClose={() => { setStayDateAction(undefined); setStayDateMode("DATE_CHANGE"); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked
            || !orderStayDateRequestIsCompatible(stayDateAction, stayDateMode, request.commandType)
            || !enabledActions.has(request.commandType as OrderActionCode)) return;
          setStayDateAction(undefined);
          setStayDateMode("DATE_CHANGE");
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {movingUnit ? <MoveUnitDrawer
        view={view}
        units={meta.inventoryUnits}
        writeBlocked={orderActionsBlocked}
        runPreview={commandRecovery.runPreview}
        {...(commandDraft?.commandType === "MOVE_UNIT" ? { draft: commandDraft } : {})}
        onClose={() => { setMovingUnit(false); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || !enabledActions.has("MOVE_UNIT")) return;
          setMovingUnit(false);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {correctingOccupant ? <OrderOccupantCorrectionDialog view={view} occupant={correctingOccupant} {...(correctionDraftMatchesOccupant(commandDraft, view.order.id, correctingOccupant.id) ? { draft: commandDraft } : {})} onClose={() => { setCorrectingOccupant(undefined); setCommandDraft(undefined); }} onSubmit={(request) => { if (orderActionsBlocked || !enabledActions.has("CORRECT_ORDER_OCCUPANT")) return; setCorrectingOccupant(undefined); setCommandDraft(undefined); setRecoveryDialogOpen(false); setCommand(request); }} /> : null}
      {lifecycleAction ? <OrderLifecycleActionDrawer
        action={lifecycleAction}
        view={view}
        inventoryUnitLabels={Object.fromEntries(meta.inventoryUnits.map((unit) => [unit.id, [unit.building_code ? `${unit.building_code}栋` : null, unit.name].filter(Boolean).join(" ")]))}
        writeBlocked={orderActionsBlocked}
        {...(commandDraft?.commandType === lifecycleAction ? { draft: commandDraft } : {})}
        onClose={() => { setLifecycleAction(undefined); setCommandDraft(undefined); }}
        onSubmit={(request) => {
          if (orderActionsBlocked || request.commandType !== lifecycleAction || !enabledActions.has(lifecycleAction)) return;
          setLifecycleAction(undefined);
          setCommandDraft(undefined);
          setRecoveryDialogOpen(false);
          setCommand(request);
        }}
      /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${pendingRecovery?.confirmationKey ?? "missing"}` : "new-order-command"}
        request={command}
        onClose={closeCommandDialog}
        onCommitted={async () => {
          if (!orderId) throw new Error("当前订单引用缺失，无法刷新订单详情");
          const response = await api.order(orderId);
          setView(response);
          setLoadedPrincipalOrderScope(principalOrderScope);
          viewRef.current = response;
        }}
        onBusinessSuccess={(message) => setCommandNotice(message)}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
        onReturnToEdit={returnCommandToEdit}
        {...(recoveryDialogOpen && pendingRecovery ? {
          initialConfirmationKey: pendingRecovery.confirmationKey
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
      /> : null}
    </div>
  );
}
