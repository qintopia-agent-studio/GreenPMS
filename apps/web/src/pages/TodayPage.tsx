import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, ChevronRight, DoorOpen, LogIn, LogOut, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import type { CommandType } from "@qintopia/contracts";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { CommandRequest, OrderRowDto } from "../types";
import { localDateInTimeZone } from "../dates";
import {
  CommandDialog,
  type CommandDialogCloseContext,
  CommandResultNotice,
  CommandRecoveryBar,
  businessStatusLabel,
  EmptyState,
  formatDate,
  guestName,
  InlineError,
  isTerminalCommandRecovery,
  LoadingBlock,
  recoveryCommandRequest,
  StatusBadge,
  usePersistentCommandRecovery
} from "../ui";

type TodayTab = "ARRIVALS" | "IN_HOUSE" | "DEPARTURES" | "EXCEPTIONS";

const tabs: Array<{ id: TodayTab; label: string }> = [
  { id: "ARRIVALS", label: "今日到店" },
  { id: "IN_HOUSE", label: "在住" },
  { id: "DEPARTURES", label: "今日离店" },
  { id: "EXCEPTIONS", label: "异常" }
];

export function TodayPage() {
  const { meta, principal, propertyId } = useWorkspace();
  const commandRecovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  const propertyTimezone = meta.properties.find((property) => property.id === propertyId)?.timezone ?? "UTC";
  const [orders, setOrders] = useState<OrderRowDto[]>([]);
  const [businessDate, setBusinessDate] = useState(() => localDateInTimeZone(propertyTimezone));
  const dateEdited = useRef(false);
  const previousPropertyId = useRef(propertyId);
  const [tab, setTab] = useState<TodayTab>("ARRIVALS");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [recoveryError, setRecoveryError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [command, setCommand] = useState<CommandRequest>();
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();
  const commandsBlocked = commandRecovery.blocked;

  useEffect(() => {
    if (previousPropertyId.current === propertyId) return;
    previousPropertyId.current = propertyId;
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    setRecoveryError(undefined);
    setCommandNotice(undefined);
    if (!dateEdited.current) setBusinessDate(localDateInTimeZone(propertyTimezone));
  }, [propertyId, propertyTimezone]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(undefined);
    api.orders(propertyId)
      .then((response) => current && setOrders(response.orders))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [propertyId, refreshToken]);

  const buckets = useMemo<Record<TodayTab, OrderRowDto[]>>(() => ({
    ARRIVALS: orders.filter((order) => order.arrival_date === businessDate && order.status === "RESERVED"),
    IN_HOUSE: orders.filter((order) => order.status === "CHECKED_IN"),
    DEPARTURES: orders.filter((order) => order.departure_date === businessDate && order.status === "CHECKED_IN"),
    EXCEPTIONS: orders.filter((order) => ["NO_SHOW", "CANCELLED"].includes(order.status) || (order.departure_date < businessDate && !["CHECKED_OUT", "CANCELLED", "NO_SHOW"].includes(order.status)))
  }), [businessDate, orders]);

  function directCommand(order: OrderRowDto, commandType: CommandType, title: string) {
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
    if (!commandRecovery.pending) return;
    setRecoveryDialogOpen(true);
    setCommand(recoveryCommandRequest(commandRecovery.pending));
  }

  function closeCommandDialog(context?: CommandDialogCloseContext) {
    let refreshAfterClose = context?.receipt.businessCommitted === true;
    if (context || (commandRecovery.pending && isTerminalCommandRecovery(commandRecovery.pending.state))) {
      refreshAfterClose ||= commandRecovery.pending?.state === "EXECUTED";
      if (commandRecovery.clearResolved()) setRecoveryError(undefined);
      else setRecoveryError(new Error("无法清除已收口的本地恢复记录；为避免重复履约，写命令继续保持暂停"));
    }
    setCommand(undefined);
    setRecoveryDialogOpen(false);
    if (refreshAfterClose) setRefreshToken((value) => value + 1);
  }

  const visible = buckets[tab];

  return (
    <div className="today-page">
      <header className="page-heading page-heading-actions">
        <div><p className="eyebrow">前台日常</p><h1>今日履约</h1><p>{formatDate(businessDate)}</p></div>
        <div className="today-date"><CalendarDays aria-hidden="true" size={17} /><label><span className="sr-only">营业日期</span><input type="date" value={businessDate} onChange={(event) => { dateEdited.current = true; setBusinessDate(event.target.value); }} /></label><button className="icon-button" type="button" onClick={() => setRefreshToken((value) => value + 1)} aria-label="刷新今日履约" title="刷新"><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" size={18} /></button></div>
      </header>
      <InlineError error={recoveryError} title="恢复记录未收口" />
      <InlineError error={commandRecovery.error} title="本地命令恢复记录不可用" />
      <CommandResultNotice message={commandNotice} onDismiss={() => setCommandNotice(undefined)} />
      {commandRecovery.pending ? <CommandRecoveryBar recovery={commandRecovery.pending} onOpen={openRecoveryDialog} testId="today-command-recovery" /> : null}
      <div className="today-tabs" role="tablist" aria-label="今日履约分类">
        {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls="today-tabpanel" id={`tab-${item.id}`} onClick={() => setTab(item.id)}><span>{item.label}</span><strong>{buckets[item.id].length}</strong></button>)}
      </div>
      <InlineError error={error} title="无法载入今日履约" />
      <section id="today-tabpanel" className="today-queue" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {loading ? <LoadingBlock label="正在载入履约队列" /> : visible.length === 0 ? <EmptyState title="当前队列为空" detail="该营业日期没有匹配的订单。" /> : visible.map((order) => (
          <article className="queue-row" key={order.id}>
            <div className="queue-icon" aria-hidden="true">{tab === "EXCEPTIONS" ? <AlertTriangle size={19} /> : tab === "DEPARTURES" ? <LogOut size={19} /> : tab === "ARRIVALS" ? <LogIn size={19} /> : <DoorOpen size={19} />}</div>
            <div className="queue-primary"><strong>{guestName(order.primary_guest_snapshot)}</strong><code>{order.id}</code><span>{formatDate(order.arrival_date)} 至 {formatDate(order.departure_date)}</span></div>
            <StatusBadge value={order.status} label={businessStatusLabel(order.status)} />
            <div className="queue-actions">
              {tab === "ARRIVALS" ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_IN", "办理入住")} disabled={commandsBlocked}><LogIn aria-hidden="true" size={17} />入住</button> : null}
              {tab === "DEPARTURES" ? <button className="button button-primary" type="button" onClick={() => directCommand(order, "CHECK_OUT", "办理退房")} disabled={commandsBlocked}><LogOut aria-hidden="true" size={17} />退房</button> : null}
              {tab === "IN_HOUSE" ? <Link className="button button-primary" to={`/orders/${encodeURIComponent(order.id)}?action=CHECK_OUT`}><LogOut aria-hidden="true" size={17} />退房</Link> : null}
              <Link className="icon-button" to={`/orders/${encodeURIComponent(order.id)}`} aria-label={`查看订单 ${order.id}`} title="查看订单"><ChevronRight aria-hidden="true" size={19} /></Link>
            </div>
          </article>
        ))}
      </section>
      {command ? <CommandDialog
        key={recoveryDialogOpen ? `recovery-${commandRecovery.pending?.confirmationKey ?? "missing"}` : "new-today-command"}
        request={command}
        onClose={closeCommandDialog}
        {...(recoveryDialogOpen && commandRecovery.pending ? {
          initialConfirmationKey: commandRecovery.pending.confirmationKey
        } : {})}
        onProgress={(progress) => commandRecovery.track(command, progress)}
        onCommitted={async () => {
          const response = await api.orders(propertyId);
          setOrders(response.orders);
        }}
        onBusinessSuccess={(message) => setCommandNotice(message)}
        onBusinessNotExecuted={(message) => setCommandNotice(message)}
      /> : null}
    </div>
  );
}
