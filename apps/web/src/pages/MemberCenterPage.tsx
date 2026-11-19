import { useCallback, useEffect, useRef, useState } from "react";
import type { MemberCenterState, MemberNightUnit } from "@qintopia/contracts";
import "./member-center.css";

const root = "/api/wechat/member";
export async function memberRequest<T>(suffix = "", body?: object): Promise<T> {
  const reply = await fetch(root + suffix, { credentials: "same-origin", cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!reply.ok) throw new Error(reply.status === 403 ? "身份或绑定状态已变化，请重新打开我的权益。" : "暂时无法读取，请稍后再试。");
  return await reply.json() as T;
}
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

function Subscription({ subscribed, onChange }: { subscribed: boolean; onChange(): void }) {
  const host = useRef<HTMLDivElement>(null), [template, setTemplate] = useState(""), [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const target = host.current!;
    async function mount() {
      const { template: id, ...signature } = await memberRequest<{ template: string; appId: string; timestamp: number; nonceStr: string; signature: string }>("/subscription");
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
          try { await memberRequest("/subscription", { enabled: true, template: id }); if (active) { setMessage("已记录本次接收授权。"); onChange(); } }
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
  }, [onChange]);
  return <section><h2>微信到期提醒</h2><p>到期前 60 天和 30 天各提醒一次。一次微信授权可接收一条。</p><div ref={host} />
    {subscribed && template && <button onClick={async () => { try { await memberRequest("/subscription", { enabled: false, template }); setMessage("已关闭微信提醒。"); onChange(); } catch (e) { setMessage(errorText(e)); } }}>关闭提醒</button>}
    {message && <p role="status">{message}</p>}</section>;
}

export default function MemberCenterPage() {
  const [state, setState] = useState<MemberCenterState>(), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<{ code: string; expiresAt: string }>(), [confirmUnlink, setConfirmUnlink] = useState(false);
  const readGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
      const data = await memberRequest<MemberCenterState>();
      if (generation !== readGeneration.current) return;
      setState(data); setMessage("");
      if (data.status !== "UNBOUND") setPair(undefined);
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
    {state?.status === "UNBOUND" && <section><h2>绑定我的会员档案</h2><p>生成绑定码并向前台出示。异地办理可请前台回拨会员档案预留手机号核实本人。</p>
      {pair && <p role="status"><strong className="member-pair-code">{pair.code}</strong><br />有效至 {new Date(pair.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</p>}
      <button className="member-primary" disabled={busy} onClick={() => void act(async () => setPair(await memberRequest("/pair", {})))}>{pair ? "重新生成绑定码" : "同意绑定并生成绑定码"}</button>
      <button onClick={() => void refresh()}>已完成核验</button></section>}
    {bound && <>
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
      {bound.remindersEnabled && <Subscription subscribed={bound.subscribed} onChange={refresh} />}
      {confirmUnlink ? <section><p>解除后，当前微信将停止查询和接收提醒。</p><button onClick={() => setConfirmUnlink(false)}>保留绑定</button>
        <button disabled={busy} onClick={() => void act(async () => { await memberRequest("/unlink", {}); setPair(undefined); setConfirmUnlink(false); await refresh(); })}>确认解除</button></section>
        : <button onClick={() => setConfirmUnlink(true)}>解除微信绑定</button>}</>}
  </main>;
}
