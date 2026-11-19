import { useEffect, useRef, useState } from "react";
import type { MemberBooking, MemberBookings as BookingList } from "@qintopia/contracts";
import { memberRequest } from "./member-request";

const stays: Record<string, string> = {
  IN_HOUSE: "在住",
  CHECKED_IN: "在住",
  CHECKED_OUT: "已退房",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  NO_SHOW: "未到"
};
const status = { PENDING: "待排房", CONFIRMED: "已确认", DECLINED: "未能安排" };
export function bookingAnchor() {
  const id = location.hash.match(/^#booking=(Q[A-F0-9]{18})$/)?.[1];
  if (id) sessionStorage.setItem("member-booking-link", id);
  return id ?? sessionStorage.getItem("member-booking-link") ?? "";
}
export function MemberBookingPanel({
  form,
  onSubmitted,
  focusId
}: {
  form: boolean;
  onSubmitted: (id: string) => void;
  focusId: string;
}) {
  const [data, setData] = useState<BookingList>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [arrival, setArrival] = useState(""),
    [departure, setDeparture] = useState(""),
    [room, setRoom] = useState(""),
    [offset, setOffset] = useState(0);
  const [all, setAll] = useState(false),
    [retry, setRetry] = useState(0);
  const key = useRef({ fingerprint: "", id: "" }),
    target = !form && !all ? focusId : "";
  useEffect(() => {
    let active = true;
    setData(undefined);
    setMessage("");
    const query = target ? "?id=" + encodeURIComponent(target) : "?offset=" + offset;
    memberRequest<BookingList>("/bookings" + query)
      .then((result) => {
        if (!active) return;
        setData(result);
        setRoom((previous) =>
          result.rooms.some((r) => r.code === previous) ? previous : (result.rooms[0]?.code ?? "")
        );
      })
      .catch((err) => {
        if (active) setMessage(err.message);
      });
    return () => {
      active = false;
    };
  }, [offset, target, retry]);
  async function submit() {
    if (busy || !data) return;
    const type = data.rooms.find((r) => r.code === room);
    if (!type) return;
    const fingerprint = JSON.stringify([arrival, departure, type.code, type.kind]);
    if (key.current.fingerprint !== fingerprint) key.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setMessage("");
    try {
      const b = await memberRequest<MemberBooking>("/bookings", {
        arrival,
        departure,
        roomType: room,
        kind: type.kind,
        requestKey: key.current.id
      });
      onSubmitted(b.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "提交失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="member-bookings">
      <h2>{form ? "预订住宿" : "我的预订"}</h2>
      {message && (
        <p role="alert">
          {message} {!data && <button onClick={() => setRetry((v) => v + 1)}>重新读取</button>}
        </p>
      )}
      {!data && !message && <p role="status">正在读取…</p>}
      {data &&
        form &&
        (data.rooms.length ? (
          <form
            className="member-sms"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="wx-arrival">入住日</label>
            <input
              id="wx-arrival"
              type="date"
              min={data.today}
              required
              value={arrival}
              onChange={(e) => setArrival(e.target.value)}
            />
            <label htmlFor="wx-departure">离店日</label>
            <input
              id="wx-departure"
              type="date"
              min={arrival || data.today}
              required
              value={departure}
              onChange={(e) => setDeparture(e.target.value)}
            />
            <label htmlFor="wx-room">房型或床位</label>
            <select id="wx-room" value={room} onChange={(e) => setRoom(e.target.value)}>
              {data.rooms.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name} · {r.kind === "ROOM" ? "整间" : "床位"}
                </option>
              ))}
            </select>
            <p>提交后由门店排房，确认结果通过服务号通知，也可在「我的预订」查看。</p>
            <button className="member-primary" disabled={busy || !room || !arrival || departure <= arrival}>
              {busy ? "提交中…" : "提交预订"}
            </button>
          </form>
        ) : (
          <p>当前没有适用的住宿权益，请联系服务号客服。</p>
        ))}
      {data && !form && (
        <>
          {data.bookings.length === 0 && <p>{target ? "当前账号找不到这条预订。" : "暂无预订申请。"}</p>}
          <ol>
            {data.bookings.map((b) => (
              <li key={b.id}>
                <div>
                  <strong>{b.room}</strong>
                  <span>{(b.stay && stays[b.stay.status]) || status[b.status]}</span>
                </div>
                <p>
                  {b.stay?.arrival ?? b.arrival} 至 {b.stay?.departure ?? b.departure}
                </p>
                <small>预订编号 {b.id}</small>
                {b.status === "PENDING" && <small>{b.attention ?? "门店确认排房后通知你。"}</small>}
                {b.status === "DECLINED" && <small>可另选日期重新预订，或联系服务号客服。</small>}
              </li>
            ))}
          </ol>
          {target ? (
            <button
              onClick={() => {
                setAll(true);
                setOffset(0);
                sessionStorage.removeItem("member-booking-link");
                history.replaceState(null, "", location.pathname);
              }}
            >
              查看全部预订
            </button>
          ) : (
            <>
              {offset > 0 && <button onClick={() => setOffset((v) => Math.max(0, v - 20))}>上一页</button>}
              {data.next && <button onClick={() => setOffset(Number(data.next))}>下一页</button>}
            </>
          )}
          <button onClick={() => setRetry((v) => v + 1)}>刷新结果</button>
        </>
      )}
    </section>
  );
}
