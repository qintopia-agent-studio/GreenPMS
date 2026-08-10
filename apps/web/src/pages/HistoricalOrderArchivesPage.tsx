import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useWorkspace } from "../session";
import type { BookingChannelCode, HistoricalOrderArchiveDetailDto, HistoricalOrderArchiveDto } from "../types";
import { EmptyState, formatDate, formatMinor, InlineError, LoadingBlock } from "../ui";

const channelLabels: Record<BookingChannelCode, string> = {
  YOUMUDAO: "游牧岛", CTRIP: "携程", MEITUAN: "美团", WECOM: "企业微信"
};

function guestLabel(archive: Pick<HistoricalOrderArchiveDto, "guest_full_name" | "guest_nickname">) {
  return archive.guest_nickname || archive.guest_full_name || "历史未记录";
}

function archiveKindLabel(kind: HistoricalOrderArchiveDto["record_kind"]) {
  return kind === "NON_ACCOMMODATION_ARCHIVE" ? "非住宿记录" : "历史住宿";
}

function channelLabel(channel: BookingChannelCode | null) {
  return channel ? channelLabels[channel] : "历史未记录";
}

function dateRange(archive: Pick<HistoricalOrderArchiveDto, "arrival_date" | "departure_date">) {
  return archive.arrival_date && archive.departure_date
    ? `${formatDate(archive.arrival_date)} 至 ${formatDate(archive.departure_date)}`
    : "历史未记录";
}

interface ArchiveFiltersState {
  ownerPropertyId: string;
  searchInput: string;
  searchQuery: string;
  kind: string;
  channel: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
}

export function emptyArchiveFilters(ownerPropertyId: string): ArchiveFiltersState {
  return { ownerPropertyId, searchInput: "", searchQuery: "", kind: "ALL", channel: "ALL", status: "ALL", arrivalDate: "", departureDate: "" };
}

export function updateArchiveFilters(
  current: ArchiveFiltersState,
  ownerPropertyId: string,
  patch: Partial<Omit<ArchiveFiltersState, "ownerPropertyId">>
): ArchiveFiltersState {
  return {
    ...(current.ownerPropertyId === ownerPropertyId ? current : emptyArchiveFilters(ownerPropertyId)),
    ...patch,
    ownerPropertyId
  };
}

export function HistoricalOrderArchivesPage() {
  const { propertyId } = useWorkspace();
  const [archives, setArchives] = useState<HistoricalOrderArchiveDto[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [filters, setFilters] = useState<ArchiveFiltersState>(() => emptyArchiveFilters(propertyId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [refreshToken, setRefreshToken] = useState(0);
  const activeFilters = filters.ownerPropertyId === propertyId ? filters : emptyArchiveFilters(propertyId);
  const requestKey = JSON.stringify([
    propertyId, activeFilters.searchQuery, activeFilters.kind, activeFilters.channel,
    activeFilters.status, activeFilters.arrivalDate, activeFilters.departureDate, refreshToken
  ]);
  const [resultRequestKey, setResultRequestKey] = useState(requestKey);
  const visibleArchives = resultRequestKey === requestKey ? archives : [];
  const visibleTruncated = resultRequestKey === requestKey && truncated;
  const visibleLoading = resultRequestKey !== requestKey || loading;
  const visibleError = resultRequestKey === requestKey ? error : undefined;

  function updateFilters(patch: Partial<Omit<ArchiveFiltersState, "ownerPropertyId">>) {
    setFilters((current) => updateArchiveFilters(current, propertyId, patch));
  }

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setArchives([]); setTruncated(false); setResultRequestKey(requestKey); setLoading(true); setError(undefined);
    api.historicalOrderArchives(propertyId, {
      ...(activeFilters.searchQuery ? { query: activeFilters.searchQuery } : {}),
      ...(activeFilters.kind !== "ALL" ? { recordKind: activeFilters.kind as HistoricalOrderArchiveDto["record_kind"] } : {}),
      ...(activeFilters.channel !== "ALL" ? { channelCode: activeFilters.channel as BookingChannelCode } : {}),
      ...(activeFilters.status !== "ALL" ? { sourceStatus: activeFilters.status } : {}),
      ...(activeFilters.arrivalDate ? { arrivalDate: activeFilters.arrivalDate } : {}),
      ...(activeFilters.departureDate ? { departureDate: activeFilters.departureDate } : {})
    }, controller.signal)
      .then((response) => {
        if (!current) return;
        setArchives(response.archives);
        setTruncated(response.truncated);
      })
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; controller.abort(); };
  }, [propertyId, activeFilters.searchQuery, activeFilters.kind, activeFilters.channel, activeFilters.status, activeFilters.arrivalDate, activeFilters.departureDate, refreshToken, requestKey]);

  const kinds = useMemo(() => [...new Set(visibleArchives.map((item) => item.record_kind))], [visibleArchives]);
  const channels = useMemo(() => [...new Set(visibleArchives.map((item) => item.mapped_channel_code).filter((item): item is BookingChannelCode => item !== null))], [visibleArchives]);
  const statuses = useMemo(() => [...new Set(visibleArchives.map((item) => item.source_status).filter((item): item is string => item !== null))], [visibleArchives]);

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFilters({ searchQuery: activeFilters.searchInput.trim() });
  }

  return <div className="orders-page historical-archives-page">
    <header className="page-heading page-heading-actions">
      <div><p className="eyebrow">历史数据</p><h1>历史订单归档</h1><p>只读查看未进入当前订单流程的历史记录。</p></div>
      <button className="button button-secondary" type="button" onClick={() => setRefreshToken((value) => value + 1)} disabled={visibleLoading}><RefreshCw className={visibleLoading ? "spin" : ""} aria-hidden="true" size={17} />刷新</button>
    </header>
    <form className="list-toolbar" aria-label="历史订单归档筛选" onSubmit={submitSearch}>
      <label className="search-control"><Search aria-hidden="true" size={17} /><span className="sr-only">搜索历史订单归档</span><input type="search" value={activeFilters.searchInput} onChange={(event) => updateFilters({ searchInput: event.target.value })} placeholder="源订单号、姓名、渠道或日期" /></label>
      <button className="button button-secondary" type="submit" disabled={visibleLoading}>搜索</button>
      <label>记录类型<select value={activeFilters.kind} onChange={(event) => updateFilters({ kind: event.target.value })}><option value="ALL">全部</option>{kinds.map((item) => <option key={item} value={item}>{archiveKindLabel(item)}</option>)}</select></label>
      <label>渠道<select value={activeFilters.channel} onChange={(event) => updateFilters({ channel: event.target.value })}><option value="ALL">全部</option>{channels.map((item) => <option key={item} value={item}>{channelLabel(item)}</option>)}</select></label>
      <label>来源状态<select value={activeFilters.status} onChange={(event) => updateFilters({ status: event.target.value })}><option value="ALL">全部</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>入住日期<input type="date" value={activeFilters.arrivalDate} onChange={(event) => updateFilters({ arrivalDate: event.target.value })} /></label>
      <label>离店日期<input type="date" value={activeFilters.departureDate} onChange={(event) => updateFilters({ departureDate: event.target.value })} /></label>
      <span className="result-count">{visibleArchives.length}</span>
    </form>
    <InlineError error={visibleError} title="无法载入历史订单归档" />
    {visibleTruncated ? <div className="inline-error" role="status"><div><strong>结果已截断</strong><p>当前最多显示 1000 条记录，请收窄搜索或筛选条件。</p></div></div> : null}
    {visibleLoading ? <LoadingBlock label="正在载入历史订单归档" /> : visibleArchives.length === 0 ? <EmptyState title="没有匹配的历史订单归档" detail="调整筛选条件后重试。" /> : (
      <div className="table-region orders-table-region" role="region" aria-label="历史订单归档列表" tabIndex={0}>
        <table className="data-table" data-testid="historical-order-archives-table"><thead><tr><th scope="col">源订单 / 住客</th><th scope="col">记录类型</th><th scope="col">渠道</th><th scope="col">住宿周期</th><th scope="col">来源状态</th><th scope="col">历史金额</th><th scope="col"><span className="sr-only">查看</span></th></tr></thead>
          <tbody>{visibleArchives.map((archive) => <tr key={archive.id}>
            <th scope="row"><Link className="primary-cell-link" to={`/historical-order-archives/${encodeURIComponent(archive.id)}`}><strong>{guestLabel(archive)}</strong><code>{archive.source_order_id}</code></Link></th>
            <td>{archiveKindLabel(archive.record_kind)}</td><td>{channelLabel(archive.mapped_channel_code)}</td><td>{dateRange(archive)}</td><td>{archive.source_status || "历史未记录"}</td><td><strong>{formatMinor(archive.historical_actual_amount_minor, archive.currency)}</strong></td>
            <td><Link className="icon-button" to={`/historical-order-archives/${encodeURIComponent(archive.id)}`} aria-label={`查看历史订单 ${archive.source_order_id}`} title="查看"><ChevronRight aria-hidden="true" size={19} /></Link></td>
          </tr>)}</tbody>
        </table>
      </div>
    )}
  </div>;
}

function DetailValue({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-item"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function HistoricalOrderArchiveDetailPage() {
  const { propertyId } = useWorkspace();
  const { archiveId = "" } = useParams();
  const [archiveState, setArchive] = useState<HistoricalOrderArchiveDetailDto>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const requestKey = `${propertyId}:${archiveId}`;
  const [resultRequestKey, setResultRequestKey] = useState(requestKey);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setArchive(undefined); setResultRequestKey(requestKey); setLoading(true); setError(undefined);
    api.historicalOrderArchive(archiveId, propertyId, controller.signal)
      .then((response) => current && setArchive(response))
      .catch((nextError) => current && setError(nextError))
      .finally(() => current && setLoading(false));
    return () => { current = false; controller.abort(); };
  }, [archiveId, propertyId, requestKey]);

  const visibleArchive = resultRequestKey === requestKey ? archiveState : undefined;
  const visibleError = resultRequestKey === requestKey ? error : undefined;
  if (resultRequestKey !== requestKey || loading) return <LoadingBlock label="正在载入历史订单归档" />;
  if (visibleError || !visibleArchive) return <><Link className="button button-secondary" to="/historical-order-archives"><ArrowLeft aria-hidden="true" size={17} />返回历史归档</Link><InlineError error={visibleError ?? new Error("历史订单归档不存在")} title="无法载入历史订单归档" /></>;
  const archive = visibleArchive;
  return <div className="order-detail-page historical-archive-detail-page">
    <header className="page-heading page-heading-actions"><div><p className="eyebrow">历史数据 · 只读</p><h1>{guestLabel(archive)}</h1><p>源订单号：<code>{archive.source_order_id}</code></p></div><Link className="button button-secondary" to="/historical-order-archives"><ArrowLeft aria-hidden="true" size={17} />返回列表</Link></header>
    <section className="detail-card" aria-labelledby="archive-detail-title"><h2 id="archive-detail-title">归档详情</h2><dl className="detail-grid">
      <DetailValue label="记录类型">{archiveKindLabel(archive.record_kind)}</DetailValue><DetailValue label="来源状态">{archive.source_status || "历史未记录"}</DetailValue>
      <DetailValue label="姓名">{archive.guest_full_name || "历史未记录"}</DetailValue><DetailValue label="昵称">{archive.guest_nickname || "历史未记录"}</DetailValue>
      <DetailValue label="手机号">{archive.guest_phone || "历史未记录"}</DetailValue><DetailValue label="渠道">{channelLabel(archive.mapped_channel_code)}</DetailValue>
      <DetailValue label="渠道订单号">{archive.channel_order_reference || archive.channel_reference_missing_reason === "HISTORICAL_NOT_RECORDED" ? (archive.channel_order_reference || "历史未记录") : "不适用"}</DetailValue><DetailValue label="住宿类型">{archive.stay_type || "历史未记录"}</DetailValue>
      <DetailValue label="住宿周期">{dateRange(archive)}</DetailValue><DetailValue label="历史实际金额">{formatMinor(archive.historical_actual_amount_minor, archive.currency)}</DetailValue>
      <DetailValue label="房费小计">{archive.lodging_subtotal_minor === null ? "历史未记录" : formatMinor(archive.lodging_subtotal_minor, archive.currency)}</DetailValue><DetailValue label="结账住宿金额">{archive.checkout_amount_minor === null ? "历史未记录" : formatMinor(archive.checkout_amount_minor, archive.currency)}</DetailValue>
      <DetailValue label="金额差异说明">{archive.amount_difference_reason || "无"}</DetailValue>
      <DetailValue label="原始渠道">{archive.sourceEvidence.rawChannel || "历史未记录"}</DetailValue><DetailValue label="来源行">{archive.sourceEvidence.sourceSystem} 第 {archive.sourceEvidence.sourceRow} 行</DetailValue>
      <DetailValue label="姓名来源">{archive.sourceEvidence.guestNameProvenance || "历史未记录"}</DetailValue><DetailValue label="手机号来源">{archive.sourceEvidence.guestPhoneProvenance || "历史未记录"}</DetailValue>
      <DetailValue label="人工确认">{archive.sourceEvidence.manualConfirmation.latestCorrection || archive.sourceEvidence.manualConfirmation.reason || "无"}</DetailValue><DetailValue label="复核结论">{archive.sourceEvidence.reviewConclusion || "历史未记录"}</DetailValue>
      <DetailValue label="审核金额">{archive.pricingEvidence.auditHistoricalAmountMinor === null ? "历史未记录" : formatMinor(archive.pricingEvidence.auditHistoricalAmountMinor, archive.currency)}</DetailValue><DetailValue label="结账总金额">{archive.pricingEvidence.checkoutTotalAmountMinor === null ? "历史未记录" : formatMinor(archive.pricingEvidence.checkoutTotalAmountMinor, archive.currency)}</DetailValue>
    </dl></section>
    <section className="detail-card" aria-labelledby="archive-source-title"><h2 id="archive-source-title">来源文件证据</h2>
      <div className="table-region"><table className="data-table"><thead><tr><th scope="col">来源角色</th><th scope="col">文件</th><th scope="col">导出时间</th><th scope="col">行数</th><th scope="col">SHA-256</th></tr></thead><tbody>{archive.sourceEvidence.files.map((file) => <tr key={file.sourceRole}><td>{file.sourceRole}</td><td>{file.fileName}</td><td>{file.exportedAt || "历史未记录"}</td><td>{file.rowCount ?? "历史未记录"}</td><td><code>{file.sha256}</code></td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
