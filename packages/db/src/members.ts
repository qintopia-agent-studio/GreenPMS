import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "kysely";
import { DomainError } from "@qintopia/contracts";
import { entitlementAvailableBalance } from "./entitlement-balance.ts";
import type { DbExecutor } from "./inventory.ts";

const propertyClockForTesting = new AsyncLocalStorage<Date>();
const propertyOperationClockSnapshot = new AsyncLocalStorage<Date>();
const authoritativePropertyWallClockForTesting = new AsyncLocalStorage<{ instant: Date }>();

function assertValidClockInstant(instant: Date, label: string): void {
  if (!Number.isFinite(instant.getTime())) throw new Error(`${label} is invalid`);
}

export function withPropertyClockForTesting<T>(instant: Date, operation: () => Promise<T>): Promise<T> {
  assertValidClockInstant(instant, "Test property clock instant");
  return propertyClockForTesting.run(new Date(instant), operation);
}

export interface MutablePropertyWallClockForTesting {
  get(): Date;
  set(instant: Date): void;
}

export function withMutablePropertyWallClockForTesting<T>(
  initialInstant: Date,
  operation: (clock: MutablePropertyWallClockForTesting) => Promise<T>
): Promise<T> {
  assertValidClockInstant(initialInstant, "Test property wall clock instant");
  const state = { instant: new Date(initialInstant) };
  const clock: MutablePropertyWallClockForTesting = {
    get: () => new Date(state.instant),
    set: (instant: Date) => {
      assertValidClockInstant(instant, "Test property wall clock instant");
      state.instant = new Date(instant);
    }
  };
  return authoritativePropertyWallClockForTesting.run(state, () => operation(clock));
}

export function withPropertyOperationClockSnapshot<T>(instant: Date, operation: () => Promise<T>): Promise<T> {
  assertValidClockInstant(instant, "Property operation clock snapshot");
  return propertyOperationClockSnapshot.run(new Date(instant), operation);
}

export async function sampleAuthoritativePropertyWallClock(db: DbExecutor): Promise<Date> {
  const testingClock = authoritativePropertyWallClockForTesting.getStore();
  if (testingClock) return new Date(testingClock.instant);
  const legacyTestingClock = propertyClockForTesting.getStore();
  if (legacyTestingClock) return new Date(legacyTestingClock);
  const clock = await sql<{ as_of: Date }>`select clock_timestamp() as as_of`.execute(db);
  return new Date(clock.rows[0]!.as_of);
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

export function propertyLocalClockAt(timeZone: string, databaseInstant: Date): { date: string; time: string } {
  return localClockInTimeZone(timeZone, propertyOperationClockSnapshot.getStore() ?? propertyClockForTesting.getStore() ?? databaseInstant);
}

export async function propertyLocalClock(db: DbExecutor, propertyId: string): Promise<{ date: string; time: string }> {
  const property = await db.selectFrom("properties")
    .select(["timezone", sql<Date>`transaction_timestamp()`.as("as_of")])
    .where("id", "=", propertyId)
    .executeTakeFirst();
  if (!property) throw new DomainError("NOT_FOUND", "Property not found", 404);
  return propertyLocalClockAt(property.timezone, new Date(property.as_of));
}

export async function propertyLocalToday(db: DbExecutor, propertyId: string): Promise<string> {
  return (await propertyLocalClock(db, propertyId)).date;
}

interface MemberProfileCorrectionSensitiveFields {
  prior_identity_card_number: string | null;
  prior_phone: string;
  prior_wechat: string;
  corrected_identity_card_number: string | null;
  corrected_phone: string;
  corrected_wechat: string;
}

export function maskIdentityCardNumber(value: string | null): string | null {
  if (value === null) return null;
  const characters = Array.from(value);
  if (characters.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, characters.length - 4))}${characters.slice(-4).join("")}`;
}

export function maskPhone(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 7) return "****";
  return `${characters.slice(0, 3).join("")}****${characters.slice(-4).join("")}`;
}

export function maskWechat(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 3) return "***";
  return `${characters[0]}***${characters.slice(-2).join("")}`;
}

export function projectMemberViewForRead<T extends { profileCorrections: readonly MemberProfileCorrectionSensitiveFields[] }>(view: T) {
  return {
    ...view,
    profileCorrections: view.profileCorrections.map((correction) => ({
      ...correction,
      prior_identity_card_number: maskIdentityCardNumber(correction.prior_identity_card_number),
      prior_phone: maskPhone(correction.prior_phone),
      prior_wechat: maskWechat(correction.prior_wechat),
      corrected_identity_card_number: maskIdentityCardNumber(correction.corrected_identity_card_number),
      corrected_phone: maskPhone(correction.corrected_phone),
      corrected_wechat: maskWechat(correction.corrected_wechat)
    }))
  };
}

export async function getMemberView(db: DbExecutor, propertyId: string, memberId: string) {
  const balanceAsOfDate = await propertyLocalToday(db, propertyId);
  const member = await db.selectFrom("members")
    .where("members.deleted_at", "is", null)
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
  const [
    profileCorrections,
    effectiveDateCorrections,
    historicalMembershipBackfills,
    paymentReclassifications,
    voidReconversions
  ] = await Promise.all([
    db.selectFrom("member_profile_corrections")
      .innerJoin("command_executions", "command_executions.id", "member_profile_corrections.command_id")
      .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("member_profile_corrections")
      .select(["command_executions.subject_id as actor_subject_id", "subjects.display_name as actor_display_name"])
      .where("member_profile_corrections.member_id", "=", memberId)
      .where("member_profile_corrections.property_id", "=", propertyId)
      .orderBy("sequence")
      .orderBy("member_profile_corrections.id")
      .execute(),
    db.selectFrom("membership_effective_date_corrections")
      .innerJoin("command_executions", "command_executions.id", "membership_effective_date_corrections.command_id")
      .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("membership_effective_date_corrections")
      .select(["command_executions.subject_id as actor_subject_id", "subjects.display_name as actor_display_name"])
      .where("membership_effective_date_corrections.member_id", "=", memberId)
      .where("membership_effective_date_corrections.property_id", "=", propertyId)
      .orderBy("membership_effective_date_corrections.created_at")
      .orderBy("membership_effective_date_corrections.id")
      .execute(),
    db.selectFrom("historical_membership_backfills")
      .innerJoin("command_executions", "command_executions.id", "historical_membership_backfills.command_id")
      .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("historical_membership_backfills")
      .select(["command_executions.subject_id as actor_subject_id", "subjects.display_name as actor_display_name"])
      .where("historical_membership_backfills.member_id", "=", memberId)
      .where("historical_membership_backfills.property_id", "=", propertyId)
      .orderBy("historical_membership_backfills.created_at")
      .orderBy("historical_membership_backfills.id")
      .execute(),
    db.selectFrom("membership_payment_reclassifications")
      .innerJoin("command_executions", "command_executions.id", "membership_payment_reclassifications.command_id")
      .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
      .selectAll("membership_payment_reclassifications")
      .select(["command_executions.subject_id as actor_subject_id", "subjects.display_name as actor_display_name"])
      .where("membership_payment_reclassifications.member_id", "=", memberId)
      .where("membership_payment_reclassifications.property_id", "=", propertyId)
      .orderBy("membership_payment_reclassifications.created_at")
      .orderBy("membership_payment_reclassifications.id")
      .execute(),
    db.selectFrom("membership_void_reconversions")
      .innerJoin("command_executions", "command_executions.id", "membership_void_reconversions.command_id")
      .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
      .innerJoin("membership_orders as reconversion_membership_order", "reconversion_membership_order.id", "membership_void_reconversions.new_membership_order_id")
      .selectAll("membership_void_reconversions")
      .select(["command_executions.subject_id as actor_subject_id", "subjects.display_name as actor_display_name", "reconversion_membership_order.currency as currency"])
      .where("membership_void_reconversions.member_id", "=", memberId)
      .where("membership_void_reconversions.property_id", "=", propertyId)
      .orderBy("membership_void_reconversions.created_at")
      .orderBy("membership_void_reconversions.id")
      .execute()
  ]);
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
    const product = membershipProducts.find((item) => item.id === order.product_id);
    if (!product) throw new DomainError("INTERNAL_ERROR", "会员订单缺少产品有效期规则", 500);
    return {
      order: { ...order, validity_period: product.validity_period },
      paymentFacts,
      paymentTotalMinor,
      paymentDifferenceMinor: paymentTotalMinor - order.agreed_price_minor
    };
  });
  return projectMemberViewForRead({
    member,
    contracts,
    lots,
    ledger,
    externalReferences,
    lotBalances,
    availableBalance,
    balanceAsOfDate,
    membershipProducts,
    membershipOrders,
    profileCorrections: profileCorrections.map(({ actor_subject_id, actor_display_name, ...correction }) => ({
      ...correction,
      actor: { subjectId: actor_subject_id, displayName: actor_display_name }
    })),
    effectiveDateCorrections: effectiveDateCorrections.map(({ actor_subject_id, actor_display_name, ...correction }) => ({
      ...correction,
      actor: { subjectId: actor_subject_id, displayName: actor_display_name }
    })),
    historicalMembershipBackfills: historicalMembershipBackfills.map(({ actor_subject_id, actor_display_name, ...backfill }) => ({
      ...backfill,
      actor: { subjectId: actor_subject_id, displayName: actor_display_name }
    })),
    paymentReclassifications: paymentReclassifications.map(({ actor_subject_id, actor_display_name, ...reclassification }) => ({
      ...reclassification,
      actor: { subjectId: actor_subject_id, displayName: actor_display_name }
    })),
    voidReconversions: voidReconversions.map(({ actor_subject_id, actor_display_name, ...reconversion }) => ({
      ...reconversion,
      actor: { subjectId: actor_subject_id, displayName: actor_display_name }
    }))
  });
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listMemberSummaries(db: DbExecutor, propertyId: string, query?: string) {
  let selection = db.selectFrom("members")
    .where("members.deleted_at", "is", null)
    .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
    .selectAll("members")
    .where("member_property_links.property_id", "=", propertyId);
  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    selection = selection.where(sql<boolean>`(
      members.full_name ILIKE ${pattern} ESCAPE '\\'
      OR members.nickname ILIKE ${pattern} ESCAPE '\\'
      OR members.phone ILIKE ${pattern} ESCAPE '\\'
      OR members.wechat ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  const members = await selection.orderBy("members.full_name").orderBy("members.id").execute();
  return members.map((member) => ({ member }));
}
