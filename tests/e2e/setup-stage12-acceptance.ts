import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  pricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 12 Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

const defaultDatabaseUrl = process.env.STAGE12_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage12_acceptance";

export interface Stage12StayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  originalContractMinor: number;
  recordedCollectionMinor: number;
  memberId?: string;
}

export interface Stage12AcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  cancellation: Stage12StayFixture;
  memberCancellation: Stage12StayFixture;
  freeCancellation: Stage12StayFixture;
  noShow: Stage12StayFixture;
  noShowThreshold: Stage12StayFixture;
  overdueCheckIn: Stage12StayFixture;
  revokeCheckIn: Stage12StayFixture;
  memberRevokeCheckIn: Stage12StayFixture;
  noShowBoundary: { rejectedAt1959: true; acceptedAt2000: true };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "STAGE12_ACCEPTANCE", note: "准备 4.5 自动化与人工验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus} ${receipt.error?.message ?? ""}`.trim());
  }
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "room_type_code"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
}

async function createMember(db: Kysely<Database>, key: string): Promise<string> {
  const profile = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: `阶段十二会员-${key}`,
    nickname: `阶段十二会员-${key}`,
    identityCardNumber: `STAGE12-ID-${key}`,
    phone: "13800001212",
    wechat: `wx-stage12-${key}`
  }, `${key}-profile`);
  const memberId = profile.result?.memberId;
  if (typeof memberId !== "string") throw new Error("Stage 12 member profile was not created");
  const membership = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: "membership_product_shared_bath_single_v1",
    agreedPriceMinor: 162_000
  }, `${key}-membership`);
  const membershipOrderId = membership.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Stage 12 membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: 162_000,
    transactionReference: `WX-STAGE12-${key}`
  }, `${key}-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${key}-activate`);
  return memberId;
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  stayType?: "TRANSIENT" | "FREE";
  memberId?: string;
  collectionMinor?: number;
}): Promise<Stage12StayFixture> {
  const unit = await unitByCode(db, options.unitCode);
  const stayType = options.stayType ?? "TRANSIENT";
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unit.id,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.pricingPolicyId,
    stayType,
    ...(options.memberId ? { memberId: options.memberId } : {})
  });
  const created = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: `${options.nickname}完整姓名`,
      nickname: options.nickname,
      phone: "13800001210",
      documentNumber: `STAGE12-${options.key}`
    },
    ...(!options.memberId && stayType !== "FREE" ? {
      bookingChannelCode: "WECOM",
      channelOrderReference: null
    } : {}),
    ...(stayType === "FREE" ? {
      freeStayReason: "4.5 取消与库存释放验收",
      freeStayCategoryCode: "RECEPTION"
    } : {})
  }, `${options.key}-create`);
  const orderId = created.result?.orderId;
  const stayId = created.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") {
    throw new Error(`${options.key} did not create an order`);
  }
  const recordedCollectionMinor = options.collectionMinor ?? 0;
  if (recordedCollectionMinor > 0) {
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: recordedCollectionMinor,
      method: "WECOM",
      transactionReference: `WX-STAGE12-${options.key}`,
      note: "4.5 只计算退款参考，不登记实际退款"
    }, `${options.key}-collection`);
  }
  return {
    orderId,
    stayId,
    unitId: unit.id,
    unitCode: unit.code,
    nickname: options.nickname,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    originalContractMinor: quote.currentContractAmount.minorUnits,
    recordedCollectionMinor,
    ...(options.memberId ? { memberId: options.memberId } : {})
  };
}

async function checkIn(db: Kysely<Database>, stay: Stage12StayFixture, key: string): Promise<void> {
  await withPropertyClockForTesting(new Date(`${stay.arrivalDate}T12:00:00+08:00`), () => execute(db, "CHECK_IN", {
    propertyId: demo.propertyId,
    orderId: stay.orderId
  }, `${key}-check-in`));
}

async function verifyNoShowBoundary(
  db: Kysely<Database>,
  stay: Stage12StayFixture,
  key: string
): Promise<{ rejectedAt1959: true; acceptedAt2000: true }> {
  const input = { propertyId: demo.propertyId, orderId: stay.orderId };
  let rejectedAt1959 = false;
  try {
    await withPropertyClockForTesting(new Date(`${stay.arrivalDate}T19:59:00+08:00`), () => createCommandPreview(
      db,
      principal,
      { commandType: "MARK_NO_SHOW", input },
      { idempotencyKey: `${key}-1959-preview`, correlationId: `${key}-1959` }
    ));
  } catch (error) {
    rejectedAt1959 = error instanceof Error && error.message.includes("20:00");
  }
  if (!rejectedAt1959) throw new Error("Stage 12 no-show guard did not reject 19:59");

  const before = await db.selectFrom("orders").select(["status", "version"]).where("id", "=", stay.orderId).executeTakeFirstOrThrow();
  const accepted = await withPropertyClockForTesting(new Date(`${stay.arrivalDate}T20:00:00+08:00`), () => createCommandPreview(
    db,
    principal,
    { commandType: "MARK_NO_SHOW", input },
    { idempotencyKey: `${key}-2000-preview`, correlationId: `${key}-2000` }
  ));
  const after = await db.selectFrom("orders").select(["status", "version"]).where("id", "=", stay.orderId).executeTakeFirstOrThrow();
  if (accepted.preview.commandType !== "MARK_NO_SHOW" || before.status !== "RESERVED" || after.status !== "RESERVED" || after.version !== before.version) {
    throw new Error("Stage 12 no-show 20:00 preview did not preserve the reserved order");
  }
  return { rejectedAt1959: true, acceptedAt2000: true };
}

export async function prepareStage12Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; suffix?: string } = {}
): Promise<Stage12AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `manual-${businessDate.replaceAll("-", "")}`;
    const futureArrival = addDays(businessDate, 5);
    const futureDeparture = addDays(businessDate, 7);
    const overdueArrival = addDays(businessDate, -1);
    const currentDeparture = addDays(businessDate, 2);
    const memberId = await withPropertyClockForTesting(
      new Date(`${businessDate}T09:00:00+08:00`),
      () => createMember(db, `${suffix}-member`)
    );

    const cancellation = await createStay(db, {
      key: `${suffix}-cancel-normal`,
      unitCode: "A01",
      nickname: `普通取消-${suffix}`,
      arrivalDate: futureArrival,
      departureDate: futureDeparture,
      collectionMinor: 12_300
    });
    const memberCancellation = await createStay(db, {
      key: `${suffix}-cancel-member`,
      unitCode: "D02",
      nickname: `会员取消-${suffix}`,
      arrivalDate: futureArrival,
      departureDate: futureDeparture,
      memberId
    });
    const freeCancellation = await createStay(db, {
      key: `${suffix}-cancel-free`,
      unitCode: "D03",
      nickname: `免费取消-${suffix}`,
      arrivalDate: futureArrival,
      departureDate: futureDeparture,
      stayType: "FREE"
    });
    const noShow = await createStay(db, {
      key: `${suffix}-no-show`,
      unitCode: "D04",
      nickname: `逾期未到-${suffix}`,
      arrivalDate: overdueArrival,
      departureDate: currentDeparture,
      collectionMinor: 8_600
    });
    const noShowThreshold = await createStay(db, {
      key: `${suffix}-no-show-threshold`,
      unitCode: "D05",
      nickname: `未到门禁-${suffix}`,
      arrivalDate: businessDate,
      departureDate: currentDeparture
    });
    const overdueCheckIn = await createStay(db, {
      key: `${suffix}-late-check-in`,
      unitCode: "E01",
      nickname: `迟录入住-${suffix}`,
      arrivalDate: overdueArrival,
      departureDate: currentDeparture
    });
    const revokeCheckIn = await createStay(db, {
      key: `${suffix}-revoke-normal`,
      unitCode: "E02",
      nickname: `撤销入住-${suffix}`,
      arrivalDate: businessDate,
      departureDate: currentDeparture,
      collectionMinor: 17_000
    });
    const memberRevokeCheckIn = await createStay(db, {
      key: `${suffix}-revoke-member`,
      unitCode: "D01",
      nickname: `会员撤销入住-${suffix}`,
      arrivalDate: businessDate,
      departureDate: currentDeparture,
      memberId
    });
    await checkIn(db, revokeCheckIn, `${suffix}-revoke-normal`);
    await checkIn(db, memberRevokeCheckIn, `${suffix}-revoke-member`);

    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      cancellation,
      memberCancellation,
      freeCancellation,
      noShow,
      noShowThreshold,
      overdueCheckIn,
      revokeCheckIn,
      memberRevokeCheckIn,
      noShowBoundary: await verifyNoShowBoundary(db, noShowThreshold, `${suffix}-no-show-boundary`)
    };
  } finally {
    await db.destroy();
  }
}
