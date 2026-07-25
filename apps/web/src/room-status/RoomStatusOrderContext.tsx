import { ArrowRight, CalendarRange, Clock3, Crosshair, FilePenLine, ReceiptText, Users, X } from "lucide-react";
import type { InventoryUnitDto, OrderViewDto } from "../types";
import { formatDate, formatDateTime, formatMoney, StatusBadge } from "../ui";

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

const amendmentLabels: Record<string, string> = {
  CREATE_ORDER: "创建订单",
  CORRECT_ORDER_OCCUPANT: "更正住宿人资料",
  CHECK_IN: "办理入住",
  CHECK_OUT: "办理退房",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住",
  MOVE_UNIT: "换房",
  REPRICE_ORDER: "调整订单金额",
  REFRESH_MEMBER_COVERAGE: "刷新会员权益",
  CANCEL_ORDER: "取消订单",
  MARK_NO_SHOW: "标记未到"
};

const segmentLabels: Record<string, string> = {
  INITIAL: "初始入住",
  MOVE: "换房",
  SHORTEN_STAY: "缩短住宿",
  EXTEND_STAY: "续住"
};

const orderStatusLabels: Record<string, string> = {
  RESERVED: "已预订",
  CHECKED_IN: "在住",
  CHECKED_OUT: "已退房",
  CANCELLED: "已取消",
  NO_SHOW: "未到"
};

const collectionFactLabels = {
  COLLECTION: "收款",
  REFUND: "退款",
  REVERSAL: "冲销"
} as const;

export interface RoomStatusOrderContextProps {
  view: OrderViewDto;
  units: readonly InventoryUnitDto[];
  loading?: boolean;
  writeBlocked?: boolean;
  onClose?: () => void;
  onOpenOrder: (actionCode?: string) => void;
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function amendmentStatusChange(payload: unknown): string | null {
  const effect = recordValue(payload);
  if (!effect) return null;
  const fromStatus = typeof effect.fromStatus === "string" ? effect.fromStatus : null;
  const toStatus = typeof effect.toStatus === "string" ? effect.toStatus : null;
  if (!fromStatus || !toStatus) return null;
  return `状态：${orderStatusLabels[fromStatus] ?? "变更前状态"} → ${orderStatusLabels[toStatus] ?? "变更后状态"}`;
}

function membershipCoverageSummary(view: OrderViewDto): string {
  const active = view.coverageSet.filter((coverage) => coverage.status === "HELD" || coverage.status === "CONSUMED");
  const roomNights = active.filter((coverage) => coverage.unit_kind === "ROOM_NIGHT").length;
  const bedNights = active.filter((coverage) => coverage.unit_kind === "BED_NIGHT").length;
  const parts = [roomNights ? `${roomNights} 房晚` : null, bedNights ? `${bedNights} 床晚` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "暂无在用权益";
}

export function RoomStatusOrderContext({
  view,
  units,
  loading = false,
  writeBlocked = false,
  onClose,
  onOpenOrder,
  onCorrectOccupant,
  onLocateRange
}: RoomStatusOrderContextProps) {
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const enabledActions = view.allowedActions.filter((action) => action.enabled);
  const canCorrectOccupants = enabledActions.some((action) => action.code === "CORRECT_ORDER_OCCUPANT") && !writeBlocked;
  const routedActions = enabledActions.filter((action) => action.code !== "CORRECT_ORDER_OCCUPANT");
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
          <span>选中对象上下文</span>
          <h2 id="room-status-order-context-heading">订单 {view.order.id}</h2>
        </div>
        <div className="room-status-order-context-header-actions">
          <StatusBadge value={view.order.status} />
          {onClose ? <button type="button" className="room-status-icon-button" onClick={onClose} aria-label="关闭订单上下文" title="关闭订单上下文"><X aria-hidden="true" size={17} /></button> : null}
        </div>
      </header>

      <section className="room-status-context-section" aria-labelledby="room-status-order-stay-heading">
        <div className="room-status-context-section-heading"><CalendarRange aria-hidden="true" size={17} /><h3 id="room-status-order-stay-heading">完整住宿</h3></div>
        <dl className="room-status-context-facts">
          <dt>日期</dt><dd>{formatDate(view.order.arrival_date)} 至 {formatDate(view.order.departure_date)}</dd>
          <dt>夜数</dt><dd>{nightsBetween(view.order.arrival_date, view.order.departure_date)} 夜</dd>
          <dt>来源</dt><dd>{source}</dd>
          <dt>订单金额</dt><dd>{formatMoney(view.amounts.currentContractAmount)}</dd>
          <dt>已收净额</dt><dd>{formatMoney(view.amounts.netRecordedCollection)}</dd>
          <dt>待收 / 差额</dt><dd>{formatMoney(view.amounts.collectionDifference)}</dd>
          <dt>资金记录</dt><dd>{view.collectionFacts.length} 笔</dd>
        </dl>
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-occupants-heading">
        <div className="room-status-context-section-heading"><Users aria-hidden="true" size={17} /><h3 id="room-status-order-occupants-heading">住宿人</h3></div>
        <ol className="room-status-order-occupants">
          {[...view.occupants].sort((left, right) => left.ordinal - right.ordinal).map((occupant) => (
            <li key={occupant.id}>
              <div><strong>{occupantLabel(occupant)}</strong><span>{occupant.role === "PRIMARY" ? "主要 / 联系人" : `同行人 ${Math.max(1, occupant.ordinal - 1)}`}</span></div>
              <small>{occupant.fullName || "姓名未记录"}{occupant.phone ? ` · ${occupant.phone}` : ""}</small>
              {canCorrectOccupants ? <button type="button" className="room-status-text-button" onClick={() => onCorrectOccupant(occupant)}><FilePenLine aria-hidden="true" size={15} />更正资料</button> : null}
            </li>
          ))}
        </ol>
      </section>

      <section className="room-status-context-section" aria-labelledby="room-status-order-segments-heading">
        <div className="room-status-context-section-heading"><ReceiptText aria-hidden="true" size={17} /><h3 id="room-status-order-segments-heading">住宿分段</h3></div>
        <ol className="room-status-order-segments">
          {view.segments.map((segment) => {
            const unit = unitMap.get(segment.inventory_unit_id);
            return <li key={segment.id}><strong>#{segment.sequence} · {unit ? `${unit.code} ${unit.name}` : "房源名称暂不可用"}</strong><span>{formatDate(segment.arrival_date)} 至 {formatDate(segment.departure_date)}</span><small>{segmentLabels[segment.segment_type] ?? "住宿分段"}</small><button type="button" className="room-status-text-button" onClick={() => onLocateRange({ inventoryUnitId: segment.inventory_unit_id, arrivalDate: segment.arrival_date, departureDate: segment.departure_date })}><Crosshair aria-hidden="true" size={15} />定位这段住宿</button></li>;
          })}
        </ol>
      </section>

      {view.amendments.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-order-amendments-heading">
          <div className="room-status-context-section-heading"><Clock3 aria-hidden="true" size={17} /><h3 id="room-status-order-amendments-heading">变更记录</h3></div>
          <ol className="room-status-order-corrections">
            {view.amendments.map((amendment) => {
              const revision = view.pricingRevisions.find((candidate) => candidate.amendment_id === amendment.id);
              const segment = view.segments.find((candidate) => candidate.amendment_id === amendment.id);
              const segmentAtChange = [...view.segments]
                .filter((candidate) => {
                  const candidateAmendment = view.amendments.find((item) => item.id === candidate.amendment_id);
                  return candidateAmendment ? candidateAmendment.sequence <= amendment.sequence : false;
                })
                .sort((left, right) => right.sequence - left.sequence)[0];
              const priorSegment = segment?.supersedes_segment_id
                ? view.segments.find((candidate) => candidate.id === segment.supersedes_segment_id)
                : undefined;
              const segmentUnit = segment ? unitMap.get(segment.inventory_unit_id) : undefined;
              const priorUnit = priorSegment ? unitMap.get(priorSegment.inventory_unit_id) : undefined;
              const factsAtChange = view.collectionFacts.filter((fact) => fact.created_at <= amendment.created_at);
              const netAtChange = factsAtChange.reduce((total, fact) => total + fact.net_effect_minor, 0);
              const relatedFacts = revision
                ? view.collectionFacts.filter((fact) => fact.pricing_revision_id === revision.id)
                : [];
              const statusChange = amendmentStatusChange(amendment.payload);
              const locationSegment = segment ?? segmentAtChange;
              const locateTarget = locationSegment ? {
                inventoryUnitId: locationSegment.inventory_unit_id,
                arrivalDate: locationSegment.arrival_date,
                departureDate: locationSegment.departure_date
              } : null;
              return <li key={amendment.id}>
                <strong>#{amendment.sequence} · {amendmentLabels[amendment.amendment_type] ?? "订单变更"}</strong>
                <span>原因：{amendment.reason_note || "未填写说明"}</span>
                {segment ? <span>房源：{priorSegment ? `${priorUnit ? `${priorUnit.code} ${priorUnit.name}` : "原房源名称暂不可用"} → ` : ""}{segmentUnit ? `${segmentUnit.code} ${segmentUnit.name}` : "新房源名称暂不可用"}</span> : null}
                {segment ? <span>日期：{priorSegment ? `${formatDate(priorSegment.arrival_date)} 至 ${formatDate(priorSegment.departure_date)} → ` : ""}{formatDate(segment.arrival_date)} 至 {formatDate(segment.departure_date)}</span> : null}
                {statusChange ? <span>{statusChange}</span> : null}
                {revision ? <span>计价修订 #{revision.revision_no} · {formatMoney({ currency: revision.currency, minorUnits: revision.current_contract_amount_minor })}</span> : null}
                {revision ? <span>相关资金：{relatedFacts.length
                  ? relatedFacts.map((fact) => `${collectionFactLabels[fact.fact_type]} ${formatMoney({ currency: fact.currency, minorUnits: fact.net_effect_minor })}${fact.transaction_reference ? ` · ${fact.transaction_reference}` : ""}`).join("；")
                  : "无"}</span> : null}
                <span>变更时资金：已收净额 {formatMoney({ currency: view.amounts.netRecordedCollection.currency, minorUnits: netAtChange })} · {factsAtChange.length} 笔</span>
                <small>{amendment.actor?.displayName ? `操作人：${amendment.actor.displayName} · ` : ""}{formatDateTime(amendment.created_at)}</small>
                {locateTarget ? <button type="button" className="room-status-text-button" onClick={() => onLocateRange(locateTarget)}><Crosshair aria-hidden="true" size={15} />定位这次变更</button> : null}
              </li>;
            })}
          </ol>
        </section>
      ) : null}

      {view.collectionFacts.length ? (
        <section className="room-status-context-section" aria-labelledby="room-status-order-funds-heading">
          <div className="room-status-context-section-heading"><ReceiptText aria-hidden="true" size={17} /><h3 id="room-status-order-funds-heading">资金记录</h3></div>
          <ol className="room-status-order-corrections">
            {view.collectionFacts.map((fact) => <li key={fact.fact_id}>
              <strong>{collectionFactLabels[fact.fact_type]} · {formatMoney({ currency: fact.currency, minorUnits: fact.amount_minor })}</strong>
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
        <button type="button" className="room-status-button" onClick={() => onOpenOrder()}>查看完整订单<ArrowRight aria-hidden="true" size={16} /></button>
        {routedActions.length ? <ul>{routedActions.map((action) => <li key={action.code}><button type="button" className="room-status-button" onClick={() => onOpenOrder(action.code)}>{actionLabels[action.code]}<ArrowRight aria-hidden="true" size={16} /></button></li>)}</ul> : null}
      </section>

      <footer className="room-status-context-freshness"><Clock3 aria-hidden="true" size={15} /><span>订单更新 {formatDateTime(view.order.updated_at)}</span><span>{view.accessLevel === "WRITE" ? "可写" : "只读"}</span></footer>
    </aside>
  );
}
