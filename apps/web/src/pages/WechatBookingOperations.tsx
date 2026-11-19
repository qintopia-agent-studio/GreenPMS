import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { MemberInteraction, StaffBooking } from "@qintopia/contracts";
import { memberOps } from "../api";
import { useWorkspace } from "../session";
import "./wechat-operations.css";

const bookingState = { PENDING: "待排房", CONFIRMED: "已确认", DECLINED: "未能安排" };
const deliveryState: Record<string, string> = {
  PENDING: "待发送",
  ACCEPTED: "平台已受理",
  REJECTED: "平台拒绝",
  SKIPPED: "已跳过",
  UNKNOWN: "结果未知",
  RECORDED: "已记录"
};
function when(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
type Page<T> = { items: T[]; more: boolean };
function Decision({
  property,
  booking,
  done
}: {
  property: string;
  booking: StaffBooking;
  done: (message: string) => void;
}) {
  const [units, setUnits] = useState<{ id: string; name: string }[]>(),
    [unit, setUnit] = useState(""),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [decline, setDecline] = useState(false),
    [load, setLoad] = useState(0);
  const base = "bookings/" + encodeURIComponent(booking.id);
  useEffect(() => {
    let active = true;
    setError("");
    setUnits(undefined);
    setUnit("");
    memberOps<{ id: string; name: string }[]>(property, base + "/units")
      .then((rows) => {
        if (active) {
          setUnits(rows);
          setUnit(rows.length === 1 ? rows[0]!.id : "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [property, base, load]);
  async function decide(action: "CONFIRM" | "DECLINE") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await memberOps<{ status: keyof typeof bookingState }>(
        property,
        base + "/decision",
        action === "CONFIRM" ? { action, unitId: unit } : { action }
      );
      done("申请已处理，排房结果为「" + bookingState[r.status] + "」。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "处理失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wx-decision">
      {units === undefined && !error && <p>正在核对全程可用房源…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="button" onClick={() => setLoad((n) => n + 1)}>
            重新核对
          </button>
        </p>
      )}
      {units && (
        <>
          {units.length ? (
            <label>
              分配房间或床位
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="">请选择</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>所选日期暂无全程可用的房间或床位。</p>
          )}
          <button className="button button-primary" disabled={busy || !unit} onClick={() => void decide("CONFIRM")}>
            确认排房并建单
          </button>
        </>
      )}
      {decline ? (
        <>
          <p>确认将这次预订标记为「未能安排」并按通知设置告知会员？</p>
          <button className="button" disabled={busy} onClick={() => void decide("DECLINE")}>
            确认未能安排
          </button>
          <button className="button" disabled={busy} onClick={() => setDecline(false)}>
            返回
          </button>
        </>
      ) : (
        <button className="button" disabled={busy} onClick={() => setDecline(true)}>
          未能安排
        </button>
      )}
    </div>
  );
}
export default function WechatBookingOperations() {
  const { propertyId } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "pending",
    member = params.get("memberId") ?? "",
    filter = params.get("state") ?? "";
  const [reload, setReload] = useState(0),
    [notice, setNotice] = useState("");
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  function update(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p);
  }
  return (
    <section className="wx-operations">
      <header className="page-heading">
        <div>
          <Link to="/members">返回会员档案</Link>
          <h1>服务号预订与交互</h1>
        </div>
        <button className="button button-secondary" onClick={() => setReload((n) => n + 1)}>
          刷新
        </button>
      </header>
      <nav className="wx-tabs" aria-label="运营视图">
        {Object.entries({ pending: "待排房", bookings: "预订记录", history: "交互记录" }).map(([k, v]) => (
          <button
            className="button"
            key={k}
            aria-pressed={tab === k}
            onClick={() => update({ tab: k, state: "", offset: "" })}
          >
            {v}
          </button>
        ))}
      </nav>
      {member && (
        <p>
          仅看所选会员{" "}
          <button className="button" onClick={() => update({ memberId: "", offset: "" })}>
            查看全部会员
          </button>
        </p>
      )}
      {tab === "history" && (
        <label>
          发送或记录状态
          <select value={filter} onChange={(e) => update({ state: e.target.value, offset: "" })}>
            <option value="">全部状态</option>
            {Object.entries(deliveryState).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {notice && <p role="status">{notice}</p>}
      <Records
        key={[propertyId, tab, offset, member, filter, reload].join("|")}
        property={propertyId}
        tab={tab}
        offset={offset}
        member={member}
        filter={filter}
        page={(n) => update({ offset: String(n) })}
        done={(message) => {
          setNotice(message);
          setReload((n) => n + 1);
        }}
      />
    </section>
  );
}
function Records({
  property,
  tab,
  offset,
  member,
  filter,
  page,
  done
}: {
  property: string;
  tab: string;
  offset: number;
  member: string;
  filter: string;
  page: (n: number) => void;
  done: (s: string) => void;
}) {
  const [bookings, setBookings] = useState<StaffBooking[]>(),
    [events, setEvents] = useState<MemberInteraction[]>(),
    [more, setMore] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ offset: String(offset) });
    if (member) query.set("memberId", member);
    if (tab === "pending") query.set("state", "PENDING");
    if (tab === "history" && filter) query.set("state", filter);
    const job =
      tab === "history"
        ? memberOps<Page<MemberInteraction>>(property, "interactions?" + query).then((r) => {
            if (active) {
              setEvents(r.items);
              setMore(r.more);
            }
          })
        : memberOps<Page<StaffBooking>>(property, "bookings?" + query).then((r) => {
            if (active) {
              setBookings(r.items);
              setMore(r.more);
            }
          });
    job.catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [property, tab, offset, member, filter]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {!events && !bookings && !error && <p>正在读取…</p>}
      {bookings?.length === 0 && <p>{tab === "pending" ? "当前没有待排房申请。" : "暂无预订记录。"}</p>}
      {bookings?.map((b) => (
        <article className="wx-card" key={b.id}>
          <div className="wx-row">
            <h2>
              {b.member} · {b.room}
            </h2>
            <strong>{bookingState[b.status]}</strong>
          </div>
          <p>
            {b.arrival} 至 {b.departure}
          </p>
          <small>
            {b.id} · {when(b.created)} 提交
          </small>
          {b.operator && b.decided && (
            <p>
              {b.operator} 于 {when(b.decided)} 处理
            </p>
          )}
          {b.notice && <p>通知记录　{b.notice}</p>}
          {b.orderId && (
            <p>
              <Link to={"/orders/" + encodeURIComponent(b.orderId)}>打开住宿订单</Link>
            </p>
          )}
          {b.status === "PENDING" &&
            (selected === b.id ? (
              <Decision property={property} booking={b} done={done} />
            ) : (
              <p>
                <button className="button" onClick={() => setSelected(b.id)}>
                  处理申请
                </button>
              </p>
            ))}
        </article>
      ))}
      {events?.length === 0 && <p>没有符合条件的交互记录。</p>}
      {events?.map((e) => (
        <article className="wx-card" key={e.id}>
          <div className="wx-row">
            <h2>
              {e.kind} · {e.member ?? "已无关联档案"}
            </h2>
            <strong>{deliveryState[e.state] ?? e.state}</strong>
          </div>
          <p>{e.detail}</p>
          <small>
            {when(e.created)} 记录{e.updated !== e.created ? " · " + when(e.updated) + " 更新" : ""}
          </small>
          {(e.template || Object.keys(e.content).length > 0) && (
            <details>
              <summary>模板与内容</summary>
              <dl>
                {e.template && (
                  <div>
                    <dt>模板 ID</dt>
                    <dd>{e.template}</dd>
                  </div>
                )}
                {Object.entries(e.content).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </article>
      ))}
      <div className="wx-tabs">
        {offset > 0 && (
          <button className="button" onClick={() => page(Math.max(0, offset - 30))}>
            上一页
          </button>
        )}
        {more && (
          <button className="button" onClick={() => page(offset + 30)}>
            下一页
          </button>
        )}
      </div>
    </>
  );
}
