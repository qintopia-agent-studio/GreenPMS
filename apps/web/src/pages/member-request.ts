export const root = "/api/wechat/member";
export async function memberRequest<T>(suffix = "", body?: object): Promise<T> {
  const reply = await fetch(root + suffix, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
  });
  if (!reply.ok) {
    if (reply.status === 403) throw new Error("身份或绑定状态已变化，请从服务号重新打开我的权益。");
    if (reply.status === 429) throw new Error("操作过于频繁，请稍后再试。");
    if (suffix.startsWith("/sms/") || suffix.startsWith("/bookings")) {
      if (reply.status === 503) throw new Error("本店服务暂不可用，请稍后再试。");
      const detail = await reply.json().catch(() => undefined);
      if (
        ["VALIDATION_ERROR", "ENTITLEMENT_CONFLICT", "AGGREGATE_VERSION_CONFLICT"].includes(detail?.code) &&
        typeof detail.message === "string"
      )
        throw new Error(detail.message);
    }
    throw new Error("暂时无法读取，请稍后再试。");
  }
  return (await reply.json()) as T;
}
