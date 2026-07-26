import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { newId, todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STAGE8_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage8_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 8 Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

export interface Stage8StayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nickname: string;
}

export interface Stage8LegacyCleaningFixture extends Stage8StayFixture {
  cleaningTaskId: string;
  serviceDate: string;
}

export interface Stage8AcceptanceFixture {
  businessDate: string;
  arrivalDate: string;
  departureDate: string;
  normal: Stage8StayFixture;
  member: Stage8StayFixture & { memberId: string; coverageCount: number };
  free: Stage8StayFixture;
  futureCheckIn: Stage8StayFixture;
  overdueCheckIn: Stage8StayFixture;
  plannedCheckout: Stage8StayFixture;
  overdueCheckout: Stage8StayFixture;
  earlyCheckoutGate: Stage8StayFixture;
  overdueGrid: Stage8StayFixture;
  legacyCleaning: Stage8LegacyCleaningFixture;
  restoration: Stage8StayFixture;
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
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "STAGE8_ACCEPTANCE", note: "准备第 4 步 4.1 独立人工验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus}`);
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units").select(["id", "code"])
    .where("property_id", "=", demo.propertyId).where("code", "=", code).executeTakeFirstOrThrow();
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitId: string;
  unitCode: string;
  arrivalDate: string;
  departureDate: string;
  nickname: string;
  stayType?: "TRANSIENT" | "FREE";
  memberId?: string;
}): Promise<Stage8StayFixture> {
  const stayType = options.stayType ?? "TRANSIENT";
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId,
    stayType,
    ...(options.memberId ? { memberId: options.memberId } : {})
  });
  const receipt = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: `${options.nickname}完整姓名`,
      nickname: options.nickname,
      phone: "13800008008",
      documentNumber: `STAGE8-${options.key}`
    },
    ...(!options.memberId && stayType !== "FREE" ? { bookingChannelCode: "WECOM", channelOrderReference: null } : {}),
    ...(stayType === "FREE" ? { freeStayReason: "阶段 8 免费住宿履约验收", freeStayCategoryCode: "RECEPTION" } : {})
  }, `${options.key}-create-stay`);
  const orderId = receipt.result?.orderId;
  const stayId = receipt.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") throw new Error(`${options.key} did not create an order and Stay`);
  return { orderId, stayId, unitId: options.unitId, unitCode: options.unitCode, nickname: options.nickname };
}

async function createMemberWithCoverage(db: Kysely<Database>, key: string): Promise<string> {
  const memberId = `member_${key}`;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `STAGE8-ID-${key}`,
    full_name: "星河",
    phone: "13800008018",
    wechat: `wx-${key}`
  }).execute();
  await db.insertInto("member_property_links").values({ member_id: memberId, property_id: demo.propertyId }).execute();
  const membershipOrder = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: "membership_product_shared_bath_single_v1",
    agreedPriceMinor: 162_000
  }, `${key}-membership-order`);
  const membershipOrderId = membershipOrder.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Stage 8 membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: 162_000,
    transactionReference: `WX-${key}`
  }, `${key}-membership-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", { propertyId: demo.propertyId, membershipOrderId }, `${key}-membership-activate`);
  return memberId;
}

async function markStayInHouseForAcceptance(
  db: Kysely<Database>,
  stay: Stage8StayFixture,
  businessDate: string
): Promise<void> {
  const order = await db.selectFrom("orders").select(["version", "status"])
    .where("id", "=", stay.orderId).executeTakeFirstOrThrow();
  const amendmentId = newId("amend");
  await db.insertInto("amendments").values({
    id: amendmentId,
    order_id: stay.orderId,
    sequence: order.version + 1,
    amendment_type: "CHECK_IN",
    reason_code: "STAGE8_ACCEPTANCE_SETUP",
    reason_note: "准备计划退房日普通退房验收状态",
    prior_version: order.version,
    new_version: order.version + 1,
    payload: {
      orderId: stay.orderId,
      fromStatus: order.status,
      toStatus: "CHECKED_IN",
      inventoryUnitId: stay.unitId,
      businessDate,
      entitlementTransition: { from: "HELD", to: "CONSUMED", coverageCount: 0 }
    },
    command_id: null
  }).execute();
  await db.updateTable("orders").set({
    status: "CHECKED_IN",
    version: order.version + 1,
    updated_at: new Date()
  }).where("id", "=", stay.orderId).execute();
  await db.updateTable("stays").set({ status: "IN_HOUSE" }).where("id", "=", stay.stayId).execute();
}

async function markStayCheckedOutForAcceptance(
  db: Kysely<Database>,
  stay: Stage8StayFixture,
  checkInBusinessDate: string,
  checkOutBusinessDate: string
): Promise<string> {
  await markStayInHouseForAcceptance(db, stay, checkInBusinessDate);
  const order = await db.selectFrom("orders").select("version")
    .where("id", "=", stay.orderId).executeTakeFirstOrThrow();
  const amendmentId = newId("amend");
  await db.insertInto("amendments").values({
    id: amendmentId,
    order_id: stay.orderId,
    sequence: order.version + 1,
    amendment_type: "CHECK_OUT",
    reason_code: "STAGE8_ACCEPTANCE_SETUP",
    reason_note: "准备已停用清洁流程的历史兼容数据",
    prior_version: order.version,
    new_version: order.version + 1,
    payload: {
      orderId: stay.orderId,
      fromStatus: "CHECKED_IN",
      toStatus: "CHECKED_OUT",
      inventoryUnitId: stay.unitId,
      businessDate: checkOutBusinessDate
    },
    command_id: null
  }).execute();
  await db.updateTable("orders").set({
    status: "CHECKED_OUT",
    version: order.version + 1,
    updated_at: new Date()
  }).where("id", "=", stay.orderId).execute();
  await db.updateTable("stays").set({ status: "COMPLETED" }).where("id", "=", stay.stayId).execute();
  await db.updateTable("inventory_claims").set({ active: false, released_at: new Date() })
    .where("source_type", "=", "ORDER_SEGMENT")
    .where("source_id", "in", db.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.stayId))
    .execute();
  return amendmentId;
}

export async function prepareStage8Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; scenario?: "desktop" | "mobile" } = {}
): Promise<Stage8AcceptanceFixture> {
  const db = options.reset === false
    ? createDatabase(databaseUrl)
    : await (await import("../helpers/database.ts")).resetDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const arrivalDate = businessDate;
    const departureDate = addDays(arrivalDate, 2);
    const plannedCheckoutArrivalDate = addDays(businessDate, -2);
    const overdueCheckoutArrivalDate = addDays(businessDate, -3);
    const overdueCheckoutDepartureDate = addDays(businessDate, -1);
    const legacyCleaningServiceDate = addDays(businessDate, -1);
    const legacyCleaningArrivalDate = addDays(legacyCleaningServiceDate, -1);
    const scenario = options.scenario ?? "desktop";
    const unitCodes = scenario === "desktop"
      ? ["D02", "D01", "D03", "D04", "D05", "201", "202", "203", "E01", "305", "306"]
      : ["204", "205", "301", "302", "303", "304", "B01", "E02", "E03", "307", "308"];
    const key = `stage8-${scenario}-${arrivalDate.replaceAll("-", "")}-${process.pid}`;
    const [
      normalUnit,
      memberUnit,
      freeUnit,
      legacyCleaningUnit,
      restorationUnit,
      plannedCheckoutUnit,
      overdueCheckoutUnit,
      futureCheckInUnit,
      overdueCheckInUnit,
      earlyCheckoutGateUnit,
      overdueGridUnit
    ] = await Promise.all([
      unitByCode(db, unitCodes[0]!),
      unitByCode(db, unitCodes[1]!),
      unitByCode(db, unitCodes[2]!),
      unitByCode(db, unitCodes[3]!),
      unitByCode(db, unitCodes[4]!),
      unitByCode(db, unitCodes[5]!),
      unitByCode(db, unitCodes[6]!),
      unitByCode(db, unitCodes[7]!),
      unitByCode(db, unitCodes[8]!),
      unitByCode(db, unitCodes[9]!),
      unitByCode(db, unitCodes[10]!)
    ]);
    const memberId = await createMemberWithCoverage(db, key);
    const [
      normal,
      member,
      free,
      legacyCleaning,
      restoration,
      plannedCheckout,
      overdueCheckout,
      futureCheckIn,
      overdueCheckIn,
      earlyCheckoutGate,
      overdueGrid
    ] = await Promise.all([
      createStay(db, { key: `${key}-normal`, unitId: normalUnit.id, unitCode: normalUnit.code, arrivalDate, departureDate, nickname: "青岚" }),
      createStay(db, { key: `${key}-member`, unitId: memberUnit.id, unitCode: memberUnit.code, arrivalDate, departureDate, nickname: "星河", memberId }),
      createStay(db, { key: `${key}-free`, unitId: freeUnit.id, unitCode: freeUnit.code, arrivalDate, departureDate, nickname: "云朵", stayType: "FREE" }),
      createStay(db, {
        key: `${key}-legacy-cleaning`,
        unitId: legacyCleaningUnit.id,
        unitCode: legacyCleaningUnit.code,
        arrivalDate: legacyCleaningArrivalDate,
        departureDate: legacyCleaningServiceDate,
        nickname: "清和"
      }),
      createStay(db, { key: `${key}-restoration`, unitId: restorationUnit.id, unitCode: restorationUnit.code, arrivalDate, departureDate, nickname: "归舟" }),
      createStay(db, {
        key: `${key}-planned-checkout`,
        unitId: plannedCheckoutUnit.id,
        unitCode: plannedCheckoutUnit.code,
        arrivalDate: plannedCheckoutArrivalDate,
        departureDate: businessDate,
        nickname: "海棠"
      }),
      createStay(db, {
        key: `${key}-overdue-checkout`,
        unitId: overdueCheckoutUnit.id,
        unitCode: overdueCheckoutUnit.code,
        arrivalDate: overdueCheckoutArrivalDate,
        departureDate: overdueCheckoutDepartureDate,
        nickname: "晚舟"
      }),
      createStay(db, {
        key: `${key}-future-check-in`,
        unitId: futureCheckInUnit.id,
        unitCode: futureCheckInUnit.code,
        arrivalDate: addDays(businessDate, 1),
        departureDate: addDays(businessDate, 3),
        nickname: "初晴"
      }),
      createStay(db, {
        key: `${key}-overdue-check-in`,
        unitId: overdueCheckInUnit.id,
        unitCode: overdueCheckInUnit.code,
        arrivalDate: addDays(businessDate, -1),
        departureDate: addDays(businessDate, 1),
        nickname: "远帆"
      }),
      createStay(db, {
        key: `${key}-early-checkout-gate`,
        unitId: earlyCheckoutGateUnit.id,
        unitCode: earlyCheckoutGateUnit.code,
        arrivalDate: businessDate,
        departureDate: addDays(businessDate, 2),
        nickname: "临川"
      }),
      createStay(db, {
        key: `${key}-overdue-grid`,
        unitId: overdueGridUnit.id,
        unitCode: overdueGridUnit.code,
        arrivalDate: overdueCheckoutArrivalDate,
        departureDate: overdueCheckoutDepartureDate,
        nickname: "泊舟"
      })
    ]);
    await markStayInHouseForAcceptance(db, plannedCheckout, plannedCheckoutArrivalDate);
    await markStayInHouseForAcceptance(db, overdueCheckout, overdueCheckoutArrivalDate);
    await markStayInHouseForAcceptance(db, earlyCheckoutGate, businessDate);
    await markStayInHouseForAcceptance(db, overdueGrid, overdueCheckoutArrivalDate);
    await markStayCheckedOutForAcceptance(
      db,
      legacyCleaning,
      legacyCleaningArrivalDate,
      legacyCleaningServiceDate
    );
    const legacyCreateCommand = await db.selectFrom("amendments").select("command_id")
      .where("order_id", "=", legacyCleaning.orderId)
      .where("sequence", "=", 1)
      .executeTakeFirstOrThrow();
    if (!legacyCreateCommand.command_id) throw new Error("Stage 8 legacy cleaning fixture has no source command");
    const cleaningTaskId = newId("cleaning");
    await db.insertInto("cleaning_tasks").values({
      id: cleaningTaskId,
      property_id: demo.propertyId,
      order_id: legacyCleaning.orderId,
      stay_id: legacyCleaning.stayId,
      inventory_unit_id: legacyCleaning.unitId,
      room_id: legacyCleaning.unitId,
      service_date: legacyCleaningServiceDate,
      status: "PENDING",
      version: 1,
      created_by_command_id: legacyCreateCommand.command_id,
      completed_by_command_id: null,
      completed_at: null
    }).execute();
    return {
      businessDate,
      arrivalDate,
      departureDate,
      normal,
      member: { ...member, memberId, coverageCount: 2 },
      free,
      futureCheckIn,
      overdueCheckIn,
      plannedCheckout,
      overdueCheckout,
      earlyCheckoutGate,
      overdueGrid,
      legacyCleaning: { ...legacyCleaning, cleaningTaskId, serviceDate: legacyCleaningServiceDate },
      restoration
    };
  } finally {
    await db.destroy();
  }
}

async function main() {
  const fixture = await prepareStage8Acceptance(defaultDatabaseUrl);
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-stage8-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
