import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  noticeFieldExample,
  noticeFieldNames,
  renderNoticeFields,
  validNoticeTemplate,
  type MemberNoticeField,
  type MemberNoticeTemplate,
  type MemberSettingsView
} from "@qintopia/contracts";
import { memberOps } from "../api";
import { useWorkspace } from "../session";
import "./wechat-operations.css";

type Kind = "expiry" | "booking";
const fields: Record<Kind, MemberNoticeField[]> = {
  expiry: ["product", "expiry", "days"],
  booking: ["status", "room", "arrival", "departure", "reference"]
};
const examples = {
  product: "thing1",
  expiry: "date2",
  days: "number3",
  status: "phrase1",
  room: "thing2",
  arrival: "date3",
  departure: "date4",
  reference: "character_string5"
};
interface DraftTemplate {
  id: string;
  keys: Partial<Record<MemberNoticeField, string>>;
}
function draft(template: MemberNoticeTemplate | null): DraftTemplate {
  return {
    id: template?.template ?? "",
    keys: Object.fromEntries(Object.entries(template?.fields ?? {}).map(([k, v]) => [v, k]))
  };
}
function configured(t: DraftTemplate, kind: Kind): MemberNoticeTemplate | null {
  if (!t.id.trim()) {
    if (Object.values(t.keys).some((k) => k?.trim())) throw new Error("已填写模板字段，请补充模板 ID 或清空该组字段。");
    return null;
  }
  const entries = fields[kind].filter((f) => t.keys[f]?.trim()).map((f) => [t.keys[f]!.trim(), f] as const);
  const setting = { template: t.id.trim(), fields: Object.fromEntries(entries) };
  if (new Set(entries.map(([key]) => key)).size !== entries.length || !validNoticeTemplate(setting, kind))
    throw new Error(
      kind === "expiry" ? "请核对到期模板的字段名，并填写到期日字段。" : "请核对预订模板的字段名，并填写排房结果字段。"
    );
  return setting;
}
function TemplateEditor({
  kind,
  value,
  change
}: {
  kind: Kind;
  value: DraftTemplate;
  change: (t: DraftTemplate) => void;
}) {
  const [sampleStatus, setSampleStatus] = useState("已确认");
  let preview: Record<string, { value: string }> = {};
  try {
    const template = configured(value, kind);
    if (template) preview = renderNoticeFields(template, { ...noticeFieldExample, status: sampleStatus });
  } catch {
    /* incomplete draft */
  }
  return (
    <>
      <p>模板标题与字段来自微信公众平台，请按审核通过的字段名对应下方内容。</p>
      <label>
        微信模板 ID
        <input value={value.id} maxLength={160} onChange={(e) => change({ ...value, id: e.target.value })} />
      </label>
      <div className="wx-fields">
        {fields[kind].map((f) => (
          <label key={f}>
            {noticeFieldNames[f]}字段
            <input
              placeholder={examples[f]}
              value={value.keys[f] ?? ""}
              maxLength={32}
              onChange={(e) => change({ ...value, keys: { ...value.keys, [f]: e.target.value } })}
            />
          </label>
        ))}
      </div>
      <details open={Boolean(Object.keys(preview).length)}>
        <summary>会员通知预览</summary>
        {kind === "booking" && Object.keys(preview).length > 0 && (
          <label>
            预览排房结果
            <select value={sampleStatus} onChange={(e) => setSampleStatus(e.target.value)}>
              <option>已确认</option>
              <option>无法安排</option>
            </select>
          </label>
        )}
        {Object.keys(preview).length ? (
          <dl>
            {Object.entries(preview).map(([k, v]) => (
              <div key={k}>
                <dt>{noticeFieldNames[fields[kind].find((f) => value.keys[f]?.trim() === k)!]}</dt>
                <dd>{v.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>填入公众平台已选模板的 ID 和对应字段后，可查看示例。</p>
        )}
      </details>
    </>
  );
}
export default function WechatNotificationSettings() {
  const { propertyId } = useWorkspace();
  return <Editor key={propertyId} property={propertyId} />;
}
function Editor({ property }: { property: string }) {
  const [view, setView] = useState<MemberSettingsView>(),
    [rules, setRules] = useState<MemberSettingsView["rules"]>();
  const [expiry, setExpiry] = useState<DraftTemplate>(draft(null)),
    [booking, setBooking] = useState<DraftTemplate>(draft(null));
  const [days, setDays] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  function populate(v: MemberSettingsView) {
    setView(v);
    setRules(v.rules);
    setDays(v.rules.leadDays.join("、"));
    setExpiry(draft(v.rules.expiry));
    setBooking(draft(v.rules.booking));
  }
  useEffect(() => {
    let active = true;
    setError("");
    setView(undefined);
    memberOps<MemberSettingsView>(property, "notifications")
      .then((v) => {
        if (active) populate(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [property, reload]);
  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!view || !rules || busy) return;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const parts = days.trim().split(/[、，,\s]+/);
      const leadDays = parts.map(Number);
      if (
        parts.some((p) => !/^\d{1,4}$/.test(p)) ||
        leadDays.some((d) => d > 3650) ||
        new Set(leadDays).size !== parts.length
      )
        throw new Error("提醒天数请填写 0 至 3650 的整数，可用顿号分隔，每个天数只填一次。");
      const updated = await memberOps<MemberSettingsView>(property, "notifications", {
        version: view.version,
        rules: { ...rules, leadDays, expiry: configured(expiry, "expiry"), booking: configured(booking, "booking") }
      });
      populate(updated);
      setMessage("设置已发布。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "发布失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wx-operations">
      <header>
        <h1>会员通知</h1>
        <p>管理会员通过秦托邦服务号收到的通知，以及首次绑定使用的验证码。</p>
      </header>
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="button" onClick={() => setReload((n) => n + 1)}>
            重新读取设置
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!view && !error && <p>正在读取门店设置…</p>}
      {view && rules && (
        <form onSubmit={publish}>
          <section className="wx-card">
            <h2>服务号入口</h2>
            <p>
              {view.entry
                ? "在公众平台的自定义菜单中添加「会员中心」，选择跳转网页，填写下方地址。"
                : "当前门店等待接入服务号。完成服务端配置后，这里会显示会员入口地址。"}
            </p>
            {view.entry && <code>{view.entry}</code>}
            <p>
              腾讯云短信接口{view.smsReady ? "已配置" : "待配置"} ·{" "}
              {view.version ? "版本 " + view.version + "，由 " + view.updatedBy + " 发布" : "使用初始设置"}
            </p>
          </section>
          <section className="wx-card">
            <h2>权益到期提醒</h2>
            <label className="wx-switch">
              <input
                type="checkbox"
                checked={rules.expiryEnabled}
                onChange={(e) => setRules({ ...rules, expiryEnabled: e.target.checked })}
              />
              启用到期提醒
            </label>
            <label>
              到期前提醒天数
              <input value={days} onChange={(e) => setDays(e.target.value)} required />
            </label>
            <TemplateEditor kind="expiry" value={expiry} change={setExpiry} />
          </section>
          <section className="wx-card">
            <h2>住宿预订结果</h2>
            <label className="wx-switch">
              <input
                type="checkbox"
                checked={rules.bookingEnabled}
                onChange={(e) => setRules({ ...rules, bookingEnabled: e.target.checked })}
              />
              排房确认或未能安排时通知会员
            </label>
            <TemplateEditor kind="booking" value={booking} change={setBooking} />
          </section>
          <section className="wx-card">
            <h2>首次绑定短信</h2>
            <label className="wx-switch">
              <input
                type="checkbox"
                checked={rules.smsEnabled}
                onChange={(e) => setRules({ ...rules, smsEnabled: e.target.checked })}
              />
              允许会员用登记手机号验证绑定
            </label>
            <div className="wx-fields">
              <label>
                腾讯云审核通过的签名
                <input
                  value={rules.smsSign}
                  maxLength={64}
                  onChange={(e) => setRules({ ...rules, smsSign: e.target.value })}
                />
              </label>
              <label>
                验证码模板 ID
                <input
                  value={rules.smsTemplate}
                  inputMode="numeric"
                  maxLength={30}
                  onChange={(e) => setRules({ ...rules, smsTemplate: e.target.value })}
                />
              </label>
            </div>
            <p>短信正文取自腾讯云审核模板，传入一个验证码。交互记录仅显示脱敏占位符。</p>
          </section>
          <button className="button button-primary" disabled={busy}>
            {busy ? "正在发布…" : "发布设置"}
          </button>{" "}
          <Link to="/members/bookings?tab=history">查看交互记录</Link>
        </form>
      )}
    </section>
  );
}
