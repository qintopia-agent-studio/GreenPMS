/** A navigation hint only; identity, entitlement and inventory remain server validated. */
export function memberStayHref(propertyId: string, memberId: string): string {
  return `/?${new URLSearchParams({ propertyId, memberId }).toString()}`;
}

export function memberStayIntent(search: string, propertyId: string): string | undefined {
  const params = new URLSearchParams(search);
  if (params.get("propertyId") !== propertyId) return undefined;
  return params.get("memberId")?.trim() || undefined;
}
