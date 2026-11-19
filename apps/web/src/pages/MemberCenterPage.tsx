import { useCallback, useEffect, useRef, useState } from "react";
import { mainlandMemberPhone, type MemberCenterState, type MemberNightUnit } from "@qintopia/contracts";
import "./member-center.css";

import { memberRequest, root } from "./member-request";
import { bookingAnchor, MemberBookingPanel } from "./MemberBookings";
const unitName = (unit: MemberNightUnit) => unit === "ROOM_NIGHT" ? "间夜" : "床夜";
const statusNames = { ACTIVE: "生效中", PENDING: "待生效", EXPIRED: "已到期", VOIDED: "已作废", CANCELLED: "已取消" };
const wxBrowser = () => /MicroMessenger/i.test(navigator.userAgent);
const errorText = (error: unknown) => error instanceof Error ? error.message : "请稍后再试。";

type WxSdk = { config(opts: object): void; ready(cb: () => void): void; error(cb: () => void): void };
type WxWindow = Window & { wx?: WxSdk };
let loadingSdk: Promise<WxSdk> | undefined;
function loadSdk(): Promise<WxSdk> {
  const wx = (window as WxWindow).wx;
  if (wx) return Promise.resolve(wx);
  if (!loadingSdk) loadingSdk = new Promise<WxSdk>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
    tag.onload = () => { const loaded = (window as WxWindow).wx; if (loaded) resolve(loaded); else reject(new Error("微信订阅组件暂不可用。")); };
    tag.onerror = () => { tag.remove(); reject(new Error("微信订阅组件暂不可用。")); };
    document.head.appendChild(tag);
  }).catch(error => { loadingSdk = undefined; throw error; });
  return loadingSdk;
}

export function acceptedSubscription(detail: { errMsg?: string; subscribeDetails?: string } | undefined, template: string): boolean {
  if (detail?.errMsg !== "subscribe:ok" || !detail.subscribeDetails) return false;
  try {
    const value: unknown = JSON.parse(detail.subscribeDetails)[template];
    if (value === "accept") return true;
    return typeof value === "string" ? JSON.parse(value)?.status === "accept" : (value as {status?: string} | null)?.status === "accept";
  } catch { return false; }
}

function Subscription({ subscribed, onChange, kind, days }: { subscribed: boolean; onChange(): void; kind:"expiry"|"booking"; days?:number[] }) {
  const host = useRef<HTMLDivElement>(null), [template, setTemplate] = useState(""), [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const target = host.current!;
    async function mount() {
      const { template: id, ...signature } = await memberRequest<{ template: string; appId: string; timestamp: number; nonceStr: string; signature: string }>("/subscription?kind="+kind);
      if (!active) return;
      setTemplate(id);
      const wx = await loadSdk();
      if (!active) return;
      wx.ready(() => {
        if (!active) return;
        const button = document.createElement("wx-open-subscribe");
        button.setAttribute("template", id);
        const content = document.createElement("script");
        content.type = "text/wxtag-template";
        content.setAttribute("slot", "default");
        content.textContent = '<button style="height:42px;padding:0 20px;border:0;border-radius:8px;background:#195744;color:#fff;font-size:16px">授权一次微信提醒</button>';
        button.appendChild(content);
        button.addEventListener("success", async event => {
          if (!acceptedSubscription((event as CustomEvent).detail, id)) { setMessage("本次没有新增接收授权。"); return; }
          try { await memberRequest("/subscription", { enabled: true, template: id, kind }); if (active) { setMessage("已记录本次接收授权。"); onChange(); } }
          catch (e) { if (active) setMessage(errorText(e)); }
        });
        button.addEventListener("error", () => setMessage("微信未完成授权，请在微信中重新打开。"));
        target.replaceChildren(button);
      });
      wx.error(() => { if (active) setMessage("微信订阅暂不可用，权益和到期日可以正常查看。"); });
      wx.config({ ...signature, jsApiList: [], openTagList: ["wx-open-subscribe"] });
    }
    void mount().catch(e => { if (active) setMessage(errorText(e)); });
    return () => { active = false; target.replaceChildren(); };
  }, [onChange,kind]);
  return <section><h2>{kind==="expiry"?"微信到期提醒":"预订结果通知"}</h2><p>{kind==="expiry"?"按门店规则，到期提前天数为 "+days?.join("、")+" 天。":"同意接收门店的排房结果。"}一次微信授权可接收一条。</p><div ref={host} />
    {subscribed && template && <button onClick={async () => { try { await memberRequest("/subscription", { enabled: false, template, kind }); setMessage("已关闭微信提醒。"); onChange(); } catch (e) { setMessage(errorText(e)); } }}>关闭提醒</button>}
    {message && <p role="status">{message}</p>}</section>;
}

function PhoneBinding({ onBound }: { onBound(): Promise<void> }) {
  const [phone, setPhone] = useState(""), [code, setCode] = useState("");
  const [pending, setPending] = useState<"send" | "verify">(), [message, setMessage] = useState("");
  const [retryAt, setRetryAt] = useState(0), [seconds, setSeconds] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);
  const number = mainlandMemberPhone(phone);
  useEffect(() => {
    if (!retryAt) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSeconds(left);
      if (!left) setRetryAt(0);
    };
    tick();
    const interval = window.setInterval(tick, 500);
    return () => window.clearInterval(interval);
  }, [retryAt]);
  async function sendCode() {
    if (!number || pending || seconds) return;
    setPending("send"); setMessage("");
    try {
      const { retryAfterSeconds } = await memberRequest<{ retryAfterSeconds: number }>("/sms/request", { phone: number });
      setCode(""); setSeconds(retryAfterSeconds); setRetryAt(Date.now() + retryAfterSeconds * 1000);
      setMessage("如果号码与本店会员档案匹配，你将收到短信。验证码 5 分钟内有效。");
      codeInput.current?.focus();
    } catch (error) { setMessage(errorText(error)); }
    finally { setPending(undefined); }
  }
  async function bind() {
    if (!number || !/^\d{6}$/.test(code) || pending) return;
    setPending("verify"); setMessage("");
    try { await memberRequest("/sms/verify", { phone: number, code }); await onBound(); }
    catch (error) { setMessage(errorText(error)); }
    finally { setPending(undefined); }
  }
  return <section><h2>绑定我的会员档案</h2><p>首次使用，请验证办卡时预留的中国大陆手机号。绑定后，用这个微信即可查看住宿权益。</p>
    <form className="member-sms" onSubmit={event => { event.preventDefault(); void bind(); }}>
      <label htmlFor="member-phone">预留手机号</label>
      <input id="member-phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={32} value={phone}
        readOnly={Boolean(pending)} onChange={e => { setPhone(e.target.value); setCode(""); setMessage(""); }} />
      <label htmlFor="member-code">短信验证码</label>
      <div className="member-sms-code"><input ref={codeInput} id="member-code" type="text" inputMode="numeric" autoComplete="one-time-code"
        maxLength={6} placeholder="6 位数字" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} />
        <button type="button" disabled={!number || Boolean(pending) || seconds > 0} onClick={() => void sendCode()}>
          {pending === "send" ? "正在请求…" : seconds ? seconds + " 秒后重发" : "获取验证码"}</button></div>
      {message && <p role="status">{message}</p>}
      <button className="member-primary" type="submit" disabled={!number || code.length !== 6 || Boolean(pending)}>
        {pending === "verify" ? "正在绑定…" : "同意绑定并查看权益"}</button>
    </form><p className="member-sms-help">原号码已停用，可联系门店核实并更正会员档案。</p></section>;
}

export default function MemberCenterPage() {
  const [state, setState] = useState<MemberCenterState>(), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [focusId,setFocusId]=useState(bookingAnchor);
  const [panel,setPanel]=useState<"rights"|"form"|"list">(()=>bookingAnchor()?"list":"rights");
  function openPanel(value:"rights"|"form"|"list") {
    sessionStorage.removeItem("member-booking-link");history.replaceState(null,"",location.pathname);setFocusId("");setPanel(value);
  }
  const readGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
      const data = await memberRequest<MemberCenterState>();
      if (generation !== readGeneration.current) return;
      setState(data); setMessage("");
      if (data.status === "SIGNED_OUT" && wxBrowser() && location.hash !== "#auth-failed") location.replace(root + "/login");
    } catch(e) { if (generation === readGeneration.current) { setState(undefined); setMessage(errorText(e)); } }
  }, []);
  useEffect(() => { document.title = "我的住宿权益 · 秦托邦"; void refresh(); }, [refresh]);
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => { if (e.persisted) { setState(undefined); void refresh(); } };
    const resumed = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("pageshow", shown);
    document.addEventListener("visibilitychange", resumed);
    return () => {
      window.removeEventListener("pageshow", shown);
      document.removeEventListener("visibilitychange", resumed);
    };
  }, [refresh]);
  async function act(job: () => Promise<void>) {
    setBusy(true); setMessage(""); try { await job(); } catch(e) { setMessage(errorText(e)); } finally { setBusy(false); }
  }
  const bound = state?.status === "BOUND" ? state : undefined;
  return <main className="member-center"><header><span>秦托邦</span><h1>我的住宿权益</h1></header>
    {!state && !message && <p role="status">正在读取权益…</p>}
    {message && <p role="alert">{message} <button onClick={() => void refresh()}>重新读取</button></p>}
    {state?.status === "DISABLED" && <p>本服务号尚未开通会员权益查询。</p>}
    {state?.status === "SIGNED_OUT" && <section><h2>验证微信身份</h2><p>请从秦托邦服务号打开「我的权益」。</p>{wxBrowser() && <a href={root + "/login"}>用当前微信继续</a>}</section>}
    {state?.status === "UNBOUND" && (state.smsAvailable ? <PhoneBinding onBound={refresh} />
      : <section><h2>绑定我的会员档案</h2><p>本店尚未开通短信验证，请稍后再来。</p></section>)}
    {bound && <><nav className="member-tabs" aria-label="会员服务">
      <button aria-pressed={panel==="rights"} onClick={()=>openPanel("rights")}>我的权益</button>
      <button aria-pressed={panel==="form"} onClick={()=>openPanel("form")}>预订住宿</button>
      <button aria-pressed={panel==="list"} onClick={()=>openPanel("list")}>我的预订</button></nav>
      {panel!=="rights"&&<><MemberBookingPanel key={panel+focusId} form={panel==="form"} focusId={focusId} onSubmitted={id=>{setFocusId(id);setPanel("list");history.replaceState(null,"","#booking="+id);}}/>
        {bound.bookingNoticeEnabled&&<Subscription kind="booking" subscribed={bound.bookingSubscribed} onChange={refresh}/>}</>}
      {panel==="rights"&&<>
      {bound.view.cards.length === 0 && <p>当前没有已办理的住宿权益。</p>}
      {bound.view.cards.map((card, index) => (
        <section className="member-card" key={index}>
          <div className="member-card-head"><h2>{card.product}</h2><span>{statusNames[card.status]}</span></div>
          <p className="member-rooms">{card.rooms.join("、")}</p>
          <div className="member-nights">
            <div><span>当前可订</span><strong>{card.available ?? "—"}</strong> {unitName(card.unit)}</div>
            <div><span>已预留</span><strong>{card.held}</strong> {unitName(card.unit)}</div>
          </div>
          {card.expiresOn && <dl className="member-dates">
            <div><dt>有效期</dt><dd>{card.startsOn} 至 {card.expiresOn}（含当天）</dd></div>
            {card.reminderDates.length > 0 && <div><dt>到期提醒日</dt><dd>{card.reminderDates.join("、")}</dd></div>}
          </dl>}
        </section>
      ))}
      <section><h2>权益使用明细</h2>
        {bound.view.history.length ? <ol>{bound.view.history.map((row, index) => (
          <li key={index}>
            <div><strong>{row.action}</strong><span>{row.quantity} {unitName(row.unit)}</span></div>
            <small>{row.product} · {row.serviceDate ?? row.recordedOn}</small>
          </li>
        ))}</ol> : <p>暂无权益使用记录。</p>}
        {bound.view.next && <button disabled={busy} onClick={() => void act(async () => {
          const generation = readGeneration.current;
          const next = await memberRequest<MemberCenterState>("?cursor=" + encodeURIComponent(bound.view.next!));
          if (generation !== readGeneration.current) return;
          if (next.status !== "BOUND") { setState(next); return; }
          setState({ ...next, view: { ...next.view, history: [...bound.view.history, ...next.view.history] } });
        })}>查看更多明细</button>}</section>
      {bound.remindersEnabled && <Subscription kind="expiry" days={bound.leadDays} subscribed={bound.subscribed} onChange={refresh} />}
      {confirmUnlink ? <section><p>解除后，当前微信将停止查询和接收提醒。</p><button onClick={() => setConfirmUnlink(false)}>保留绑定</button>
        <button disabled={busy} onClick={() => void act(async () => { await memberRequest("/unlink", {}); setConfirmUnlink(false); await refresh(); })}>确认解除</button></section>
        : <button onClick={() => setConfirmUnlink(true)}>解除微信绑定</button>}</>}</>}
  </main>;
}
