import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, Link, useParams } from "react-router-dom";
import { SWRConfig } from "swr";
import { BedDouble, ChartNoAxesCombined, ClipboardList, Users, Settings, Building2, FlaskConical } from "lucide-react";
import "@fontsource-variable/noto-sans-sc";
import "../../styles.css";
import { DashboardWorkspace } from "../../pages/DashboardPage";
import { sampleDashboard, sampleDetails, type Scenario } from "./sample";
import "./preview.css";

function Preview() {
  const [property, setProperty] = useState("sample-a");
  const [scenario, setScenario] = useState<Scenario>("complete");
  const read = useCallback(async (id: string, query: string, signal?: AbortSignal) => {
    await delay(signal);
    if (scenario === "error") throw new Error("合成失败场景：服务暂不可用");
    return sampleDashboard(id, query, scenario);
  }, [scenario]);
  const details = useCallback(async (id: string, query: string, signal?: AbortSignal) => { await delay(signal); return sampleDetails(id, query, scenario); }, [scenario]);
  return <MemoryRouter><div className="app-shell preview-shell"><aside className="sidebar"><div className="sidebar-brand-row"><div className="sidebar-brand"><div className="sidebar-brand-identity"><span className="brand-word">QinTopia</span><small>社区运营工作台</small></div></div></div><nav className="primary-navigation" aria-label="合成预览导航"><span className="nav-link preview-disabled"><BedDouble size={17} />房态</span><span className="nav-link preview-disabled"><ClipboardList size={17} />订单</span><span className="nav-link preview-disabled"><Users size={17} />会员</span><Link to="/" className="nav-link active"><ChartNoAxesCombined size={17} />经营概览</Link></nav><div className="sidebar-utilities"><label className="sidebar-property"><Building2 size={16} /><span className="sr-only">合成门店</span><select value={property} onChange={e => setProperty(e.target.value)}><option value="sample-a">西安社区 · 样本</option><option value="sample-b">山居社区 · 样本</option></select></label><div className="sidebar-property"><Settings size={16} /><span>无登录 · 无数据库</span></div></div></aside><main className="preview-main"><div className="sample-banner"><div><FlaskConical size={16} /><strong>合成样本预览</strong><span>仅验收界面与纯统计，不代表真实经营数据</span></div><label><span className="sr-only">样本场景</span><select value={scenario} onChange={e => setScenario(e.target.value as Scenario)}><option value="complete">完整非零样本</option><option value="partial">资料缺项样本</option><option value="zero">真实零值样本</option><option value="empty">无资料样本</option><option value="error">请求失败样本</option></select></label></div><Routes><Route path="/" element={<SWRConfig key={`${property}:${scenario}`} value={{ provider: () => new Map() }}><DashboardWorkspace propertyId={property} read={read} readDetails={details} /></SWRConfig>} /><Route path="/orders/:orderId" element={<SampleRecord />} /><Route path="*" element={<SampleRecord />} /></Routes></main></div></MemoryRouter>;
}
function SampleRecord() { const { orderId } = useParams(); return <section className="dashboard-panel"><h1>合成记录核对</h1><p>{orderId || "此业务页面不在样本预览中"}</p><p>这里不伪造真实订单或登录权限。正式看板中的同一链接会进入经过鉴权的原订单页面。</p><Link to="/" className="button button-secondary">返回经营看板</Link></section>; }
function delay(signal?: AbortSignal) { return new Promise<void>((resolve, reject) => { if (signal?.aborted) { reject(signal.reason); return; } const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250); function abort() { clearTimeout(timer); reject(signal?.reason); } signal?.addEventListener("abort", abort, { once: true }); }); }
createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
