import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, RefreshCw, Save, PlugZap } from "lucide-react";
import { api } from "../api";
import { useWorkspace } from "../session";
import { errorMessage, LoadingBlock, Modal } from "../uiBasic";
import { SettingsHint as InfoHint } from "../components/SettingsHint";
import { useAssistant } from "./context";
import type { AssistantProviderRole, AssistantSettings } from "../../../../packages/contracts/src/assistant.ts";
import { canEnableAssistant, canEnableProvider, canPromoteProvider, connectionChanged, providerDirty, providerDraft, providerPayload, providerSettings, providerTitles, type ProviderDraft } from "./provider-settings";

const roles: AssistantProviderRole[] = ["primary", "backup"];
const emptyDrafts = (): Record<AssistantProviderRole, ProviderDraft> => ({
  primary: { name: providerTitles.primary, enabled: false, baseUrl: "", model: "", apiKey: "" },
  backup: { name: providerTitles.backup, enabled: false, baseUrl: "", model: "", apiKey: "" }
});
const localTime = (value: string) => new Date(value).toLocaleString("zh-CN");

export function AssistantSettingsPage() {
  const { propertyId } = useWorkspace();
  return <ScopedAssistantSettings key={propertyId} propertyId={propertyId} />;
}
function ScopedAssistantSettings({ propertyId }: { propertyId: string }) {
  const assistant = useAssistant();
  const [saved, setSaved] = useState<AssistantSettings>(), [drafts, setDrafts] = useState(emptyDrafts);
  const [busy, setBusy] = useState(""), [error, setError] = useState<string>(), [notice, setNotice] = useState("");
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const mounted = useRef(true), operation = useRef(false), loadGeneration = useRef(0);
  function accept(value: AssistantSettings, replace: AssistantProviderRole | "all" | "none" = "all") {
    setSaved(value);
    setDrafts(previous => Object.fromEntries(roles.map(role => [role, replace === "all" || replace === role
      ? providerDraft(providerSettings(value, role)) : { ...previous[role], testToken: undefined }])) as Record<AssistantProviderRole, ProviderDraft>);
  }
  const load = async () => {
    if (operation.current) return;
    const ticket = ++loadGeneration.current;
    setBusy("load"); setError(undefined); setNotice("");
    try { const value = await api.assistantSettings(propertyId); if (mounted.current && ticket === loadGeneration.current) accept(value); }
    catch (e) { if (mounted.current && ticket === loadGeneration.current) setError(errorMessage(e)); }
    finally { if (mounted.current && ticket === loadGeneration.current) setBusy(""); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadGeneration.current++; }; }, [propertyId]);
  async function perform(label: string, work: () => Promise<void>) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(label); setError(undefined); setNotice("");
    try { await work(); } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { operation.current = false; if (mounted.current) setBusy(""); }
  }
  function update(role: AssistantProviderRole, key: keyof ProviderDraft, value: string | boolean) {
    setDrafts(previous => ({ ...previous, [role]: { ...previous[role], [key]: value,
      ...(["baseUrl", "model", "apiKey"].includes(key) ? { testToken: undefined } : {}) } }));
    setNotice("");
  }
  const testProvider = (role: AssistantProviderRole) => perform(`test-${role}`, async () => {
    if (!saved) return;
    const result = await api.assistantTest(providerPayload(propertyId, saved, role, drafts[role]));
    if (!mounted.current) return;
    setDrafts(previous => ({ ...previous, [role]: { ...previous[role], testToken: result.testToken } }));
    setNotice(`${providerTitles[role]}：${result.message} 请保存配置以记录本次测试。`);
  });
  const saveProvider = (role: AssistantProviderRole) => perform(`save-${role}`, async () => {
    if (!saved) return;
    const result = await api.assistantSave(providerPayload(propertyId, saved, role, drafts[role]));
    if (!mounted.current) return;
    accept(result, role); assistant?.refreshSettings();
    setNotice(`${providerTitles[role]}已保存。原配置下的对话已失效，请新建对话。`);
  });
  const toggleAssistant = () => perform("enable", async () => {
    if (!saved) return;
    const body = providerPayload(propertyId, saved, "primary", providerDraft(providerSettings(saved, "primary")));
    const result = await api.assistantSave({ ...body, enabled: !saved.enabled });
    if (!mounted.current) return;
    accept(result, "none"); assistant?.refreshSettings();
    setNotice(result.enabled ? "AI 助手已启用，请新建对话。" : "AI 助手已停用，正在生成的回答已停止。");
  });
  const promote = () => perform("promote", async () => {
    if (!saved) return;
    const result = await api.assistantPromoteBackup({ propertyId, expectedVersion: saved.version });
    if (!mounted.current) return;
    accept(result); assistant?.refreshSettings();
    setNotice("主备优先级已互换，双方启用状态和已有对话保持不变。正在生成的回答继续完成，后续问题优先使用新的主供应商。");
  });
  const recover = () => perform("recover", async () => {
    if (!saved) return;
    const result = await api.assistantRecoverPrimary({ propertyId, expectedVersion: saved.version });
    if (!mounted.current) return;
    // A recovery check updates runtime health, not the saved connection or its test receipts.
    setSaved(result.settings); assistant?.refreshSettings(); setNotice(result.message);
  });
  const dirty = saved && roles.some(role => providerDirty(drafts[role], providerSettings(saved, role)));
  const hasUnsavedChanges = Boolean(dirty || roles.some(role => drafts[role].testToken));
  const available = saved && canEnableAssistant(saved);
  const route = saved?.routing;
  const routingText = !saved?.enabled ? "助手已停用" : route?.state === "checking" ? "正在检查主供应商，用户提问继续使用备用"
    : route?.state === "backup" ? "当前临时使用备用供应商" : route?.state === "unavailable" ? "当前没有可用供应商" : "当前优先使用主供应商";
  return <div className="assistant-settings-page"><header className="page-heading"><div className="assistant-settings-help"><h1>AI 助手</h1><InfoHint label="AI 助手设置说明" text="配置主用与备用模型服务。自动切换与恢复不会改变主备身份，也不会打断已在备用上生成的回答。" /></div><button type="button" className="button button-secondary assistant-settings-refresh" onClick={() => hasUnsavedChanges ? setConfirmRefresh(true) : void load()} disabled={Boolean(busy)}><RefreshCw size={16} />{busy === "load" ? "正在刷新…" : "刷新"}</button></header>
    {error ? <div className="assistant-error" role="alert">{error}</div> : null}
    {!saved && busy ? <LoadingBlock label="正在读取模型配置" /> : null}
    {notice ? <div className="assistant-save-notice" role="status">{notice}</div> : null}
    {hasUnsavedChanges ? <p className="assistant-unsaved-notice" role="status">有未保存的修改或连接测试结果，请在对应供应商中保存。</p> : null}
    {saved && !saved.canManage ? <section className="detail-section"><h2>仅管理员可配置</h2><p>请联系模型配置所属门店的管理员调整连接。你可以使用已启用的 AI 助手。</p></section> : saved ? <div className="assistant-settings-form">
      <section className="detail-section assistant-service-status" aria-labelledby="assistant-service-heading"><div className="section-title-row"><div className="assistant-settings-help"><h2 id="assistant-service-heading">助手服务</h2><InfoHint label="主备恢复说明" text="主服务故障后暂停尝试 10 分钟，再由新提问触发独立短请求检查；用户继续使用备用，不等待检查。无人提问时不自动检查。" /></div><span>{saved.enabled ? "已启用" : "未启用"}</span></div>
        <div className="assistant-service-body"><div className="assistant-enablement-row"><label className="assistant-enable"><input type="checkbox" checked={saved.enabled} disabled={Boolean(busy) || !saved.enabled && (!saved.keyReady || !available)} onChange={() => void toggleAssistant()} />启用 AI 助手</label><span className="assistant-save-mode">立即生效</span></div>
          <p className="assistant-setting-hint">停用会立即停止正在生成的回答；重新启用后需新建对话。</p>
          <p role="status">{routingText}</p>
          {!saved.enabled && !available ? <p className="assistant-setting-hint">启用助手前，请先测试并保存所有已启用的供应商；也可以先停用尚未验证的供应商。</p> : null}
          {route?.lastFailure ? <p className="assistant-setting-hint">最近供应商故障：{route.lastFailure}</p> : null}
          {saved.enabled && route && ["backup", "checking"].includes(route.state) ? <div className="assistant-recovery-actions"><p className="assistant-setting-hint">恢复检查会发送测试请求，费用按服务商规则计算。</p><button type="button" className="button button-secondary" onClick={() => void recover()} disabled={Boolean(busy) || route.state === "checking" || !providerSettings(saved, "primary").enabled}><RefreshCw size={16} />{busy === "recover" ? "正在检查…" : "立即检查恢复"}</button></div> : null}
          <details className="assistant-runtime-details"><summary>运行详情</summary>
            {route?.retryAfter ? <p className="assistant-setting-hint">可再次检查主供应商：{localTime(route.retryAfter)}。到期后有新提问时才会触发后台检查。</p> : null}
            <p className="assistant-setting-hint">{route?.lastCheckedAt ? `最近恢复检查：${localTime(route.lastCheckedAt)}` : "尚无恢复检查记录。"}</p>
            <p className="assistant-setting-hint">配置适用于当前系统。{saved.updatedAt ? `上次保存：${localTime(saved.updatedAt)}` : "首次保存后建立配置。"}</p>
          </details>
        </div>
      </section>
      {!saved.keyReady ? <div className="assistant-notice" role="status">服务端密钥保护尚未就绪，请联系部署人员配置后再保存供应商连接。其他系统功能可以正常使用。</div> : null}
      {roles.map(role => {
        const current = providerSettings(saved, role), draft = drafts[role], tested = canEnableProvider(draft, current);
        const changed = connectionChanged(draft, current);
        const validFields = Boolean(draft.name.trim() && draft.baseUrl.trim() && draft.model.trim() && (draft.apiKey || current.hasKey));
        const needsNewKey = draft.baseUrl.trim().replace(/\/+$/, "") !== current.baseUrl && !draft.apiKey;
        const canSave = validFields && !needsNewKey && (!draft.enabled || tested);
        const onlyDisabling = !draft.enabled && !changed && draft.name.trim() === current.name && current.hasKey;
        const pending = providerDirty(draft, current) || Boolean(draft.testToken);
        const saveBlockReason = !saved.keyReady && !onlyDisabling ? "密钥保护尚未就绪，暂不能保存连接。"
          : !validFields ? "请填写供应商名称、API 地址、模型名称和密钥。"
          : needsNewKey ? "地址已改变，请填写新地址对应的密钥并重新测试。"
          : draft.enabled && !tested ? "启用前请先测试当前连接。" : "";
        return <form key={role} className="detail-section assistant-provider-card" aria-labelledby={`assistant-provider-${role}`} onSubmit={event => { event.preventDefault(); void saveProvider(role); }}>
          <div className="section-title-row assistant-provider-heading"><div className="assistant-provider-title"><h2 id={`assistant-provider-${role}`}>{providerTitles[role]}</h2><span className="assistant-current-state">{current.hasKey ? current.enabled ? "当前已启用" : "当前已停用" : "待配置"}</span>{pending ? <span className="assistant-pending-badge">未保存</span> : null}</div>
            {role === "backup" ? <div className="assistant-settings-help assistant-promote-action"><button type="button" className="button button-secondary" onClick={() => void promote()} disabled={Boolean(busy) || Boolean(dirty) || !canPromoteProvider(current) || !saved.keyReady}><ArrowUpDown size={17} />设为主用</button><InfoHint label="设为主用说明" text="仅互换主备优先顺序，保留已有对话，不打断当前回答，后续问题生效。请先保存未保存的供应商配置。" /></div> : null}
          </div>
          {role === "backup" && dirty ? <p className="assistant-setting-hint">设为主用前，请先保存未保存的供应商配置。</p> : null}
          <fieldset disabled={Boolean(busy)}>
            <label>供应商名称<input aria-label={`${providerTitles[role]}名称`} value={draft.name} maxLength={80} required onChange={event => update(role, "name", event.target.value)} autoComplete="off" /></label>
            <div className="assistant-settings-field"><div className="assistant-settings-help"><label htmlFor={`assistant-${role}-url`}>API 地址（Base URL）</label><InfoHint label="API 地址说明" text="填写 HTTPS API 根地址；服务需支持流式 Chat Completions 和工具调用。" /></div><input id={`assistant-${role}-url`} aria-label={role === "primary" ? "Base URL" : "备用 Base URL"} type="url" required value={draft.baseUrl} onChange={event => update(role, "baseUrl", event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" /></div>
            <div className="assistant-settings-field"><div className="assistant-settings-help"><label htmlFor={`assistant-${role}-key`}>模型服务密钥（API Key）</label><InfoHint label="模型服务密钥说明" text="密钥加密保存在服务端，保存后不显示原文。已有密钥时留空会保留原密钥。" /></div><input id={`assistant-${role}-key`} aria-label={role === "primary" ? "API Key" : "备用 API Key"} type="password" value={draft.apiKey} onChange={event => update(role, "apiKey", event.target.value)} placeholder={current.hasKey ? "留空保留这家供应商已保存的密钥" : "填写这家供应商的 API Key 或访问 Token"} autoComplete="new-password" maxLength={4096} />{needsNewKey && current.hasKey ? <small className="assistant-setting-hint">地址已改变，必须填写新地址对应的密钥并重新测试。</small> : null}</div>
            <label>模型名称<input aria-label={role === "primary" ? "模型名称" : "备用模型名称"} required value={draft.model} onChange={event => update(role, "model", event.target.value)} placeholder="服务商提供的模型标识" maxLength={120} autoComplete="off" /></label>
            <div className="assistant-enablement-row"><label className="assistant-enable"><input type="checkbox" aria-label={`启用${providerTitles[role]}`} checked={draft.enabled} disabled={!draft.enabled && !tested} onChange={event => update(role, "enabled", event.target.checked)} />启用此供应商</label><span className="assistant-save-mode">保存后生效</span></div>
            <p className="assistant-setting-hint">{draft.testToken ? "本次连接测试通过，请保存配置。" : changed ? "连接已修改，启用前请重新测试。" : current.testedAt ? `已保存的连接测试通过：${localTime(current.testedAt)}` : current.enabled && current.hasKey ? "现有连接保持启用；更改连接或停用后重新启用须测试。" : "请先测试连接，再启用并保存。"}</p>
          </fieldset>
          <div className="assistant-provider-footer">
            {saveBlockReason ? <p className="assistant-setting-hint" role="status">{saveBlockReason}</p> : null}
            <p className="assistant-setting-hint">保存配置会使原对话失效，并停止正在生成的回答。</p>
            <div className="assistant-settings-help assistant-test-cost"><p className="assistant-setting-hint">测试连接可能产生费用，按服务商规则计算。</p><InfoHint label="测试请求说明" text="测试连接和恢复检查只发送简短的合成请求，不发送业务资料。" /></div>
            <div className="assistant-settings-actions"><button type="button" className="button button-secondary" disabled={Boolean(busy) || !saved.keyReady || !validFields || needsNewKey} onClick={() => void testProvider(role)}><PlugZap size={17} />{busy === `test-${role}` ? "正在测试…" : "测试连接"}</button><button type="submit" className="button button-primary" disabled={Boolean(busy) || !canSave || !saved.keyReady && !onlyDisabling}><Save size={17} />{busy === `save-${role}` ? "正在保存…" : "保存配置"}</button></div>
          </div>
        </form>;
      })}
    </div> : null}
    {confirmRefresh ? <Modal title="放弃修改并刷新？" onClose={() => setConfirmRefresh(false)} footer={<><button type="button" className="button button-secondary" onClick={() => setConfirmRefresh(false)}>继续编辑</button><button type="button" className="button button-primary" onClick={() => { setConfirmRefresh(false); void load(); }}>放弃修改并刷新</button></>}><p>刷新将放弃未保存的供应商配置和本次连接测试结果，重新读取已保存配置。</p></Modal> : null}
  </div>;
}
