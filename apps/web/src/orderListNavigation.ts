export const orderListStatuses = ["RESERVED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"] as const;

export function orderListSearch(search: string): string {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  for (const key of ["propertyId", "before"]) {
    const value = source.get(key);
    if (value && /^[a-zA-Z0-9_-]{1,200}$/.test(value)) target.set(key, value);
  }
  const query = source.get("q")?.trim().slice(0, 200);
  if (query) target.set("q", query);
  const funds = source.get("funds");
  if (funds === "BALANCE_DUE" || funds === "OVERPAID") target.set("funds", funds);
  const status = source.get("status");
  if (orderListStatuses.some((value) => value === status)) target.set("status", status!);
  return target.toString();
}

export function orderListBackHref(state: unknown): string {
  const search = state && typeof state === "object" ? (state as Record<string, unknown>).orderListSearch : undefined;
  const sanitized = typeof search === "string" ? orderListSearch(search) : "";
  return sanitized ? `/orders?${sanitized}` : "/orders";
}

export function orderPreviousPages(state: unknown): string[] {
  const pages = state && typeof state === "object" ? (state as Record<string, unknown>).orderPreviousPages : undefined;
  return Array.isArray(pages) && pages.every((value) => typeof value === "string" && /^[a-zA-Z0-9_-]{0,200}$/.test(value)) ? pages : [];
}
