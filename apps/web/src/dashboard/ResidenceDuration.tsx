import { Link } from "react-router-dom";
import type { DashboardResponse } from "@qintopia/contracts";
import { dashboardDurationBands } from "./dashboard-presentation";

export function ResidenceDuration({ data, perspective, onPerspectiveChange }: {
  data: DashboardResponse;
  perspective: "current" | "all";
  onPerspectiveChange: (value: "current" | "all") => void;
}) {
  const duration = dashboardDurationBands(data.community.duration);
  const coverage = data.community.durationCoverage?.[perspective];
  const complete = !!coverage && coverage.pendingRegistrations === 0 && coverage.pendingOrders === 0 && coverage.issues.length === 0;
  const known = duration.reduce((sum, row) => sum + row[perspective], 0);
  const max = Math.max(1, ...duration.map(row => row[perspective]));
  const unit = perspective === "current" ? "人" : "人次";
  return <>
    <div className="dashboard-range-tabs" role="group" aria-label="居住时长口径" aria-describedby="duration-explanation">
      <button type="button" aria-pressed={perspective === "current"} onClick={() => onPerspectiveChange("current")}>当前在住</button>
      <button type="button" aria-pressed={perspective === "all"} onClick={() => onPerspectiveChange("all")}>所选期间全部</button>
    </div>
    <div id="duration-explanation" className="duration-explanation">
      <strong>{perspective === "current" ? "现在还在住的人，已经住了多久？" : "这段时间住过的人，每次连续住宿已住多久？"}</strong>
      <p>{perspective === "current"
        ? "从本次连续入住算到今天，只算已经住过的夜数，不含未来预订。按人数统计。"
        : "使用页面顶部日期筛选。包含所选期间实际住过、已离店或仍在住的住宿；从每次连续入住累计至离店或统计截止日，不只算期间内的夜数。同一人离店后隔天再来，分别计人次，不含仅预订未入住。"}</p>
      <small>{perspective === "current" ? `截至 ${data.businessDate} · 不随顶部历史日期变化`
        : `住宿期间：${data.range.from} 至 ${data.range.to} · 统计截至 ${data.range.to < data.businessDate ? data.range.to : data.businessDate}（最晚今天）`}</small>
    </div>
    <p className="dashboard-muted duration-band-note">连续续住或换房不中断累计。以下仅为时长分组，1 个月按固定 30 晚，不改变业务长短住规则。</p>
    <div className="duration-coverage" aria-label="住宿时长统计覆盖情况">
      <strong>{complete ? `已统计 ${known} ${unit}` : `已统计 ${known} ${unit} · 部分住宿资料异常`}</strong>
      {data.community.identityApproximate && <p>按昵称优先、姓名辅助自动关联住客，跨单连续时长为近似统计；无需补证件或逐条人工核对。</p>}
      {!!coverage?.registrationBased && <p>已按实际住宿登记自动计算，原单续住和换房连续累计。跨订单已有身份关联的合并计算，未能关联的登记分别统计。</p>}
      {!complete && <>
        <p>{coverage
          ? [coverage.pendingRegistrations ? `${coverage.pendingRegistrations} 条住宿登记缺少实际住宿日期` : "", coverage.pendingOrders ? `${coverage.pendingOrders} 个订单的住宿人或时间线待核对` : ""].filter(Boolean).join("；") + "。"
          : "当前返回资料未提供时长覆盖情况，暂不能确认是否包含全部住客。"}</p>
        <p>下方仅展示有实际住宿依据的部分；缺失的日期或名单不能当作 0 人。异常登记不与已统计人数相加。</p>
      </>}
    </div>
    <div className="duration-bars" aria-label={complete ? "住宿时长分布" : "已核对部分的住宿时长分布"}>
      {known > 0 ? duration.map(row => <div key={row.label}>
        <span>{row.label}<small>{row.range}</small></span>
        <div aria-hidden="true"><i style={{ width: `${row[perspective] / max * 100}%` }} /></div>
        <b>{!complete && row[perspective] === 0 ? "待核对" : `${row[perspective]}${unit}`}</b>
      </div>) : <p className="dashboard-empty">{complete ? perspective === "current" ? "当前没有实际在住人员。" : "所选期间没有实际住宿记录。" : "暂无可计算的实际住宿时长，不代表没有人在住。"}</p>}
    </div>
    {!!coverage?.issues.length && <details className="duration-review">
      <summary>查看异常依据与关联订单（{coverage.issues.length}）</summary>
      <ul>{coverage.issues.map(issue => <li key={issue.orderId}>
        <span>{issue.reason}</span>{" "}<Link to={`/orders/${encodeURIComponent(issue.orderId)}`}>查看订单</Link>
      </li>)}</ul>
    </details>}
  </>;
}
