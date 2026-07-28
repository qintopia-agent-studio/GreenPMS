import { ArrowRight, CalendarRange, Clock3, Crosshair, FilePenLine, ReceiptText, Sparkles, Users, X } from "lucide-react";
import { currentReleaseFeatures } from "@qintopia/contracts";
import type { InventoryUnitDto, OrderViewDto } from "../types";
import { businessStatusLabel, formatDate, formatDateTime, formatMoney, StatusBadge } from "../ui";

type OrderOccupant = OrderViewDto["occupants"][number];

const actionLabels: Record<OrderViewDto["allowedActions"][number]["code"], string> = {
  CORRECT_ORDER_OCCUPANT: "更正住宿人资料",
  CHECK_IN: "办理入住",
  CHECK_OUT: "办理退房",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  MOVE_UNIT: "换房",
  REPRICE_ORDER: "调整订单金额",
  CANCEL_ORDER: "取消订单",
  MARK_NO_SHOW: "标记未到",
  RECORD_COLLECTION: "记录收款",
  RECORD_REFUND: "记录退款"
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
  NO_SHOW_ORDER: "未到订单安排"
};

const fulfillmentStateLabels: Record<OrderViewDto["fulfillment"]["state"], string> = {
  NOT_CHECKED_IN: "尚未入住",
  IN_HOUSE: "在住",
  CHECKED_OUT: "已退房",
  CANCELLED: "已取消",
  NO_SHOW: "未到"
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
  loading?: boolean;
  writeBlocked?: boolean;
  onClose?: () => void;
  primaryActionPlacement?: "CONTENT" | "DRAWER_FOOTER";
  onOpenOrder: (actionCode?: string) => void;
  onFulfillmentAction: (action: "CHECK_IN" | "CHECK_OUT") => void;
  onCorrectOccupant: (occupant: OrderOccupant) => void;
  onLocateRange: (target: { inventoryUnitId: string; arrivalDate: string; departureDate: string }) => void;
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
  type: "CHECK_IN" | "CHECK_OUT";
  record: OrderViewDto["fulfillment"]["checkIn"];
}) {
  const isCheckIn = type === "CHECK_IN";
  if (!record) return <li><strong>{isCheckIn ? "入住" : "退房"}</strong><span>尚无办理记录</span></li>;
  return <li>
    <strong>{isCheckIn ? "入住办理" : "退房办理"}</strong>
    <span>{isCheckIn ? "计划入住日" : "计划退房日"}：{formatDate(record.plannedBusinessDate)}</span>
    <span>办理营业日：{record.recordedBusinessDate ? formatDate(record.recordedBusinessDate) : "历史未记录"}</span>
    <span>备注：{record.reason.note || (isCheckIn ? "按计划办理入住" : "按计划办理退房")}</span>
    <small>{record.actor?.displayName ?? "系统记录"} · 记录于 {formatDateTime(record.recordedAt)}</small>
  </li>;
}

export function RoomStatusOrderContext({
  view,
  units,
  loading = false,
  writeBlocked = false,
  onClose,
  primaryActionPlacement = "CONTENT",
  onOpenOrder,
  onFulfillmentAction,
  onCorrectOccupant,
  onLocateRange
}: RoomStatusOrderContextProps) {
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const enabledActions = view.allowedActions.filter((action) => action.enabled);
  const canCorrectOccupants = enabledActions.some((action) => action.code === "CORRECT_ORDER_OCCUPANT");
  const fulfillmentActions = enabledActions.filter((action): action is typeof action & { code: "CHECK_IN" | "CHECK_OUT" } => (
    action.code === "CHECK_IN" || action.code === "CHECK_OUT"
  ));
  const routedActions = enabledActions.filter((action) => (
    action.code !== "CORRECT_ORDER_OCCUPANT" && action.code !== "CHECK_IN" && action.code !== "CHECK_OUT"
  ));
  const amountDifference = view.amounts.collectionDifference;
  const source = view.order.stay_type === "FREE"
    ? `免费住宿 · ${view.order.free_stay_reason || "未填写原因"}`
    : view.order.member_id || view.order.member_contract_id
      ? `会员权益 · ${membershipCoverageSummary(view)}`
      : view.order.booking_channel_code
        ? `${channelLabels[view.order.booking_channel_code]}${view.order.channel_order_reference ? ` · ${view.order.channel_order_reference}` : ""}`
        : "历史未记录";

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
          <dt>订单金额</dt><dd>{formatMoney(view.amounts.currentContractAmount)}</dd>
          <dt>已登记净收款</dt><dd>{formatMoney(view.amounts.netRecordedCollection)}</dd>
          <dt>{amountDifference.minorUnits > 0 ? "待收" : amountDifference.minorUnits < 0 ? "多收" : "已结清"}</dt><dd>{formatMoney({ currency: amountDifference.currency, minorUnits: Math.abs(amountDifference.minorUnits) })}</dd>
          <dt>资金记录</dt><dd>{view.collectionFacts.length} 笔</dd>
        </dl>
      </section>

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
              <div><strong>{occupantLabel(occupant)}</strong><span>{occupant.role === "PRIMARY" ? "主要 / 联系人" : `同行人 ${Math.max(1, occupant.ordinal - 1)}`}</span></div>
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
        <ArrangementIntervals arrangement={view.effectiveArrangement} unitMap={unitMap} onLocateRange={onLocateRange} actionLabel="定位当前安排" />
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-fulfillment-heading">
        <div className="room-status-context-section-heading"><Clock3 aria-hidden="true" size={17} /><h3 id="room-status-order-fulfillment-heading">入住与退房结果</h3></div>
        <p className="room-status-context-note">当前状态：{fulfillmentStateLabels[view.fulfillment.state]}。办理记录时间不等同于住客实际到店或离店时间。</p>
        <ol className="room-status-order-corrections">
          <FulfillmentRecord type="CHECK_IN" record={view.fulfillment.checkIn} />
          <FulfillmentRecord type="CHECK_OUT" record={view.fulfillment.checkOut} />
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
              <span>订单金额：{formatMoney(item.pricingSummary.currentContractAmount)} · 与政策基础金额差额 {formatMoney(item.pricingSummary.differenceFromPolicy)}</span>
              <span>变更时已登记净收款：{formatMoney(item.fundsSummary.netRecordedCollection)} · {difference.minorUnits > 0 ? `待收 ${formatMoney({ currency: difference.currency, minorUnits: difference.minorUnits })}` : difference.minorUnits < 0 ? `多收 ${formatMoney({ currency: difference.currency, minorUnits: Math.abs(difference.minorUnits) })}` : "已结清"}</span>
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
        {fulfillmentActions.length || routedActions.length ? <ul>
          {fulfillmentActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" disabled={writeBlocked} data-room-status-action-mode="inline" onClick={() => onFulfillmentAction(action.code)}>{actionLabels[action.code]}</button></li>)}
          {routedActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" data-room-status-action-mode="order-detail" onClick={() => onOpenOrder(action.code)}>{actionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} /></button></li>)}
        </ul> : null}
      </section>

      <footer className="room-status-context-freshness"><Clock3 aria-hidden="true" size={15} /><span>订单更新 {formatDateTime(view.order.updated_at)}</span><span>{view.accessLevel === "WRITE" ? "可写" : "只读"}</span></footer>
    </aside>
  );
}
