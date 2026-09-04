import { sql, type Selectable, type Transaction } from "kysely";
import { DomainError, type CommandReason } from "@qintopia/contracts";
import {
  enumerateServiceDates,
  newId,
  parseLocalDate,
  requireTransactionReference,
  stableHash
} from "@qintopia/domain";
import { entitlementAvailableBalance } from "../entitlement-balance.ts";
import type { DbExecutor } from "../inventory.ts";
import { getMemberView, propertyLocalToday } from "../members.ts";
import { getOrderViewSnapshot } from "../orders.ts";
import type { Database } from "../schema.ts";

export const memberCorrectionCommandTypes = [
  "CORRECT_MEMBER_PROFILE",
  "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
  "BACKFILL_HISTORICAL_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
] as const;

export type MemberCorrectionCommandType = (typeof memberCorrectionCommandTypes)[number];

export interface BuiltMemberCorrectionEffect {
  propertyId: string;
  effect: Record<string, unknown>;
  basisVersions: Record<string, unknown>;
  effectHash: string;
}

export interface AppliedMemberCorrection {
  persistedResult: Record<string, unknown>;
  resourceRefs: string[];
  factRefs: string[];
}

export function isMemberCorrectionCommandType(value: string): value is MemberCorrectionCommandType {
  return (memberCorrectionCommandTypes as readonly string[]).includes(value);
}

function object(value: unknown, field = "input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(input: Record<string, unknown>, field: string, maximum = 2_000): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) throw new DomainError("VALIDATION_ERROR", `${field} is too long`);
  return normalized;
}

function integer(input: Record<string, unknown>, field: string, minimum = 0): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 2_147_483_647) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be a supported integer`);
  }
  return value as number;
}

function localDate(input: Record<string, unknown>, field: string): string {
  const value = string(input, field, 10);
  parseLocalDate(value);
  return value;
}

function phone(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "phone must be a string");
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) throw new DomainError("VALIDATION_ERROR", "phone is required");
  if (normalized.length > 80) throw new DomainError("VALIDATION_ERROR", "phone is too long");
  return normalized;
}

function identity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "identityCardNumber must be a string or null");
  const normalized = value.trim().toUpperCase();
  if (normalized.length > 200) throw new DomainError("VALIDATION_ERROR", "identityCardNumber is too long");
  return normalized || null;
}

function money(currency: string, minorUnits: number) {
  return { currency, minorUnits };
}

function addOneCalendarYear(value: string): string {
  const parsed = parseLocalDate(value);
  const year = parsed.getUTCFullYear() + 1;
  const month = parsed.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(parsed.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

function finalize(
  propertyId: string,
  effect: Record<string, unknown>,
  basisVersions: Record<string, unknown>
): BuiltMemberCorrectionEffect {
  return { propertyId, effect, basisVersions, effectHash: stableHash({ effect, basisVersions }) };
}

function profileSnapshot(input: Record<string, unknown>, field: string) {
  const profile = object(input[field], field);
  if (!Object.hasOwn(profile, "identityCardNumber")) {
    throw new DomainError("VALIDATION_ERROR", `${field}.identityCardNumber is required`);
  }
  return {
    fullName: string(profile, "fullName", 200),
    nickname: string(profile, "nickname", 200),
    identityCardNumber: identity(profile.identityCardNumber),
    phone: phone(profile.phone),
    wechat: string(profile, "wechat", 200)
  };
}

export function normalizeMemberCorrectionInput(
  commandType: MemberCorrectionCommandType,
  rawInput: unknown
): Record<string, unknown> {
  const input = object(rawInput);
  const propertyId = string(input, "propertyId");
  const evidenceNote = string(input, "evidenceNote");
  if (commandType === "CORRECT_MEMBER_PROFILE") {
    return {
      propertyId,
      memberId: string(input, "memberId"),
      expectedPriorProfile: profileSnapshot(input, "expectedPriorProfile"),
      correctedProfile: profileSnapshot(input, "correctedProfile"),
      evidenceNote
    };
  }
  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") {
    return {
      propertyId,
      membershipOrderId: string(input, "membershipOrderId"),
      actualMembershipDate: localDate(input, "actualMembershipDate"),
      evidenceNote
    };
  }
  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") {
    const payment = object(input.payment, "payment");
    return {
      propertyId,
      memberId: string(input, "memberId"),
      membershipProductId: string(input, "membershipProductId"),
      actualMembershipDate: localDate(input, "actualMembershipDate"),
      payment: {
        amountMinor: integer(payment, "amountMinor", 1),
        businessDate: localDate(payment, "businessDate"),
        transactionReference: requireTransactionReference(payment.transactionReference),
        note: typeof payment.note === "string" ? payment.note.trim() : ""
      },
      evidenceNote
    };
  }
  const replacement = input.replacementDirectPayment === undefined
    ? undefined
    : object(input.replacementDirectPayment, "replacementDirectPayment");
  return {
    propertyId,
    erroneousMembershipOrderId: string(input, "erroneousMembershipOrderId"),
    sourceStayOrderId: string(input, "sourceStayOrderId"),
    actualMembershipDate: localDate(input, "actualMembershipDate"),
    ...(replacement ? {
      replacementDirectPayment: {
        businessDate: localDate(replacement, "businessDate"),
        transactionReference: requireTransactionReference(replacement.transactionReference)
      }
    } : {}),
    evidenceNote
  };
}

function membershipProductEffect(
  product: Selectable<Database["membership_products"]>,
  agreedPriceMinor: number
) {
  return {
    productId: product.id,
    code: product.code,
    version: product.version,
    name: product.name,
    listedPrice: money(product.currency, product.list_price_minor),
    agreedPrice: money(product.currency, agreedPriceMinor),
    entitlementUnitKind: product.entitlement_unit_kind,
    entitlementUnits: product.entitlement_units,
    validityPeriod: product.validity_period,
    allowedRoomTypeCode: product.allowed_room_type_code,
    allowedInventoryKind: product.allowed_inventory_kind
  };
}

type CoverageLifecycleCounts = {
  hold: number;
  release: number;
  consume: number;
  restore: number;
  conversionConsume: number;
};

type LifecycleEntryType = "HOLD" | "RELEASE" | "CONSUME" | "RESTORE" | "CONVERSION_CONSUME";

const lifecycleEntryTypes = new Set<string>([
  "HOLD",
  "RELEASE",
  "CONSUME",
  "RESTORE",
  "CONVERSION_CONSUME"
]);

type SourceAmendment = {
  id: string;
  order_id: string;
  amendment_type: string;
  command_id: string | null;
  payload: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordAt(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const field of path) {
    current = record(current)?.[field];
  }
  return record(current);
}

function stringAt(value: unknown, path: readonly string[]): string | null {
  if (path.length === 0) return typeof value === "string" ? value : null;
  const parent = recordAt(value, path.slice(0, -1));
  const candidate = parent?.[path.at(-1)!];
  return typeof candidate === "string" ? candidate : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : null;
}

function stringArrayAt(value: unknown, path: readonly string[]): string[] | null {
  if (path.length === 0) return stringArray(value);
  const parent = recordAt(value, path.slice(0, -1));
  return stringArray(parent?.[path.at(-1)!]);
}

function exactOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  const orderedActual = [...actual].sort();
  const orderedExpected = [...expected].sort();
  return new Set(orderedActual).size === orderedActual.length
    && new Set(orderedExpected).size === orderedExpected.length
    && exactOrderedStrings(orderedActual, orderedExpected);
}

function exactDateSet(actual: readonly string[], expected: readonly string[]): boolean {
  return exactStringSet(actual, expected);
}

function isCanonicalLocalDateSequence(values: readonly string[]): boolean {
  if (new Set(values).size !== values.length) return false;
  try {
    values.forEach((value) => parseLocalDate(value));
  } catch {
    return false;
  }
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function isCanonicalLocalDate(value: string): boolean {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

type PricingCoverageItem = {
  serviceDate: string;
  inventoryUnitId: string;
  unitKind: string;
  entitlementLotId: string;
};

function pricingCoverageItems(value: unknown): PricingCoverageItem[] | null {
  if (!Array.isArray(value)) return null;
  const result: PricingCoverageItem[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (!item
      || typeof item.serviceDate !== "string"
      || typeof item.inventoryUnitId !== "string"
      || typeof item.unitKind !== "string"
      || typeof item.entitlementLotId !== "string") return null;
    try {
      parseLocalDate(item.serviceDate);
    } catch {
      return null;
    }
    result.push({
      serviceDate: item.serviceDate,
      inventoryUnitId: item.inventoryUnitId,
      unitKind: item.unitKind,
      entitlementLotId: item.entitlementLotId
    });
  }
  return result;
}

function hasExactTypedAmendmentSet(
  commandType: string,
  orderId: string,
  amendments: readonly SourceAmendment[]
): boolean {
  if (amendments.length === 0 || amendments.some((item) => item.order_id !== orderId)) return false;
  const count = (type: string) => amendments.filter((item) => item.amendment_type === type).length;
  const only = (...types: string[]) => amendments.every((item) => types.includes(item.amendment_type));

  if (commandType === "CREATE_ORDER") {
    return only("CREATE_ORDER", "CHECK_IN", "CHECK_OUT")
      && count("CREATE_ORDER") === 1
      && count("CHECK_IN") <= 1
      && count("CHECK_OUT") <= 1
      && (count("CHECK_OUT") === 0 || count("CHECK_IN") === 1);
  }
  if (commandType === "COMPLETE_STAY" || commandType === "BACKFILL_COMPLETED_STAY") {
    return amendments.length === 2
      && only("CHECK_IN", "CHECK_OUT")
      && count("CHECK_IN") === 1
      && count("CHECK_OUT") === 1;
  }
  if (commandType === "SHORTEN_STAY") {
    return only("SHORTEN_STAY", "CHECK_OUT")
      && count("SHORTEN_STAY") === 1
      && count("CHECK_OUT") <= 1;
  }
  return amendments.length === 1 && amendments[0]!.amendment_type === commandType;
}

function emptyCoverageLifecycleCounts(): CoverageLifecycleCounts {
  return { hold: 0, release: 0, consume: 0, restore: 0, conversionConsume: 0 };
}

function coverageLifecycleIsConserved(
  status: Selectable<Database["coverage_items"]>["status"],
  counts: CoverageLifecycleCounts
): boolean {
  if (status === "HELD") {
    return counts.hold === 1
      && counts.release === 0
      && counts.consume === 0
      && counts.restore === 0
      && counts.conversionConsume === 0;
  }
  if (status === "CONSUMED") {
    return (counts.hold === 1
        && counts.release === 0
        && counts.consume === 1
        && counts.restore === 0
        && counts.conversionConsume === 0)
      || (counts.hold === 1
        && counts.release === 0
        && counts.consume === 1
        && counts.restore === 1
        && counts.conversionConsume === 0)
      || (counts.hold === 0
        && counts.release === 0
        && counts.consume === 0
        && counts.restore === 0
        && counts.conversionConsume === 1);
  }
  return (counts.hold === 1
      && counts.release === 1
      && counts.consume === 0
      && counts.restore === 0
      && counts.conversionConsume === 0)
    || (counts.hold === 1
      && counts.release === 0
      && counts.consume === 1
      && counts.restore === 1
      && counts.conversionConsume === 0)
    || (counts.hold === 0
      && counts.release === 0
      && counts.consume === 0
      && counts.restore === 1
      && counts.conversionConsume === 1);
}

async function buildProfileCorrection(db: DbExecutor, input: Record<string, unknown>, propertyId: string) {
  const memberId = string(input, "memberId");
  const evidenceNote = string(input, "evidenceNote");
  const expected = profileSnapshot(input, "expectedPriorProfile");
  const after = profileSnapshot(input, "correctedProfile");
  const linkedMembers = await db.selectFrom("members")
    .innerJoin("member_property_links", "member_property_links.member_id", "members.id")
    .selectAll("members")
    .select("member_property_links.property_id")
    .where("members.id", "=", memberId)
    .orderBy("member_property_links.property_id")
    .execute();
  const member = linkedMembers.find((candidate) => candidate.property_id === propertyId);
  if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
  if (linkedMembers.some((candidate) => candidate.property_id !== propertyId)) {
    throw new DomainError(
      "ENTITLEMENT_CONFLICT",
      "该会员同时关联其他门店，暂不支持在这里修改资料",
      409
    );
  }
  const before = {
    fullName: member.full_name,
    nickname: member.nickname,
    identityCardNumber: member.identity_card_number,
    phone: member.phone,
    wechat: member.wechat
  };
  if (stableHash(expected) !== stableHash(before)) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员资料已变化，请刷新后重新修改", 409);
  }
  const fields = ["fullName", "nickname", "identityCardNumber", "phone", "wechat"] as const;
  const changedFields = fields.filter((field) => before[field] !== after[field]);
  if (changedFields.length === 0) throw new DomainError("VALIDATION_ERROR", "会员资料必须至少修改一项");
  const conflict = await db.selectFrom("members").select("id")
    .where("phone", "=", after.phone).where("id", "!=", memberId).executeTakeFirst();
  if (conflict) throw new DomainError("VALIDATION_ERROR", "该手机号已属于另一位会员，不能合并或迁移会员资料", 409);
  const latest = await db.selectFrom("member_profile_corrections")
    .select(["id", "sequence"]).where("member_id", "=", memberId)
    .orderBy("sequence", "desc").executeTakeFirst();
  return finalize(propertyId, {
    operation: "CORRECT_MEMBER_PROFILE",
    memberId,
    before,
    after,
    changedFields,
    evidenceNote
  }, {
    member: { id: member.id, profile: before },
    latestCorrectionId: latest?.id ?? null,
    nextCorrectionSequence: (latest?.sequence ?? 0) + 1
  });
}

async function loadExactActiveMembershipChain(db: DbExecutor, propertyId: string, membershipOrderId: string) {
  const order = await db.selectFrom("membership_orders")
    .selectAll().where("id", "=", membershipOrderId).where("property_id", "=", propertyId).executeTakeFirst();
  if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
  if (!order.contract_id || !order.entitlement_lot_id || !order.valid_from || !order.valid_until) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员订单、合同或权益记录不完整，不能修改", 409);
  }
  const [contract, primaryLot, allLots] = await Promise.all([
    db.selectFrom("member_contracts").selectAll().where("id", "=", order.contract_id).executeTakeFirst(),
    db.selectFrom("entitlement_lots").selectAll().where("id", "=", order.entitlement_lot_id).executeTakeFirst(),
    db.selectFrom("entitlement_lots").select("id")
      .where("contract_id", "=", order.contract_id)
      .orderBy("id")
      .execute()
  ]);
  if (!contract || !primaryLot
    || order.status !== "ACTIVE"
    || contract.status !== "ACTIVE"
    || primaryLot.status !== "ACTIVE"
    || contract.property_id !== propertyId
    || contract.member_id !== order.member_id
    || contract.membership_order_id !== order.id
    || primaryLot.contract_id !== contract.id
    || primaryLot.unit_kind !== order.entitlement_unit_kind
    || primaryLot.total_units !== order.entitlement_units
    || contract.valid_from !== order.valid_from
    || contract.valid_until !== order.valid_until
    || primaryLot.expires_on !== order.valid_until) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员订单、合同和权益记录状态不一致，不能修改", 409);
  }
  if (allLots.length !== 1 || allLots[0]?.id !== primaryLot.id) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "会员合同存在额外权益记录，当前规则无法安全计算其独立到期日", 409);
  }
  return { order, contract, lot: primaryLot };
}

async function loadActiveMembershipProjections(db: DbExecutor, propertyId: string, memberId: string) {
  const [contracts, lots] = await Promise.all([
    db.selectFrom("member_contracts")
      .select(["id", "membership_order_id"])
      .where("property_id", "=", propertyId)
      .where("member_id", "=", memberId)
      .where("status", "=", "ACTIVE")
      .orderBy("id")
      .execute(),
    db.selectFrom("entitlement_lots")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id")
      .select(["entitlement_lots.id", "entitlement_lots.contract_id"])
      .where("member_contracts.property_id", "=", propertyId)
      .where("member_contracts.member_id", "=", memberId)
      .where("entitlement_lots.status", "=", "ACTIVE")
      .orderBy("entitlement_lots.id")
      .execute()
  ]);
  return { contracts, lots };
}

async function buildEffectiveDateCorrection(db: DbExecutor, input: Record<string, unknown>, propertyId: string) {
  const membershipOrderId = string(input, "membershipOrderId");
  const actualMembershipDate = localDate(input, "actualMembershipDate");
  const evidenceNote = string(input, "evidenceNote");
  const { order, contract, lot } = await loadExactActiveMembershipChain(db, propertyId, membershipOrderId);
  const propertyToday = await propertyLocalToday(db, propertyId);
  const validUntil = addOneCalendarYear(actualMembershipDate);
  if (order.valid_from! > propertyToday || order.valid_until! < propertyToday
    || actualMembershipDate > propertyToday || validUntil < propertyToday) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "修改前后会员资格都必须保持当前有效，不能通过修改日期改变订单状态", 409);
  }
  if (actualMembershipDate === order.valid_from && validUntil === order.valid_until) {
    throw new DomainError("VALIDATION_ERROR", "修改后的会员有效期必须发生变化");
  }
  const [ledger, coverage, paymentFacts, view, latest, creationExecution, membershipCoverageRevisions] = await Promise.all([
    db.selectFrom("entitlement_ledger")
      .leftJoin("coverage_items", "coverage_items.id", "entitlement_ledger.coverage_id")
      .selectAll("entitlement_ledger")
      .where((expression) => expression.or([
        expression("entitlement_ledger.lot_id", "=", lot.id),
        expression("coverage_items.lot_id", "=", lot.id)
      ]))
      .orderBy("entitlement_ledger.created_at")
      .orderBy("entitlement_ledger.fact_id")
      .execute(),
    db.selectFrom("coverage_items").selectAll().where("lot_id", "=", lot.id)
      .orderBy("service_date").orderBy("id").execute(),
    db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", order.id)
      .orderBy("created_at").orderBy("fact_id").execute(),
    getMemberView(db, propertyId, order.member_id),
    db.selectFrom("membership_effective_date_corrections").select(["id", "sequence"])
      .where("membership_order_id", "=", order.id).orderBy("sequence", "desc").executeTakeFirst(),
    order.created_by_command_id === null
      ? Promise.resolve(undefined)
      : db.selectFrom("command_executions").select(["id", "command_type"])
        .where("id", "=", order.created_by_command_id).executeTakeFirst(),
    db.selectFrom("pricing_revisions")
      .innerJoin("orders", "orders.id", "pricing_revisions.order_id")
      .select([
        "pricing_revisions.id", "pricing_revisions.order_id", "pricing_revisions.arrival_date",
        "pricing_revisions.departure_date", "pricing_revisions.coverage_set"
      ])
      .where("orders.property_id", "=", propertyId)
      .where("orders.member_contract_id", "=", contract.id)
      .orderBy("pricing_revisions.order_id")
      .orderBy("pricing_revisions.revision_no")
      .execute()
  ]);
  const coverageOwnership = coverage.length === 0 ? [] : await db.selectFrom("coverage_items")
    .leftJoin("orders", "orders.id", "coverage_items.order_id")
    .leftJoin("inventory_units", "inventory_units.id", "coverage_items.inventory_unit_id")
    .leftJoin("pricing_revisions", "pricing_revisions.id", "coverage_items.held_by_revision_id")
    .select([
      "coverage_items.id as coverage_id",
      "orders.id as order_id",
      "orders.property_id as order_property_id",
      "orders.member_id as order_member_id",
      "orders.member_contract_id as order_contract_id",
      "orders.status as order_status",
      "orders.arrival_date as order_arrival_date",
      "orders.departure_date as order_departure_date",
      "orders.current_revision_id as order_current_revision_id",
      "inventory_units.id as inventory_unit_id",
      "inventory_units.property_id as inventory_property_id",
      "inventory_units.kind as inventory_kind",
      "inventory_units.room_type_code as inventory_room_type_code",
      "pricing_revisions.id as revision_id",
      "pricing_revisions.order_id as revision_order_id",
      "pricing_revisions.amendment_id as revision_amendment_id",
      "pricing_revisions.arrival_date as revision_arrival_date",
      "pricing_revisions.departure_date as revision_departure_date",
      "pricing_revisions.pricing_basis as revision_pricing_basis",
      "pricing_revisions.current_contract_amount_minor as revision_contract_amount_minor",
      "pricing_revisions.manual_adjustment_minor as revision_manual_adjustment_minor",
      "pricing_revisions.coverage_set as revision_coverage_set",
      "pricing_revisions.cash_lines as revision_cash_lines"
    ])
    .where("coverage_items.id", "in", coverage.map((item) => item.id))
    .execute();
  const coverageOwnershipById = new Map(coverageOwnership.map((item) => [item.coverage_id, item]));
  const coverageById = new Map(coverage.map((item) => [item.id, item]));
  const lifecycleByCoverageId = new Map<string, CoverageLifecycleCounts>();
  for (const item of coverage) {
    const ownership = coverageOwnershipById.get(item.id);
    const expectedUnitKind = ownership?.inventory_kind === "ROOM" ? "ROOM_NIGHT"
      : ownership?.inventory_kind === "BED" ? "BED_NIGHT"
        : null;
    if (!ownership
      || ownership.order_id === null
      || ownership.inventory_unit_id === null
      || ownership.revision_id === null
      || item.contract_id !== contract.id
      || ownership.order_property_id !== propertyId
      || ownership.inventory_property_id !== propertyId
      || item.unit_kind !== lot.unit_kind
      || item.unit_kind !== order.entitlement_unit_kind
      || item.unit_kind !== expectedUnitKind
      || ownership.revision_order_id !== item.order_id
      || ownership.revision_arrival_date === null
      || ownership.revision_departure_date === null
      || item.service_date < ownership.revision_arrival_date
      || item.service_date >= ownership.revision_departure_date
      || (ownership.order_member_id !== null && ownership.order_member_id !== order.member_id)
      || ownership.order_contract_id !== contract.id
      || ownership.inventory_kind !== order.allowed_inventory_kind
      || ownership.inventory_room_type_code !== order.allowed_room_type_code
      || item.service_date < actualMembershipDate
      || item.service_date > validUntil) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "已有权益使用记录的归属、房型或有效期不完整，不能修改生效日", 409);
    }
  }
  for (const item of ledger) {
    if (item.entry_type === "EXPIRE" || item.entry_type === "VOID") {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员权益记录已包含到期或作废操作，不能修改生效日", 409);
    }
    if (item.entry_type === "ADJUST"
      && (item.service_date !== null || item.order_id !== null || item.coverage_id !== null)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益余额修改记录不能关联服务日、订单或权益使用记录", 409);
    }
    const needsServiceDate = lifecycleEntryTypes.has(item.entry_type);
    const expectedLifecycleDelta = item.entry_type === "HOLD" ? -1
      : item.entry_type === "RELEASE" ? 1
        : item.entry_type === "CONSUME" ? 0
          : item.entry_type === "RESTORE" ? 1
            : item.entry_type === "CONVERSION_CONSUME" ? -1
              : null;
    if (expectedLifecycleDelta !== null && item.quantity_delta !== expectedLifecycleDelta) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益变动数量不符合规则，不能修改生效日", 409);
    }
    if (needsServiceDate && !item.service_date) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益使用记录缺少服务日，不能安全修改生效日", 409);
    }
    if (item.service_date && (item.service_date < actualMembershipDate || item.service_date > validUntil)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益使用服务日不在修改后的有效期内", 409);
    }
    if (item.coverage_id) {
      const linked = coverageById.get(item.coverage_id);
      if (!linked || linked.lot_id !== item.lot_id || linked.order_id !== item.order_id || linked.service_date !== item.service_date) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "权益变动记录与权益使用记录关联不完整，不能修改生效日", 409);
      }
      const counts = lifecycleByCoverageId.get(item.coverage_id) ?? emptyCoverageLifecycleCounts();
      if (item.entry_type === "HOLD") counts.hold += 1;
      if (item.entry_type === "RELEASE") counts.release += 1;
      if (item.entry_type === "CONSUME") counts.consume += 1;
      if (item.entry_type === "RESTORE") counts.restore += 1;
      if (item.entry_type === "CONVERSION_CONSUME") counts.conversionConsume += 1;
      lifecycleByCoverageId.set(item.coverage_id, counts);
    } else if (item.entry_type !== "CONVERSION_CONSUME" && lifecycleEntryTypes.has(item.entry_type)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益使用记录缺少对应的住宿权益记录，不能修改生效日", 409);
    }
  }
  for (const item of coverage) {
    const counts = lifecycleByCoverageId.get(item.id) ?? emptyCoverageLifecycleCounts();
    if (!coverageLifecycleIsConserved(item.status, counts)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "权益使用与变动记录不完整或不唯一，不能修改生效日", 409);
    }
  }

  const convertedOrderIds = new Set(ledger
    .filter((item) => item.entry_type === "CONVERSION_CONSUME" && item.order_id !== null)
    .map((item) => item.order_id!));
  const expectedCoverageDatesByOrder = new Map<string, Set<string>>();
  for (const revision of membershipCoverageRevisions) {
    if (convertedOrderIds.has(revision.order_id)) continue;
    const revisionCoverage = pricingCoverageItems(revision.coverage_set);
    if (revisionCoverage === null) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿的定价权益记录不完整，不能修改生效日", 409);
    }
    for (const item of revisionCoverage) {
      if (item.entitlementLotId !== lot.id) continue;
      if (item.unitKind !== lot.unit_kind
        || item.serviceDate < revision.arrival_date
        || item.serviceDate >= revision.departure_date) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿的定价权益服务日不完整，不能修改生效日", 409);
      }
      const dates = expectedCoverageDatesByOrder.get(revision.order_id) ?? new Set<string>();
      dates.add(item.serviceDate);
      expectedCoverageDatesByOrder.set(revision.order_id, dates);
    }
  }
  const actualCoverageDatesByOrder = new Map<string, Set<string>>();
  for (const item of coverage) {
    const dates = actualCoverageDatesByOrder.get(item.order_id) ?? new Set<string>();
    dates.add(item.service_date);
    actualCoverageDatesByOrder.set(item.order_id, dates);
  }
  for (const [orderId, expectedDates] of expectedCoverageDatesByOrder) {
    const actualDates = actualCoverageDatesByOrder.get(orderId) ?? new Set<string>();
    if (!exactDateSet([...actualDates], [...expectedDates])) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "会员住宿缺少完整的逐晚权益记录，不能修改生效日", 409);
    }
  }

  const lifecycleFacts = ledger.filter((item): item is typeof item & {
    entry_type: LifecycleEntryType;
    command_id: string;
    order_id: string;
  } => lifecycleEntryTypes.has(item.entry_type) && item.command_id !== null && item.order_id !== null);
  if (lifecycleFacts.length !== ledger.filter((item) => lifecycleEntryTypes.has(item.entry_type)).length) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "权益变动记录缺少可核对的操作来源，不能修改生效日", 409);
  }
  if (creationExecution && new Set([
    "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
    "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
  ]).has(creationExecution.command_type)
    && !lifecycleFacts.some((item) => item.command_id === creationExecution.id
      && item.entry_type === "CONVERSION_CONSUME")) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "住宿升级创建的会员缺少原始权益核销记录，不能修改生效日", 409);
  }

  let sourceStates: Array<{
    orderId: string;
    version: number;
    status: string;
    currentRevisionId: string | null;
    stayId: string;
    stayStatus: string;
  }> = [];
  if (lifecycleFacts.length > 0) {
    const lifecycleCommandIds = [...new Set(lifecycleFacts.map((item) => item.command_id))];
    const orderIds = [...new Set(lifecycleFacts.map((item) => item.order_id))];
    const revocationCommandRefs = await db.selectFrom("amendments")
      .select("command_id")
      .where("order_id", "in", orderIds)
      .where("amendment_type", "=", "REVOKE_CHECK_IN")
      .execute();
    const commandIds = [...new Set([
      ...lifecycleCommandIds,
      ...revocationCommandRefs.flatMap((item) => item.command_id === null ? [] : [item.command_id])
    ])];
    const [executions, amendments, receipts, audits, sourceOrders, sourceStays,
      conversionAmendments, sourceRevisions, sourceVoidReconversions, commandLedger] = await Promise.all([
      db.selectFrom("command_executions")
        .select(["id", "subject_id", "credential_id", "property_id", "command_type", "correlation_id", "state"])
        .where("id", "in", commandIds)
        .execute(),
      db.selectFrom("amendments")
        .select(["id", "order_id", "command_id", "amendment_type", "payload"])
        .where("command_id", "in", commandIds)
        .orderBy("id")
        .execute(),
      db.selectFrom("command_receipts")
        .select(["command_id", "execution_status", "business_committed", "result", "resource_refs", "fact_refs"])
        .where("command_id", "in", commandIds)
        .execute(),
      db.selectFrom("audit_entries")
        .select(["command_id", "subject_id", "credential_id", "action", "decision", "correlation_id"])
        .where("command_id", "in", commandIds)
        .where("decision", "=", "ALLOWED")
        .execute(),
      db.selectFrom("orders")
        .select(["id", "property_id", "member_id", "member_contract_id", "arrival_date", "departure_date", "status", "current_revision_id", "version"])
        .where("id", "in", orderIds)
        .execute(),
      db.selectFrom("stays")
        .select(["id", "order_id", "status"])
        .where("order_id", "in", orderIds)
        .orderBy("id")
        .execute(),
      db.selectFrom("amendments")
        .select(["id", "order_id", "command_id", "amendment_type", "payload"])
        .where("order_id", "in", orderIds)
        .where("amendment_type", "=", "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
        .orderBy("id")
        .execute(),
      db.selectFrom("pricing_revisions")
        .innerJoin("amendments", "amendments.id", "pricing_revisions.amendment_id")
        .select([
          "pricing_revisions.id", "pricing_revisions.order_id", "pricing_revisions.amendment_id",
          "pricing_revisions.arrival_date", "pricing_revisions.departure_date",
          "pricing_revisions.pricing_basis", "pricing_revisions.current_contract_amount_minor",
          "pricing_revisions.manual_adjustment_minor", "pricing_revisions.coverage_set", "pricing_revisions.cash_lines",
          "amendments.command_id"
        ])
        .where("amendments.command_id", "in", commandIds)
        .orderBy("pricing_revisions.id")
        .execute(),
      db.selectFrom("membership_void_reconversions")
        .select([
          "property_id", "member_id", "source_order_id", "source_stay_id",
          "new_membership_order_id", "new_contract_id", "new_entitlement_lot_id",
          sql<string[]>`${sql.ref("membership_void_reconversions.service_dates")}::text[]`.as("service_dates"),
          "command_id"
        ])
        .where("command_id", "in", commandIds)
        .orderBy("id")
        .execute(),
      db.selectFrom("entitlement_ledger")
        .selectAll()
        .where("command_id", "in", commandIds)
        .orderBy("created_at")
        .orderBy("fact_id")
        .execute()
    ]);

    const executionById = new Map(executions.map((item) => [item.id, item]));
    const sourceOrderById = new Map(sourceOrders.map((item) => [item.id, item]));
    const rowsBy = <T,>(rows: readonly T[], key: (row: T) => string | null) => {
      const result = new Map<string, T[]>();
      for (const row of rows) {
        const value = key(row);
        if (!value) continue;
        const existing = result.get(value) ?? [];
        existing.push(row);
        result.set(value, existing);
      }
      return result;
    };
    const amendmentsByCommand = rowsBy(amendments, (item) => item.command_id);
    const receiptsByCommand = rowsBy(receipts, (item) => item.command_id);
    const auditsByCommand = rowsBy(audits, (item) => item.command_id);
    const staysByOrder = rowsBy(sourceStays, (item) => item.order_id);
    const conversionsByOrder = rowsBy(conversionAmendments, (item) => item.order_id);
    const revisionsByCommand = rowsBy(sourceRevisions, (item) => item.command_id);
    const voidsByCommand = rowsBy(sourceVoidReconversions, (item) => item.command_id);
    const ledgerByCommand = rowsBy(commandLedger, (item) => item.command_id);
    const factsByCommand = rowsBy(lifecycleFacts, (item) => item.command_id);

    const holdCommands = new Set([
      "CREATE_ORDER", "RESCHEDULE_STAY", "EXTEND_STAY", "MOVE_UNIT",
      "REPRICE_ORDER", "REFRESH_MEMBER_COVERAGE"
    ]);
    const releaseCommands = new Set([
      "RESCHEDULE_STAY", "EXTEND_STAY", "MOVE_UNIT", "REPRICE_ORDER",
      "REFRESH_MEMBER_COVERAGE", "CANCEL_ORDER", "MARK_NO_SHOW"
    ]);
    const checkInConsumeCommands = new Set([
      "CREATE_ORDER", "CHECK_IN", "COMPLETE_STAY", "BACKFILL_COMPLETED_STAY",
      "REPRICE_ORDER", "REFRESH_MEMBER_COVERAGE"
    ]);

    for (const item of lifecycleFacts) {
      const execution = executionById.get(item.command_id);
      const commandAmendments = amendmentsByCommand.get(item.command_id) ?? [];
      const commandReceipts = receiptsByCommand.get(item.command_id) ?? [];
      const commandAudits = auditsByCommand.get(item.command_id) ?? [];
      const sourceOrder = sourceOrderById.get(item.order_id);
      const sourceStayRows = staysByOrder.get(item.order_id) ?? [];
      const receipt = commandReceipts[0];
      const factRefs = stringArray(receipt?.fact_refs);
      const resourceRefs = stringArray(receipt?.resource_refs);
      if (!execution
        || execution.property_id !== propertyId
        || execution.state !== "APPLIED"
        || !sourceOrder
        || sourceOrder.property_id !== propertyId
        || sourceStayRows.length !== 1
        || !hasExactTypedAmendmentSet(execution.command_type, item.order_id, commandAmendments)
        || commandReceipts.length !== 1
        || receipt?.execution_status !== "EXECUTED"
        || receipt.business_committed !== true
        || !factRefs?.includes(item.fact_id)
        || (item.coverage_id !== null && !resourceRefs?.includes(item.coverage_id))
        || commandAudits.length !== 1
        || commandAudits[0]!.subject_id !== execution.subject_id
        || commandAudits[0]!.credential_id !== execution.credential_id
        || commandAudits[0]!.action !== execution.command_type
        || commandAudits[0]!.correlation_id !== execution.correlation_id) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "权益变动记录无法追溯到完整的原业务操作，不能修改生效日", 409);
      }

      if (item.entry_type === "HOLD") {
        const ownership = coverageOwnershipById.get(item.coverage_id!);
        if (!holdCommands.has(execution.command_type)
          || item.reason !== "ORDER_COVERAGE_HOLD"
          || !ownership
          || !commandAmendments.some((amendment) => amendment.id === ownership.revision_amendment_id)) {
          throw new DomainError("ENTITLEMENT_CONFLICT", "权益占用无法追溯到对应的住宿定价操作，不能修改生效日", 409);
        }
      } else if (item.entry_type === "RELEASE") {
        if (!releaseCommands.has(execution.command_type) || item.reason !== "ORDER_COVERAGE_RELEASE") {
          throw new DomainError("ENTITLEMENT_CONFLICT", "权益释放无法追溯到原订单操作，不能修改生效日", 409);
        }
      } else if (item.entry_type === "CONSUME") {
        const checkInConsumption = item.reason === "CHECK_IN_ENTITLEMENT_CONSUMED"
          && checkInConsumeCommands.has(execution.command_type)
          && (execution.command_type !== "CREATE_ORDER"
            || commandAmendments.some((amendment) => amendment.amendment_type === "CHECK_IN"));
        const extensionConsumption = item.reason === "EXTEND_STAY_ENTITLEMENT_CONSUMED"
          && execution.command_type === "EXTEND_STAY";
        if (!checkInConsumption && !extensionConsumption) {
          throw new DomainError("ENTITLEMENT_CONFLICT", "权益核销无法追溯到入住或续住操作，不能修改生效日", 409);
        }
      } else if (item.entry_type === "RESTORE") {
        if (execution.command_type === "REVOKE_CHECK_IN") {
          const sourceStay = sourceStayRows[0]!;
          if (item.reason !== "REVOKE_CHECK_IN_ENTITLEMENT_RESTORED"
            || sourceOrder.status !== "CHECK_IN_REVOKED"
            || sourceStay.status !== "CHECK_IN_REVOKED") {
            throw new DomainError("ENTITLEMENT_CONFLICT", "权益返还无法追溯到完整的撤销入住操作，不能修改生效日", 409);
          }
        } else if (execution.command_type !== "SHORTEN_STAY"
          || item.reason !== "SHORTEN_STAY_FUTURE_ENTITLEMENT_RESTORED") {
          throw new DomainError("ENTITLEMENT_CONFLICT", "权益返还无法追溯到撤销入住或缩短住宿操作，不能修改生效日", 409);
        }
      } else if ((item.coverage_id !== null
        && execution.command_type !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP")
        || (item.coverage_id === null && !new Set([
          "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
          "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
        ]).has(execution.command_type))) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "权益核销记录无法追溯到原住宿升级操作，不能修改生效日", 409);
      }
    }

    for (const [commandId, commandFacts] of factsByCommand) {
      const execution = executionById.get(commandId)!;
      const sourceOrder = sourceOrderById.get(commandFacts[0]!.order_id)!;
      const sourceStay = (staysByOrder.get(sourceOrder.id) ?? [])[0]!;
      const commandAmendments = amendmentsByCommand.get(commandId) ?? [];
      const commandRows = ledgerByCommand.get(commandId) ?? [];
      const receipt = (receiptsByCommand.get(commandId) ?? [])[0]!;

      if (execution.command_type === "SHORTEN_STAY"
        && commandRows.some((item) => item.entry_type === "RESTORE")) {
        const shortening = commandAmendments.find((item) => item.amendment_type === "SHORTEN_STAY");
        const restoredDates = stringArrayAt(shortening?.payload, ["entitlementSummary", "restoredFutureCoverageDates"]);
        const releasedDates = stringArrayAt(shortening?.payload, ["inventoryChange", "releasedDates"]);
        const businessDate = stringAt(shortening?.payload, ["businessDate"]);
        const afterDeparture = stringAt(shortening?.payload, ["after", "departureDate"]);
        const restoreRows = commandRows.filter((item) => item.entry_type === "RESTORE");
        const shorteningRevisions = (revisionsByCommand.get(commandId) ?? [])
          .filter((revision) => revision.amendment_id === shortening?.id);
        if (!shortening
          || !restoredDates
          || !releasedDates
          || !businessDate
          || !afterDeparture
          || !isCanonicalLocalDate(businessDate)
          || !isCanonicalLocalDate(afterDeparture)
          || !isCanonicalLocalDateSequence(restoredDates)
          || !isCanonicalLocalDateSequence(releasedDates)
          || !exactOrderedStrings(restoredDates, releasedDates)
          || commandRows.length !== restoreRows.length
          || !exactDateSet(restoreRows.map((item) => item.service_date ?? ""), restoredDates)
          || restoreRows.some((item) => item.order_id !== sourceOrder.id
            || item.service_date === null
            || item.service_date < businessDate
            || item.service_date < afterDeparture)
          || shorteningRevisions.length !== 1
          || shorteningRevisions[0]!.order_id !== sourceOrder.id
          || shorteningRevisions[0]!.departure_date !== afterDeparture
          || (conversionsByOrder.get(sourceOrder.id) ?? []).length !== 1) {
          throw new DomainError("ENTITLEMENT_CONFLICT", "缩短住宿返还的权益记录、日期或业务范围不完整，不能修改生效日", 409);
        }
      }

    }

    const revokedSourceOrders = sourceOrders.filter((sourceOrder) => {
      const sourceStayRows = staysByOrder.get(sourceOrder.id) ?? [];
      return sourceOrder.status === "CHECK_IN_REVOKED"
        || sourceStayRows.some((sourceStay) => sourceStay.status === "CHECK_IN_REVOKED");
    });
    for (const sourceOrder of revokedSourceOrders) {
      const sourceStayRows = staysByOrder.get(sourceOrder.id) ?? [];
      const revocations = amendments.filter((item) =>
        item.order_id === sourceOrder.id && item.amendment_type === "REVOKE_CHECK_IN"
      );
      const revocation = revocations[0];
      const commandId = revocation?.command_id;
      const execution = commandId ? executionById.get(commandId) : undefined;
      const commandAmendments = commandId ? amendmentsByCommand.get(commandId) ?? [] : [];
      const commandReceipts = commandId ? receiptsByCommand.get(commandId) ?? [] : [];
      const commandAudits = commandId ? auditsByCommand.get(commandId) ?? [] : [];
      const commandRows = commandId ? ledgerByCommand.get(commandId) ?? [] : [];
      const receipt = commandReceipts[0];
      const audit = commandAudits[0];
      const transition = recordAt(receipt?.result, ["entitlementTransition"]);
      const receiptFactRefs = stringArray(receipt?.fact_refs);
      const receiptResourceRefs = stringArray(receipt?.resource_refs);
      const restoreRows = commandRows.filter((item) => item.entry_type === "RESTORE");
      const sourceCoverageIds = ledger
        .filter((item) => item.order_id === sourceOrder.id
          && item.entry_type === "CONSUME"
          && item.coverage_id !== null)
        .map((item) => item.coverage_id!);
      const sourceCoverageRows = sourceCoverageIds.map((coverageId) => coverageById.get(coverageId));
      const restoredCoverageIds = restoreRows.map((item) => item.coverage_id ?? "");
      if (sourceStayRows.length !== 1
        || sourceOrder.status !== "CHECK_IN_REVOKED"
        || sourceStayRows[0]!.status !== "CHECK_IN_REVOKED"
        || (sourceOrder.member_id !== null && sourceOrder.member_id !== order.member_id)
        || sourceOrder.member_contract_id !== contract.id
        || revocations.length !== 1
        || !commandId
        || !execution
        || execution.command_type !== "REVOKE_CHECK_IN"
        || execution.property_id !== propertyId
        || execution.state !== "APPLIED"
        || !hasExactTypedAmendmentSet(execution.command_type, sourceOrder.id, commandAmendments)
        || record(revocation.payload)?.unusedRoomConfirmed !== true
        || stringAt(revocation.payload, ["businessDate"]) !== sourceOrder.arrival_date
        || commandReceipts.length !== 1
        || receipt?.execution_status !== "EXECUTED"
        || receipt.business_committed !== true
        || transition?.from !== "CONSUMED"
        || transition.to !== "RESTORED"
        || transition.coverageCount !== restoreRows.length
        || commandRows.length !== restoreRows.length
        || sourceCoverageIds.length === 0
        || new Set(sourceCoverageIds).size !== sourceCoverageIds.length
        || sourceCoverageRows.some((item) => !item || item.order_id !== sourceOrder.id || item.status !== "CONSUMED")
        || restoreRows.some((item) => item.order_id !== sourceOrder.id
          || item.lot_id !== lot.id
          || item.coverage_id === null
          || item.reason !== "REVOKE_CHECK_IN_ENTITLEMENT_RESTORED")
        || !exactStringSet(restoredCoverageIds, sourceCoverageIds)
        || !receiptFactRefs
        || !exactStringSet(receiptFactRefs, restoreRows.map((item) => item.fact_id))
        || !receiptResourceRefs
        || sourceCoverageIds.some((coverageId) => !receiptResourceRefs.includes(coverageId))
        || commandAudits.length !== 1
        || audit?.subject_id !== execution.subject_id
        || audit.credential_id !== execution.credential_id
        || audit.action !== execution.command_type
        || audit.correlation_id !== execution.correlation_id) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "撤销入住的权益返还结果与原操作不一致，不能修改生效日", 409);
      }
    }

    const conversionFacts = lifecycleFacts.filter((item) => item.entry_type === "CONVERSION_CONSUME");
    const conversionFactsByCommand = rowsBy(conversionFacts, (item) => item.command_id);
    for (const [commandId, facts] of conversionFactsByCommand) {
      const execution = executionById.get(commandId)!;
      const commandAmendments = amendmentsByCommand.get(commandId) ?? [];
      const amendment = commandAmendments[0]!;
      const sourceOrder = sourceOrderById.get(facts[0]!.order_id)!;
      const sourceStay = (staysByOrder.get(sourceOrder.id) ?? [])[0]!;
      const receipt = (receiptsByCommand.get(commandId) ?? [])[0]!;
      const amendmentDates = stringArrayAt(amendment.payload, ["entitlement", "serviceDates"]);
      const conversionRevisions = (revisionsByCommand.get(commandId) ?? [])
        .filter((revision) => revision.amendment_id === amendment.id);
      const voidRoots = voidsByCommand.get(commandId) ?? [];
      const uncovered = facts.every((item) => item.coverage_id === null);
      const covered = facts.every((item) => item.coverage_id !== null);
      const conversionRevision = conversionRevisions[0];
      const revisionDates = conversionRevision
        ? enumerateServiceDates(conversionRevision.arrival_date, conversionRevision.departure_date)
        : [];
      const factDates = facts.map((item) => item.service_date ?? "");
      const sourceLifecycleMatches = (sourceOrder.status === "CHECKED_OUT" && sourceStay.status === "COMPLETED")
        || (sourceOrder.status === "CHECKED_IN" && sourceStay.status === "IN_HOUSE");
      if ((!uncovered && !covered)
        || amendmentDates === null
        || conversionRevisions.length !== 1
        || conversionRevision!.order_id !== sourceOrder.id
        || conversionRevision!.pricing_basis !== "MEMBER_ENTITLEMENT"
        || conversionRevision!.current_contract_amount_minor !== 0
        || conversionRevision!.manual_adjustment_minor !== 0
        || !Array.isArray(conversionRevision!.coverage_set)
        || conversionRevision!.coverage_set.length !== 0
        || !Array.isArray(conversionRevision!.cash_lines)
        || conversionRevision!.cash_lines.length !== 0
        || !exactDateSet(amendmentDates, revisionDates)
        || !exactDateSet(factDates, revisionDates)
        || facts.some((item) => item.order_id !== sourceOrder.id
          || item.lot_id !== lot.id
          || item.quantity_delta !== -1
          || item.reason !== "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED")
        || sourceOrder.member_id !== order.member_id
        || sourceOrder.member_contract_id !== contract.id
        || !sourceLifecycleMatches
        || order.created_by_command_id !== commandId
        || order.activated_by_command_id !== commandId) {
        throw new DomainError("ENTITLEMENT_CONFLICT", "住宿升级权益核销与原订单、日期或会员记录不一致，不能修改生效日", 409);
      }

      if (covered) {
        const currentRevision = sourceRevisions.find((item) => item.id === sourceOrder.current_revision_id);
        const currentAmendment = currentRevision
          ? amendments.find((item) => item.id === currentRevision.amendment_id)
          : undefined;
        const currentExecution = currentAmendment?.command_id
          ? executionById.get(currentAmendment.command_id)
          : undefined;
        const currentCommandRows = currentExecution
          ? ledgerByCommand.get(currentExecution.id) ?? []
          : [];
        const sourceDatesMatch = sourceOrder.arrival_date === conversionRevision!.arrival_date
          && (sourceOrder.departure_date === conversionRevision!.departure_date
            || (sourceOrder.departure_date < conversionRevision!.departure_date
              && currentRevision?.order_id === sourceOrder.id
              && currentRevision.arrival_date === sourceOrder.arrival_date
              && currentRevision.departure_date === sourceOrder.departure_date
              && currentAmendment?.order_id === sourceOrder.id
              && currentAmendment.amendment_type === "SHORTEN_STAY"
              && stringAt(currentAmendment.payload, ["after", "departureDate"]) === sourceOrder.departure_date
              && currentExecution?.command_type === "SHORTEN_STAY"
              && currentExecution.property_id === propertyId
              && currentExecution.state === "APPLIED"
              && hasExactTypedAmendmentSet(
                currentExecution.command_type,
                sourceOrder.id,
                amendmentsByCommand.get(currentExecution.id) ?? []
              )
              && currentCommandRows.some((item) => item.order_id === sourceOrder.id
                && item.lot_id === lot.id
                && item.entry_type === "RESTORE")));
        if (execution.command_type !== "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
          || stringAt(receipt.result, ["conversionMode"]) !== "IN_HOUSE"
          || voidRoots.length !== 0
          || !sourceDatesMatch
          || facts.some((item) => {
            const ownership = coverageOwnershipById.get(item.coverage_id!);
            return !ownership
              || ownership.revision_id !== conversionRevision!.id
              || ownership.revision_amendment_id !== amendment.id;
          })) {
          throw new DomainError("ENTITLEMENT_CONFLICT", "在住升级的权益记录未绑定原转换记录，不能修改生效日", 409);
        }
      } else {
        const completedDates = enumerateServiceDates(sourceOrder.arrival_date, sourceOrder.departure_date);
        const standardRoot = execution.command_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
          && stringAt(receipt.result, ["conversionMode"]) === "COMPLETED"
          && voidRoots.length === 0;
        const rebuildRoot = execution.command_type === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
          && voidRoots.length === 1
          && voidRoots[0]!.property_id === propertyId
          && voidRoots[0]!.member_id === order.member_id
          && voidRoots[0]!.source_order_id === sourceOrder.id
          && voidRoots[0]!.source_stay_id === sourceStay.id
          && voidRoots[0]!.new_membership_order_id === order.id
          && voidRoots[0]!.new_contract_id === contract.id
          && voidRoots[0]!.new_entitlement_lot_id === lot.id
          && exactDateSet(voidRoots[0]!.service_dates, completedDates);
        if (sourceOrder.status !== "CHECKED_OUT"
          || sourceStay.status !== "COMPLETED"
          || !exactDateSet(factDates, completedDates)
          || !exactDateSet(amendmentDates, completedDates)
          || (!standardRoot && !rebuildRoot)) {
          throw new DomainError("ENTITLEMENT_CONFLICT", "历史权益核销无法唯一追溯到完整的原住宿转换，不能修改生效日", 409);
        }
      }
    }
    sourceStates = [...sourceOrders]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((sourceOrder) => {
        const sourceStay = (staysByOrder.get(sourceOrder.id) ?? [])[0]!;
        return {
          orderId: sourceOrder.id,
          version: sourceOrder.version,
          status: sourceOrder.status,
          currentRevisionId: sourceOrder.current_revision_id,
          stayId: sourceStay.id,
          stayStatus: sourceStay.status
        };
      });
  }
  const usedUnits = ledger.filter((item) =>
    item.entry_type === "CONSUME" || item.entry_type === "CONVERSION_CONSUME"
  ).length;
  return finalize(propertyId, {
    operation: "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
    propertyToday,
    memberId: order.member_id,
    membershipOrderId: order.id,
    contractId: contract.id,
    entitlementLotId: lot.id,
    evidenceNote,
    before: { validFrom: order.valid_from, validUntil: order.valid_until, status: "ACTIVE" },
    after: { validFrom: actualMembershipDate, validUntil, status: "ACTIVE" },
    unchanged: {
      memberId: order.member_id,
      productName: order.product_name,
      agreedPrice: money(order.currency, order.agreed_price_minor),
      entitlementUnitKind: lot.unit_kind,
      entitlementUnits: lot.total_units,
      usedUnits,
      availableBalance: view.availableBalance,
      paymentFactCount: paymentFacts.length,
      lifecycleStatus: "ACTIVE"
    }
  }, {
    order: { id: order.id, version: order.version, status: order.status },
    contract: { id: contract.id, version: contract.version, status: contract.status },
    lot: { id: lot.id, version: lot.version, status: lot.status, expiresOn: lot.expires_on },
    paymentFactIds: paymentFacts.map((item) => item.fact_id),
    ledgerFactIds: ledger.map((item) => item.fact_id),
    coverageStates: coverage.map((item) => ({ id: item.id, status: item.status })),
    sourceStates,
    memberBalance: view.availableBalance,
    latestCorrectionId: latest?.id ?? null,
    nextCorrectionSequence: (latest?.sequence ?? 0) + 1,
    propertyToday
  });
}

async function buildHistoricalBackfill(db: DbExecutor, input: Record<string, unknown>, propertyId: string) {
  const memberId = string(input, "memberId");
  const membershipProductId = string(input, "membershipProductId");
  const actualMembershipDate = localDate(input, "actualMembershipDate");
  const evidenceNote = string(input, "evidenceNote");
  const paymentInput = object(input.payment, "payment");
  const amountMinor = integer(paymentInput, "amountMinor", 1);
  const businessDate = localDate(paymentInput, "businessDate");
  const transactionReference = requireTransactionReference(paymentInput.transactionReference);
  const note = typeof paymentInput.note === "string" ? paymentInput.note.trim() : "";
  const [member, product, property, propertyToday, blockingOrders, activeProjections, duplicateMembershipPayment, duplicateStayPayment] = await Promise.all([
    db.selectFrom("members").innerJoin("member_property_links", "member_property_links.member_id", "members.id")
      .select(["members.id", "members.full_name"]).where("members.id", "=", memberId)
      .where("member_property_links.property_id", "=", propertyId).executeTakeFirst(),
    db.selectFrom("membership_products").selectAll().where("id", "=", membershipProductId)
      .where("status", "=", "PUBLISHED").executeTakeFirst(),
    db.selectFrom("properties").select("currency").where("id", "=", propertyId).executeTakeFirst(),
    propertyLocalToday(db, propertyId),
    db.selectFrom("membership_orders").select(["id", "product_id", "status"])
      .where("property_id", "=", propertyId).where("member_id", "=", memberId)
      .where("status", "!=", "VOIDED").orderBy("id").execute(),
    loadActiveMembershipProjections(db, propertyId, memberId),
    db.selectFrom("membership_payment_facts").select("fact_id")
      .where("transaction_reference", "=", transactionReference).executeTakeFirst(),
    db.selectFrom("collection_facts").select("fact_id")
      .where("transaction_reference", "=", transactionReference).executeTakeFirst()
  ]);
  if (!member) throw new DomainError("NOT_FOUND", "当前门店未找到该会员", 404);
  if (!product) throw new DomainError("NOT_FOUND", "会员产品不存在", 404);
  if (!property) throw new DomainError("NOT_FOUND", "当前门店不存在", 404);
  if (property.currency !== product.currency) throw new DomainError("VALIDATION_ERROR", "会员产品币种与物业不一致");
  if (product.validity_period !== "P1Y") {
    throw new DomainError("ENTITLEMENT_CONFLICT", "当前仅支持一年期会员产品的历史办卡补录", 409);
  }
  if (blockingOrders.length > 0 || activeProjections.contracts.length > 0 || activeProjections.lots.length > 0) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "该会员已有未作废会员订单或旧系统有效记录，不能使用历史办卡补录", 409);
  }
  if (duplicateMembershipPayment || duplicateStayPayment) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "该交易引用已被其他收款记录使用", 409);
  }
  const validUntil = addOneCalendarYear(actualMembershipDate);
  if (actualMembershipDate > propertyToday || validUntil < propertyToday) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "首版只允许补录截至物业营业日仍有效的历史会员", 409);
  }
  if (businessDate > propertyToday) {
    throw new DomainError("VALIDATION_ERROR", "企业微信收款日期不能晚于物业营业日");
  }
  return finalize(propertyId, {
    operation: "BACKFILL_HISTORICAL_MEMBERSHIP",
    evidenceNote,
    member: { memberId: member.id, fullName: member.full_name },
    product: membershipProductEffect(product, product.list_price_minor),
    payment: {
      amount: money(product.currency, amountMinor),
      businessDate,
      transactionReference,
      note
    },
    validFrom: actualMembershipDate,
    validUntil,
    entitlementUnitKind: product.entitlement_unit_kind,
    entitlementUnits: product.entitlement_units,
    status: "ACTIVE"
  }, {
    member: { id: member.id, fullName: member.full_name },
    product: { id: product.id, version: product.version, status: product.status },
    nonVoidedMembershipOrderIds: blockingOrders.map((item) => item.id),
    activeContractIds: activeProjections.contracts.map((item) => item.id),
    activeEntitlementLotIds: activeProjections.lots.map((item) => item.id),
    duplicateMembershipPaymentFactId: null,
    duplicateStayPaymentFactId: null,
    propertyToday
  });
}

async function buildMembershipVoidReconversion(db: DbExecutor, input: Record<string, unknown>, propertyId: string) {
  const erroneousMembershipOrderId = string(input, "erroneousMembershipOrderId");
  const sourceStayOrderId = string(input, "sourceStayOrderId");
  const actualMembershipDate = localDate(input, "actualMembershipDate");
  const evidenceNote = string(input, "evidenceNote");
  const { order: oldOrder, contract: oldContract, lot: oldLot } = await loadExactActiveMembershipChain(
    db,
    propertyId,
    erroneousMembershipOrderId
  );
  const sourceRaw = await db.selectFrom("orders").innerJoin("stays", "stays.order_id", "orders.id")
    .innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
    .selectAll("orders")
    .select(["stays.id as stay_id", "stays.status as stay_status", "pricing_revisions.currency", "pricing_revisions.current_contract_amount_minor"])
    .where("orders.id", "=", sourceStayOrderId).where("orders.property_id", "=", propertyId).executeTakeFirst();
  if (!sourceRaw) throw new DomainError("NOT_FOUND", "源住宿订单不存在", 404);
  const [member, oldPayments, oldCoverage, oldLedger, oldTransfers, priorVoid, activeOrders, activeProjections, sourceView, sourceFunds, property, propertyToday] = await Promise.all([
    db.selectFrom("members").selectAll().where("id", "=", oldOrder.member_id).executeTakeFirst(),
    db.selectFrom("membership_payment_facts").selectAll().where("membership_order_id", "=", oldOrder.id)
      .orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("coverage_items").select("id").where("lot_id", "=", oldLot.id).execute(),
    db.selectFrom("entitlement_ledger").selectAll().where("lot_id", "=", oldLot.id).execute(),
    db.selectFrom("stay_collection_membership_transfers").select("id")
      .where("membership_order_id", "=", oldOrder.id).execute(),
    db.selectFrom("membership_void_reconversions").select("id")
      .where("old_membership_order_id", "=", oldOrder.id).executeTakeFirst(),
    db.selectFrom("membership_orders").select("id")
      .where("property_id", "=", propertyId).where("member_id", "=", oldOrder.member_id)
      .where("status", "=", "ACTIVE").orderBy("id").execute(),
    loadActiveMembershipProjections(db, propertyId, oldOrder.member_id),
    getOrderViewSnapshot(db, sourceStayOrderId),
    db.selectFrom("collection_facts").selectAll().where("order_id", "=", sourceStayOrderId)
      .orderBy("created_at").orderBy("fact_id").execute(),
    db.selectFrom("properties").select("id").where("id", "=", propertyId).executeTakeFirst(),
    propertyLocalToday(db, propertyId)
  ]);
  if (!member || !property) throw new DomainError("NOT_FOUND", "会员或物业不存在", 404);
  if (priorVoid) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "该错误会员记录已经作废重建", 409);
  if (activeOrders.length !== 1 || activeOrders[0]!.id !== oldOrder.id) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "目标会员存在其他有效会员记录，无法唯一重建", 409);
  }
  if (activeProjections.contracts.length !== 1 || activeProjections.contracts[0]!.id !== oldContract.id
    || activeProjections.lots.length !== 1 || activeProjections.lots[0]!.id !== oldLot.id) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "目标会员存在其他有效合同或权益记录，无法唯一重建", 409);
  }
  if (oldCoverage.length > 0 || oldLedger.length > 0 || oldTransfers.length > 0) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "只有权益完全未使用且从未转换的错误会员记录可以作废重建", 409);
  }
  if (oldPayments.length === 0 || oldPayments.some((item) => item.fact_type !== "COLLECTION"
    || item.source_type !== "DIRECT_WECOM"
    || item.amount_minor <= 0
    || item.net_effect_minor !== item.amount_minor
    || !item.transaction_reference
    || item.corrects_fact_id !== null
    || item.reverses_fact_id !== null
    || item.currency !== oldOrder.currency)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "原会员订单必须只包含未冲销的直接会员收款", 409);
  }
  if (sourceRaw.status !== "CHECKED_OUT" || sourceRaw.stay_status !== "COMPLETED") {
    throw new DomainError("INVALID_ORDER_STATE", "源住宿必须已退房并完成", 409);
  }
  if (sourceRaw.stay_type === "FREE" || sourceRaw.booking_channel_code !== "WECOM"
    || sourceRaw.member_id || sourceRaw.member_contract_id || sourceView.membershipConversion) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿必须是尚未转换的普通企业微信住宿", 409);
  }
  if (sourceFunds.length === 0 || sourceFunds.some((item) => item.fact_type !== "COLLECTION"
    || item.amount_minor <= 0
    || item.net_effect_minor !== item.amount_minor
    || item.method !== "WECOM"
    || !item.transaction_reference
    || item.references_fact_id !== null
    || item.reverses_fact_id !== null
    || item.currency !== oldOrder.currency)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿资金必须是完整、未退款且未冲销的企业微信收款", 409);
  }
  const primaryOccupants = sourceView.occupants.filter((item) => item.role === "PRIMARY");
  const primaryOccupant = primaryOccupants[0];
  if (primaryOccupants.length !== 1 || !primaryOccupant) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿必须有且仅有一个主要住宿人", 409);
  }
  const memberPhone = phone(member.phone);
  const sourcePhone = typeof primaryOccupant.phone === "string" && primaryOccupant.phone.trim() !== ""
    ? phone(primaryOccupant.phone)
    : null;
  const memberDocumentNumber = identity(member.identity_card_number);
  const sourceDocumentNumber = identity(primaryOccupant.documentNumber);
  const phoneMatched = sourcePhone !== null && sourcePhone === memberPhone;
  const documentMatched = sourceDocumentNumber !== null
    && memberDocumentNumber !== null
    && sourceDocumentNumber === memberDocumentNumber;
  if (sourcePhone === null) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿主要住宿人手机号缺失，无法核对目标会员", 409);
  }
  if (!phoneMatched) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿主要住宿人手机号与目标会员不一致", 409);
  }
  if (sourceDocumentNumber !== null && memberDocumentNumber !== null && sourceDocumentNumber !== memberDocumentNumber) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿主要住宿人证件号与目标会员不一致", 409);
  }
  const intervals = sourceView.effectiveArrangement.intervals;
  const serviceDates = intervals.flatMap((interval) => enumerateServiceDates(interval.arrivalDate, interval.departureDate));
  if (serviceDates.length === 0 || new Set(serviceDates).size !== serviceDates.length) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿服务日无法唯一推导", 409);
  }
  if (serviceDates.length > oldOrder.entitlement_units) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿夜数超过会员产品权益数量", 409);
  }
  const inventoryUnitIds = [...new Set(intervals.map((item) => item.inventoryUnitId))];
  const units = await db.selectFrom("inventory_units").select(["id", "kind", "room_type_code"])
    .where("id", "in", inventoryUnitIds).orderBy("id").execute();
  if (units.length !== inventoryUnitIds.length || units.some((unit) => unit.kind !== oldOrder.allowed_inventory_kind
    || unit.room_type_code !== oldOrder.allowed_room_type_code)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿房型与旧会员产品不匹配", 409);
  }
  const existingConversionAmendment = sourceView.amendments.find((item) =>
    item.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
      || item.amendment_type === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY");
  if (existingConversionAmendment) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "源住宿已经转换过会员", 409);
  const stayTransferTotal = sourceFunds.reduce((sum, item) => sum + item.amount_minor, 0);
  const oldDirectCollectionTotal = oldPayments.reduce((sum, item) => sum + item.amount_minor, 0);
  const replacementDirectAmount = oldOrder.agreed_price_minor - stayTransferTotal;
  if (!Number.isSafeInteger(stayTransferTotal) || !Number.isSafeInteger(oldDirectCollectionTotal)
    || !Number.isSafeInteger(replacementDirectAmount) || replacementDirectAmount < 0) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "住宿净收款不能超过重建会员成交价", 409);
  }
  if (sourceView.amounts.netRecordedCollection.minorUnits !== stayTransferTotal
    || sourceRaw.current_contract_amount_minor < stayTransferTotal) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "源住宿当前金额必须覆盖企业微信净收款", 409);
  }
  const validUntil = addOneCalendarYear(actualMembershipDate);
  if (actualMembershipDate > propertyToday || validUntil < propertyToday
    || serviceDates.some((date) => date < actualMembershipDate || date > validUntil)) {
    throw new DomainError("ENTITLEMENT_CONFLICT", "新会员有效期必须覆盖全部历史服务日且截至营业日仍有效", 409);
  }
  const replacementInput = input.replacementDirectPayment === undefined
    ? null
    : object(input.replacementDirectPayment, "replacementDirectPayment");
  if (replacementDirectAmount > 0 && !replacementInput) {
    throw new DomainError("VALIDATION_ERROR", "存在直接会员差额时必须提供真实直收交易证据");
  }
  if (replacementDirectAmount === 0 && replacementInput) {
    throw new DomainError("VALIDATION_ERROR", "没有直接会员差额时不应提供直收交易证据");
  }
  let replacementDirectPayment: {
    amount: { currency: string; minorUnits: number };
    businessDate: string;
    transactionReference: string;
  } | null = null;
  if (replacementInput) {
    const businessDate = localDate(replacementInput, "businessDate");
    const transactionReference = requireTransactionReference(replacementInput.transactionReference);
    if (businessDate > propertyToday) {
      throw new DomainError("VALIDATION_ERROR", "企业微信收款日期不能晚于物业营业日");
    }
    const [duplicateMembershipPayment, duplicateStayPayment] = await Promise.all([
      db.selectFrom("membership_payment_facts").select("fact_id")
        .where("transaction_reference", "=", transactionReference).executeTakeFirst(),
      db.selectFrom("collection_facts").select("fact_id")
        .where("transaction_reference", "=", transactionReference).executeTakeFirst()
    ]);
    if (duplicateMembershipPayment || duplicateStayPayment) {
      throw new DomainError("VALIDATION_ERROR", "直接会员交易引用不能复用其他会员或住宿资金流水");
    }
    replacementDirectPayment = {
      amount: money(oldOrder.currency, replacementDirectAmount),
      businessDate,
      transactionReference
    };
  }
  const arrivalDate = sourceView.effectiveArrangement.arrivalDate;
  const departureDate = sourceView.effectiveArrangement.departureDate;
  const directCollections = oldPayments.map((item) => ({
    factId: item.fact_id,
    amount: money(item.currency, item.amount_minor),
    transactionReference: requireTransactionReference(item.transaction_reference),
    businessDate: item.business_date
  }));
  return finalize(propertyId, {
    operation: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
    evidenceNote,
    member: { memberId: member.id, fullName: member.full_name },
    oldMembership: {
      membershipOrderId: oldOrder.id,
      contractId: oldContract.id,
      entitlementLotId: oldLot.id,
      productId: oldOrder.product_id,
      status: "ACTIVE",
      directCollections
    },
    sourceStay: {
      orderId: sourceRaw.id,
      stayId: sourceRaw.stay_id,
      arrivalDate,
      departureDate,
      serviceDates,
      identityEvidence: { phoneMatched, documentMatched }
    },
    funds: {
      oldDirectCollectionTotal: money(oldOrder.currency, oldDirectCollectionTotal),
      oldReversalTotal: money(oldOrder.currency, oldDirectCollectionTotal),
      stayTransferTotal: money(oldOrder.currency, stayTransferTotal),
      replacementDirectPayment,
      membershipAgreedPrice: money(oldOrder.currency, oldOrder.agreed_price_minor),
      reclassificationOnly: true
    },
    newMembership: {
      productId: oldOrder.product_id,
      productName: oldOrder.product_name,
      validFrom: actualMembershipDate,
      validUntil
    },
    entitlement: {
      unitKind: oldOrder.entitlement_unit_kind,
      totalUnits: oldOrder.entitlement_units,
      consumedUnits: serviceDates.length,
      remainingUnits: oldOrder.entitlement_units - serviceDates.length,
      serviceDates
    }
  }, {
    oldOrder: { id: oldOrder.id, version: oldOrder.version, status: oldOrder.status },
    oldContract: { id: oldContract.id, version: oldContract.version, status: oldContract.status },
    oldLot: { id: oldLot.id, version: oldLot.version, status: oldLot.status },
    oldPaymentsHash: stableHash(oldPayments),
    sourceOrder: { id: sourceRaw.id, version: sourceRaw.version, status: sourceRaw.status },
    sourceStay: { id: sourceRaw.stay_id, status: sourceRaw.stay_status },
    sourceArrangement: sourceView.effectiveArrangement,
    sourceIdentity: {
      phoneMatched,
      documentMatched,
      sourcePhonePresent: sourcePhone !== null,
      sourceDocumentNumberPresent: sourceDocumentNumber !== null,
      memberDocumentNumberPresent: memberDocumentNumber !== null
    },
    sourceFundsHash: stableHash(sourceFunds),
    activeMembershipOrderIds: activeOrders.map((item) => item.id),
    activeContractIds: activeProjections.contracts.map((item) => item.id),
    activeEntitlementLotIds: activeProjections.lots.map((item) => item.id),
    propertyToday
  });
}

export async function buildMemberCorrectionEffect(
  db: DbExecutor,
  commandType: MemberCorrectionCommandType,
  rawInput: unknown
): Promise<BuiltMemberCorrectionEffect> {
  const input = normalizeMemberCorrectionInput(commandType, rawInput);
  const propertyId = input.propertyId as string;
  if (commandType === "CORRECT_MEMBER_PROFILE") return buildProfileCorrection(db, input, propertyId);
  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") return buildEffectiveDateCorrection(db, input, propertyId);
  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") return buildHistoricalBackfill(db, input, propertyId);
  return buildMembershipVoidReconversion(db, input, propertyId);
}

async function advisoryLocks(trx: Transaction<Database>, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0::bigint))`.execute(trx);
  }
}

async function lockMemberMembershipProjectionResources(
  trx: Transaction<Database>,
  propertyId: string,
  memberId: string
): Promise<void> {
  await trx.selectFrom("membership_orders").select("id")
    .where("member_id", "=", memberId).where("property_id", "=", propertyId)
    .orderBy("id").forUpdate().execute();
  const contracts = await trx.selectFrom("member_contracts").select("id")
    .where("member_id", "=", memberId).where("property_id", "=", propertyId)
    .orderBy("id").forUpdate().execute();
  const contractIds = contracts.map((contract) => contract.id);
  if (contractIds.length > 0) {
    await trx.selectFrom("entitlement_lots").select("id")
      .where("contract_id", "in", contractIds).orderBy("id").forUpdate().execute();
  }
}

export async function lockMemberCorrectionResources(
  trx: Transaction<Database>,
  commandType: MemberCorrectionCommandType,
  rawInput: unknown
): Promise<void> {
  const input = normalizeMemberCorrectionInput(commandType, rawInput);
  const propertyId = input.propertyId as string;
  if (commandType === "CORRECT_MEMBER_PROFILE") {
    const memberId = string(input, "memberId");
    const expected = profileSnapshot(input, "expectedPriorProfile");
    const corrected = profileSnapshot(input, "correctedProfile");
    await advisoryLocks(trx, [
      `qintopia:member:${memberId}`,
      `qintopia:member-phone:${expected.phone}`,
      `qintopia:member-phone:${corrected.phone}`
    ]);
    await trx.selectFrom("members").select("id").where("id", "=", memberId).forUpdate().executeTakeFirst();
    await trx.selectFrom("members").select("id")
      .where("phone", "in", [...new Set([expected.phone, corrected.phone])]).orderBy("id").forUpdate().execute();
    return;
  }

  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") {
    const memberId = string(input, "memberId");
    await advisoryLocks(trx, [
      `qintopia:member-entitlements:${memberId}`
    ]);
    await trx.selectFrom("members").select("id").where("id", "=", memberId).forUpdate().executeTakeFirst();
    await lockMemberMembershipProjectionResources(trx, propertyId, memberId);
    return;
  }

  const membershipOrderId = commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE"
    ? string(input, "membershipOrderId")
    : string(input, "erroneousMembershipOrderId");
  const order = await trx.selectFrom("membership_orders").select(["id", "member_id", "contract_id", "entitlement_lot_id"])
    .where("id", "=", membershipOrderId).where("property_id", "=", propertyId).executeTakeFirst();
  if (!order) throw new DomainError("NOT_FOUND", "会员订单不存在", 404);
  const keys = [`qintopia:member-entitlements:${order.member_id}`, `qintopia:membership-order:${order.id}`];
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
    keys.push(`qintopia:stay-order:${string(input, "sourceStayOrderId")}`);
  }
  await advisoryLocks(trx, keys);
  await trx.selectFrom("members").select("id").where("id", "=", order.member_id).forUpdate().executeTakeFirst();
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
    await lockMemberMembershipProjectionResources(trx, propertyId, order.member_id);
  } else {
    await trx.selectFrom("membership_orders").select("id").where("id", "=", order.id).forUpdate().executeTakeFirst();
    if (order.contract_id) {
      await trx.selectFrom("member_contracts").select("id").where("id", "=", order.contract_id).forUpdate().executeTakeFirst();
      await trx.selectFrom("entitlement_lots").select("id").where("contract_id", "=", order.contract_id)
        .orderBy("id").forUpdate().execute();
    }
  }
  if (order.contract_id) {
    const lotIds = (await trx.selectFrom("entitlement_lots").select("id")
      .where("contract_id", "=", order.contract_id).orderBy("id").execute())
      .map((lot) => lot.id);
    if (lotIds.length > 0) {
      await trx.selectFrom("coverage_items").select("id").where("lot_id", "in", lotIds).orderBy("id").forUpdate().execute();
      await trx.selectFrom("entitlement_ledger").select("fact_id").where("lot_id", "in", lotIds).orderBy("fact_id").forUpdate().execute();
    }
  }
  await trx.selectFrom("membership_payment_facts").select("fact_id")
    .where("membership_order_id", "=", order.id).orderBy("fact_id").forUpdate().execute();

  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
    const sourceOrderId = string(input, "sourceStayOrderId");
    await trx.selectFrom("orders").select("id").where("id", "=", sourceOrderId)
      .where("property_id", "=", propertyId).forUpdate().executeTakeFirst();
    await trx.selectFrom("stays").select("id").where("order_id", "=", sourceOrderId).forUpdate().executeTakeFirst();
    await trx.selectFrom("collection_facts").select("fact_id").where("order_id", "=", sourceOrderId)
      .orderBy("fact_id").forUpdate().execute();
    await trx.selectFrom("stay_collection_membership_transfers").select("id")
      .where("order_id", "=", sourceOrderId).orderBy("id").forUpdate().execute();
  }
}

function effectObject(effect: Record<string, unknown>, field: string): Record<string, unknown> {
  return object(effect[field], field);
}

function effectMoney(value: unknown, field: string): { currency: string; minorUnits: number } {
  const amount = object(value, field);
  const currency = string(amount, "currency", 3);
  const minorUnits = integer(amount, "minorUnits", 0);
  return { currency, minorUnits };
}

function effectString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value) throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  return value;
}

function effectInteger(input: Record<string, unknown>, field: string, minimum = 0): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  }
  return value as number;
}

function effectEntitlementUnitKind(input: Record<string, unknown>, field: string): "ROOM_NIGHT" | "BED_NIGHT" {
  const value = effectString(input, field);
  if (value !== "ROOM_NIGHT" && value !== "BED_NIGHT") {
    throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  }
  return value;
}

function effectInventoryKind(input: Record<string, unknown>, field: string): "ROOM" | "BED" {
  const value = effectString(input, field);
  if (value !== "ROOM" && value !== "BED") {
    throw new DomainError("INTERNAL_ERROR", `${field} is invalid`, 500);
  }
  return value;
}

async function correctionReceiptAudit(
  trx: Transaction<Database>,
  commandId: string,
  reason: CommandReason,
  evidenceNote: string
) {
  const row = await trx.selectFrom("command_executions")
    .innerJoin("subjects", "subjects.id", "command_executions.subject_id")
    .select([
      "command_executions.subject_id as actor_subject_id",
      "subjects.display_name as actor_display_name"
    ])
    .select(sql<Date>`transaction_timestamp()`.as("recorded_at"))
    .where("command_executions.id", "=", commandId)
    .executeTakeFirstOrThrow();
  return {
    reason,
    evidenceNote,
    actor: {
      subjectId: row.actor_subject_id,
      displayName: row.actor_display_name
    },
    recordedAt: row.recorded_at.toISOString()
  };
}

export async function applyMemberCorrectionCommand(
  trx: Transaction<Database>,
  options: {
    commandType: MemberCorrectionCommandType;
    propertyId: string;
    effect: Record<string, unknown>;
    commandId: string;
    reason: CommandReason;
  }
): Promise<AppliedMemberCorrection> {
  const { commandType, propertyId, effect, commandId } = options;
  if (commandType === "CORRECT_MEMBER_PROFILE") {
    const memberId = effectString(effect, "memberId");
    const before = effectObject(effect, "before");
    const after = effectObject(effect, "after");
    const changedFields = effect.changedFields;
    if (!Array.isArray(changedFields) || changedFields.some((item) => typeof item !== "string")) {
      throw new DomainError("INTERNAL_ERROR", "会员资料修改内容无效", 500);
    }
    const latest = await trx.selectFrom("member_profile_corrections").select("sequence")
      .where("member_id", "=", memberId).orderBy("sequence", "desc").executeTakeFirst();
    const correctionId = newId("fact");
    await trx.insertInto("member_profile_corrections").values({
      id: correctionId,
      property_id: propertyId,
      member_id: memberId,
      sequence: (latest?.sequence ?? 0) + 1,
      prior_full_name: effectString(before, "fullName"),
      prior_nickname: effectString(before, "nickname"),
      prior_identity_card_number: before.identityCardNumber as string | null,
      prior_phone: effectString(before, "phone"),
      prior_wechat: effectString(before, "wechat"),
      corrected_full_name: effectString(after, "fullName"),
      corrected_nickname: effectString(after, "nickname"),
      corrected_identity_card_number: after.identityCardNumber as string | null,
      corrected_phone: effectString(after, "phone"),
      corrected_wechat: effectString(after, "wechat"),
      changed_fields: changedFields as string[],
      evidence_note: effectString(effect, "evidenceNote"),
      command_id: commandId
    }).execute();
    try {
      const updated = await trx.updateTable("members").set({
        full_name: effectString(after, "fullName"),
        nickname: effectString(after, "nickname"),
        identity_card_number: after.identityCardNumber as string | null,
        phone: effectString(after, "phone"),
        wechat: effectString(after, "wechat")
      }).where("id", "=", memberId).returning("id").executeTakeFirst();
      if (!updated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员资料已变化", 409);
    } catch (error) {
      const databaseError = error as { code?: unknown; constraint?: unknown };
      if (databaseError.code === "23505" && databaseError.constraint === "members_phone_unique") {
        throw new DomainError("VALIDATION_ERROR", "该手机号已属于另一位会员，不能合并或迁移会员资料", 409);
      }
      throw error;
    }
    return {
      persistedResult: {
        memberId,
        correctionId,
        changedFields,
        before,
        after,
        ...(await correctionReceiptAudit(
          trx,
          commandId,
          options.reason,
          effectString(effect, "evidenceNote")
        ))
      },
      resourceRefs: [memberId],
      factRefs: [correctionId]
    };
  }

  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") {
    const orderId = effectString(effect, "membershipOrderId");
    const contractId = effectString(effect, "contractId");
    const lotId = effectString(effect, "entitlementLotId");
    const memberId = effectString(effect, "memberId");
    const before = effectObject(effect, "before");
    const after = effectObject(effect, "after");
    const unchanged = effectObject(effect, "unchanged");
    const expectedAvailableBalance = object(unchanged.availableBalance, "unchanged.availableBalance");
    const [order, contract, lot, allLots, latest] = await Promise.all([
      trx.selectFrom("membership_orders").select(["version"]).where("id", "=", orderId).executeTakeFirstOrThrow(),
      trx.selectFrom("member_contracts").select(["version"]).where("id", "=", contractId).executeTakeFirstOrThrow(),
      trx.selectFrom("entitlement_lots").selectAll().where("id", "=", lotId).executeTakeFirstOrThrow(),
      trx.selectFrom("entitlement_lots").select("id").where("contract_id", "=", contractId)
        .orderBy("id").execute(),
      trx.selectFrom("membership_effective_date_corrections").select("sequence")
        .where("membership_order_id", "=", orderId).orderBy("sequence", "desc").executeTakeFirst()
    ]);
    if (allLots.length !== 1 || allLots[0]?.id !== lotId || lot.status !== "ACTIVE") {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员权益记录已变化，请重新预览", 409);
    }
    const correctionId = newId("fact");
    const validFrom = effectString(after, "validFrom");
    const validUntil = effectString(after, "validUntil");
    await trx.insertInto("membership_effective_date_corrections").values({
      id: correctionId,
      property_id: propertyId,
      member_id: memberId,
      membership_order_id: orderId,
      contract_id: contractId,
      entitlement_lot_id: lotId,
      sequence: (latest?.sequence ?? 0) + 1,
      prior_valid_from: effectString(before, "validFrom"),
      prior_valid_until: effectString(before, "validUntil"),
      corrected_valid_from: validFrom,
      corrected_valid_until: validUntil,
      prior_order_version: order.version,
      prior_contract_version: contract.version,
      prior_lot_version: lot.version,
      evidence_note: effectString(effect, "evidenceNote"),
      command_id: commandId
    }).execute();
    const updatedOrder = await trx.updateTable("membership_orders").set({
      valid_from: validFrom,
      valid_until: validUntil,
      version: sql`version + 1`,
      updated_at: sql<Date>`transaction_timestamp()`
    }).where("id", "=", orderId).where("status", "=", "ACTIVE").where("version", "=", order.version)
      .returning("id").executeTakeFirst();
    const updatedContract = await trx.updateTable("member_contracts").set({
      valid_from: validFrom,
      valid_until: validUntil,
      version: sql`version + 1`
    }).where("id", "=", contractId).where("status", "=", "ACTIVE").where("version", "=", contract.version)
      .returning("id").executeTakeFirst();
    const updatedLot = await trx.updateTable("entitlement_lots").set({
      expires_on: validUntil,
      version: sql`version + 1`
    }).where("id", "=", lot.id).where("status", "=", "ACTIVE").where("version", "=", lot.version)
      .returning("id").executeTakeFirst();
    if (!updatedOrder || !updatedContract || !updatedLot) {
      throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员订单、合同或权益记录已变化，请重新预览", 409);
    }
    const viewAfter = await getMemberView(trx, propertyId, memberId);
    if (stableHash(viewAfter.availableBalance) !== stableHash(expectedAvailableBalance)) {
      throw new DomainError("ENTITLEMENT_CONFLICT", "修改生效日不能改变会员权益余额", 409);
    }
    return {
      persistedResult: {
        memberId,
        membershipOrderId: orderId,
        contractId,
        entitlementLotId: lotId,
        correctionId,
        validFrom,
        validUntil,
        status: "ACTIVE",
        before,
        after,
        unchanged,
        ...(await correctionReceiptAudit(
          trx,
          commandId,
          options.reason,
          effectString(effect, "evidenceNote")
        ))
      },
      resourceRefs: [memberId, orderId, contractId, lotId],
      factRefs: [correctionId]
    };
  }

  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") {
    return applyHistoricalMembershipBackfill(trx, options);
  }
  return applyMembershipVoidReconversion(trx, options);
}

async function applyHistoricalMembershipBackfill(
  trx: Transaction<Database>,
  options: {
    commandType: MemberCorrectionCommandType;
    propertyId: string;
    effect: Record<string, unknown>;
    commandId: string;
    reason: CommandReason;
  }
): Promise<AppliedMemberCorrection> {
  const { effect, propertyId, commandId } = options;
  const member = effectObject(effect, "member");
  const productEffect = effectObject(effect, "product");
  const paymentEffect = effectObject(effect, "payment");
  const paymentAmount = effectMoney(paymentEffect.amount, "payment.amount");
  const productId = effectString(productEffect, "productId");
  const productCode = effectString(productEffect, "code");
  const productVersion = effectInteger(productEffect, "version", 1);
  const productName = effectString(productEffect, "name");
  const listedPrice = effectMoney(productEffect.listedPrice, "product.listedPrice");
  const agreedPrice = effectMoney(productEffect.agreedPrice, "product.agreedPrice");
  const entitlementUnitKind = effectEntitlementUnitKind(productEffect, "entitlementUnitKind");
  const entitlementUnits = effectInteger(productEffect, "entitlementUnits", 1);
  const validityPeriod = effectString(productEffect, "validityPeriod");
  const allowedRoomTypeCode = effectString(productEffect, "allowedRoomTypeCode");
  const allowedInventoryKind = effectInventoryKind(productEffect, "allowedInventoryKind");
  if (listedPrice.currency !== agreedPrice.currency
    || agreedPrice.currency !== paymentAmount.currency
    || agreedPrice.minorUnits !== listedPrice.minorUnits
    || effectEntitlementUnitKind(effect, "entitlementUnitKind") !== entitlementUnitKind
    || effectInteger(effect, "entitlementUnits", 1) !== entitlementUnits
    || validityPeriod !== "P1Y") {
    throw new DomainError("INTERNAL_ERROR", "历史会员补录的产品信息不一致", 500);
  }
  const product = await trx.selectFrom("membership_products").selectAll()
    .where("id", "=", productId).where("status", "=", "PUBLISHED").executeTakeFirst();
  if (!product || stableHash(membershipProductEffect(product, product.list_price_minor)) !== stableHash(productEffect)) {
    throw new DomainError("AGGREGATE_VERSION_CONFLICT", "会员产品已变化", 409);
  }
  const memberId = effectString(member, "memberId");
  const validFrom = effectString(effect, "validFrom");
  const validUntil = effectString(effect, "validUntil");
  const businessDate = effectString(paymentEffect, "businessDate");
  const transactionReference = requireTransactionReference(paymentEffect.transactionReference);
  const membershipOrderId = newId("membership_order");
  const paymentFactId = newId("membership_payment");
  const contractId = newId("contract");
  const lotId = newId("lot");
  const backfillId = newId("fact");
  const recordedAt = sql<Date>`transaction_timestamp()`;
  await trx.insertInto("membership_orders").values({
    id: membershipOrderId,
    property_id: propertyId,
    member_id: memberId,
    product_id: productId,
    product_code: productCode,
    product_version: productVersion,
    product_name: productName,
    listed_price_minor: listedPrice.minorUnits,
    agreed_price_minor: agreedPrice.minorUnits,
    price_adjustment_minor: 0,
    price_adjustment_reason: null,
    currency: agreedPrice.currency,
    entitlement_unit_kind: entitlementUnitKind,
    entitlement_units: entitlementUnits,
    allowed_room_type_code: allowedRoomTypeCode,
    allowed_inventory_kind: allowedInventoryKind,
    status: "DRAFT",
    activated_at: null,
    valid_from: null,
    valid_until: null,
    contract_id: null,
    entitlement_lot_id: null,
    version: 1,
    created_by_command_id: commandId,
    activated_by_command_id: null
  }).execute();
  await trx.insertInto("membership_payment_facts").values({
    fact_id: paymentFactId,
    membership_order_id: membershipOrderId,
    fact_type: "COLLECTION",
    amount_minor: paymentAmount.minorUnits,
    net_effect_minor: paymentAmount.minorUnits,
    currency: paymentAmount.currency,
    transaction_reference: transactionReference,
    corrects_fact_id: null,
    reverses_fact_id: null,
    source_type: "DIRECT_WECOM",
    source_order_id: null,
    source_collection_fact_id: null,
    note: typeof paymentEffect.note === "string" ? paymentEffect.note : "",
    command_id: commandId,
    business_date: businessDate
  }).execute();
  await trx.insertInto("member_contracts").values({
    id: contractId,
    property_id: propertyId,
    member_id: memberId,
    member_name: effectString(member, "fullName"),
    status: "ACTIVE",
    valid_from: validFrom,
    valid_until: validUntil,
    version: 1,
    membership_order_id: membershipOrderId
  }).execute();
  await trx.insertInto("entitlement_lots").values({
    id: lotId,
    contract_id: contractId,
    unit_kind: entitlementUnitKind,
    total_units: entitlementUnits,
    expires_on: validUntil,
    status: "ACTIVE",
    version: 1
  }).execute();
  const activated = await trx.updateTable("membership_orders").set({
    status: "ACTIVE",
    activated_at: recordedAt,
    valid_from: validFrom,
    valid_until: validUntil,
    contract_id: contractId,
    entitlement_lot_id: lotId,
    version: sql`version + 1`,
    activated_by_command_id: commandId,
    updated_at: recordedAt
  }).where("id", "=", membershipOrderId).where("status", "=", "DRAFT").returning("id").executeTakeFirst();
  if (!activated) throw new DomainError("AGGREGATE_VERSION_CONFLICT", "历史会员补录链创建失败", 409);
  await trx.insertInto("historical_membership_backfills").values({
    id: backfillId,
    property_id: propertyId,
    member_id: memberId,
    membership_order_id: membershipOrderId,
    contract_id: contractId,
    entitlement_lot_id: lotId,
    payment_fact_id: paymentFactId,
    actual_membership_date: validFrom,
    valid_until: validUntil,
    business_date: businessDate,
    transaction_reference: transactionReference,
    product_id: productId,
    product_code: productCode,
    product_version: productVersion,
    product_name: productName,
    listed_price_minor: listedPrice.minorUnits,
    agreed_price_minor: agreedPrice.minorUnits,
    currency: agreedPrice.currency,
    entitlement_unit_kind: entitlementUnitKind,
    entitlement_units: entitlementUnits,
    validity_period: validityPeriod,
    allowed_room_type_code: allowedRoomTypeCode,
    allowed_inventory_kind: allowedInventoryKind,
    evidence_note: effectString(effect, "evidenceNote"),
    command_id: commandId
  }).execute();
  return {
    persistedResult: {
      memberId,
      membershipOrderId,
      paymentFactId,
      contractId,
      entitlementLotId: lotId,
      backfillId,
      status: "ACTIVE",
      validFrom,
      validUntil,
      entitlementUnitKind,
      entitlementUnits,
      member,
      product: productEffect,
      payment: paymentEffect,
      ...(await correctionReceiptAudit(
        trx,
        commandId,
        options.reason,
        effectString(effect, "evidenceNote")
      ))
    },
    resourceRefs: [memberId, membershipOrderId, contractId, lotId],
    factRefs: [paymentFactId, backfillId]
  };
}

async function applyMembershipVoidReconversion(
  trx: Transaction<Database>,
  options: {
    commandType: MemberCorrectionCommandType;
    propertyId: string;
    effect: Record<string, unknown>;
    commandId: string;
    reason: CommandReason;
  }
): Promise<AppliedMemberCorrection> {
  const { effect, propertyId, commandId, reason } = options;
  const member = effectObject(effect, "member");
  const oldMembership = effectObject(effect, "oldMembership");
  const sourceStay = effectObject(effect, "sourceStay");
  const funds = effectObject(effect, "funds");
  const newMembership = effectObject(effect, "newMembership");
  const entitlement = effectObject(effect, "entitlement");
  const memberId = effectString(member, "memberId");
  const oldOrderId = effectString(oldMembership, "membershipOrderId");
  const oldContractId = effectString(oldMembership, "contractId");
  const oldLotId = effectString(oldMembership, "entitlementLotId");
  const sourceOrderId = effectString(sourceStay, "orderId");
  const sourceStayId = effectString(sourceStay, "stayId");
  const serviceDates = entitlement.serviceDates;
  const directCollections = oldMembership.directCollections;
  if (!Array.isArray(serviceDates) || serviceDates.some((item) => typeof item !== "string")
    || !Array.isArray(directCollections) || directCollections.length === 0) {
    throw new DomainError("INTERNAL_ERROR", "会员作废重建信息不完整", 500);
  }
  const oldDirectTotal = effectMoney(funds.oldDirectCollectionTotal, "funds.oldDirectCollectionTotal");
  const stayTransferTotal = effectMoney(funds.stayTransferTotal, "funds.stayTransferTotal");
  const membershipAgreedPrice = effectMoney(funds.membershipAgreedPrice, "funds.membershipAgreedPrice");
  const replacementEffect = funds.replacementDirectPayment === null
    ? null
    : object(funds.replacementDirectPayment, "funds.replacementDirectPayment");
  const replacementDirectTotal = replacementEffect
    ? effectMoney(replacementEffect.amount, "replacementDirectPayment.amount")
    : money(membershipAgreedPrice.currency, 0);
  const replacementBusinessDate = replacementEffect
    ? effectString(replacementEffect, "businessDate")
    : null;
  const replacementTransactionReference = replacementEffect
    ? requireTransactionReference(replacementEffect.transactionReference)
    : null;
  const [oldOrder, oldContract, oldLot, sourceOrder, sourceRevision, sourceCollections] = await Promise.all([
    trx.selectFrom("membership_orders").selectAll().where("id", "=", oldOrderId).executeTakeFirstOrThrow(),
    trx.selectFrom("member_contracts").selectAll().where("id", "=", oldContractId).executeTakeFirstOrThrow(),
    trx.selectFrom("entitlement_lots").selectAll().where("id", "=", oldLotId).executeTakeFirstOrThrow(),
    trx.selectFrom("orders").selectAll().where("id", "=", sourceOrderId).executeTakeFirstOrThrow(),
    trx.selectFrom("orders").innerJoin("pricing_revisions", "pricing_revisions.id", "orders.current_revision_id")
      .selectAll("pricing_revisions").where("orders.id", "=", sourceOrderId).executeTakeFirstOrThrow(),
    trx.selectFrom("collection_facts").selectAll().where("order_id", "=", sourceOrderId)
      .where("fact_type", "=", "COLLECTION").orderBy("created_at").orderBy("fact_id").execute()
  ]);
  const newOrderId = newId("membership_order");
  const newContractId = newId("contract");
  const newLotId = newId("lot");
  const replacementPaymentFactId = replacementEffect ? newId("membership_payment") : null;
  const voidId = newId("fact");
  const validFrom = effectString(newMembership, "validFrom");
  const validUntil = effectString(newMembership, "validUntil");
  const recordedAt = sql<Date>`transaction_timestamp()`;

  await trx.insertInto("membership_void_reconversions").values({
    id: voidId,
    property_id: propertyId,
    member_id: memberId,
    old_membership_order_id: oldOrderId,
    old_contract_id: oldContractId,
    old_entitlement_lot_id: oldLotId,
    prior_old_order_version: oldOrder.version,
    prior_old_contract_version: oldContract.version,
    prior_old_lot_version: oldLot.version,
    source_order_id: sourceOrderId,
    source_stay_id: sourceStayId,
    prior_source_order_version: sourceOrder.version,
    new_membership_order_id: newOrderId,
    new_contract_id: newContractId,
    new_entitlement_lot_id: newLotId,
    replacement_payment_fact_id: replacementPaymentFactId,
    replacement_business_date: replacementBusinessDate,
    replacement_transaction_reference: replacementTransactionReference,
    actual_membership_date: validFrom,
    valid_until: validUntil,
    old_direct_collection_total_minor: oldDirectTotal.minorUnits,
    stay_transfer_total_minor: stayTransferTotal.minorUnits,
    membership_agreed_price_minor: membershipAgreedPrice.minorUnits,
    service_dates: serviceDates as string[],
    evidence_note: effectString(effect, "evidenceNote"),
    command_id: commandId
  }).execute();

  await trx.insertInto("membership_orders").values({
    id: newOrderId,
    property_id: propertyId,
    member_id: memberId,
    product_id: oldOrder.product_id,
    product_code: oldOrder.product_code,
    product_version: oldOrder.product_version,
    product_name: oldOrder.product_name,
    listed_price_minor: oldOrder.listed_price_minor,
    agreed_price_minor: oldOrder.agreed_price_minor,
    price_adjustment_minor: oldOrder.price_adjustment_minor,
    price_adjustment_reason: oldOrder.price_adjustment_reason,
    currency: oldOrder.currency,
    entitlement_unit_kind: oldOrder.entitlement_unit_kind,
    entitlement_units: oldOrder.entitlement_units,
    allowed_room_type_code: oldOrder.allowed_room_type_code,
    allowed_inventory_kind: oldOrder.allowed_inventory_kind,
    status: "DRAFT",
    activated_at: null,
    valid_from: null,
    valid_until: null,
    contract_id: null,
    entitlement_lot_id: null,
    version: 1,
    created_by_command_id: commandId,
    activated_by_command_id: null
  }).execute();

  const transferIds: string[] = [];
  const sourceReversalFactIds: string[] = [];
  const transferPaymentFactIds: string[] = [];
  for (const source of sourceCollections) {
    const sourceReversalFactId = newId("fact");
    const transferPaymentFactId = newId("membership_payment");
    const transferId = newId("transfer");
    await trx.insertInto("collection_facts").values({
      fact_id: sourceReversalFactId,
      order_id: sourceOrderId,
      fact_type: "REVERSAL",
      amount_minor: source.amount_minor,
      net_effect_minor: -source.net_effect_minor,
      currency: source.currency,
      references_fact_id: null,
      reverses_fact_id: source.fact_id,
      method: "REVERSAL",
      note: "错误办卡作废后重新登记会员",
      transaction_reference: null,
      pricing_revision_id: sourceRevision.id,
      command_id: commandId
    }).execute();
    await trx.insertInto("membership_payment_facts").values({
      fact_id: transferPaymentFactId,
      membership_order_id: newOrderId,
      fact_type: "COLLECTION",
      amount_minor: source.amount_minor,
      net_effect_minor: source.amount_minor,
      currency: source.currency,
      transaction_reference: null,
      corrects_fact_id: null,
      reverses_fact_id: null,
      source_type: "STAY_COLLECTION_TRANSFER",
      source_order_id: sourceOrderId,
      source_collection_fact_id: source.fact_id,
      note: "错误办卡作废后，住宿收款转入新会员订单",
      command_id: commandId,
      business_date: sql<string>`(
        SELECT (source_fact.created_at AT TIME ZONE property_row.timezone)::date
        FROM collection_facts AS source_fact
        JOIN orders AS source_order ON source_order.id = source_fact.order_id
        JOIN properties AS property_row ON property_row.id = source_order.property_id
        WHERE source_fact.fact_id = ${source.fact_id}
      )`
    }).execute();
    await trx.insertInto("stay_collection_membership_transfers").values({
      id: transferId,
      property_id: propertyId,
      order_id: sourceOrderId,
      source_collection_fact_id: source.fact_id,
      source_reversal_fact_id: sourceReversalFactId,
      membership_order_id: newOrderId,
      membership_payment_fact_id: transferPaymentFactId,
      command_id: commandId
    }).execute();
    sourceReversalFactIds.push(sourceReversalFactId);
    transferPaymentFactIds.push(transferPaymentFactId);
    transferIds.push(transferId);
  }

  if (replacementEffect && replacementPaymentFactId) {
    await trx.insertInto("membership_payment_facts").values({
      fact_id: replacementPaymentFactId,
      membership_order_id: newOrderId,
      fact_type: "COLLECTION",
      amount_minor: replacementDirectTotal.minorUnits,
      net_effect_minor: replacementDirectTotal.minorUnits,
      currency: replacementDirectTotal.currency,
      transaction_reference: replacementTransactionReference!,
      corrects_fact_id: null,
      reverses_fact_id: null,
      source_type: "DIRECT_WECOM",
      source_order_id: null,
      source_collection_fact_id: null,
      note: "错误办卡作废后，实际差额收款计入新会员订单",
      command_id: commandId,
      business_date: replacementBusinessDate!
    }).execute();
  }

  await trx.insertInto("member_contracts").values({
    id: newContractId,
    property_id: propertyId,
    member_id: memberId,
    member_name: effectString(member, "fullName"),
    status: "ACTIVE",
    valid_from: validFrom,
    valid_until: validUntil,
    version: 1,
    membership_order_id: newOrderId
  }).execute();
  await trx.insertInto("entitlement_lots").values({
    id: newLotId,
    contract_id: newContractId,
    unit_kind: oldOrder.entitlement_unit_kind,
    total_units: oldOrder.entitlement_units,
    expires_on: validUntil,
    status: "ACTIVE",
    version: 1
  }).execute();
  await trx.updateTable("membership_orders").set({
    status: "ACTIVE",
    activated_at: recordedAt,
    valid_from: validFrom,
    valid_until: validUntil,
    contract_id: newContractId,
    entitlement_lot_id: newLotId,
    version: sql`version + 1`,
    activated_by_command_id: commandId,
    updated_at: recordedAt
  }).where("id", "=", newOrderId).where("status", "=", "DRAFT").executeTakeFirstOrThrow();

  const oldPaymentReversalFactIds: string[] = [];
  const paymentReclassificationFactIds: string[] = [];
  for (const value of directCollections) {
    const direct = object(value, "oldMembership.directCollections[]");
    const oldFactId = effectString(direct, "factId");
    const amount = effectMoney(direct.amount, "oldMembership.directCollections[].amount");
    const businessDate = effectString(direct, "businessDate");
    const reversalFactId = newId("membership_payment_reversal");
    const reclassificationId = newId("fact");
    await trx.insertInto("membership_payment_facts").values({
      fact_id: reversalFactId,
      membership_order_id: oldOrderId,
      fact_type: "REVERSAL",
      amount_minor: amount.minorUnits,
      net_effect_minor: -amount.minorUnits,
      currency: amount.currency,
      transaction_reference: null,
      corrects_fact_id: null,
      reverses_fact_id: oldFactId,
      source_type: "DIRECT_WECOM",
      source_order_id: null,
      source_collection_fact_id: null,
      note: "错误办卡作废后，原会员收款已冲销",
      command_id: commandId,
      business_date: businessDate
    }).execute();
    await trx.insertInto("membership_payment_reclassifications").values({
      id: reclassificationId,
      property_id: propertyId,
      member_id: memberId,
      old_membership_order_id: oldOrderId,
      old_payment_fact_id: oldFactId,
      old_reversal_fact_id: reversalFactId,
      new_membership_order_id: newOrderId,
      new_payment_fact_id: replacementPaymentFactId,
      amount_minor: amount.minorUnits,
      currency: amount.currency,
      evidence_note: effectString(effect, "evidenceNote"),
      command_id: commandId
    }).execute();
    oldPaymentReversalFactIds.push(reversalFactId);
    paymentReclassificationFactIds.push(reclassificationId);
  }

  const voidLedgerFactId = newId("fact");
  await trx.insertInto("entitlement_ledger").values({
    fact_id: voidLedgerFactId,
    lot_id: oldLotId,
    entry_type: "VOID",
    quantity_delta: -oldLot.total_units,
    service_date: null,
    order_id: null,
    coverage_id: null,
    reason: "ERRONEOUS_MEMBERSHIP_VOIDED",
    command_id: commandId
  }).execute();
  await trx.updateTable("membership_orders").set({
    status: "VOIDED",
    version: sql`version + 1`,
    updated_at: recordedAt
  }).where("id", "=", oldOrderId).where("status", "=", "ACTIVE").where("version", "=", oldOrder.version).executeTakeFirstOrThrow();
  await trx.updateTable("member_contracts").set({ status: "VOIDED", version: sql`version + 1` })
    .where("id", "=", oldContractId).where("status", "=", "ACTIVE").where("version", "=", oldContract.version).executeTakeFirstOrThrow();
  await trx.updateTable("entitlement_lots").set({ status: "VOIDED", version: sql`version + 1` })
    .where("id", "=", oldLotId).where("status", "=", "ACTIVE").where("version", "=", oldLot.version).executeTakeFirstOrThrow();

  const amendmentId = newId("amend");
  const revisionId = newId("revision");
  await trx.insertInto("amendments").values({
    id: amendmentId,
    order_id: sourceOrderId,
    sequence: sourceOrder.version + 1,
    amendment_type: "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
    reason_code: reason.code,
    reason_note: reason.note,
    prior_version: sourceOrder.version,
    new_version: sourceOrder.version + 1,
    payload: effect,
    command_id: commandId,
    created_at: sql<Date>`greatest(
      transaction_timestamp(),
      coalesce(
        (select max(created_at) from amendments where order_id = ${sourceOrderId}),
        '-infinity'::timestamptz
      )
    )`
  }).execute();
  await trx.insertInto("pricing_revisions").values({
    id: revisionId,
    order_id: sourceOrderId,
    revision_no: sourceRevision.revision_no + 1,
    amendment_id: amendmentId,
    policy_version_id: sourceOrder.pricing_policy_version_id,
    arrival_date: effectString(sourceStay, "arrivalDate"),
    departure_date: effectString(sourceStay, "departureDate"),
    coverage_set: JSON.stringify([]),
    cash_lines: JSON.stringify([]),
    policy_base_amount_minor: 0,
    pricing_basis: "MEMBER_ENTITLEMENT",
    manual_adjustment_minor: 0,
    current_contract_amount_minor: 0,
    currency: oldOrder.currency
  }).execute();
  await trx.updateTable("orders").set({
    current_revision_id: revisionId,
    member_id: memberId,
    member_contract_id: newContractId,
    version: sourceOrder.version + 1,
    updated_at: recordedAt
  }).where("id", "=", sourceOrderId).where("version", "=", sourceOrder.version).executeTakeFirstOrThrow();

  const conversionLedgerFactIds: string[] = [];
  for (const serviceDate of serviceDates as string[]) {
    const factId = newId("fact");
    await trx.insertInto("entitlement_ledger").values({
      fact_id: factId,
      lot_id: newLotId,
      entry_type: "CONVERSION_CONSUME",
      quantity_delta: -1,
      service_date: serviceDate,
      order_id: sourceOrderId,
      coverage_id: null,
      reason: "STAY_COLLECTION_TO_MEMBERSHIP_CONSUMED",
      command_id: commandId
    }).execute();
    conversionLedgerFactIds.push(factId);
  }
  await trx.updateTable("member_contracts").set({ version: sql`version + 1` })
    .where("id", "=", newContractId).execute();
  await trx.updateTable("entitlement_lots").set({ version: sql`version + 1` })
    .where("id", "=", newLotId).execute();

  return {
    persistedResult: {
      memberId,
      voidReconversionId: voidId,
      member,
      oldMembership,
      oldMembershipOrderId: oldOrderId,
      oldContractId,
      oldEntitlementLotId: oldLotId,
      oldStatus: "VOIDED",
      sourceStayOrderId: sourceOrderId,
      sourceStayId,
      sourceStay,
      amendmentId,
      pricingRevisionId: revisionId,
      membershipOrderId: newOrderId,
      status: "ACTIVE",
      contractId: newContractId,
      entitlementLotId: newLotId,
      oldDirectCollectionTotal: oldDirectTotal,
      transferredAmount: stayTransferTotal,
      replacementDirectPaymentAmount: replacementDirectTotal,
      membershipAgreedPrice,
      funds,
      validFrom,
      validUntil,
      newMembership: {
        ...newMembership,
        membershipOrderId: newOrderId,
        contractId: newContractId,
        entitlementLotId: newLotId
      },
      entitlementUnitKind: oldOrder.entitlement_unit_kind,
      convertedUnits: serviceDates.length,
      remainingUnits: oldOrder.entitlement_units - serviceDates.length,
      entitlement,
      serviceDates,
      sourceCollectionFactIds: sourceCollections.map((source) => source.fact_id),
      oldPaymentReversalFactIds,
      paymentReclassificationFactIds,
      sourceReversalFactIds,
      transferPaymentFactIds,
      replacementPaymentFactId,
      transferIds,
      voidLedgerFactId,
      conversionLedgerFactIds,
      ...(await correctionReceiptAudit(
        trx,
        commandId,
        options.reason,
        effectString(effect, "evidenceNote")
      ))
    },
    resourceRefs: [
      memberId,
      oldOrderId,
      oldContractId,
      oldLotId,
      sourceOrderId,
      amendmentId,
      revisionId,
      newOrderId,
      newContractId,
      newLotId,
      ...transferIds
    ],
    factRefs: [
      voidId,
      ...oldPaymentReversalFactIds,
      ...paymentReclassificationFactIds,
      voidLedgerFactId,
      ...sourceReversalFactIds,
      ...transferPaymentFactIds,
      ...(replacementPaymentFactId ? [replacementPaymentFactId] : []),
      ...conversionLedgerFactIds
    ]
  };
}
