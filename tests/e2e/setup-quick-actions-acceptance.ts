import pg from "pg";
import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { getOrderView } from "../../packages/db/src/orders.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";

// Keep the fixture importable by the existing CommonJS Playwright loader;
// seed.ts is only loaded by the standalone reset path below.
const demo = {
  propertyId: "prop_qintopia_demo",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  operatorSubjectId: "subject_demo_operator",
  agentSubjectId: "subject_demo_agent",
  administratorSubjectId: "subject_demo_administrator"
} as const;

const databaseNames = ["qintopia_quick_actions_acceptance", "qintopia_quick_actions_e2e"] as const;
const ownershipMarker = "Green PMS synthetic quick-actions acceptance fixture v1";
const fixtureNote = "快捷操作验收：本地合成数据";
const defaultDatabaseUrl = process.env.QUICK_ACTIONS_ACCEPTANCE_DATABASE_URL
  ?? `postgres://qintopia:qintopia@127.0.0.1:55432/${databaseNames[0]}`;

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Quick actions synthetic acceptance setup",
  ...authScope()
};

export interface QuickActionStayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  contractAmountMinor: number;
  recordedCollectionMinor: number;
  expectedStatus: "RESERVED" | "CHECKED_IN";
  memberId: string | null;
  membershipOrderId?: string;
  expectedCoverageCount: number;
}

export interface QuickActionsAcceptanceFixture {
  database: string;
  propertyId: string;
  businessDate: string;
  dateWindow: { from: string; toExclusive: string };
  identities: { username: string; subjectId: string; profile: string }[];
  emptyUnitCode: string;
  multiOrderRoomUnitId: string;
  cases: {
    todayUnpaid: QuickActionStayFixture;
    todayPaid: QuickActionStayFixture;
    dueOutUnpaid: QuickActionStayFixture;
    earlyCheckout: QuickActionStayFixture;
    memberCovered: QuickActionStayFixture;
    memberPartial: QuickActionStayFixture;
    upgradedMember: QuickActionStayFixture;
    temporaryOtherRoom: QuickActionStayFixture;
    externalChannel: QuickActionStayFixture;
    freeStay: QuickActionStayFixture;
    futureArrival: QuickActionStayFixture;
    multiOrderA: QuickActionStayFixture;
    multiOrderB: QuickActionStayFixture;
  };
}

export function assertQuickActionsDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const name = parsed.pathname.slice(1);
  if (parsed.protocol !== "postgres:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.port !== "55432"
    || parsed.username !== "qintopia"
    || !databaseNames.includes(name as typeof databaseNames[number])
    || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`Quick-actions fixtures only support local port 55432 and ${databaseNames.join(" / ")}`);
  }
  return name;
}

/** An existing database must be explicitly marked as this fixture, owned by the
 * local test role, and idle. Never terminate another acceptance server. */
async function withOwnedDatabase<T>(databaseUrl: string, operation: () => Promise<T>): Promise<T> {
  const name = assertQuickActionsDatabaseUrl(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const lock = await admin.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [name]
    );
    if (!lock.rows[0]?.locked) throw new Error(`Another quick-actions setup owns ${name}`);
    const existing = await admin.query<{ owner: string; marker: string | null }>(
      "SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
      [name]
    );
    if (existing.rows[0] && (existing.rows[0].owner !== "qintopia" || existing.rows[0].marker !== ownershipMarker)) {
      throw new Error(`Refusing to reset unowned database ${name}`);
    }
    const sessions = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1", [name]
    );
    if (Number(sessions.rows[0]?.count ?? 0) !== 0) throw new Error(`Stop the quick-actions server before preparing ${name}`);
    try {
      return await operation();
    } finally {
      // Preserve ownership even if migration or a later synthetic command fails,
      // so a corrected fixture can safely prepare this same dedicated database.
      const created = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (created.rowCount) await admin.query(`COMMENT ON DATABASE "${name}" IS '${ownershipMarker}'`);
    }
  } finally {
    await admin.end();
  }
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function execute(db: Kysely<Database>, commandType: CommandType, input: Record<string, unknown>, key: string): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, principal, { commandType, input } as CommandEnvelope, {
    idempotencyKey: `${key}-preview`, correlationId: key
  });
  const reason = commandType !== "CREATE_ORDER"
    ? { code: "QUICK_ACTIONS_ACCEPTANCE", note: fixtureNote }
    : input.temporaryOtherRoomReason
      ? { code: "TEMPORARY_OTHER_ROOM", note: String(input.temporaryOtherRoomReason) }
      : { code: "CREATE_STANDARD_ORDER", note: "" };
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId, commandType, confirmation: true,
    expectedEffectHash: prepared.preview.effectHash, reason
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) {
    throw new Error(`${key}: ${receipt.error?.code ?? receipt.executionStatus}: ${receipt.error?.message ?? ""}`);
  }
  return receipt;
}

function resultId(receipt: ReceiptDto, field: string): string {
  const value = receipt.result?.[field];
  if (typeof value !== "string") throw new Error(`Fixture command returned no ${field}`);
  return value;
}

interface MemberFixture { memberId: string; phone: string; membershipOrderId?: string; lotId?: string }

async function createMember(db: Kysely<Database>, key: string, ordinal: number, nickname: string, activate: boolean): Promise<MemberFixture> {
  const phone = `1398800${String(ordinal).padStart(4, "0")}`;
  const receipt = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId, fullName: nickname, nickname,
    identityCardNumber: `SYNTHETIC-QUICK-${ordinal}`, phone, wechat: `synthetic-quick-${ordinal}`
  }, `${key}-member`);
  const memberId = resultId(receipt, "memberId");
  if (!activate) return { memberId, phone };
  const membership = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId, memberId,
    membershipProductId: "membership_product_shared_bath_single_v1", agreedPriceMinor: 162_000
  }, `${key}-membership`);
  const membershipOrderId = resultId(membership, "membershipOrderId");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId, membershipOrderId,
    amountMinor: 162_000, transactionReference: `SYNTHETIC-${key}-membership`
  }, `${key}-membership-payment`);
  const activation = await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId, membershipOrderId
  }, `${key}-activation`);
  return { memberId, phone, membershipOrderId, lotId: resultId(activation, "entitlementLotId") };
}

async function createStay(db: Kysely<Database>, options: {
  key: string; unitCode: string; nickname: string; arrivalDate: string; departureDate: string;
  inHouse?: boolean; paid?: boolean; free?: boolean; external?: boolean;
  member?: MemberFixture; guestPhone?: string; temporaryOtherRoom?: boolean;
}): Promise<QuickActionStayFixture> {
  const unit = await db.selectFrom("inventory_units").select(["id", "code"])
    .where("property_id", "=", demo.propertyId).where("code", "=", options.unitCode).executeTakeFirstOrThrow();
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId, inventoryUnitId: unit.id,
    arrivalDate: options.arrivalDate, departureDate: options.departureDate,
    stayType: options.free ? "FREE" : "TRANSIENT",
    pricingPolicyVersionId: options.free ? demo.freePolicyId : demo.publicPricingPolicyId,
    ...(options.member ? { memberId: options.member.memberId } : {}),
    ...(options.temporaryOtherRoom ? { temporaryOtherRoom: true } : {})
  });
  const receipt = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId, quoteId: quote.quoteId,
    primaryGuest: {
      fullName: options.nickname, nickname: options.nickname,
      phone: options.member?.phone ?? options.guestPhone ?? "13988009999"
    },
    ...(!options.member && !options.free ? {
      bookingChannelCode: options.external ? "CTRIP" : "WECOM",
      channelOrderReference: options.external ? `SYNTHETIC-CTRIP-${options.key}` : null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    } : {}),
    ...(options.free ? { freeStayReason: fixtureNote, freeStayCategoryCode: "RECEPTION" } : {}),
    ...(options.temporaryOtherRoom ? { temporaryOtherRoomReason: "合成验收：保留原权益，临时安排其他整间房型" } : {})
  }, `${options.key}-create`);
  const orderId = resultId(receipt, "orderId");
  if (options.paid) {
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId, orderId, amountMinor: quote.currentContractAmount.minorUnits,
      method: "WECOM", transactionReference: `SYNTHETIC-${options.key}-collection`, note: fixtureNote
    }, `${options.key}-collection`);
  }
  if (options.inHouse) {
    await execute(db, "CHECK_IN", { propertyId: demo.propertyId, orderId }, `${options.key}-check-in`);
  }
  return {
    orderId, stayId: resultId(receipt, "stayId"), unitId: unit.id, unitCode: unit.code,
    nickname: options.nickname, arrivalDate: options.arrivalDate, departureDate: options.departureDate,
    contractAmountMinor: quote.currentContractAmount.minorUnits,
    recordedCollectionMinor: options.paid ? quote.currentContractAmount.minorUnits : 0,
    expectedStatus: options.inHouse ? "CHECKED_IN" : "RESERVED",
    memberId: options.member?.memberId ?? null,
    ...(options.member?.membershipOrderId ? { membershipOrderId: options.member.membershipOrderId } : {}),
    expectedCoverageCount: quote.coverageSet.length
  };
}

export async function prepareQuickActionsAcceptance(databaseUrl = defaultDatabaseUrl): Promise<QuickActionsAcceptanceFixture> {
  return withOwnedDatabase(databaseUrl, async () => {
    const { resetDatabase } = await import("../helpers/database.ts");
    const db = await resetDatabase(databaseUrl);
    try {
      return await populateQuickActionsAcceptance(db, assertQuickActionsDatabaseUrl(databaseUrl));
    } finally {
      await db.destroy();
    }
  });
}

/** Populates the already-reset database owned by the normal E2E lock runner. */
export async function populateQuickActionsAcceptance(db: Kysely<Database>, databaseName: string): Promise<QuickActionsAcceptanceFixture> {
  // The live application always uses the real property date. Only this
  // historical synthetic booking scopes its creation/check-in to its past arrival.
  const businessDate = todayInTimeZone("Asia/Shanghai");
  const at = (offset: number) => addDays(businessDate, offset);
  const key = `quick-${businessDate}-${process.pid}`;
  const common = { arrivalDate: businessDate, departureDate: at(3) };
  const todayUnpaid = await createStay(db, { ...common, key: `${key}-unpaid`, unitCode: "C01", nickname: "今日未付款" });
  const todayPaid = await createStay(db, { ...common, key: `${key}-paid`, unitCode: "C02", nickname: "今日已付清", paid: true });
  const dueOutUnpaid = await withPropertyClockForTesting(new Date(`${at(-2)}T12:00:00+08:00`), () => createStay(db, {
    key: `${key}-due`, unitCode: "C03", nickname: "今日应退欠款", arrivalDate: at(-2), departureDate: businessDate, inHouse: true
  }));
  const earlyCheckout = await createStay(db, { ...common, key: `${key}-early`, unitCode: "C04", nickname: "在住提前退房", inHouse: true });
  const fullMember = await createMember(db, `${key}-full`, 1, "会员全覆盖", true);
  const memberCovered = await createStay(db, { ...common, key: `${key}-covered`, unitCode: "D01", nickname: "会员全覆盖", member: fullMember, inHouse: true });
  const partialMember = await createMember(db, `${key}-partial`, 2, "会员部分现金", true);
  await execute(db, "CORRECT_MEMBER_ENTITLEMENT_BALANCE", {
    propertyId: demo.propertyId, entitlementLotId: partialMember.lotId,
    expectedAvailableBalance: 30, targetAvailableBalance: 1,
    adjustmentReason: "合成验收：保留 1 晚权益以覆盖部分住宿"
  }, `${key}-partial-balance`);
  const memberPartial = await createStay(db, { ...common, key: `${key}-partial-stay`, unitCode: "D04", nickname: "会员部分现金", member: partialMember, inHouse: true });
  const conversionMember = await createMember(db, `${key}-upgrade`, 3, "在住升级会员", false);
  const upgradedMember = await createStay(db, {
    ...common, key: `${key}-upgraded`, unitCode: "201", nickname: "在住升级会员",
    guestPhone: conversionMember.phone, inHouse: true, paid: true
  });
  const collection = await db.selectFrom("collection_facts").select("fact_id").where("order_id", "=", upgradedMember.orderId)
    .where("fact_type", "=", "COLLECTION").executeTakeFirstOrThrow();
  const conversion = await execute(db, "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", {
    propertyId: demo.propertyId, orderId: upgradedMember.orderId, memberId: conversionMember.memberId,
    membershipProductId: "membership_product_shared_bath_single_v1", collectionFactIds: [collection.fact_id],
    agreedPriceMinor: 162_000, remainingPaymentTransactionReference: `SYNTHETIC-${key}-remaining`
  }, `${key}-convert`);
  upgradedMember.memberId = conversionMember.memberId;
  upgradedMember.membershipOrderId = resultId(conversion, "membershipOrderId");
  upgradedMember.contractAmountMinor = 0;
  upgradedMember.recordedCollectionMinor = 0;
  upgradedMember.expectedCoverageCount = 3;
  const temporaryMember = await createMember(db, `${key}-temporary`, 4, "会员临时跨房型", true);
  const temporaryOtherRoom = await createStay(db, {
    ...common, key: `${key}-temporary-stay`, unitCode: "B01", nickname: "会员临时跨房型",
    member: temporaryMember, temporaryOtherRoom: true, inHouse: true
  });
  const externalChannel = await createStay(db, { ...common, key: `${key}-external`, unitCode: "E01", nickname: "携程在住", external: true, inHouse: true });
  const freeStay = await createStay(db, { ...common, key: `${key}-free`, unitCode: "D02", nickname: "免费在住", free: true, inHouse: true });
  const futureArrival = await createStay(db, {
    key: `${key}-future`, unitCode: "D03", nickname: "未来未到店", arrivalDate: at(1), departureDate: at(4)
  });
  const multiOrderA = await createStay(db, { ...common, key: `${key}-multi-a`, unitCode: "101-A", nickname: "同房甲客" });
  const multiOrderB = await createStay(db, { ...common, key: `${key}-multi-b`, unitCode: "101-B", nickname: "同房乙客", paid: true });
  const multiOrderRoom = await db.selectFrom("inventory_units").select("id")
    .where("property_id", "=", demo.propertyId).where("code", "=", "101").executeTakeFirstOrThrow();
  const cases = { todayUnpaid, todayPaid, dueOutUnpaid, earlyCheckout, memberCovered, memberPartial, upgradedMember, temporaryOtherRoom, externalChannel, freeStay, futureArrival, multiOrderA, multiOrderB };
  for (const [name, stay] of Object.entries(cases)) {
    const view = await getOrderView(db, stay.orderId);
    if (view.order.status !== stay.expectedStatus
      || view.amounts.currentContractAmount.minorUnits !== stay.contractAmountMinor
      || view.amounts.netRecordedCollection.minorUnits !== stay.recordedCollectionMinor
      || view.coverageSet.length !== stay.expectedCoverageCount) {
      throw new Error(`Unexpected ${name} lifecycle, funds or member coverage`);
    }
  }
  if (memberCovered.contractAmountMinor !== 0 || memberCovered.expectedCoverageCount !== 3
    || memberPartial.contractAmountMinor <= 0 || memberPartial.expectedCoverageCount !== 1) {
    throw new Error("Synthetic member full/partial coverage fixtures are invalid");
  }
  return {
    database: databaseName, propertyId: demo.propertyId,
    businessDate, dateWindow: { from: at(-2), toExclusive: at(5) }, emptyUnitCode: "D05",
    multiOrderRoomUnitId: multiOrderRoom.id,
    identities: [
      { username: "operator", subjectId: demo.operatorSubjectId, profile: "ordinary" },
      { username: "admin", subjectId: demo.administratorSubjectId, profile: "administrator" }
    ], cases
  };
}

if (process.argv[1]?.endsWith("setup-quick-actions-acceptance.ts")) {
  void prepareQuickActionsAcceptance().then((fixture) => {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
