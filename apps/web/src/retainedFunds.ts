import type { RetainedFundList, RetainedFundItem } from '@qintopia/contracts';
import type { CollectionFactDto } from './types';
import { remainingRefundableMinor } from './orderFunds';

/** Retention reserves existing money; it must not be counted as another receipt. */
export function unreservedSourceMinor(facts: readonly CollectionFactDto[], fact: CollectionFactDto, retained: readonly RetainedFundItem[]): number {
  const reserved = retained.filter(item => item.sourceFactId === fact.fact_id).reduce((sum, item) => sum + item.remainingMinor, 0);
  return Math.max(0, remainingRefundableMinor(facts, fact) - reserved);
}
export function retainedAmountAllowed(amount: number | undefined, maximum: number): amount is number {
  return amount !== undefined && Number.isSafeInteger(amount) && amount > 0 && amount <= maximum;
}

/** Load every reservation before computing a refund/retention ceiling. Never silently truncate. */
export async function readOrderRetainedFunds(
  load: (query: Record<string, string>, signal?: AbortSignal) => Promise<RetainedFundList>,
  propertyId: string, orderId: string, signal: AbortSignal, status: "AVAILABLE" | "ALL" = "AVAILABLE"
): Promise<RetainedFundList> {
  const items: RetainedFundItem[] = [];
  const seen = new Set<string>();
  let beforeId = '';
  let enabled = true;
  while (!signal.aborted) {
    const page = await load({propertyId, orderId, status, limit: '100', ...(beforeId ? {beforeId} : {})}, signal);
    enabled = enabled && page.enabled;
    items.push(...page.items);
    if (!page.hasMore) return {...page, enabled, items, hasMore: false, nextBeforeId: null};
    if (!page.nextBeforeId || seen.has(page.nextBeforeId)) throw new Error('留存分页异常，不能安全计算可用余额');
    seen.add(page.nextBeforeId); beforeId = page.nextBeforeId;
  }
  throw new DOMException('Aborted', 'AbortError');
}
