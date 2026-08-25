import { ArrowRight, CalendarRange, Clock3, Crosshair, FilePenLine, ReceiptText, Sparkles, Users, X } from "lucide-react";
import { currentReleaseFeatures } from "@qintopia/contracts";
import { Link } from "react-router-dom";
import { AccommodationPositionSummary } from "../components/AccommodationPositionSummary";
import type { InventoryUnitDto, MemberViewDto, OrderViewDto } from "../types";
import { businessStatusLabel, formatDate, formatDateTime, formatMinor, formatMoney, stayDateFundsAreOperatorFacing, StatusBadge } from "../ui";
import { stayDateChangeActionState, type StayDateChangeAction, type StayDateChangeMode } from "../components/StayDateChangeDrawer";
import type { OrderLifecycleAction } from "../components/OrderLifecycleActionDrawer";

type OrderOccupant = OrderViewDto["occupants"][number];

const actionLabels: Record<OrderViewDto["allowedActions"][number]["code"], string> = {
  CORRECT_ORDER_OCCUPANT: "更正住宿人资料",
  CHECK_IN: "办理入住",
  CHECK_OUT: "办理退房",
  COMPLETE_STAY: "完成住宿",
  RESCHEDULE_STAY: "调整预订日期",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "延长住宿",
  MOVE_UNIT: "换房",
  REPRICE_ORDER: "调整订单金额",
  CANCEL_ORDER: "取消订单",
  MARK_NO_SHOW: "标记未到",
  REVOKE_CHECK_IN: "撤销入住",
  RECORD_COLLECTION: "登记收款",
  RECORD_REFUND: "登记退款",
  CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: "升级会员"
};

const channelLabels = {
  YOUMUDAO: "游牧岛",
  CTRIP: "携程",
  MEITUAN: "美团",
  WECOM: "企业微信"
} as const;

const arrangementChangeLabels: Record<OrderViewDto["arrangementHistory"][number]["type"], string> = {
  INITIAL_BOOKING: "初始预订",
  RESCHEDULE: "改期",
  EXTENSION: "续住",
  SHORTENING: "缩短住宿",
  MOVE: "换房",
  EARLY_CHECK_OUT: "提前退房"
};

const effectiveArrangementLabels: Record<OrderViewDto["effectiveArrangement"]["presentation"], string> = {
  CURRENT: "当前住宿安排",
  LAST: "最后住宿安排",
  BEFORE_CANCELLATION: "取消前住宿安排",
  NO_SHOW_ORDER: "未到订单安排",
  BEFORE_CHECK_IN_REVOCATION: "撤销入住前住宿安排"
};

const fulfillmentStateLabels: Record<OrderViewDto["fulfillment"]["state"], string> = {
  NOT_CHECKED_IN: "尚未入住",
  IN_HOUSE: "在住",
  CHECKED_OUT: "已退房",
  CANCELLED: "已取消",
  NO_SHOW: "未到",
  CHECK_IN_REVOKED: "入住已撤销"
};

const collectionFactLabels = {
  COLLECTION: "收款",
  REFUND: "退款",
  REVERSAL: "冲销"
} as const;

function collectionMethodLabel(method: string): string {
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

export interface RoomStatusOrderContextProps {
  view: OrderViewDto;
  units: readonly InventoryUnitDto[];
  memberView?: MemberViewDto;
  loading?: boolean;
  writeBlocked?: boolean;
  onClose?: () => void;
  primaryActionPlacement?: "CONTENT" | "DRAWER_FOOTER";
  onOpenOrder: (actionCode?: string) => void;
  onOpenMember?: (target: { memberId: string; contractId: string }) => void;
  onFulfillmentAction: (action: "CHECK_IN" | "CHECK_OUT") => void;
  onLifecycleAction?: (action: OrderLifecycleAction) => void;
  onDateAction?: (action: StayDateChangeAction, mode?: StayDateChangeMode) => void;
  onMoveUnit?: () => void;
  onCorrectOccupant: (occupant: OrderOccupant) => void;
  onLocateRange: (target: { inventoryUnitId: string; arrivalDate: string; departureDate: string }) => void;
}

function membershipCoverageStatusSummary(view: OrderViewDto, status: "HELD" | "CONSUMED", lotId: string): string | undefined {
  const coverage = view.coverageSet.filter((item) => item.status === status
    && item.contract_id === view.order.member_contract_id
    && item.lot_id === lotId);
  const roomNights = coverage.filter((item) => item.unit_kind === "ROOM_NIGHT").length;
  const bedNights = coverage.filter((item) => item.unit_kind === "BED_NIGHT").length;
  const units = [roomNights ? `${roomNights} 间夜` : null, bedNights ? `${bedNights} 床夜` : null].filter(Boolean);
  return units.length ? `${status === "CONSUMED" ? "已核销" : "已冻结"} ${units.join(" · ")}` : undefined;
}

function occupantLabel(occupant: OrderOccupant): string {
  return occupant.nickname?.trim() || occupant.fullName?.trim() || "历史未记录";
}

function nightsBetween(arrivalDate: string, departureDate: string): number {
  return Math.max(0, Math.round((Date.parse(`${departureDate}T00:00:00Z`) - Date.parse(`${arrivalDate}T00:00:00Z`)) / 86_400_000));
}

const correctionFieldLabels = {
  nickname: "昵称",
  fullName: "姓名",
  phone: "联系电话",
  documentNumber: "证件号码"
} as const;

function correctionChanges(correction: OrderViewDto["occupantCorrections"][number]) {
  return (Object.keys(correctionFieldLabels) as Array<keyof typeof correctionFieldLabels>).flatMap((key) => {
    const prior = correction.priorSnapshot[key] || "未记录";
    const corrected = correction.correctedSnapshot[key] || "未记录";
    return prior === corrected ? [] : [{ label: correctionFieldLabels[key], prior, corrected }];
  });
}

function membershipCoverageSummary(view: OrderViewDto): string {
  const active = view.coverageSet.filter((coverage) => coverage.status === "HELD" || coverage.status === "CONSUMED");
  const roomNights = active.filter((coverage) => coverage.unit_kind === "ROOM_NIGHT").length;
  const bedNights = active.filter((coverage) => coverage.unit_kind === "BED_NIGHT").length;
  const parts = [roomNights ? `${roomNights} 房晚` : null, bedNights ? `${bedNights} 床晚` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "暂无在用权益";
}

function arrangementSummary(
  arrangement: OrderViewDto["originalArrangement"],
  unitMap: ReadonlyMap<string, InventoryUnitDto>
): string {
  return arrangement.intervals.map((interval) => {
    const unit = unitMap.get(interval.inventoryUnitId);
    const unitLabel = unit ? `${unit.code} ${unit.name}` : "房源名称暂不可用";
    return `${unitLabel} · ${formatDate(interval.arrivalDate)} 至 ${formatDate(interval.departureDate)}`;
  }).join("；");
}

function ArrangementIntervals({
  arrangement,
  unitMap,
  onLocateRange,
  actionLabel
}: {
  arrangement: OrderViewDto["originalArrangement"];
  unitMap: ReadonlyMap<string, InventoryUnitDto>;
  onLocateRange: RoomStatusOrderContextProps["onLocateRange"];
  actionLabel: string;
}) {
  return <ol className="room-status-order-segments">
    {arrangement.intervals.map((interval, index) => {
      const unit = unitMap.get(interval.inventoryUnitId);
      return <li key={`${interval.inventoryUnitId}:${interval.arrivalDate}:${interval.departureDate}`}>
        <strong>{arrangement.intervals.length > 1 ? `第 ${index + 1} 段 · ` : ""}{unit ? `${unit.code} ${unit.name}` : "房源名称暂不可用"}</strong>
        <span>{formatDate(interval.arrivalDate)} 至 {formatDate(interval.departureDate)}</span>
        <button type="button" className="room-status-text-button" onClick={() => onLocateRange(interval)}><Crosshair aria-hidden="true" size={15} />{actionLabel}</button>
      </li>;
    })}
  </ol>;
}

function FulfillmentRecord({
  type,
  record
}: {
  type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN";
  record: OrderViewDto["fulfillment"]["checkIn"];
}) {
  const isCheckIn = type === "CHECK_IN";
  const isRevocation = type === "REVOKE_CHECK_IN";
  const label = isCheckIn ? "入住" : isRevocation ? "撤销入住" : "退房";
  if (!record) return <li><strong>{label}</strong><span>尚无办理记录</span></li>;
  return <li>
    <strong>{label}办理</strong>
    <span>{isCheckIn || isRevocation ? "计划入住日" : "计划退房日"}：{formatDate(record.plannedBusinessDate)}</span>
    <span>办理营业日：{record.recordedBusinessDate ? formatDate(record.recordedBusinessDate) : "历史未记录"}</span>
    <span>备注：{record.reason.note || (isCheckIn ? "按计划办理入住" : isRevocation ? "撤销误办入住" : "按计划办理退房")}</span>
    <small>{record.actor?.displayName ?? "系统记录"} · 记录于 {formatDateTime(record.recordedAt)}</small>
  </li>;
}

export function RoomStatusOrderContext({
  view,
  units,
  memberView,
  loading = false,
  writeBlocked = false,
  onClose,
  primaryActionPlacement = "CONTENT",
  onOpenOrder,
  onOpenMember,
  onFulfillmentAction,
  onLifecycleAction,
  onDateAction,
  onMoveUnit,
  onCorrectOccupant,
  onLocateRange
}: RoomStatusOrderContextProps) {
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const enabledActions = view.allowedActions.filter((action) => action.enabled);
  const canCorrectOccupants = enabledActions.some((action) => action.code === "CORRECT_ORDER_OCCUPANT");
  const fulfillmentActions = enabledActions.filter((action): action is typeof action & { code: "CHECK_IN" | "CHECK_OUT" } => (
    action.code === "CHECK_IN" || action.code === "CHECK_OUT"
  ));
  const dateActionStates = (["RESCHEDULE_STAY", "EXTEND_STAY", "SHORTEN_STAY"] as const)
    .map((action) => stayDateChangeActionState(view, action))
    .filter((state): state is NonNullable<typeof state> => Boolean(state));
  const extensionState = dateActionStates.find((state) => state.action === "EXTEND_STAY");
  const shortenState = dateActionStates.find((state) => state.action === "SHORTEN_STAY");
  const dateActions = enabledActions.filter((action): action is typeof action & { code: StayDateChangeAction } => (
    action.code === "RESCHEDULE_STAY"
      && dateActionStates.some((state) => state.action === action.code && state.enabled)
  ));
  const departureAdjustmentAction = view.order.status === "CHECKED_IN"
    ? extensionState?.enabled ? "EXTEND_STAY" : shortenState?.enabled ? "SHORTEN_STAY" : undefined
    : undefined;
  const moveUnitEnabled = enabledActions.some((action) => action.code === "MOVE_UNIT");
  const lifecycleActions = enabledActions.filter((action): action is typeof action & { code: OrderLifecycleAction } => (
    action.code === "CANCEL_ORDER" || action.code === "MARK_NO_SHOW" || action.code === "REVOKE_CHECK_IN"
  ));
  const routedActions = enabledActions.filter((action) => (
    action.code !== "CORRECT_ORDER_OCCUPANT" && action.code !== "CHECK_IN" && action.code !== "CHECK_OUT"
      && action.code !== "RESCHEDULE_STAY" && action.code !== "EXTEND_STAY" && action.code !== "SHORTEN_STAY"
      && action.code !== "MOVE_UNIT" && action.code !== "CANCEL_ORDER" && action.code !== "MARK_NO_SHOW"
      && action.code !== "REVOKE_CHECK_IN"
  ));
  const amountDifference = view.amounts.collectionDifference;
  const currentPricingRevision = view.pricingRevisions.find((revision) => revision.id === view.order.current_revision_id)
    ?? view.pricingRevisions[view.pricingRevisions.length - 1];
  const showPerOrderFunds = stayDateFundsAreOperatorFacing(view.order.booking_channel_code, currentPricingRevision?.pricing_basis);
  const source = view.order.stay_type === "FREE"
    ? `免费住宿 · ${view.order.free_stay_reason || "未填写原因"}`
    : view.order.member_id || view.order.member_contract_id
      ? `会员权益 · ${membershipCoverageSummary(view)}`
      : view.order.booking_channel_code
        ? `${channelLabels[view.order.booking_channel_code]}${view.order.channel_order_reference ? ` · ${view.order.channel_order_reference}` : ""}`
        : "历史未记录";
  const matchingMemberView = memberView?.member.id === view.order.member_id ? memberView : undefined;
  const matchingMembershipOrder = matchingMemberView?.membershipOrders.find(({ order }) => (
    order.status === "ACTIVE"
      && order.contract_id === view.order.member_contract_id
  ));
  const memberProfileTarget = matchingMemberView && view.order.member_contract_id
    ? { memberId: matchingMemberView.member.id, contractId: view.order.member_contract_id }
    : undefined;
  const matchingLotId = matchingMembershipOrder?.order.entitlement_lot_id ?? undefined;
  const consumedMembershipSummary = matchingLotId ? membershipCoverageStatusSummary(view, "CONSUMED", matchingLotId) : undefined;
  const heldMembershipSummary = matchingLotId ? membershipCoverageStatusSummary(view, "HELD", matchingLotId) : undefined;

  return (
    <aside className="room-status-context room-status-order-context" aria-labelledby="room-status-order-context-heading" aria-busy={loading}>
      <header className="room-status-context-header">
        <div>
          <span>订单概览</span>
          <h2 id="room-status-order-context-heading">{view.occupants[0] ? `${occupantLabel(view.occupants[0])}的住宿订单` : "住宿订单"}</h2>
        </div>
        <div className="room-status-order-context-header-actions">
          <StatusBadge value={view.order.status} label={businessStatusLabel(view.order.status)} />
          {onClose ? <button type="button" className="room-status-icon-button" onClick={onClose} aria-label="关闭订单上下文" title="关闭订单上下文"><X aria-hidden="true" size={17} /></button> : null}
        </div>
      </header>

      <section className="room-status-context-section" aria-labelledby="room-status-order-stay-heading">
        <div className="room-status-context-section-heading"><CalendarRange aria-hidden="true" size={17} /><h3 id="room-status-order-stay-heading">完整住宿</h3></div>
        <dl className="room-status-context-facts">
          <dt>日期</dt><dd>{formatDate(view.effectiveArrangement.arrivalDate)} 至 {formatDate(view.effectiveArrangement.departureDate)}</dd>
          <dt>夜数</dt><dd>{nightsBetween(view.effectiveArrangement.arrivalDate, view.effectiveArrangement.departureDate)} 夜</dd>
          <dt>来源</dt><dd>{source}</dd>
          {!showPerOrderFunds && currentPricingRevision ? <>
            <dt>政策基础金额</dt><dd>{formatMinor(currentPricingRevision.policy_base_amount_minor, currentPricingRevision.currency)}</dd>
            <dt>本单渠道应结金额</dt><dd>{formatMoney(view.amounts.currentContractAmount)}</dd>
            <dt>与政策基础金额差额</dt><dd>{formatMinor(currentPricingRevision.difference_from_policy_minor, currentPricingRevision.currency)}</dd>
            <dt>渠道价格差异说明</dt><dd>{currentPricingRevision.reason.note.trim() || "无"}</dd>
          </> : <>
            <dt>住宿金额</dt><dd>{formatMoney(view.amounts.currentContractAmount)}</dd>
            <dt>已记录净收款</dt><dd>{formatMoney(view.amounts.netRecordedCollection)}</dd>
            <dt>差额</dt><dd>{formatMoney(amountDifference)}</dd>
            {view.amounts.refundReferenceAmount.minorUnits > 0 ? <><dt>退款参考</dt><dd><strong>{formatMoney(view.amounts.refundReferenceAmount)}</strong><small>目前尚未登记退款</small></dd></> : null}
          </>}
          <dt>资金记录</dt><dd>{view.collectionFacts.length} 笔</dd>
        </dl>
      </section>

      {matchingMemberView && matchingMembershipOrder && memberProfileTarget ? <section className="room-status-context-section" aria-labelledby="room-status-order-membership-heading">
        <div className="room-status-context-section-heading"><Users aria-hidden="true" size={17} /><h3 id="room-status-order-membership-heading">会员权益</h3></div>
        <div className="room-status-context-facts">
          <p>会员：{matchingMemberView.member.full_name}</p>
          <p>使用权益：{matchingMembershipOrder.order.product_name}</p>
          {consumedMembershipSummary ? <p>{consumedMembershipSummary}</p> : null}
          {heldMembershipSummary ? <p>{heldMembershipSummary}</p> : null}
        </div>
        {onOpenMember
          ? <button type="button" className="room-status-text-button" onClick={() => onOpenMember(memberProfileTarget)}>查看会员档案<ArrowRight aria-hidden="true" size={15} /></button>
          : <Link className="room-status-text-button" to={`/members?memberId=${encodeURIComponent(memberProfileTarget.memberId)}&contractId=${encodeURIComponent(memberProfileTarget.contractId)}`}>查看会员档案<ArrowRight aria-hidden="true" size={15} /></Link>}
      </section> : null}

      {currentReleaseFeatures.cleaningWorkflow && view.cleaningTasks.length ? <section className="room-status-context-section" aria-labelledby="room-status-order-cleaning-heading">
        <div className="room-status-context-section-heading"><Sparkles aria-hidden="true" size={17} /><h3 id="room-status-order-cleaning-heading">清洁任务</h3></div>
        <ol className="room-status-order-corrections">{view.cleaningTasks.map((task) => {
          const unit = unitMap.get(task.inventoryUnitId);
          return <li key={task.id}>
            <strong>{unit ? `${unit.code} ${unit.name}` : "退房房源"} · {businessStatusLabel(task.status)}</strong>
            <span>清洁日期：{formatDate(task.serviceDate)}</span>
            <small>{task.status === "COMPLETED" ? `完成：${task.completedBy?.displayName ?? "系统记录"} · ${formatDateTime(task.completedAt ?? undefined)}` : `生成：${task.createdBy?.displayName ?? "系统记录"} · ${formatDateTime(task.createdAt)}`}</small>
          </li>;
        })}</ol>
      </section> : null}

      <section className="room-status-context-section" aria-labelledby="room-status-order-occupants-heading">
        <div className="room-status-context-section-heading"><Users aria-hidden="true" size={17} /><h3 id="room-status-order-occupants-heading">住宿人</h3></div>
        <ol className="room-status-order-occupants">
          {[...view.occupants].sort((left, right) => left.ordinal - right.ordinal).map((occupant) => (
            <li key={occupant.id}>
              <div><strong>{occupantLabel(occupant)}</strong><span>{occupant.role === "PRIMARY" ? "主要联系人" : `同行人 ${Math.max(1, occupant.ordinal - 1)}`}</span></div>
              <small>{occupant.fullName || "姓名未记录"}{occupant.phone ? ` · ${occupant.phone}` : ""}</small>
              {canCorrectOccupants ? <button type="button" className="room-status-text-button" disabled={writeBlocked} onClick={() => onCorrectOccupant(occupant)}><FilePenLine aria-hidden="true" size={15} />更正资料</button> : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-original-arrangement-heading">
        <div className="room-status-context-section-heading"><ReceiptText aria-hidden="true" size={17} /><h3 id="room-status-order-original-arrangement-heading">原始预订安排</h3></div>
        <ArrangementIntervals arrangement={view.originalArrangement} unitMap={unitMap} onLocateRange={onLocateRange} actionLabel="定位原始安排" />
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-effective-arrangement-heading">
        <div className="room-status-context-section-heading"><CalendarRange aria-hidden="true" size={17} /><h3 id="room-status-order-effective-arrangement-heading">{effectiveArrangementLabels[view.effectiveArrangement.presentation]}</h3></div>
        <AccommodationPositionSummary view={view} inventoryUnits={units} />
        <ArrangementIntervals arrangement={view.effectiveArrangement} unitMap={unitMap} onLocateRange={onLocateRange} actionLabel="定位当前安排" />
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-fulfillment-heading">
        <div className="room-status-context-section-heading"><Clock3 aria-hidden="true" size={17} /><h3 id="room-status-order-fulfillment-heading">入住与退房结果</h3></div>
        <p className="room-status-context-note">当前状态：{fulfillmentStateLabels[view.fulfillment.state]}。办理记录时间不等同于住客实际到店或离店时间。</p>
        <ol className="room-status-order-corrections">
          <FulfillmentRecord type="CHECK_IN" record={view.fulfillment.checkIn} />
          <FulfillmentRecord type="CHECK_OUT" record={view.fulfillment.checkOut} />
          {view.fulfillment.checkInRevocation ? <FulfillmentRecord type="REVOKE_CHECK_IN" record={view.fulfillment.checkInRevocation} /> : null}
        </ol>
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-arrangement-history-heading">
        <div className="room-status-context-section-heading"><Clock3 aria-hidden="true" size={17} /><h3 id="room-status-order-arrangement-history-heading">住宿安排变更历史</h3></div>
        <ol className="room-status-order-corrections">
          {view.arrangementHistory.map((item, index) => {
            const difference = item.fundsSummary.collectionDifference;
            return <li key={`${item.type}:${item.recordedAt}:${index}`}>
              <strong>{arrangementChangeLabels[item.type]}</strong>
              {item.before ? <span>调整前：{arrangementSummary(item.before, unitMap)}</span> : null}
              <span>调整后：{arrangementSummary(item.after, unitMap)}</span>
              <span>说明：{item.reason.note || (item.type === "INITIAL_BOOKING" ? "按原始预订建立" : "未填写说明")}</span>
              {!showPerOrderFunds ? <>
                <span>政策基础金额：{formatMoney(item.pricingSummary.policyBaseAmount)}</span>
                <span>本单渠道应结金额：{formatMoney(item.pricingSummary.currentContractAmount)} · 与政策基础金额差额 {formatMoney(item.pricingSummary.differenceFromPolicy)}</span>
              </> : <>
                <span>住宿金额：{formatMoney(item.pricingSummary.currentContractAmount)} · 与政策基础金额差额 {formatMoney(item.pricingSummary.differenceFromPolicy)}</span>
                <span>变更时已记录净收款：{formatMoney(item.fundsSummary.netRecordedCollection)} · 差额 {formatMoney(difference)}</span>
                {item.fundsSummary.refundReferenceAmount.minorUnits > 0 ? <span>退款参考 {formatMoney(item.fundsSummary.refundReferenceAmount)} · 目前尚未登记退款</span> : null}
              </>}
              <small>{item.actor?.displayName ?? "系统记录"} · {formatDateTime(item.recordedAt)}</small>
              {item.after.intervals.map((interval, intervalIndex) => <button key={`${interval.inventoryUnitId}:${interval.arrivalDate}`} type="button" className="room-status-text-button" onClick={() => onLocateRange(interval)}><Crosshair aria-hidden="true" size={15} />{item.after.intervals.length > 1 ? `定位调整后第 ${intervalIndex + 1} 段` : "定位调整后安排"}</button>)}
            </li>;
          })}
        </ol>
      </section>

      {view.collectionFacts.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-order-funds-heading">
          <div className="room-status-context-section-heading"><ReceiptText aria-hidden="true" size={17} /><h3 id="room-status-order-funds-heading">资金记录</h3></div>
          <ol className="room-status-order-corrections">
            {view.collectionFacts.map((fact) => <li key={fact.fact_id}>
              <strong>{collectionFactLabels[fact.fact_type]} · {formatMoney({ currency: fact.currency, minorUnits: fact.amount_minor })}</strong>
              <span>净影响：{formatMoney({ currency: fact.currency, minorUnits: fact.net_effect_minor })}</span>
              <span>外部交易单号：{fact.transaction_reference ?? (fact.fact_type === "REVERSAL" ? "不适用" : "历史未记录")}</span>
              <span>方式：{collectionMethodLabel(fact.method)}</span>
              {fact.note ? <span>{fact.note}</span> : null}
              <small>{formatDateTime(fact.created_at)}</small>
            </li>)}
          </ol>
        </section>
      ) : null}

      {view.occupantCorrections.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-order-corrections-heading">
          <div className="room-status-context-section-heading"><Clock3 aria-hidden="true" size={17} /><h3 id="room-status-order-corrections-heading">资料更正记录</h3></div>
          <ol className="room-status-order-corrections">
            {[...view.occupantCorrections].reverse().map((correction) => {
              const occupant = view.occupants.find((candidate) => candidate.id === correction.occupantId);
              return <li key={correction.id}><strong>{occupant ? occupantLabel(occupant) : "住宿人"}</strong>{correctionChanges(correction).map((change) => <span key={change.label}>{change.label}：{change.prior} → {change.corrected}</span>)}<span>原因：{correction.reason.note}</span><small>{correction.actor.displayName} · {formatDateTime(correction.createdAt)}</small></li>;
            })}
          </ol>
        </section>
      ) : null}

      <section className="room-status-context-actions" aria-labelledby="room-status-order-actions-heading">
        <div className="room-status-context-section-heading"><ArrowRight aria-hidden="true" size={17} /><h3 id="room-status-order-actions-heading">订单入口</h3></div>
        {primaryActionPlacement === "CONTENT" ? <button type="button" className="room-status-button" onClick={() => onOpenOrder()}>查看完整订单<ArrowRight aria-hidden="true" size={16} /></button> : null}
        {[...new Set(dateActionStates.filter((state) => !state.enabled && state.reason).map((state) => state.reason!))].map((reason) => <p key={reason} className="room-status-context-note" role="status" data-testid="stay-date-action-blocked">{reason}</p>)}
        {fulfillmentActions.length || lifecycleActions.length || dateActions.length || departureAdjustmentAction || moveUnitEnabled || routedActions.length ? <ul>
          {fulfillmentActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" disabled={writeBlocked} data-room-status-action-mode="inline" onClick={() => onFulfillmentAction(action.code)}>{actionLabels[action.code]}</button></li>)}
          {dateActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" disabled={writeBlocked} data-room-status-action={action.code} data-room-status-action-mode="inline" onClick={() => onDateAction?.(action.code, "DATE_CHANGE")}>{actionLabels[action.code]}</button></li>)}
          {departureAdjustmentAction ? <li><button type="button" className="room-status-button" disabled={writeBlocked} data-room-status-action="ADJUST_DEPARTURE" data-room-status-action-mode="inline" onClick={() => onDateAction?.(departureAdjustmentAction, "ADJUST_DEPARTURE")}>调整退房日期</button></li> : null}
          {moveUnitEnabled ? <li><button type="button" className="room-status-button" disabled={writeBlocked} data-room-status-action="MOVE_UNIT" data-room-status-action-mode="inline" onClick={onMoveUnit}>换房</button></li> : null}
          {lifecycleActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" disabled={writeBlocked || !onLifecycleAction} data-room-status-action={action.code} data-room-status-action-mode="inline" onClick={() => onLifecycleAction?.(action.code)}>{actionLabels[action.code]}</button></li>)}
          {routedActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" data-room-status-action-mode="order-detail" onClick={() => onOpenOrder(action.code)}>{actionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} /></button></li>)}
        </ul> : null}
      </section>

      <footer className="room-status-context-freshness"><Clock3 aria-hidden="true" size={15} /><span>订单更新 {formatDateTime(view.order.updated_at)}</span><span>{view.accessLevel === "WRITE" ? "可写" : "只读"}</span></footer>
    </aside>
  );
}
