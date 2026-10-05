import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronRight, DoorOpen, LogIn, LogOut, RefreshCw } from "lucide-react";
import { WorkbenchFundsExceptions } from "../components/WorkbenchFundsExceptions";
import { Link, useSearchParams } from "react-router-dom";
import type { CommandType } from "@qintopia/contracts";
import { api } from "../api";
import { commandRecoveryAvailable, principalCan, useWorkspace } from "../session";
import type { CommandCapability, CommandRequest, OrderRowDto } from "../types";
import { localDateInTimeZone } from "../dates";
import {
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  CommandRecoveryBar,
  DamagedCommandRecoveryNotice,
  businessStatusLabel,
  EmptyState,
  formatDate,
  guestName,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  QuoteRecoveryConflictNotice,
  recoveryCommandRequest,
  StatusBadge,
  usePersistentCommandRecovery
} from "../ui";

export type TodayTab = "ARRIVALS" | "IN_HOUSE" | "DEPARTURES" | "EXCEPTIONS";

const tabs: Array<{ id: TodayTab; label: string }> = [
  { id: "ARRIVALS", label: "今日到店" },
  { id: "IN_HOUSE", label: "在住" },
  { id: "DEPARTURES", label: "今日离店" },
  { id: "EXCEPTIONS", label: "异常·含资金" }
];

export function TodayTabLabel({ tab }: { tab: TodayTab }) {
  return <span>{tabs.find(item => item.id === tab)!.label}</span>;
}

export function TodayQueueEmpty({ tab }: { tab: TodayTab }) {
  return tab === "EXCEPTIONS"
    ? <p className="workbench-lodging-empty">暂无住宿异常，资金待办见下方。</p>
    : <EmptyState title="当前队列为空" detail="该营业日期没有匹配的订单。" />;
}

export interface TodayExceptionPresentation {
  title: "逾期在住，需确认实际状态";
  detail: string;
  actionLabel: "核对逾期在住";
}

export function todayExceptionPresentation(
  order: Pick<OrderRowDto, "status" | "stay_status" | "departure_date">,
  businessDate: string
): TodayExceptionPresentation | undefined {
  if (order.status !== "CHECKED_IN" || order.stay_status !== "IN_HOUSE" || order.departure_date >= businessDate) return undefined;
  return {
    title: "逾期在住，需确认实际状态",
    detail: `计划离店日 ${order.departure_date} 已早于营业日 ${businessDate}`,
    actionLabel: "核对逾期在住"
  };
}

export function TodayExceptionReason({ order, businessDate }: {
  order: Pick<OrderRowDto, "status" | "stay_status" | "departure_date">;
  businessDate: string;
}) {
  const presentation = todayExceptionPresentation(order, businessDate);
  return presentation ? <span className="queue-exception-reason">{presentation.detail}</span> : null;
}

export function TodayExceptionAction({ order, businessDate }: {
  order: Pick<OrderRowDto, "id" | "status" | "stay_status" | "departure_date" | "primary_guest_snapshot" | "current_primary_guest">;
  businessDate: string;
}) {
  const presentation = todayExceptionPresentation(order, businessDate);
  if (!presentation) return null;
  return <Link className="button button-secondary" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`${presentation.actionLabel}：${guestName((order.current_primary_guest ?? order.primary_guest_snapshot))}`}>{presentation.actionLabel}<ChevronRight aria-hidden="true" size={16} /></Link>;
}

export function buildTodayBuckets(
  orders: readonly OrderRowDto[],
  browsingDate: string,
  currentBusinessDate = browsingDate
): Record<TodayTab, OrderRowDto[]> {
  return {
    ARRIVALS: orders.filter((order) => order.arrival_date === browsingDate && order.status === "RESERVED"),
    IN_HOUSE: orders.filter((order) => order.status === "CHECKED_IN" && order.stay_status === "IN_HOUSE"),
    DEPARTURES: orders.filter((order) => order.departure_date === browsingDate && order.status === "CHECKED_IN" && order.stay_status === "IN_HOUSE"),
    EXCEPTIONS: orders.filter((order) => {
      const overdueArrival = order.status === "RESERVED"
        && order.stay_status === "PLANNED"
        && order.arrival_date < currentBusinessDate
        && currentBusinessDate <= order.departure_date;
      const overdueDeparture = order.departure_date < currentBusinessDate
        && (order.status === "RESERVED" && order.stay_status === "PLANNED"
          || order.status === "CHECKED_IN" && order.stay_status === "IN_HOUSE");
      const terminalStayNeedsReview = (order.status === "NO_SHOW" || order.status === "CANCELLED")
        && order.arrival_date <= currentBusinessDate
        && currentBusinessDate <= order.departure_date;
      return overdueArrival || overdueDeparture || terminalStayNeedsReview;
    })
  };
}

export function todayQueueStatusLabel(
  tab: TodayTab,
  order: Pick<OrderRowDto, "status" | "departure_date">,
  currentBusinessDate: string
): string {
  if (tab !== "DEPARTURES" || order.status !== "CHECKED_IN") return businessStatusLabel(order.status);
  if (order.departure_date < currentBusinessDate) return "未退";
  if (order.departure_date === currentBusinessDate) return "待退房";
  return businessStatusLabel(order.status);
}

export function todayArrivalActionAllowed(
  order: Pick<OrderRowDto, "status" | "stay_status" | "arrival_date">,
  browsingDate: string,
  businessDate: string
): boolean {
  return order.status === "RESERVED"
    && order.stay_status === "PLANNED"
    && order.arrival_date === browsingDate
    && browsingDate === businessDate;
}

export function todayLocationView(search: URLSearchParams, propertyId: string, fallbackDate: string): { date: string; tab: TodayTab } {
  const inProperty = !search.get("propertyId") || search.get("propertyId") === propertyId;
  const date = inProperty ? search.get("date") : null;
  const selectedTab = inProperty ? search.get("tab") : null;
  return {
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : fallbackDate,
    tab: tabs.find(item => item.id === selectedTab)?.id ?? "ARRIVALS"
  };
}

export function TodayPage() {
  const { meta, principal, propertyId } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const inProperty = !searchParams.get("propertyId") || searchParams.get("propertyId") === propertyId;
  const fundsQuery = inProperty ? searchParams.get("fundsQuery")?.slice(0, 200) ?? "" : "";
  const fundsCursor = inProperty ? searchParams.get("fundsCursor")?.slice(0, 1000) ?? "" : "";
  function updateFundsQuery(query: string, cursor = "") {
    const next = new URLSearchParams(searchParams);
    next.set("propertyId", propertyId); next.set("tab", "EXCEPTIONS"); next.set("date", browsingDate);
    if (query) next.set("fundsQuery", query); else next.delete("fundsQuery");
    if (cursor) next.set("fundsCursor", cursor); else next.delete("fundsCursor");
    setSearchParams(next);
  }
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const recoveryPendingAllowed = commandRecoveryAvailable(principal, propertyId, commandRecovery.pending?.commandType);
  const canCheckIn = principalCan(principal, propertyId, "CHECK_IN");
  const canCheckOut = principalCan(principal, propertyId, "CHECK_OUT");
  const propertyTimezone = meta.properties.find((property) => property.id === propertyId)?.timezone ?? "UTC";
  const [orders, setOrders] = useState<OrderRowDto[]>([]);
  const [defaultDate, setDefaultDate] = useState(() => localDateInTimeZone(propertyTimezone));
  const { date: browsingDate, tab } = todayLocationView(searchParams, propertyId, defaultDate);
  const hasExplicitDate = inProperty && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get("date") ?? "");
  function updateDateOrTab(date: string | null | undefined, nextTab = tab) {
    const next = inProperty ? new URLSearchParams(searchParams) : new URLSearchParams();
    next.set("propertyId", propertyId); next.set("tab", nextTab);
    if (date === null) next.delete("date"); else if (date !== undefined) next.set("date", date);
    setSearchParams(next);
  }
  const [currentBusinessDate, setCurrentBusinessDate] = useState(() => localDateInTimeZone(propertyTimezone));
  const previousPropertyId = useRef(propertyId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [command, setCommand] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();
  const commandsBlocked = commandRecovery.blocked && recoveryPendingAllowed;

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRecoveryError(undefined);
    setCommandNotice(undefined);
    const localDate = localDateInTimeZone(propertyTimezone);
    setCurrentBusinessDate(localDate);
    setDefaultDate(localDate);
  }, [propertyId, propertyTimezone]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (localDateInTimeZone(propertyTimezone) !== currentBusinessDate) {
        setRefreshToken((value) => value + 1);
      }
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [currentBusinessDate, propertyTimezone]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setOrders([]);
    setError(undefined);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(new Error("今日工作读取超时，请重试")), 12_000);
    api.orders(propertyId, undefined, { workDate: browsingDate, signal: controller.signal })
      .then((response) => {
        if (!current) return;
        setOrders(response.orders);
        setCurrentBusinessDate(response.businessDate);
        if (!hasExplicitDate) setDefaultDate(response.businessDate);
      })
      .catch((nextError) => current && setError(controller.signal.aborted ? controller.signal.reason : nextError))
      .finally(() => { window.clearTimeout(timeout); if (current) setLoading(false); });
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [propertyId, browsingDate, hasExplicitDate, refreshToken]);

  const buckets = useMemo<Record<TodayTab, OrderRowDto[]>>(
    () => buildTodayBuckets(orders, browsingDate, currentBusinessDate),
    [browsingDate, currentBusinessDate, orders]
  );

  function directCommand(order: OrderRowDto, commandType: CommandType, title: string) {
    if (!principalCan(principal, propertyId, commandType as CommandCapability)) return;
    if (commandsBlocked) return;
    setRecoveryDialogOpen(false);
    setCommand({
      commandType,
      title,
      presentation: "FULFILLMENT",
      description: commandType === "CHECK_IN"
        ? "核对后将住宿状态更新为在住；会员住宿会同时核销本次仍冻结的权益。"
        : "核对后将住宿状态更新为已退房并释放后续住宿库存；退房不会重复核销会员权益。",
      input: { propertyId, orderId: order.id }
    });
  }

  function openRecoveryDialog() {
    if (!commandRecovery.pending || !recoveryPendingAllowed) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  async function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    if (context || (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state))) {
      refreshAfterClose ||= commandRecovery.pending?.state === "EXECUTED";
      if (await commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复履约，写命令继续保持暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) setRefreshToken((value) => value + 1);
  }

  const visible = buckets[tab];
  const returnParams = new URLSearchParams({ propertyId, tab: "EXCEPTIONS", date: browsingDate });
  if (fundsQuery) returnParams.set("fundsQuery", fundsQuery);
  if (fundsCursor) returnParams.set("fundsCursor", fundsCursor);

  return (
    <div className="today-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">前台日常</p><h1>工作台</h1></div>
        <div className="today-date"><CalendarDays aria-hidden="true" size={17} /><label><span className="sr-only">营业日期</span><input type="date" value={browsingDate} onChange={(event) => { if (event.target.value) { updateDateOrTab(event.target.value); } }} /></label><button className="button button-secondary button-small" type="button" onClick={() => { setDefaultDate(currentBusinessDate); updateDateOrTab(null); }}>今天</button><button className="icon-button" type="button" onClick={() => setRefreshToken((value) => value + 1)} aria-label="刷新工作台" title="刷新"><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={18} /></button></div>
      </header>
      <InlineError error={recoveryError} title="恢复记录未收口" />
      {commandRecovery.canDiscardCorrupt
        ? <DamagedCommandRecoveryNotice error={commandRecovery.error} onDiscard={commandRecovery.discardCorruptAfterReview} testId="today-damaged-command-recovery" />
        : <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />}
      <QuoteRecoveryConflictNotice conflict={commandRecovery.conflict} testId="today-quote-recovery-conflict" />
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      {commandRecovery.pending && recoveryPendingAllowed ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="today-command-recovery" /> : null}
      {commandRecovery.pending && !recoveryPendingAllowed ? <section className="recovery-bar" role="status" data-testid="today-command-recovery-forbidden"><div><strong>原操作当前无权继续</strong><p>当前账号已没有该命令授权，恢复入口已隐藏；只读查看不受影响。</p></div></section> : null}
      <div className="today-tabs" role="tablist" aria-label="工作台分类">
          {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls="today-tabpanel" id={`tab-${item.id}`} onClick={() => updateDateOrTab(undefined, item.id)}><TodayTabLabel tab={item.id} /><strong>{loading || error ? "—" : buckets[item.id].length}{item.id === "EXCEPTIONS" ? " 住宿" : ""}</strong></button>)}
      </div>
      <InlineError context="read" error={error} title="无法载入工作台" />
      {error ? <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)}>重新载入工作台</button> : null}
      <section id="today-tabpanel" className="today-queue" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "EXCEPTIONS" ? <h2 className="workbench-section-heading">住宿异常</h2> : null}
        {loading ? <LoadingBlock label="正在载入待办事项" /> : error ? null : visible.length === 0 ? <TodayQueueEmpty tab={tab} /> : visible.map((order) => (
          <article className="queue-row" key={order.id}>
            <div className="queue-icon" aria-hidden="true">{tab === "EXCEPTIONS" ? <AlertTriangle size={19} /> : tab === "DEPARTURES" ? <LogOut size={19} /> : tab === "ARRIVALS" ? <LogIn size={19} /> : <DoorOpen size={19} />}</div>
            <div className="queue-primary">
              <strong>{guestName((order.current_primary_guest ?? order.primary_guest_snapshot))}</strong>
              <span>{formatDate(order.arrival_date)} 至 {formatDate(order.departure_date)}</span>
              {tab === "EXCEPTIONS" ? <TodayExceptionReason order={order} businessDate={currentBusinessDate} /> : null}
            </div>
            <StatusBadge value={order.status} label={todayQueueStatusLabel(tab, order, currentBusinessDate)} />
            <div className="queue-actions">
              {tab === "ARRIVALS" && canCheckIn && todayArrivalActionAllowed(order, browsingDate, currentBusinessDate) ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_IN", "办理入住")} disabled={commandsBlocked}><LogIn aria-hidden="true" size={17} />入住</button> : null}
              {tab === "ARRIVALS" && canCheckIn && !todayArrivalActionAllowed(order, browsingDate, currentBusinessDate) ? <span className="queue-action-hint">营业日当天可办理入住</span> : null}
              {tab === "DEPARTURES" && canCheckOut ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_OUT", "办理退房")} disabled={commandsBlocked}><LogOut aria-hidden="true" size={17} />退房</button> : null}
              {tab === "IN_HOUSE" && canCheckOut ? <Link className="button button-primary" to={`/orders/${encodeURIComponent(order.id)}?action=CHECK_OUT`}><LogOut aria-hidden="true" size={17} />退房</Link> : null}
              {tab === "EXCEPTIONS" ? <TodayExceptionAction order={order} businessDate={currentBusinessDate} /> : null}
              {tab === "EXCEPTIONS" && order.status === "RESERVED" && order.stay_status === "PLANNED" && order.arrival_date < currentBusinessDate
                ? <Link className="button button-secondary" to={`/orders/${encodeURIComponent(order.id)}`}>处理逾期到店<ChevronRight aria-hidden="true" size={17} /></Link>
                : null}
              <Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看${guestName((order.current_primary_guest ?? order.primary_guest_snapshot))}的订单`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link>
            </div>
          </article>
        ))}
      </section>
      {tab === "EXCEPTIONS" ? <WorkbenchFundsExceptions key={JSON.stringify([propertyId, fundsQuery, fundsCursor])}
        propertyId={propertyId} query={fundsQuery} cursor={fundsCursor} returnSearch={returnParams.toString()} refreshKey={refreshToken}
        onSearch={query => updateFundsQuery(query)} onNext={cursor => updateFundsQuery(fundsQuery, cursor)} onFirst={() => updateFundsQuery(fundsQuery)} /> : null}
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "new-today-command"}
        request={command}
        onClose={closeCommandDialog}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
        onCommitted={() => setRefreshToken((value) => value + 1)}
        onBusinessSuccess={(message) => setCommandNotice(message)}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
      /> : null}
    </div>
  );
}
