import { pathToFileURL } from "node:url";
import type {
  AuthPrincipal,
  BookingChannelCode,
  CommandEnvelope,
  CommandType,
  ReceiptDto
} from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { demo } from "../../packages/db/src/seed.ts";
import {
  assertBusinessTablesEmpty,
  assertExpectedLocalDatabaseIdentity,
  assertQintopiaLocalTarget,
  truncateAcceptanceBusinessDataWithinExclusiveGate,
  withPurgedIsolatedAcceptanceDatabase,
  withExclusiveAcceptanceWriterGate
} from "../../scripts/purge-local-acceptance-business-data.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const defaultDatabaseUrl = process.env.ROOM_STATUS_VISUAL_DATABASE_URL
  ?? process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Room-status Visual Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const backfillReason = "统一房态视觉人工验收模拟数据";

export interface VisualFixtureArguments {
  allowQintopiaWrite: boolean;
  confirmedEmptyDatabase: string | null;
  confirmWritersStopped: boolean;
}

export interface VisualStayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nicknames: string[];
  arrivalDate: string;
  departureDate: string;
  contractAmountMinor: number;
  recordedCollectionMinor: number;
  stayType: "TRANSIENT" | "FREE";
  bookingChannelCode: BookingChannelCode | null;
  memberId: string | null;
}

export interface VisualAcceptanceCheck {
  id: string;
  roomCode: string;
  from: string;
  toExclusive: string;
  expected: string;
}

export interface RoomStatusVisualAcceptanceFixture {
  database: string;
  businessDate: string;
  dateWindow: { from: string; to: string };
  historicalSplit: {
    roomCode: "101";
    settled: VisualStayFixture;
    arrears: VisualStayFixture;
    emptyBedCodes: ["101-C", "101-D"];
  };
  mixedSplit: {
    roomCode: "102";
    inHouse: VisualStayFixture;
    reserved: VisualStayFixture;
    maintenanceBedCode: "102-C";
    maintenanceLockId: string;
    emptyBedCode: "102-D";
  };
  historicalWholeSettled: VisualStayFixture;
  historicalWholeArrears: VisualStayFixture;
  futureWholeFourGuests: VisualStayFixture;
  futureUnpaidArrears: VisualStayFixture;
  futurePartialArrears: VisualStayFixture;
  debtExclusions: {
    externalChannel: VisualStayFixture;
    freeStay: VisualStayFixture;
    memberCovered: VisualStayFixture;
  };
  sourceBadges: {
    youmudao: VisualStayFixture;
    ctrip: VisualStayFixture;
    meituan: VisualStayFixture;
    freeStay: VisualStayFixture;
    memberCovered: VisualStayFixture;
  };
  twoBedSplit: {
    roomCode: "105";
    reserved: VisualStayFixture;
    emptyBedCode: "105-B";
  };
  kingTwoGuestsInHouse: VisualStayFixture;
  overdueWholeTwoGuests: VisualStayFixture;
  paidOverdueReserved: VisualStayFixture;
  emptyRoomCode: "D05";
  acceptanceChecks: VisualAcceptanceCheck[];
}

type CreateStayOptions = {
  key: string;
  unitCode: string;
  arrivalDate: string;
  departureDate: string;
  nicknames: [string, ...string[]];
  creationMode: "STANDARD" | "BACKFILL";
  collection: "NONE" | "PARTIAL" | "FULL";
  creationClockDate?: string;
  stayType?: "TRANSIENT" | "FREE";
  bookingChannelCode?: BookingChannelCode;
  memberId?: string;
};

export const visualAcceptanceScenarioDefinitions = {
  futurePartialArrears: {
    unitCode: "C01",
    roomCode: "C01",
    expected: "橙色整房块、部分收款仍显示欠款"
  },
  externalChannelDebtExcluded: {
    unitCode: "C02",
    roomCode: "C02",
    channelCode: "CTRIP",
    badge: "X",
    expected: "橙色整房块、左上 X 携程角标，PMS 零收款不显示欠款"
  },
  youmudaoSourceBadge: {
    unitCode: "C04",
    roomCode: "C04",
    channelCode: "YOUMUDAO",
    badge: "Y",
    expected: "橙色整房块、左上 Y 游牧岛角标，不显示欠款"
  },
  meituanSourceBadge: {
    unitCode: "E01",
    roomCode: "E01",
    channelCode: "MEITUAN",
    badge: "M",
    expected: "橙色整房块、左上 M 美团角标，不显示欠款"
  },
  freeStayDebtExcluded: {
    unitCode: "C03",
    roomCode: "C03",
    badge: "F",
    expected: "橙色整房块、左上 F 免费角标，不显示欠款"
  },
  memberCoverageDebtExcluded: {
    unitCode: "D04",
    roomCode: "D04",
    badge: "H",
    expected: "橙色整房块、左上 H 会员角标，权益完整覆盖不显示欠款"
  },
  twoBedSplit: {
    unitCode: "105-A",
    roomCode: "105",
    emptyBedCode: "105-B",
    expected: "A 为橙色预订块，B 为空心块；A 床位行不显示比例，父房显示 1/2"
  }
} as const;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function targetDatabaseName(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
}

export function parseVisualFixtureArguments(argv: readonly string[]): VisualFixtureArguments {
  const confirmation = argv.find((argument) => argument.startsWith("--confirm-business-empty="));
  return {
    allowQintopiaWrite: argv.includes("--allow-qintopia-write"),
    confirmedEmptyDatabase: confirmation?.slice("--confirm-business-empty=".length) ?? null,
    confirmWritersStopped: argv.includes("--confirm-writers-stopped")
  };
}

export function assertVisualFixtureTargetAuthorized(
  databaseUrl: string,
  arguments_: VisualFixtureArguments
): "ISOLATED" | "QINTOPIA" {
  const target = new URL(databaseUrl);
  const database = targetDatabaseName(databaseUrl);
  if (target.search !== "" || target.hash !== "") {
    throw new Error("Visual fixture database URLs must not contain query parameters or fragments");
  }
  if (database !== "qintopia") {
    const isolatedName = database === "qintopia_e2e";
    if (!(["postgres:", "postgresql:"] as string[]).includes(target.protocol)
      || target.hostname !== "127.0.0.1" || target.port !== "55432" || !isolatedName) {
      throw new Error("Visual fixtures may reset only the exact local qintopia_e2e database");
    }
    return "ISOLATED";
  }
  assertQintopiaLocalTarget(databaseUrl);
  if (!arguments_.allowQintopiaWrite
    || arguments_.confirmedEmptyDatabase !== "qintopia"
    || !arguments_.confirmWritersStopped) {
    throw new Error(
      "Writing visual fixtures to qintopia requires --allow-qintopia-write, --confirm-business-empty=qintopia, and --confirm-writers-stopped after the API and every other writer have been stopped"
    );
  }
  return "QINTOPIA";
}

type DatabaseSession = {
  pid: number;
  backend_type: string;
  application_name: string;
  state: string | null;
};

function taggedDatabaseUrl(databaseUrl: string, applicationName: string): string {
  const tagged = new URL(databaseUrl);
  tagged.searchParams.set("application_name", applicationName);
  return tagged.toString();
}

export async function assertNoOtherDatabaseSessions(
  db: Kysely<Database>,
  database: string,
  ownApplicationName: string
): Promise<void> {
  void ownApplicationName;
  const result = await sql<DatabaseSession>`
    select pid, backend_type, application_name, state
    from pg_stat_activity
    where datname = ${database}
      and pid <> pg_backend_pid()
      and backend_type not in ('autovacuum worker', 'parallel worker')
    order by pid
  `.execute(db);
  if (result.rows.length === 0) return;
  throw new Error(
    `Refusing visual fixtures: ${database} still has other sessions (${result.rows.map((row) => `${row.pid}:${row.backend_type}:${row.application_name || "unnamed"}:${row.state ?? "unknown"}`).join(", ")}). Stop the API and every other writer, then retry.`
  );
}

async function assertNoQintopiaSessionsBeforeConnection(
  databaseUrl: string,
  ownApplicationName: string
): Promise<void> {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const adminDb = createDatabase(taggedDatabaseUrl(adminUrl.toString(), `${ownApplicationName}-preflight`));
  try {
    await assertNoOtherDatabaseSessions(adminDb, "qintopia", ownApplicationName);
  } finally {
    await adminDb.destroy();
  }
}

async function execute(
  db: Kysely<Database>,
  commandType: CommandType,
  input: Record<string, unknown>,
  key: string
): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, principal, { commandType, input } as CommandEnvelope, {
    idempotencyKey: `${key}-preview`,
    correlationId: key
  });
  const backfill = commandType === "CREATE_ORDER" && input.backfill === true;
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? backfill
        ? { code: "BACKFILL_STAY", note: backfillReason }
        : { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "ROOM_STATUS_VISUAL_ACCEPTANCE", note: backfillReason }
  }, {
    idempotencyKey: `${key}-confirm`,
    correlationId: key
  });
  if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
    const detail = receipt.error ? `${receipt.error.code}: ${receipt.error.message}` : "no receipt error detail";
    throw new Error(`${key} ${commandType} failed (${receipt.executionStatus}): ${detail}`);
  }
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "kind", "physical_bed_count", "occupancy_capacity"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
}

async function atClock<T>(clockDate: string | undefined, operation: () => Promise<T>): Promise<T> {
  return clockDate
    ? withPropertyClockForTesting(new Date(`${clockDate}T12:00:00+08:00`), operation)
    : operation();
}

async function createStay(db: Kysely<Database>, options: CreateStayOptions): Promise<VisualStayFixture> {
  const unit = await unitByCode(db, options.unitCode);
  const stayType = options.stayType ?? "TRANSIENT";
  const bookingChannelCode = options.memberId || stayType === "FREE"
    ? null
    : options.bookingChannelCode ?? "WECOM";
  const result = await atClock(options.creationClockDate, async () => {
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: unit.id,
      stayType,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId,
      ...(options.memberId ? { memberId: options.memberId } : {})
    });
    const amountMinor = quote.currentContractAmount.minorUnits;
    const primaryNickname = options.nicknames[0];
    const created = await execute(db, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `${primaryNickname}完整姓名`,
        nickname: primaryNickname,
        phone: options.memberId ? "13800008888" : null,
        documentNumber: `VISUAL-${options.key}-PRIMARY`
      },
      additionalGuests: options.nicknames.slice(1).map((nickname, index) => ({
        fullName: `${nickname}完整姓名`,
        nickname,
        documentNumber: `VISUAL-${options.key}-${index + 2}`
      })),
      ...(bookingChannelCode ? {
        bookingChannelCode,
        channelOrderReference: bookingChannelCode === "WECOM" ? null : `CHANNEL-VISUAL-${options.key}`,
        targetCurrentContractAmountMinor: amountMinor
      } : {}),
      ...(stayType === "FREE" ? {
        freeStayReason: "统一房态视觉验收免费入住对照",
        freeStayCategoryCode: "RECEPTION"
      } : {}),
      ...(options.creationMode === "BACKFILL" ? {
        backfill: true,
        backfillReason,
        ...(options.collection === "FULL" ? {
          backfillCollection: {
            amountMinor,
            method: "WECOM",
            transactionReference: `WX-VISUAL-${options.key}`,
            note: backfillReason
          }
        } : {})
      } : {})
    }, `${options.key}-create`);
    return { quote, created };
  });
  const orderId = result.created.result?.orderId;
  const stayId = result.created.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") {
    throw new Error(`${options.key} did not create an order and stay`);
  }
  const amountMinor = result.quote.currentContractAmount.minorUnits;
  const recordedCollectionMinor = options.collection === "FULL"
    ? amountMinor
    : options.collection === "PARTIAL"
      ? Math.max(1, Math.floor(amountMinor / 2))
      : 0;
  if (options.creationMode === "STANDARD"
    && recordedCollectionMinor > 0
    && bookingChannelCode === "WECOM") {
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: recordedCollectionMinor,
      method: "WECOM",
      transactionReference: `WX-VISUAL-${options.key}`,
      note: backfillReason
    }, `${options.key}-collection`);
  }
  return {
    orderId,
    stayId,
    unitId: unit.id,
    unitCode: unit.code,
    nicknames: [...options.nicknames],
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    contractAmountMinor: amountMinor,
    recordedCollectionMinor,
    stayType,
    bookingChannelCode,
    memberId: options.memberId ?? null
  };
}

async function createMemberWithCoverage(db: Kysely<Database>, key: string): Promise<string> {
  const profile = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: "视觉验收会员",
    nickname: "会员覆盖",
    identityCardNumber: null,
    phone: "13800008888",
    wechat: `visual-${key}`
  }, `${key}-member`);
  const memberId = profile.result?.memberId;
  if (typeof memberId !== "string") throw new Error("Visual member profile was not created");
  const membership = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: "membership_product_shared_bath_single_v1",
    agreedPriceMinor: 162_000
  }, `${key}-membership`);
  const membershipOrderId = membership.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Visual membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: 162_000,
    transactionReference: `WX-VISUAL-${key}`
  }, `${key}-membership-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${key}-membership-activate`);
  return memberId;
}

async function checkInAtArrival(db: Kysely<Database>, stay: VisualStayFixture, key: string): Promise<void> {
  await withPropertyClockForTesting(new Date(`${stay.arrivalDate}T12:00:00+08:00`), () => execute(db, "CHECK_IN", {
    propertyId: demo.propertyId,
    orderId: stay.orderId
  }, `${key}-check-in`));
}

async function verifyFixtureOrders(db: Kysely<Database>, fixtures: RoomStatusVisualAcceptanceFixture): Promise<void> {
  const expected = [
    [fixtures.historicalSplit.settled, "CHECKED_OUT"],
    [fixtures.historicalSplit.arrears, "CHECKED_OUT"],
    [fixtures.mixedSplit.inHouse, "CHECKED_IN"],
    [fixtures.mixedSplit.reserved, "RESERVED"],
    [fixtures.historicalWholeSettled, "CHECKED_OUT"],
    [fixtures.historicalWholeArrears, "CHECKED_OUT"],
    [fixtures.futureWholeFourGuests, "RESERVED"],
    [fixtures.futureUnpaidArrears, "RESERVED"],
    [fixtures.futurePartialArrears, "RESERVED"],
    [fixtures.debtExclusions.externalChannel, "RESERVED"],
    [fixtures.sourceBadges.youmudao, "RESERVED"],
    [fixtures.sourceBadges.meituan, "RESERVED"],
    [fixtures.debtExclusions.freeStay, "RESERVED"],
    [fixtures.debtExclusions.memberCovered, "RESERVED"],
    [fixtures.twoBedSplit.reserved, "RESERVED"],
    [fixtures.kingTwoGuestsInHouse, "CHECKED_IN"],
    [fixtures.overdueWholeTwoGuests, "CHECKED_IN"],
    [fixtures.paidOverdueReserved, "RESERVED"]
  ] as const;
  for (const [fixture, expectedStatus] of expected) {
    const row = await db.selectFrom("orders as order")
      .innerJoin("pricing_revisions as revision", "revision.id", "order.current_revision_id")
      .leftJoin("collection_facts as fact", "fact.order_id", "order.id")
      .select([
        "order.status",
        "order.stay_type as stayType",
        "order.booking_channel_code as bookingChannelCode",
        "order.member_id as memberId",
        "revision.current_contract_amount_minor as contractAmountMinor"
      ])
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("fact.net_effect_minor"), eb.val(0)).as("netCollectionMinor"))
      .where("order.id", "=", fixture.orderId)
      .groupBy([
        "order.status",
        "order.stay_type",
        "order.booking_channel_code",
        "order.member_id",
        "revision.current_contract_amount_minor"
      ])
      .executeTakeFirstOrThrow();
    if (row.status !== expectedStatus
      || row.stayType !== fixture.stayType
      || row.bookingChannelCode !== fixture.bookingChannelCode
      || row.memberId !== fixture.memberId
      || Number(row.contractAmountMinor) !== fixture.contractAmountMinor
      || Number(row.netCollectionMinor) !== fixture.recordedCollectionMinor) {
      throw new Error(`Fixture verification failed for ${fixture.unitCode} / ${fixture.orderId}`);
    }
    const occupants = await db.selectFrom("order_occupants")
      .select("nickname")
      .where("order_id", "=", fixture.orderId)
      .orderBy("ordinal")
      .execute();
    if (occupants.map((occupant) => occupant.nickname).join("|") !== fixture.nicknames.join("|")) {
      throw new Error(`Occupant verification failed for ${fixture.unitCode}`);
    }
  }
  if (!(fixtures.futurePartialArrears.recordedCollectionMinor > 0
    && fixtures.futurePartialArrears.recordedCollectionMinor < fixtures.futurePartialArrears.contractAmountMinor)) {
    throw new Error("Partial-collection debt fixture is not actually partial");
  }
  if (fixtures.debtExclusions.externalChannel.bookingChannelCode !== "CTRIP"
    || fixtures.debtExclusions.externalChannel.recordedCollectionMinor !== 0) {
    throw new Error("External-channel debt exclusion fixture is invalid");
  }
  if (fixtures.sourceBadges.youmudao.bookingChannelCode !== "YOUMUDAO"
    || fixtures.sourceBadges.meituan.bookingChannelCode !== "MEITUAN"
    || fixtures.sourceBadges.youmudao.recordedCollectionMinor !== 0
    || fixtures.sourceBadges.meituan.recordedCollectionMinor !== 0) {
    throw new Error("Source-badge channel fixtures are invalid");
  }
  if (fixtures.debtExclusions.freeStay.stayType !== "FREE"
    || fixtures.debtExclusions.freeStay.contractAmountMinor !== 0) {
    throw new Error("Free-stay debt exclusion fixture is invalid");
  }
  const memberCoverageCount = await db.selectFrom("coverage_items")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("order_id", "=", fixtures.debtExclusions.memberCovered.orderId)
    .where("status", "=", "HELD")
    .executeTakeFirstOrThrow();
  if (Number(memberCoverageCount.count) !== 2
    || fixtures.debtExclusions.memberCovered.contractAmountMinor !== 0) {
    throw new Error("Member-coverage debt exclusion fixture is not fully covered");
  }
}

export async function prepareRoomStatusVisualAcceptance(
  databaseUrl = defaultDatabaseUrl,
  arguments_: VisualFixtureArguments = {
    allowQintopiaWrite: false,
    confirmedEmptyDatabase: null,
    confirmWritersStopped: false
  }
): Promise<RoomStatusVisualAcceptanceFixture> {
  const target = assertVisualFixtureTargetAuthorized(databaseUrl, arguments_);
  const fixtureApplicationName = `qtp-room-status-${process.pid}-${Date.now().toString(36)}`;
  if (target === "QINTOPIA") {
    await assertNoQintopiaSessionsBeforeConnection(databaseUrl, fixtureApplicationName);
  }
  let qintopiaFixtureWritesStarted = false;
  const buildFixture = async (db: Kysely<Database>): Promise<RoomStatusVisualAcceptanceFixture> => {
    if (target === "QINTOPIA") {
      await assertNoOtherDatabaseSessions(db, "qintopia", fixtureApplicationName);
      await assertExpectedLocalDatabaseIdentity(db);
      await assertBusinessTablesEmpty(db);
      await assertNoOtherDatabaseSessions(db, "qintopia", fixtureApplicationName);
    }
    qintopiaFixtureWritesStarted = target === "QINTOPIA";

    const property = await db.selectFrom("properties")
      .select("timezone")
      .where("id", "=", demo.propertyId)
      .executeTakeFirstOrThrow();
    const businessDate = todayInTimeZone(property.timezone);
    const at = (offset: number) => addDays(businessDate, offset);
    const suffix = `${businessDate.replaceAll("-", "")}-${process.pid}`;

    const historicalSplitSettled = await createStay(db, {
      key: `${suffix}-101a-history-settled`,
      unitCode: "101-A",
      arrivalDate: at(-8),
      departureDate: at(-6),
      nicknames: ["青禾"],
      creationMode: "BACKFILL",
      collection: "FULL"
    });
    const historicalSplitArrears = await createStay(db, {
      key: `${suffix}-101b-history-arrears`,
      unitCode: "101-B",
      arrivalDate: at(-8),
      departureDate: at(-6),
      nicknames: ["远山"],
      creationMode: "BACKFILL",
      collection: "NONE"
    });

    const mixedInHouse = await createStay(db, {
      key: `${suffix}-102a-in-house`,
      unitCode: "102-A",
      arrivalDate: at(-1),
      departureDate: at(3),
      nicknames: ["蓝桥"],
      creationMode: "BACKFILL",
      collection: "FULL"
    });
    const mixedReserved = await createStay(db, {
      key: `${suffix}-102b-reserved`,
      unitCode: "102-B",
      arrivalDate: businessDate,
      departureDate: at(3),
      nicknames: ["橙月"],
      creationMode: "STANDARD",
      collection: "FULL"
    });
    const maintenanceUnit = await unitByCode(db, "102-C");
    const maintenance = await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: maintenanceUnit.id,
      arrivalDate: businessDate,
      departureDate: at(3),
      reason: "视觉验收：C 床维修"
    }, `${suffix}-102c-maintenance`);
    const maintenanceLockId = maintenance.result?.maintenanceLockId;
    if (typeof maintenanceLockId !== "string") throw new Error("Visual maintenance fixture was not created");

    const historicalWholeSettled = await createStay(db, {
      key: `${suffix}-d01-history-settled`,
      unitCode: "D01",
      arrivalDate: at(-8),
      departureDate: at(-6),
      nicknames: ["旧日结清"],
      creationMode: "BACKFILL",
      collection: "FULL"
    });
    const historicalWholeArrears = await createStay(db, {
      key: `${suffix}-d02-history-arrears`,
      unitCode: "D02",
      arrivalDate: at(-8),
      departureDate: at(-6),
      nicknames: ["旧日欠款"],
      creationMode: "BACKFILL",
      collection: "NONE"
    });
    const futureWholeFourGuests = await createStay(db, {
      key: `${suffix}-103-future-four-guests`,
      unitCode: "103",
      arrivalDate: at(4),
      departureDate: at(6),
      nicknames: ["很长昵称春风十里", "很长昵称山海同行", "很长昵称星河入梦", "很长昵称云端漫步"],
      creationMode: "STANDARD",
      collection: "FULL"
    });
    const futureUnpaidArrears = await createStay(db, {
      key: `${suffix}-d03-future-arrears`,
      unitCode: "D03",
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["未来欠款"],
      creationMode: "STANDARD",
      collection: "NONE"
    });
    const futurePartialArrears = await createStay(db, {
      key: `${suffix}-c01-future-partial-arrears`,
      unitCode: visualAcceptanceScenarioDefinitions.futurePartialArrears.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["部分收款"],
      creationMode: "STANDARD",
      collection: "PARTIAL"
    });
    const externalChannelDebtExcluded = await createStay(db, {
      key: `${suffix}-c02-channel-no-debt`,
      unitCode: visualAcceptanceScenarioDefinitions.externalChannelDebtExcluded.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["渠道对照"],
      creationMode: "STANDARD",
      collection: "NONE",
      bookingChannelCode: "CTRIP"
    });
    const youmudaoSourceBadge = await createStay(db, {
      key: `${suffix}-c04-youmudao-source`,
      unitCode: visualAcceptanceScenarioDefinitions.youmudaoSourceBadge.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["游牧岛来源"],
      creationMode: "STANDARD",
      collection: "NONE",
      bookingChannelCode: visualAcceptanceScenarioDefinitions.youmudaoSourceBadge.channelCode
    });
    const meituanSourceBadge = await createStay(db, {
      key: `${suffix}-e01-meituan-source`,
      unitCode: visualAcceptanceScenarioDefinitions.meituanSourceBadge.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["美团来源"],
      creationMode: "STANDARD",
      collection: "NONE",
      bookingChannelCode: visualAcceptanceScenarioDefinitions.meituanSourceBadge.channelCode
    });
    const freeStayDebtExcluded = await createStay(db, {
      key: `${suffix}-c03-free-no-debt`,
      unitCode: visualAcceptanceScenarioDefinitions.freeStayDebtExcluded.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["免费对照"],
      creationMode: "STANDARD",
      collection: "NONE",
      stayType: "FREE"
    });
    const coveredMemberId = await createMemberWithCoverage(db, `${suffix}-member-coverage`);
    const memberCoverageDebtExcluded = await createStay(db, {
      key: `${suffix}-d04-member-no-debt`,
      unitCode: visualAcceptanceScenarioDefinitions.memberCoverageDebtExcluded.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["会员覆盖"],
      creationMode: "STANDARD",
      collection: "NONE",
      memberId: coveredMemberId
    });
    const twoBedReserved = await createStay(db, {
      key: `${suffix}-105a-two-bed-reserved`,
      unitCode: visualAcceptanceScenarioDefinitions.twoBedSplit.unitCode,
      arrivalDate: at(1),
      departureDate: at(3),
      nicknames: ["双床预订"],
      creationMode: "STANDARD",
      collection: "FULL"
    });
    const kingTwoGuestsInHouse = await createStay(db, {
      key: `${suffix}-a03-two-of-one`,
      unitCode: "A03",
      arrivalDate: at(-1),
      departureDate: at(2),
      nicknames: ["朝露", "晚风"],
      creationMode: "BACKFILL",
      collection: "FULL"
    });

    const overdueWholeTwoGuests = await createStay(db, {
      key: `${suffix}-104-overdue-in-house`,
      unitCode: "104",
      arrivalDate: at(-5),
      departureDate: at(-2),
      nicknames: ["未退甲", "未退乙"],
      creationMode: "STANDARD",
      collection: "FULL",
      creationClockDate: at(-5)
    });
    await checkInAtArrival(db, overdueWholeTwoGuests, `${suffix}-104-overdue-in-house`);

    const paidOverdueReserved = await createStay(db, {
      key: `${suffix}-b01-paid-overdue-reserved`,
      unitCode: "B01",
      arrivalDate: at(-4),
      departureDate: at(-2),
      nicknames: ["已付逾期预订"],
      creationMode: "STANDARD",
      collection: "FULL",
      creationClockDate: at(-4)
    });

    const acceptanceChecks: VisualAcceptanceCheck[] = [
      {
        id: "historical-split-settled-and-arrears",
        roomCode: "101",
        from: historicalSplitSettled.arrivalDate,
        toExclusive: historicalSplitSettled.departureDate,
        expected: "A/B 为绿色完成块，B 另有欠款；C/D 为空心块，显示 2/4"
      },
      {
        id: "mixed-four-bed-room",
        roomCode: "102",
        from: businessDate,
        toExclusive: mixedInHouse.departureDate,
        expected: "A 蓝色在住、B 橙色预订、C 维修、D 空心，显示 2/4"
      },
      {
        id: "historical-whole-settled",
        roomCode: historicalWholeSettled.unitCode,
        from: historicalWholeSettled.arrivalDate,
        toExclusive: historicalWholeSettled.departureDate,
        expected: "绿色整房块并带完成图标，不显示欠款"
      },
      {
        id: "historical-whole-arrears",
        roomCode: historicalWholeArrears.unitCode,
        from: historicalWholeArrears.arrivalDate,
        toExclusive: historicalWholeArrears.departureDate,
        expected: "绿色整房块并带完成图标，右上角显示欠款"
      },
      {
        id: "future-four-long-nicknames",
        roomCode: futureWholeFourGuests.unitCode,
        from: futureWholeFourGuests.arrivalDate,
        toExclusive: futureWholeFourGuests.departureDate,
        expected: "橙色整房块、四个昵称均保留且固定格高，显示 4/4"
      },
      {
        id: "future-zero-collection-arrears",
        roomCode: futureUnpaidArrears.unitCode,
        from: futureUnpaidArrears.arrivalDate,
        toExclusive: futureUnpaidArrears.departureDate,
        expected: "橙色整房块，右上角显示欠款"
      },
      {
        id: "future-partial-collection-arrears",
        roomCode: visualAcceptanceScenarioDefinitions.futurePartialArrears.roomCode,
        from: futurePartialArrears.arrivalDate,
        toExclusive: futurePartialArrears.departureDate,
        expected: visualAcceptanceScenarioDefinitions.futurePartialArrears.expected
      },
      {
        id: "external-channel-debt-excluded",
        roomCode: visualAcceptanceScenarioDefinitions.externalChannelDebtExcluded.roomCode,
        from: externalChannelDebtExcluded.arrivalDate,
        toExclusive: externalChannelDebtExcluded.departureDate,
        expected: visualAcceptanceScenarioDefinitions.externalChannelDebtExcluded.expected
      },
      {
        id: "youmudao-source-badge",
        roomCode: visualAcceptanceScenarioDefinitions.youmudaoSourceBadge.roomCode,
        from: youmudaoSourceBadge.arrivalDate,
        toExclusive: youmudaoSourceBadge.departureDate,
        expected: visualAcceptanceScenarioDefinitions.youmudaoSourceBadge.expected
      },
      {
        id: "meituan-source-badge",
        roomCode: visualAcceptanceScenarioDefinitions.meituanSourceBadge.roomCode,
        from: meituanSourceBadge.arrivalDate,
        toExclusive: meituanSourceBadge.departureDate,
        expected: visualAcceptanceScenarioDefinitions.meituanSourceBadge.expected
      },
      {
        id: "free-stay-debt-excluded",
        roomCode: visualAcceptanceScenarioDefinitions.freeStayDebtExcluded.roomCode,
        from: freeStayDebtExcluded.arrivalDate,
        toExclusive: freeStayDebtExcluded.departureDate,
        expected: visualAcceptanceScenarioDefinitions.freeStayDebtExcluded.expected
      },
      {
        id: "member-coverage-debt-excluded",
        roomCode: visualAcceptanceScenarioDefinitions.memberCoverageDebtExcluded.roomCode,
        from: memberCoverageDebtExcluded.arrivalDate,
        toExclusive: memberCoverageDebtExcluded.departureDate,
        expected: visualAcceptanceScenarioDefinitions.memberCoverageDebtExcluded.expected
      },
      {
        id: "two-bed-split-with-empty-slot",
        roomCode: visualAcceptanceScenarioDefinitions.twoBedSplit.roomCode,
        from: twoBedReserved.arrivalDate,
        toExclusive: twoBedReserved.departureDate,
        expected: visualAcceptanceScenarioDefinitions.twoBedSplit.expected
      },
      {
        id: "king-two-guests-one-physical-bed",
        roomCode: kingTwoGuestsInHouse.unitCode,
        from: kingTwoGuestsInHouse.arrivalDate,
        toExclusive: kingTwoGuestsInHouse.departureDate,
        expected: "蓝色整房块，两个昵称，显示 2/1"
      },
      {
        id: "overdue-in-house",
        roomCode: overdueWholeTwoGuests.unitCode,
        from: overdueWholeTwoGuests.arrivalDate,
        toExclusive: overdueWholeTwoGuests.departureDate,
        expected: "原住宿日期保持蓝色并显示未退，退房日以后不得扩张占用"
      },
      {
        id: "paid-overdue-reserved",
        roomCode: paidOverdueReserved.unitCode,
        from: paidOverdueReserved.arrivalDate,
        toExclusive: paidOverdueReserved.departureDate,
        expected: "保持橙色预订并显示逾期，不显示欠款"
      },
      {
        id: "fully-empty-room",
        roomCode: "D05",
        from: at(-9),
        toExclusive: at(7),
        expected: "全日期保持空闲，不出现住宿状态图形或角标"
      }
    ];

    const fixture: RoomStatusVisualAcceptanceFixture = {
      database: targetDatabaseName(databaseUrl),
      businessDate,
      dateWindow: { from: at(-9), to: at(7) },
      historicalSplit: {
        roomCode: "101",
        settled: historicalSplitSettled,
        arrears: historicalSplitArrears,
        emptyBedCodes: ["101-C", "101-D"]
      },
      mixedSplit: {
        roomCode: "102",
        inHouse: mixedInHouse,
        reserved: mixedReserved,
        maintenanceBedCode: "102-C",
        maintenanceLockId,
        emptyBedCode: "102-D"
      },
      historicalWholeSettled,
      historicalWholeArrears,
      futureWholeFourGuests,
      futureUnpaidArrears,
      futurePartialArrears,
      debtExclusions: {
        externalChannel: externalChannelDebtExcluded,
        freeStay: freeStayDebtExcluded,
        memberCovered: memberCoverageDebtExcluded
      },
      sourceBadges: {
        youmudao: youmudaoSourceBadge,
        ctrip: externalChannelDebtExcluded,
        meituan: meituanSourceBadge,
        freeStay: freeStayDebtExcluded,
        memberCovered: memberCoverageDebtExcluded
      },
      twoBedSplit: {
        roomCode: visualAcceptanceScenarioDefinitions.twoBedSplit.roomCode,
        reserved: twoBedReserved,
        emptyBedCode: visualAcceptanceScenarioDefinitions.twoBedSplit.emptyBedCode
      },
      kingTwoGuestsInHouse,
      overdueWholeTwoGuests,
      paidOverdueReserved,
      emptyRoomCode: "D05",
      acceptanceChecks
    };
    await verifyFixtureOrders(db, fixture);
    if (target === "QINTOPIA") {
      await assertNoOtherDatabaseSessions(db, "qintopia", fixtureApplicationName);
    }
    return fixture;
  };

  if (target === "ISOLATED") {
    return withPurgedIsolatedAcceptanceDatabase(databaseUrl, demo.propertyId, {
      prepare: () => resetE2eDatabase(databaseUrl),
      initialize: async (db) => {
        await db.insertInto("room_status_revisions")
          .values({ property_id: demo.propertyId, revision: 0 })
          .onConflict((conflict) => conflict.column("property_id").doNothing())
          .execute();
      },
      run: buildFixture
    });
  }

  const database = createDatabase(taggedDatabaseUrl(databaseUrl, fixtureApplicationName));
  try {
    return await withExclusiveAcceptanceWriterGate(database, async (connection) => {
      try {
        return await buildFixture(connection);
      } catch (setupError) {
        if (!qintopiaFixtureWritesStarted) throw setupError;
        try {
          await truncateAcceptanceBusinessDataWithinExclusiveGate(connection, demo.propertyId, {
            allowBlockedProtocolSharedWriters: true
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [setupError, cleanupError],
            "Visual acceptance setup failed and qintopia could not be restored to an empty business-data state"
          );
        }
        throw setupError;
      }
    });
  } finally {
    await database.destroy();
  }
}

async function main(): Promise<void> {
  const result = await prepareRoomStatusVisualAcceptance(
    defaultDatabaseUrl,
    parseVisualFixtureArguments(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
