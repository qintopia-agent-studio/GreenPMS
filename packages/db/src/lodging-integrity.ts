import { DomainError, freeStayCategoryCodes, type RoomStatusIntervalDto, type RoomStatusSourceCategory, type RoomStatusSourceKind } from "@qintopia/contracts";
import type { Selectable } from "kysely";
import type { Database } from "./schema.ts";
import { ordinaryStayCashLineTotalMinor, pricingCashLineTotalMinor } from "./historical-command-protocol.ts";

export const externalChannelCodes = new Set(["YOUMUDAO", "CTRIP", "MEITUAN"]);
const freeStayCategoryCodeSet = new Set<string>(freeStayCategoryCodes);

export type LodgingSourceProjectionRow = {
  stay_type?: string | null;
  member_id?: string | null;
  member_contract_id?: string | null;
  booking_channel_code?: string | null;
  channel_order_reference?: string | null;
  free_stay_category_code?: string | null;
  free_stay_reason?: string | null;
};

export type LodgingSourceFields = Pick<RoomStatusIntervalDto,
  "sourceCategory" | "freeStayCategoryCode" | "freeStayReason">;

export const nullLodgingSourceFields: LodgingSourceFields = {
  sourceCategory: null,
  freeStayCategoryCode: null,
  freeStayReason: null
};

function normalizedOptionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function roomStatusSourceCategoryForOrder(row: LodgingSourceProjectionRow): RoomStatusSourceCategory | null {
  if (row.stay_type === "FREE") return "FREE_STAY";
  if (row.member_id || row.member_contract_id) return "MEMBER";
  if (row.booking_channel_code && externalChannelCodes.has(row.booking_channel_code)) {
    return row.channel_order_reference?.trim()
      ? row.booking_channel_code as RoomStatusSourceCategory
      : null;
  }
  if (row.booking_channel_code === null || row.booking_channel_code === undefined || row.booking_channel_code === "WECOM") return "DIRECT";
  return null;
}

function roomStatusFreeStayCategoryCode(value: string | null | undefined): (typeof freeStayCategoryCodes)[number] | null {
  return value && freeStayCategoryCodeSet.has(value)
    ? value as (typeof freeStayCategoryCodes)[number]
    : null;
}

export function roomStatusOrderSourceFields(row: LodgingSourceProjectionRow): LodgingSourceFields {
  const freeStay = row.stay_type === "FREE";
  return {
    sourceCategory: roomStatusSourceCategoryForOrder(row),
    freeStayCategoryCode: freeStay ? roomStatusFreeStayCategoryCode(row.free_stay_category_code) : null,
    freeStayReason: freeStay ? row.free_stay_reason ?? null : null
  };
}

export function roomStatusSourceMetadataDamageReason(
  sourceKind: RoomStatusSourceKind,
  row: LodgingSourceProjectionRow,
  options: { allowLegacyHistoricalFreeMetadata: boolean } = { allowLegacyHistoricalFreeMetadata: false }
): string | null {
  const sourceFields = roomStatusOrderSourceFields(row);
  const bookingChannelCode = row.booking_channel_code ?? null;
  const channelReference = normalizedOptionalText(row.channel_order_reference);
  const hasMemberLink = Boolean(row.member_id || row.member_contract_id);
  const hasExternalChannel = bookingChannelCode !== null && externalChannelCodes.has(bookingChannelCode);
  const hasUnknownChannel = bookingChannelCode !== null && bookingChannelCode !== "WECOM" && !hasExternalChannel;
  const hasFreeStayMetadata = row.free_stay_category_code !== null && row.free_stay_category_code !== undefined
    || normalizedOptionalText(row.free_stay_reason) !== null;

  if (sourceKind === "FREE_STAY") {
    if (hasMemberLink || bookingChannelCode !== null || channelReference !== null) {
      return "订单来源类型或免费入住信息无法核对";
    }
    if (sourceFields.sourceCategory !== "FREE_STAY") return "订单来源类型或免费入住信息无法核对";
    if (sourceFields.freeStayCategoryCode === null || !sourceFields.freeStayReason?.trim()) {
      const genuinelyLegacy = row.free_stay_category_code === null || row.free_stay_category_code === undefined;
      return options.allowLegacyHistoricalFreeMetadata && genuinelyLegacy
        ? null
        : "免费入住类型或原因无法核对";
    }
    return null;
  }

  if (hasFreeStayMetadata) return "非免费订单携带了免费入住信息";
  if (hasMemberLink) {
    if (hasExternalChannel || hasUnknownChannel || channelReference !== null) return "会员住宿来源与渠道来源互相矛盾";
    return sourceFields.sourceCategory === "MEMBER" ? null : "会员住宿来源无法核对";
  }
  if (hasExternalChannel) {
    return channelReference !== null ? null : "外部渠道住宿缺少渠道订单号";
  }
  if (hasUnknownChannel) return "订单渠道来源无法识别";
  if (channelReference !== null) return "直订住宿携带了渠道订单号";
  return sourceFields.sourceCategory === "DIRECT" ? null : "订单来源类型无法核对";
}

// Shared with the board: pricing and append-only payment chain must agree before
// a healthy handoff can be exempted from accommodation-night blocking.
export function ordinaryStayMoneyAttention({ order, revisions, facts, currentTimeline }: {
  order: { current_revision_id: string | null; pricing_policy_version_id: string };
  revisions: readonly Pick<Selectable<Database["pricing_revisions"]>, "id" | "coverage_set" | "cash_lines" | "currency" | "policy_version_id" | "pricing_basis" | "policy_base_amount_minor" | "manual_adjustment_minor" | "current_contract_amount_minor">[];
  facts: readonly Pick<Selectable<Database["collection_facts"]>, "fact_id" | "currency" | "amount_minor" | "net_effect_minor" | "pricing_revision_id" | "fact_type" | "references_fact_id" | "reverses_fact_id">[];
  currentTimeline: readonly { serviceDate: string; inventoryUnitId: string }[];
}): "ARREARS" | null {
  const revision = revisions.find((candidate) => candidate.id === order.current_revision_id);
  const revisionsAreConsistent = revisions.every((candidate) => {
    const coverageSet = candidate.coverage_set;
    if (!Array.isArray(coverageSet) || coverageSet.length !== 0) return false;
    const cashLineTotal = candidate.id === order.current_revision_id
      ? ordinaryStayCashLineTotalMinor(candidate.cash_lines, candidate.currency, currentTimeline)
      : pricingCashLineTotalMinor(candidate.cash_lines, candidate.currency);
    return candidate.policy_version_id === order.pricing_policy_version_id
      && (candidate.pricing_basis === "POLICY" || candidate.pricing_basis === "MANUAL_ADJUSTMENT")
      && Number.isSafeInteger(candidate.policy_base_amount_minor)
      && candidate.policy_base_amount_minor >= 0
      && Number.isSafeInteger(candidate.manual_adjustment_minor)
      && Number.isSafeInteger(candidate.current_contract_amount_minor)
      && candidate.current_contract_amount_minor >= 0
      && candidate.current_contract_amount_minor
        === candidate.policy_base_amount_minor + candidate.manual_adjustment_minor
      && (candidate.pricing_basis === "POLICY"
        ? candidate.manual_adjustment_minor === 0
        : candidate.manual_adjustment_minor !== 0)
      && cashLineTotal !== undefined
      && cashLineTotal === candidate.policy_base_amount_minor;
  });
  if (!revision || !revisionsAreConsistent) {
    throw new DomainError("INTERNAL_ERROR", "当前住宿的计价链无法核对", 500);
  }
  const revisionIds = new Set(revisions.map((candidate) => candidate.id));
  const factsById = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const reversedFactIds = new Set<string>();
  const processedFactIds = new Set<string>();
  const activeRefundMinorByCollection = new Map<string, number>();
  let factsMatchRevisionCurrency = true;
  for (const fact of facts) {
    if (fact.currency !== revision.currency
      || !Number.isSafeInteger(fact.amount_minor)
      || fact.amount_minor <= 0
      || !Number.isSafeInteger(fact.net_effect_minor)
      || !fact.pricing_revision_id
      || !revisionIds.has(fact.pricing_revision_id)) {
      factsMatchRevisionCurrency = false;
      break;
    }
    if (fact.fact_type === "COLLECTION") {
      if (fact.net_effect_minor !== fact.amount_minor
        || fact.references_fact_id !== null
        || fact.reverses_fact_id !== null
        || activeRefundMinorByCollection.has(fact.fact_id)) {
        factsMatchRevisionCurrency = false;
        break;
      }
      activeRefundMinorByCollection.set(fact.fact_id, 0);
      processedFactIds.add(fact.fact_id);
      continue;
    }
    if (fact.fact_type === "REFUND") {
      const source = fact.references_fact_id ? factsById.get(fact.references_fact_id) : undefined;
      const activeRefundMinor = source ? activeRefundMinorByCollection.get(source.fact_id) : undefined;
      const nextActiveRefundMinor = activeRefundMinor !== undefined
        ? activeRefundMinor + fact.amount_minor
        : Number.NaN;
      if (fact.net_effect_minor !== -fact.amount_minor
        || fact.reverses_fact_id !== null
        || source?.fact_type !== "COLLECTION"
        || !processedFactIds.has(source.fact_id)
        || reversedFactIds.has(source.fact_id)
        || activeRefundMinor === undefined
        || !Number.isSafeInteger(nextActiveRefundMinor)
        || nextActiveRefundMinor > source.amount_minor) {
        factsMatchRevisionCurrency = false;
        break;
      }
      activeRefundMinorByCollection.set(source.fact_id, nextActiveRefundMinor);
      processedFactIds.add(fact.fact_id);
      continue;
    }
    const source = fact.reverses_fact_id ? factsById.get(fact.reverses_fact_id) : undefined;
    if (fact.references_fact_id !== null
      || !source
      || source.fact_type === "REVERSAL"
      || fact.amount_minor !== source.amount_minor
      || fact.net_effect_minor !== -source.net_effect_minor
      || reversedFactIds.has(source.fact_id)
      || !processedFactIds.has(source.fact_id)) {
      factsMatchRevisionCurrency = false;
      break;
    }
    if (source.fact_type === "REFUND") {
      const refundSource = source.references_fact_id ? factsById.get(source.references_fact_id) : undefined;
      const activeRefundMinor = refundSource ? activeRefundMinorByCollection.get(refundSource.fact_id) : undefined;
      const nextActiveRefundMinor = activeRefundMinor !== undefined
        ? activeRefundMinor - source.amount_minor
        : Number.NaN;
      if (refundSource?.fact_type !== "COLLECTION"
        || activeRefundMinor === undefined
        || !Number.isSafeInteger(nextActiveRefundMinor)
        || nextActiveRefundMinor < 0) {
        factsMatchRevisionCurrency = false;
        break;
      }
      activeRefundMinorByCollection.set(refundSource.fact_id, nextActiveRefundMinor);
    } else {
      const activeRefundMinor = activeRefundMinorByCollection.get(source.fact_id);
      if (activeRefundMinor !== 0) {
        factsMatchRevisionCurrency = false;
        break;
      }
    }
    reversedFactIds.add(source.fact_id);
    processedFactIds.add(fact.fact_id);
  }
  if (factsMatchRevisionCurrency) {
    for (const collection of facts.filter((fact) => fact.fact_type === "COLLECTION")) {
      const activeRefundTotal = activeRefundMinorByCollection.get(collection.fact_id);
      if (activeRefundTotal === undefined
        || !Number.isSafeInteger(activeRefundTotal)
        || activeRefundTotal > collection.amount_minor
        || (reversedFactIds.has(collection.fact_id) && activeRefundTotal !== 0)) {
        factsMatchRevisionCurrency = false;
        break;
      }
    }
  }
  const netRecordedCollectionMinor = facts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
  if (!factsMatchRevisionCurrency
    || !Number.isSafeInteger(netRecordedCollectionMinor)
    || netRecordedCollectionMinor < 0) {
    throw new DomainError("INTERNAL_ERROR", "当前住宿的资金链无法核对", 500);
  }
  return netRecordedCollectionMinor < revision.current_contract_amount_minor ? "ARREARS" : null;
}
