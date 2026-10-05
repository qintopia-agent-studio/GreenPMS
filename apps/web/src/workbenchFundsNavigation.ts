import type { WorkbenchFundsExceptionItem } from "@qintopia/contracts";

/** Only local workbench routes may be restored from navigation state. */
export function workbenchBackHref(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = (state as Record<string, unknown>).workbenchSearch;
  if (typeof value !== "string") return undefined;
  const source = new URLSearchParams(value);
  const target = new URLSearchParams({ tab: "EXCEPTIONS" });
  const propertyId = source.get("propertyId");
  if (!propertyId || !/^[a-zA-Z0-9_-]{1,200}$/.test(propertyId)) return undefined;
  target.set("propertyId", propertyId);
  const date = source.get("date");
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) target.set("date", date);
  const query = source.get("fundsQuery")?.slice(0, 200);
  const cursor = source.get("fundsCursor")?.slice(0, 1000);
  if (query) target.set("fundsQuery", query);
  if (cursor) target.set("fundsCursor", cursor);
  return `/today?${target}`;
}

export function workbenchFundsHint(state: unknown, propertyId: string): WorkbenchFundsExceptionItem | undefined {
  if (!workbenchBackHref(state)) return undefined;
  const source = state as Record<string, unknown>;
  if (new URLSearchParams(source.workbenchSearch as string).get("propertyId") !== propertyId) return undefined;
  const hint = source.workbenchFundsHint as WorkbenchFundsExceptionItem | undefined;
  if (!hint || !["UNALLOCATED_COLLECTION", "ORDER_EXCESS", "UNASSIGNED_REFUND"].includes(hint.kind)) return undefined;
  return hint;
}
