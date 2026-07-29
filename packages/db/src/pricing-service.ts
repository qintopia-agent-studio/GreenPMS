import { sql, type Kysely, type Transaction } from "kysely";
import { DomainError, type InventoryUnitKind, type QuoteDto, type StayType, type StoredQuoteDto } from "@qintopia/contracts";
import { calculatePricing, entitlementKindFor, enumerateServiceDates, isTransientDuration, newId, stableHash, type CoverageCandidate, type DurationBandAnchors, type PricingPolicy } from "@qintopia/domain";
import { entitlementAvailableBalance, parsePostgresBigInt } from "./entitlement-balance.ts";
import { listAvailability, loadInventoryUnit, type DbExecutor } from "./inventory.ts";
import { propertyLocalToday } from "./members.ts";
import type { Database } from "./schema.ts";

export interface QuoteRequest {
  propertyId: string;
  inventoryUnitId: string;
  stayType?: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberId?: string;
  memberContractId?: string;
  requesterSubjectId?: string;
}

interface MemberCoverageResolution {
  memberContractId?: string;
  coverageCandidates: CoverageCandidate[];
}

export async function resolveMemberCoverage(db: DbExecutor, options: {
  propertyId: string;
  memberId: string;
  inventoryUnitKind: InventoryUnitKind;
  roomTypeCode: string | null;
  dates: string[];
  preserved?: CoverageCandidate[];
  reallocatableHeld?: CoverageCandidate[];
}): Promise<MemberCoverageResolution> {
  const member = await db.selectFrom("member_property_links")
    .select("member_id")
    .where("member_id", "=", options.memberId)
    .where("property_id", "=", options.propertyId)
    .executeTakeFirst();
  if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员档案", 404);
  if (!options.roomTypeCode) throw new DomainError("ENTITLEMENT_CONFLICT", "所选房源缺少会员房型信息，不能使用会员权益", 409);

  const propertyToday = await propertyLocalToday(db, options.propertyId);
  const rows = await db.selectFrom("membership_orders")
    .innerJoin("member_contracts", "member_contracts.id", "membership_orders.contract_id")
    .innerJoin("entitlement_lots", "entitlement_lots.id", "membership_orders.entitlement_lot_id")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select([
      "membership_orders.allowed_room_type_code",
      "membership_orders.allowed_inventory_kind",
      "membership_orders.entitlement_unit_kind",
      "member_contracts.id as contract_id",
      "member_contracts.valid_from",
      "member_contracts.valid_until",
      "entitlement_lots.id as lot_id",
      "entitlement_lots.expires_on",
      "entitlement_lots.total_units",
      sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
      sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
    ])
    .where("membership_orders.member_id", "=", options.memberId)
    .where("membership_orders.property_id", "=", options.propertyId)
    .where("membership_orders.status", "=", "ACTIVE")
    .where("member_contracts.status", "=", "ACTIVE")
    .groupBy([
      "membership_orders.allowed_room_type_code",
      "membership_orders.allowed_inventory_kind",
      "membership_orders.entitlement_unit_kind",
      "member_contracts.id",
      "member_contracts.valid_from",
      "member_contracts.valid_until",
      "entitlement_lots.id",
      "entitlement_lots.expires_on",
      "entitlement_lots.total_units"
    ])
    .execute();

  const preservedSource = options.preserved ?? [];
  const preserved = preservedSource.filter((item) => options.dates.includes(item.serviceDate));
  const hasConsumedCoverageHistory = preservedSource.some((item) => item.status === "CONSUMED");
  const matching = rows.filter((row) => row.allowed_room_type_code === options.roomTypeCode
    && row.allowed_inventory_kind === options.inventoryUnitKind
    && row.entitlement_unit_kind === entitlementKindFor(options.inventoryUnitKind));
  if (matching.length === 0) {
    if (hasConsumedCoverageHistory) return { coverageCandidates: preserved };
    throw new DomainError("ENTITLEMENT_CONFLICT", "该会员的已生效权益不适用于所选房型", 409);
  }
  const validForStay = matching.filter((row) => row.expires_on >= propertyToday
    && parsePostgresBigInt(row.expire_count, "Entitlement expiration count") === 0n
    && options.dates.some((date) => row.valid_from <= date && date <= row.valid_until && date <= row.expires_on));
  if (validForStay.length === 0) return { coverageCandidates: preserved };

  const remaining = new Map(validForStay.map((row) => [
    row.lot_id,
    entitlementAvailableBalance(row.total_units, row.ledger_delta)
  ]));
  for (const held of options.reallocatableHeld ?? []) {
    if (held.status !== "HELD") continue;
    remaining.set(held.entitlementLotId, (remaining.get(held.entitlementLotId) ?? 0) + 1);
  }
  const coverageCandidates: CoverageCandidate[] = [...preserved];
  const alreadyCovered = new Set(preserved.map((item) => item.serviceDate));
  const usedContractIds = new Set<string>();
  for (const serviceDate of options.dates) {
    if (alreadyCovered.has(serviceDate)) continue;
    const eligible = validForStay.filter((row) => row.valid_from <= serviceDate
      && serviceDate <= row.valid_until
      && serviceDate <= row.expires_on
      && (remaining.get(row.lot_id) ?? 0) > 0);
    if (eligible.length > 1) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "该会员有多份权益可覆盖同一住宿日期，消耗顺序尚未确认，暂不能创建会员住宿", 409);
    }
    const selected = eligible[0];
    if (!selected) continue;
    remaining.set(selected.lot_id, (remaining.get(selected.lot_id) ?? 0) - 1);
    usedContractIds.add(selected.contract_id);
    coverageCandidates.push({ serviceDate, entitlementLotId: selected.lot_id });
  }
  const validContractIds = new Set(validForStay.map((row) => row.contract_id));
  const memberContractId = usedContractIds.size === 1
    ? usedContractIds.values().next().value
    : usedContractIds.size === 0 && validContractIds.size === 1
      ? validContractIds.values().next().value
      : undefined;
  return { ...(memberContractId ? { memberContractId } : {}), coverageCandidates };
}

export type StoredQuote = StoredQuoteDto;

export async function loadPricingPolicy(db: DbExecutor, propertyId: string, policyVersionId: string): Promise<PricingPolicy> {
  const row = await db.selectFrom("pricing_policy_versions")
    .selectAll()
    .where("id", "=", policyVersionId)
    .where("property_id", "=", propertyId)
    .where("status", "=", "PUBLISHED")
    .executeTakeFirst();
  if (!row) throw new DomainError("POLICY_VERSION_NOT_FOUND", "Pricing policy version not found", 404);
  const rawAnchors = typeof row.product_anchor_rates_minor === "string" ? JSON.parse(row.product_anchor_rates_minor) as unknown : row.product_anchor_rates_minor;
  const productAnchorRatesMinor = row.calculation_kind === "DURATION_BAND_TOTAL" ? rawAnchors as Record<string, DurationBandAnchors> : null;
  return {
    id: row.id,
    stayType: row.stay_type as StayType | null,
    calculationKind: row.calculation_kind,
    nightlyRateMinor: row.nightly_rate_minor,
    productAnchorRatesMinor,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    roundingRule: row.rounding_rule,
    currency: row.currency
  };
}

export async function allocateCoverageCandidates(db: DbExecutor, options: {
  propertyId: string;
  memberContractId?: string;
  inventoryUnitKind: InventoryUnitKind;
  dates: string[];
  preserved?: CoverageCandidate[];
  reallocatableHeld?: CoverageCandidate[];
}): Promise<CoverageCandidate[]> {
  if (!options.memberContractId) return options.preserved ?? [];
  const contract = await db.selectFrom("member_contracts")
    .selectAll()
    .where("id", "=", options.memberContractId)
    .where("property_id", "=", options.propertyId)
    .executeTakeFirst();
  if (!contract || contract.status !== "ACTIVE") throw new DomainError("ENTITLEMENT_CONFLICT", "Membership contract is not active", 409);

  const unitKind = entitlementKindFor(options.inventoryUnitKind);
  const propertyToday = await propertyLocalToday(db, options.propertyId);
  const lots = await db.selectFrom("entitlement_lots")
    .leftJoin("entitlement_ledger", "entitlement_ledger.lot_id", "entitlement_lots.id")
    .select([
      "entitlement_lots.id",
      "entitlement_lots.expires_on",
      "entitlement_lots.total_units",
      sql<string>`cast(coalesce(sum(entitlement_ledger.quantity_delta), 0) as text)`.as("ledger_delta"),
      sql<string>`cast(count(*) filter (where entitlement_ledger.entry_type = 'EXPIRE') as text)`.as("expire_count")
    ])
    .where("entitlement_lots.contract_id", "=", options.memberContractId)
    .where("entitlement_lots.unit_kind", "=", unitKind)
    .groupBy(["entitlement_lots.id", "entitlement_lots.expires_on", "entitlement_lots.total_units"])
    .orderBy("entitlement_lots.expires_on")
    .orderBy("entitlement_lots.id")
    .execute();

  const eligibleLots = lots.filter((lot) => lot.expires_on >= propertyToday
    && parsePostgresBigInt(lot.expire_count, "Entitlement expiration count") === 0n);
  const remaining = new Map(eligibleLots.map((lot) => [lot.id, entitlementAvailableBalance(lot.total_units, lot.ledger_delta)]));
  for (const held of options.reallocatableHeld ?? []) {
    if (held.status !== "HELD") continue;
    remaining.set(held.entitlementLotId, (remaining.get(held.entitlementLotId) ?? 0) + 1);
  }
  const result: CoverageCandidate[] = [];
  for (const preserved of options.preserved ?? []) {
    if (options.dates.includes(preserved.serviceDate)) result.push(preserved);
  }
  const alreadyCovered = new Set(result.map((candidate) => candidate.serviceDate));
  for (const serviceDate of options.dates) {
    if (alreadyCovered.has(serviceDate)) continue;
    if (serviceDate < contract.valid_from || serviceDate > contract.valid_until) continue;
    const eligible = eligibleLots.filter((candidate) => candidate.expires_on >= serviceDate && (remaining.get(candidate.id) ?? 0) > 0);
    if (eligible.length > 1) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "该会员有多份权益可覆盖同一住宿日期，消耗顺序尚未确认，暂不能调整住宿日期", 409);
    }
    const lot = eligible[0];
    if (!lot) continue;
    remaining.set(lot.id, (remaining.get(lot.id) ?? 0) - 1);
    result.push({ serviceDate, entitlementLotId: lot.id });
  }
  return result.sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
}

async function enforceQuoteQuota(db: Transaction<Database>, propertyId: string, requesterSubjectId?: string): Promise<void> {
  if (!requesterSubjectId) return;
  const active = await db.selectFrom("quotes")
    .select(sql<string>`cast(count(*) as text)`.as("count"))
    .where("requester_subject_id", "=", requesterSubjectId)
    .where("property_id", "=", propertyId)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  const activeCount = parsePostgresBigInt(active.count, "Active quote count");
  if (activeCount >= 200n) {
    throw new DomainError("RATE_LIMITED", "A subject may hold at most 200 unexpired quotes", 429, true, {
      activeQuoteCount: activeCount.toString(),
      limit: 200
    });
  }
}

export async function createQuoteInTransaction(db: Transaction<Database>, request: QuoteRequest): Promise<StoredQuote> {
  await enforceQuoteQuota(db, request.propertyId, request.requesterSubjectId);
  const unit = await loadInventoryUnit(db, request.propertyId, request.inventoryUnitId);
  const policy = await loadPricingPolicy(db, request.propertyId, request.pricingPolicyVersionId);
  const availability = await listAvailability(db, request.propertyId, request.arrivalDate, request.departureDate, unit.kind);
  const selected = availability.find((candidate) => candidate.id === unit.id);
  const dates = enumerateServiceDates(request.arrivalDate, request.departureDate);
  const derivedPaidStayType = isTransientDuration(dates.length) ? "TRANSIENT" : "CUSTOM";
  const stayType = request.stayType === "FREE" ? "FREE" : derivedPaidStayType;
  if (request.memberId && request.memberContractId) {
    throw new DomainError("VALIDATION_ERROR", "会员报价只能选择会员档案，不能同时指定会员合同");
  }
  if (request.stayType !== undefined && request.stayType !== "FREE" && request.stayType !== derivedPaidStayType) {
    throw new DomainError(
      "PRICING_POLICY_UNCONFIGURED",
      `住宿类型与 ${dates.length} 晚住宿不一致，请重新报价`,
      422
    );
  }
  if (stayType === "FREE" && (request.memberId || request.memberContractId)) {
    throw new DomainError("PRICING_POLICY_UNCONFIGURED", "Free stays cannot use member entitlement coverage", 409);
  }
  if (!selected) throw new DomainError("NOT_FOUND", "Inventory unit not found", 404);
  if (!selected.available) {
    const firstBlockedIndex = selected.nights.findIndex((night) => !night.available);
    const firstBlocked = selected.nights[firstBlockedIndex];
    let endIndex = firstBlockedIndex;
    while (endIndex + 1 < selected.nights.length && !selected.nights[endIndex + 1]!.available) endIndex += 1;
    const overlapEnd = dates[endIndex + 1] ?? request.departureDate;
    throw new DomainError(
      "INVENTORY_CONFLICT",
      `${unit.code} 在 ${firstBlocked!.serviceDate} 至 ${overlapEnd} 已有住宿，不能重复安排`,
      409,
      false,
      {
        inventoryUnitCode: unit.code,
        overlapStartDate: firstBlocked!.serviceDate,
        overlapEndDate: overlapEnd,
        claimIds: firstBlocked!.blockingClaimIds
      }
    );
  }
  const memberCoverage = request.memberId
    ? await resolveMemberCoverage(db, {
      propertyId: request.propertyId,
      memberId: request.memberId,
      inventoryUnitKind: unit.kind,
      roomTypeCode: unit.roomTypeCode,
      dates
    })
    : {
      memberContractId: request.memberContractId,
      coverageCandidates: await allocateCoverageCandidates(db, {
        propertyId: request.propertyId,
        inventoryUnitKind: unit.kind,
        dates,
        ...(request.memberContractId ? { memberContractId: request.memberContractId } : {})
      })
    };
  const coverageCandidates = memberCoverage.coverageCandidates;
  const calculated = calculatePricing({
    propertyId: request.propertyId,
    inventoryUnitId: unit.id,
    inventoryUnitKind: unit.kind,
    inventoryProductCode: unit.pricingProductCode,
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    stayType,
    policy,
    memberCoverage: Boolean(request.memberId || request.memberContractId),
    coverageCandidates
  });
  const quoteId = newId("quote");
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const normalizedRequest = { ...request, stayType };
  const inputHash = stableHash(normalizedRequest);
  await db.insertInto("quotes").values({
    id: quoteId,
    property_id: request.propertyId,
    inventory_unit_id: unit.id,
    stay_type: stayType,
    arrival_date: request.arrivalDate,
    departure_date: request.departureDate,
    policy_version_id: policy.id,
    member_id: request.memberId ?? null,
    member_contract_id: memberCoverage.memberContractId ?? null,
    requester_subject_id: request.requesterSubjectId ?? null,
    input_hash: inputHash,
    coverage_set: JSON.stringify(calculated.coverageSet),
    cash_lines: JSON.stringify(calculated.cashLines),
    cash_remainder_minor: calculated.cashRemainder.minorUnits,
    current_contract_amount_minor: calculated.currentContractAmount.minorUnits,
    currency: policy.currency,
    expires_at: expiresAt
  }).execute();
  return {
    quoteId,
    propertyId: request.propertyId,
    inventoryUnitId: unit.id,
    stayType,
    arrivalDate: request.arrivalDate,
    departureDate: request.departureDate,
    pricingPolicyVersionId: policy.id,
    coverageSet: calculated.coverageSet,
    cashLines: calculated.cashLines,
    cashRemainder: calculated.cashRemainder,
    currentContractAmount: calculated.currentContractAmount,
    expiresAt: expiresAt.toISOString(),
    ...(request.memberId ? { memberId: request.memberId } : {}),
    ...(memberCoverage.memberContractId ? { memberContractId: memberCoverage.memberContractId } : {}),
    inputHash
  };
}

async function createQuoteSnapshot(db: Kysely<Database>, request: QuoteRequest): Promise<StoredQuote> {
  return db.transaction().setIsolationLevel("repeatable read").execute((trx) => createQuoteInTransaction(trx, request));
}

export async function createQuoteForTesting(db: Kysely<Database>, request: QuoteRequest): Promise<StoredQuote> {
  if (!request.requesterSubjectId) return createQuoteSnapshot(db, request);
  const lockKey = `qintopia:quote:${request.requesterSubjectId}`;
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    try {
      return await createQuoteSnapshot(connection, request);
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0::bigint))`.execute(connection);
    }
  });
}

export async function loadStoredQuote(db: DbExecutor, quoteId: string, requireFresh = true): Promise<StoredQuote> {
  const row = await db.selectFrom("quotes").selectAll().where("id", "=", quoteId).executeTakeFirst();
  if (!row) throw new DomainError("NOT_FOUND", "Quote not found", 404);
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (requireFresh && expiresAt.getTime() <= Date.now()) throw new DomainError("QUOTE_EXPIRED", "Quote has expired", 409);
  return {
    quoteId: row.id,
    propertyId: row.property_id,
    inventoryUnitId: row.inventory_unit_id,
    stayType: row.stay_type as StayType,
    arrivalDate: row.arrival_date,
    departureDate: row.departure_date,
    pricingPolicyVersionId: row.policy_version_id,
    coverageSet: row.coverage_set as QuoteDto["coverageSet"],
    cashLines: row.cash_lines as QuoteDto["cashLines"],
    cashRemainder: { currency: row.currency, minorUnits: row.cash_remainder_minor },
    currentContractAmount: { currency: row.currency, minorUnits: row.current_contract_amount_minor },
    expiresAt: expiresAt.toISOString(),
    ...(row.member_id ? { memberId: row.member_id } : {}),
    ...(row.member_contract_id ? { memberContractId: row.member_contract_id } : {}),
    inputHash: row.input_hash
  };
}

export async function lockEntitlementLots(trx: Transaction<Database>, contractId?: string): Promise<void> {
  if (!contractId) return;
  await trx.selectFrom("member_contracts").select("id").where("id", "=", contractId).forUpdate().executeTakeFirstOrThrow();
  await trx.selectFrom("entitlement_lots").select("id").where("contract_id", "=", contractId).orderBy("id").forUpdate().execute();
}

export async function lockMemberEntitlementLots(
  trx: Transaction<Database>,
  propertyId: string,
  memberId: string
): Promise<void> {
  const contracts = await trx.selectFrom("member_contracts")
    .select("id")
    .where("property_id", "=", propertyId)
    .where("member_id", "=", memberId)
    .orderBy("id")
    .forUpdate()
    .execute();
  const contractIds = contracts.map((contract) => contract.id);
  if (contractIds.length === 0) return;
  await trx.selectFrom("entitlement_lots")
    .select("id")
    .where("contract_id", "in", contractIds)
    .orderBy("id")
    .forUpdate()
    .execute();
}
