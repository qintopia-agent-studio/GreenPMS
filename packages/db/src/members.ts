import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { entitlementAvailableBalance } from "./entitlement-balance.ts";
import type { DbExecutor } from "./inventory.ts";

const propertyClockForTesting = new AsyncLocalStorage<Date>();

export function withPropertyClockForTesting<T>(instant: Date, operation: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(instant.getTime())) throw new Error("Test property clock instant is invalid");
  return propertyClockForTesting.run(new Date(instant), operation);
}

export function localDateInTimeZone(timeZone: string, instant = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function localClockInTimeZone(timeZone: string, instant = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

export async function propertyLocalClock(db: DbExecutor, propertyId: string): Promise<{ date: string; time: string }> {
  const property = await db.selectFrom("properties")
    .select(["timezone", sql<Date>`transaction_timestamp()`.as("as_of")])
    .where("id", "=", propertyId)
    .executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
  return localClockInTimeZone(property.timezone, propertyClockForTesting.getStore() ?? new Date(property.as_of));
}

export async function propertyLocalToday(db: DbExecutor, propertyId: string): Promise<string> {
  return (await propertyLocalClock(db, propertyId)).date;
}

export async function getMemberView(db: DbExecutor, propertyId: string, memberId: string) {
  const balanceAsOfDate = await propertyLocalToday(db, propertyId);
  const member = await db.selectFrom("members")
    .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
    .selectAll("members")
    .where("members.id", "=", memberId)
    .where("member_property_links.property_id", "=", propertyId)
    .executeTakeFirst();
  if (!member) throw new DomainError("NOT_FOUND", "Member not found for this property", 404);
  const contracts = await db.selectFrom("member_contracts").selectAll()
    .where("member_id", "=", memberId)
    .where("property_id", "=", propertyId)
    .orderBy("valid_from", "desc")
    .orderBy("id")
    .execute();
  const contractIds = contracts.map((contract) => contract.id);
  const lots = contractIds.length > 0
    ? await db.selectFrom("entitlement_lots").selectAll()
      .where("contract_id", "in", contractIds)
      .orderBy("expires_on")
      .orderBy("id")
      .execute()
    : [];
  const lotIds = lots.map((lot) => lot.id);
  const ledger = lotIds.length > 0
    ? await db.selectFrom("entitlement_ledger").selectAll()
      .where("lot_id", "in", lotIds)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
    : [];
  const ledgerDeltaByLot = new Map<string, number>();
  for (const entry of ledger) {
    ledgerDeltaByLot.set(entry.lot_id, (ledgerDeltaByLot.get(entry.lot_id) ?? 0) + entry.quantity_delta);
  }
  const contractStatusById = new Map(contracts.map((contract) => [contract.id, contract.status]));
  const lotBalances = lots.map((lot) => ({
    lotId: lot.id,
    unitKind: lot.unit_kind,
    availableUnits: contractStatusById.get(lot.contract_id) !== "ACTIVE" || lot.expires_on < balanceAsOfDate
      ? 0
      : entitlementAvailableBalance(lot.total_units, ledgerDeltaByLot.get(lot.id) ?? 0)
  }));
  const availableBalance = lotBalances.reduce((total, lot) => {
    total[lot.unitKind] += lot.availableUnits;
    return total;
  }, { ROOM_NIGHT: 0, BED_NIGHT: 0 });
  if (!Number.isSafeInteger(availableBalance.ROOM_NIGHT) || !Number.isSafeInteger(availableBalance.BED_NIGHT)) {
    throw new DomainError("INTERNAL_ERROR", "Member entitlement balance exceeds the supported integer range", 500);
  }
  const externalReferences = await db.selectFrom("member_external_references").selectAll()
    .where("member_id", "=", memberId)
    .where("property_id", "=", propertyId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const membershipProducts = await db.selectFrom("membership_products").selectAll()
    .where("status", "=", "PUBLISHED")
    .orderBy("list_price_minor")
    .orderBy("code")
    .execute();
  const membershipOrderRows = await db.selectFrom("membership_orders").selectAll()
    .where("member_id", "=", memberId)
    .where("property_id", "=", propertyId)
    .orderBy("created_at", "desc")
    .orderBy("id")
    .execute();
  const membershipOrderIds = membershipOrderRows.map((order) => order.id);
  const membershipPaymentFacts = membershipOrderIds.length > 0
    ? await db.selectFrom("membership_payment_facts").selectAll()
      .where("membership_order_id", "in", membershipOrderIds)
      .orderBy("created_at")
      .orderBy("fact_id")
      .execute()
    : [];
  const factsByOrder = new Map<string, typeof membershipPaymentFacts>();
  for (const fact of membershipPaymentFacts) {
    const facts = factsByOrder.get(fact.membership_order_id) ?? [];
    facts.push(fact);
    factsByOrder.set(fact.membership_order_id, facts);
  }
  const membershipOrders = membershipOrderRows.map((order) => {
    const paymentFacts = factsByOrder.get(order.id) ?? [];
    const paymentTotalMinor = paymentFacts.reduce((sum, fact) => sum + fact.net_effect_minor, 0);
    if (!Number.isSafeInteger(paymentTotalMinor)) throw new DomainError("INTERNAL_ERROR", "会员订单收款合计超出支持范围", 500);
    return {
      order,
      paymentFacts,
      paymentTotalMinor,
      paymentDifferenceMinor: paymentTotalMinor - order.agreed_price_minor
    };
  });
  return { member, contracts, lots, ledger, externalReferences, lotBalances, availableBalance, balanceAsOfDate, membershipProducts, membershipOrders };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listMemberSummaries(db: DbExecutor, propertyId: string, query?: string) {
  let selection = db.selectFrom("members")
    .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
    .selectAll("members")
    .where("member_property_links.property_id", "=", propertyId);
  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    selection = selection.where(sql<boolean>`(
      members.full_name ILIKE ${pattern} ESCAPE '\\'
      OR members.identity_card_number ILIKE ${pattern} ESCAPE '\\'
      OR members.phone ILIKE ${pattern} ESCAPE '\\'
      OR members.wechat ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  const members = await selection.orderBy("members.full_name").orderBy("members.id").execute();
  return members.map((member) => ({ member }));
}
