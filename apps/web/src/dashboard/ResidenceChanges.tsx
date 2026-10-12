import { useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { CommunityRecord, DashboardResponse } from "@qintopia/contracts";
import { DashboardHint } from "./DashboardHint";
import { dashboardDurationBands } from "./dashboard-presentation";

const categories = [
  { key: "NEW", name: "新入住", note: "首次可核实的居住" },
  { key: "RENEWAL", name: "连续续住", note: "原单延长 / 无空夜接单" },
  { key: "RETURN", name: "回访复购", note: "离开后再次回来" },
  { key: "DUE", name: "即将到期", note: "从今天起7天 · 未确认接续" },
  { key: "EARLY", name: "提前离店", note: "有效提前退房 · 回访线索" }
] as const;
export function ResidenceChanges({ data }: { data: DashboardResponse }) {
  const [kind, setKind] = useState<CommunityRecord["kind"] | "DURATION" | null>(null);
  const [page, setPage] = useState(0);
  const [durationType, setDurationType] = useState<"current" | "completed">("current");
  const trigger = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const c = data.community;
  const rows = c.records.filter(row => row.kind === kind);
  function open(next: NonNullable<typeof kind>) {
    trigger.current = document.activeElement as HTMLElement;
    setKind(next); setPage(0);
    requestAnimationFrame(() => panel.current?.focus());
  }
  function close() { setKind(null); requestAnimationFrame(() => trigger.current?.focus()); }
  const duration = dashboardDurationBands(c.duration);
  const hasDuration = duration.some(row => row[durationType] > 0);
  const max = Math.max(1, ...duration.map(row => row[durationType]));
  return <section className="dashboard-panel residence-panel" aria-labelledby="residence-title">
    <div className="dashboard-section-heading"><div><p className="section-kicker">02 / 居住变化</p><h2 id="residence-title">来过，留下，再回来</h2></div><DashboardHint label="居住变化统计说明" text="数量为可追溯的订单/日期记录，展开后分别显示可确认的住客人数。不是独立人数之和。无空夜换房接单算连续续住，有空夜才算复购。提前离店不推断满意度，少住晚数不是收入损失。" /></div>
    {kind === null ? <><div className="residence-list">{categories.map(item => <button type="button" key={item.key} onClick={() => open(item.key)}><div><strong>{item.name}</strong><span>{item.note}</span></div><b>{c.counts[item.key]}<small>条</small></b><ArrowRight size={15} aria-hidden="true" /></button>)}</div><button type="button" className="residence-duration-link" onClick={() => open("DURATION")}><span>实际住宿天数分布<small>只看已住的夜，不把未来算进来</small></span><ArrowUpRight size={17} aria-hidden="true" /></button><p className="dashboard-muted residence-note">{c.reasons.length ? "仅含可核对记录，缺项不代表没有发生。" : "点击查看记录、实际时长与原始原因。"}</p></> : <div className="residence-drilldown" ref={panel} tabIndex={-1}>
      <div className="residence-drilldown-heading"><strong>{kind === "DURATION" ? "实际住宿天数分布" : categories.find(item => item.key === kind)?.name}</strong><button className="dashboard-text-button" onClick={close}><X size={14} aria-hidden="true" />返回</button></div>
      {kind === "DURATION" ? <><div className="dashboard-range-tabs" role="group" aria-label="居住时长口径"><button aria-pressed={durationType === "current"} onClick={() => { setDurationType("current"); setPage(0); }}>当前已住</button><button aria-pressed={durationType === "completed"} onClick={() => { setDurationType("completed"); setPage(0); }}>本期已结束</button></div><p className="dashboard-muted">{durationType === "current" ? "截至今天已发生的夜 · 人" : "本期离店的完整连续居住 · 次"}。按实际夜数分为 6 档，月按固定 30 晚划分，仅用于展示，不设长短住门槛。</p><div className="duration-bars">{hasDuration ? duration.map(row => <div key={row.label}><span>{row.label}<small>{row.range}</small></span><div aria-hidden="true"><i style={{ width: `${row[durationType] / max * 100}%` }} /></div><b>{row[durationType]}{durationType === "current" ? "人" : "次"}</b></div>) : <p className="dashboard-empty">暂无可核对的实际时长。</p>}</div></> : <><p className="dashboard-muted">{kind === "DUE" ? "当前在住，未来7天到期；已确认无空夜接续不列入。" : `${data.range.from} 至 ${data.range.to} · ${rows.length} 条可核对记录`}</p><div className="residence-records">{rows.slice(page * 3, page * 3 + 3).map((row, i) => <article key={`${row.orderId}:${row.date}:${i}`}><div><time>{row.date}</time><span>{kind === "EARLY" ? `提前 ${row.nights} 晚` : kind === "RENEWAL" ? "已确认接续" : `实际已住 ${row.nights} 晚`}</span></div><p>{row.reason}</p><footer><span>{row.people == null ? "人数待核对" : `${row.people} 人`}</span><Link to={`/orders/${encodeURIComponent(row.orderId)}`}>查看订单 <ArrowUpRight size={12} aria-hidden="true" /></Link></footer></article>)}{!rows.length ? <p className="dashboard-empty">{c.reasons.length ? "可核对资料中暂无此类记录；仍有资料待补充。" : "这个范围没有此类记录。"}</p> : null}</div><Pagination page={page} total={rows.length} size={3} onPage={setPage} /></>}
    </div>}
  </section>;
}
function Pagination({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (page: number) => void }) {
  if (total <= size) return null;
  return <div className="dashboard-pagination"><button className="dashboard-text-button" disabled={!page} onClick={() => onPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(total / size)}</span><button className="dashboard-text-button" disabled={(page + 1) * size >= total} onClick={() => onPage(page + 1)}>下一页</button></div>;
}
