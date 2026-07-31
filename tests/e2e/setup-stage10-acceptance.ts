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

const defaultDatabaseUrl = process.env.STAGE10_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage10_acceptance";

// These rooms do not overlap the current-day fixtures owned by the Stage 8
// desktop/mobile suites. Stage 9 uses some of them only from day +3 onward,
// exactly after the Stage 10 interval ends.
const defaultStage10UnitCodes = [
  "103", "105", "107", "108", "104", "106", "A03", "A04",
  "B03", "C01", "B04", "C02", "C03", "C04"
] as const;

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 10 Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

export interface Stage10StayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  newDepartureDate: string;
  originalContractMinor: number;
  recordedCollectionMinor: number;
}

export interface Stage10ChannelFixture extends Stage10StayFixture {
  targetContractYuan: string;
  channelPriceDifferenceReason: string;
}

export interface Stage10ManualPriceFixture extends Stage10StayFixture {
  targetContractYuan: string;
  manualPriceAdjustmentReason: string;
}

export interface Stage10MovedFixture extends Stage10StayFixture {
  destinationUnitId: string;
  destinationUnitCode: string;
}

export interface Stage10AcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  inHouseShortening: Stage10StayFixture;
  earlyCheckout: Stage10StayFixture;
  arrivalDayBlocked: Stage10StayFixture;
  retrospectiveBlocked: Stage10StayFixture;
  balancedCollection: Stage10StayFixture;
  supplementCollection: Stage10StayFixture;
  externalChannel: Stage10ChannelFixture;
  wecomManualPrice: Stage10ManualPriceFixture;
  freeStay: Stage10StayFixture;
  memberStay: Stage10StayFixture & { memberId: string };
  historicalMove: Stage10MovedFixture;
  futureMoveBlocked: Stage10MovedFixture;
}

export interface Stage10MobileAcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  earlyCheckout: Stage10StayFixture;
}

export interface Stage10MemberTraceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  memberId: string;
  memberName: string;
  memberStay: Stage10StayFixture;
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
      : { code: "STAGE10_ACCEPTANCE", note: "准备 4.3 自动化与人工验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus}`);
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "room_type_code"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  newDepartureDate: string;
  collection?: boolean;
  collectionMinor?: number;
  stayType?: "TRANSIENT" | "FREE";
  memberId?: string;
  channel?: "WECOM" | "CTRIP";
}): Promise<Stage10StayFixture> {
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
  const channel = options.channel ?? "WECOM";
  const created = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: `${options.nickname}完整姓名`,
      nickname: options.nickname,
      phone: "13800001010",
      documentNumber: `STAGE10-${options.key}`
    },
    ...(!options.memberId && stayType !== "FREE" ? {
      bookingChannelCode: channel,
      channelOrderReference: channel === "WECOM" ? null : `CTRIP-${options.key}`,
      ...(channel === "WECOM" ? {} : { targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits })
    } : {}),
    ...(stayType === "FREE" ? {
      freeStayReason: "4.3 免费住宿缩短验收",
      freeStayCategoryCode: "RECEPTION"
    } : {})
  }, `${options.key}-create`);
  const orderId = created.result?.orderId;
  const stayId = created.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") throw new Error(`${options.key} did not create an order`);
  let recordedCollectionMinor = 0;
  if (options.collection || options.collectionMinor !== undefined) {
    recordedCollectionMinor = options.collectionMinor ?? quote.currentContractAmount.minorUnits;
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: recordedCollectionMinor,
      method: "WECOM",
      transactionReference: `WX-STAGE10-${options.key}`,
      note: "4.3 提前退房退款参考验收"
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
    newDepartureDate: options.newDepartureDate,
    originalContractMinor: quote.currentContractAmount.minorUnits,
    recordedCollectionMinor
  };
}

async function createMember(db: Kysely<Database>, key: string, roomTypeCode: string | null): Promise<string> {
  const membership = roomTypeCode === "shared_bath_single"
    ? { productId: "membership_product_shared_bath_single_v1", priceMinor: 162_000 }
    : roomTypeCode === "private_bath_single"
      ? { productId: "membership_product_private_bath_single_v1", priceMinor: 216_000 }
      : null;
  if (!membership) throw new Error(`Stage 10 member fixture does not support room type ${roomTypeCode ?? "unknown"}`);
  const profile = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: `阶段十会员-${key}`,
    identityCardNumber: `STAGE10-ID-${key}`,
    phone: "13800001019",
    wechat: `wx-stage10-${key}`
  }, `${key}-profile`);
  const memberId = profile.result?.memberId;
  if (typeof memberId !== "string") throw new Error("Stage 10 member profile was not created");
  const membershipOrder = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: membership.productId,
    agreedPriceMinor: membership.priceMinor
  }, `${key}-membership`);
  const membershipOrderId = membershipOrder.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Stage 10 membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: membership.priceMinor,
    transactionReference: `WX-STAGE10-${key}`
  }, `${key}-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${key}-activate`);
  return memberId;
}

async function contractAmountForInterval(
  db: Kysely<Database>,
  unitId: string,
  arrivalDate: string,
  departureDate: string
): Promise<number> {
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.pricingPolicyId,
    stayType: "TRANSIENT"
  });
  return quote.currentContractAmount.minorUnits;
}

async function checkInOnArrival(db: Kysely<Database>, stay: Stage10StayFixture, key: string): Promise<void> {
  await withPropertyClockForTesting(new Date(`${stay.arrivalDate}T12:00:00+08:00`), async () => {
    await execute(db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId
    }, `${key}-check-in`);
  });
}

export async function prepareStage10MemberTraceAcceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { suffix?: string; unitCode?: string } = {}
): Promise<Stage10MemberTraceFixture> {
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `member-trace-${businessDate.replaceAll("-", "")}`;
    const unit = await unitByCode(db, options.unitCode ?? "D02");
    const memberKey = `${suffix}-member`;
    const memberId = await createMember(db, memberKey, unit.room_type_code);
    const arrivalDate = addDays(businessDate, 5);
    const departureDate = addDays(businessDate, 7);
    const memberStay = await createStay(db, {
      key: `${suffix}-stay`,
      unitCode: unit.code,
      nickname: `会员追溯-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: departureDate,
      memberId
    });
    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      memberId,
      memberName: `阶段十会员-${memberKey}`,
      memberStay
    };
  } finally {
    await db.destroy();
  }
}

export async function prepareStage10Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; suffix?: string; unitCodes?: readonly string[] } = {}
): Promise<Stage10AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `manual-${businessDate.replaceAll("-", "")}`;
    const unitCodes = options.unitCodes ?? defaultStage10UnitCodes;
    if (unitCodes.length !== 14 || new Set(unitCodes).size !== unitCodes.length) {
      throw new Error("Stage 10 requires fourteen distinct room codes");
    }
    const [
      shortenUnit, checkoutUnit, blockedUnit, retrospectiveUnit, balancedUnit, supplementUnit,
      externalUnit, manualUnit, freeUnit, memberUnit, historicalUnit, historicalDestination,
      futureUnit, futureDestination
    ] = unitCodes as [string, string, string, string, string, string, string, string, string, string, string, string, string, string];
    const arrivalDate = addDays(businessDate, -2);
    const departureDate = addDays(businessDate, 3);
    const shortenedDepartureDate = addDays(businessDate, 1);
    const inHouseShortening = await createStay(db, {
      key: `${suffix}-shorten`,
      unitCode: shortenUnit,
      nickname: `缩短继续住-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate
    });
    const earlyCheckout = await createStay(db, {
      key: `${suffix}-early-checkout`,
      unitCode: checkoutUnit,
      nickname: `提前退房-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: businessDate,
      collection: true
    });
    const arrivalDayBlocked = await createStay(db, {
      key: `${suffix}-arrival-day`,
      unitCode: blockedUnit,
      nickname: `当天入住-${suffix}`,
      arrivalDate: businessDate,
      departureDate: addDays(businessDate, 2),
      newDepartureDate: businessDate
    });
    const retrospectiveBlocked = await createStay(db, {
      key: `${suffix}-retrospective`,
      unitCode: retrospectiveUnit,
      nickname: `追溯日期拒绝-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: addDays(businessDate, -1)
    });
    const balancedUnitRow = await unitByCode(db, balancedUnit);
    const balancedMinor = await contractAmountForInterval(db, balancedUnitRow.id, arrivalDate, shortenedDepartureDate);
    const balancedCollection = await createStay(db, {
      key: `${suffix}-balanced`,
      unitCode: balancedUnit,
      nickname: `收款等于新金额-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate,
      collectionMinor: balancedMinor
    });
    const supplementUnitRow = await unitByCode(db, supplementUnit);
    const supplementPolicyMinor = await contractAmountForInterval(db, supplementUnitRow.id, arrivalDate, shortenedDepartureDate);
    const supplementCollection = await createStay(db, {
      key: `${suffix}-supplement`,
      unitCode: supplementUnit,
      nickname: `收款低于新金额-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate,
      collectionMinor: Math.max(100, supplementPolicyMinor - 100)
    });
    const externalUnitRow = await unitByCode(db, externalUnit);
    const externalPolicyMinor = await contractAmountForInterval(db, externalUnitRow.id, arrivalDate, shortenedDepartureDate);
    const externalChannel = await createStay(db, {
      key: `${suffix}-external`,
      unitCode: externalUnit,
      nickname: `携程缩短-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate,
      channel: "CTRIP"
    });
    const manualUnitRow = await unitByCode(db, manualUnit);
    const manualPolicyMinor = await contractAmountForInterval(db, manualUnitRow.id, arrivalDate, shortenedDepartureDate);
    const wecomManualPrice = await createStay(db, {
      key: `${suffix}-manual`,
      unitCode: manualUnit,
      nickname: `企微主动偏价-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate
    });
    const freeStay = await createStay(db, {
      key: `${suffix}-free`,
      unitCode: freeUnit,
      nickname: `免费住宿缩短-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate,
      stayType: "FREE"
    });
    const memberUnitRow = await unitByCode(db, memberUnit);
    const memberId = await withPropertyClockForTesting(
      new Date(`${arrivalDate}T09:00:00+08:00`),
      () => createMember(db, `${suffix}-member`, memberUnitRow.room_type_code)
    );
    const memberStay = await createStay(db, {
      key: `${suffix}-member-stay`,
      unitCode: memberUnit,
      nickname: `会员权益不恢复-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate,
      memberId
    });
    const historicalMoveBase = await createStay(db, {
      key: `${suffix}-historical-move`,
      unitCode: historicalUnit,
      nickname: `历史换房可缩短-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate
    });
    const futureMoveBase = await createStay(db, {
      key: `${suffix}-future-move`,
      unitCode: futureUnit,
      nickname: `未来换房拒绝-${suffix}`,
      arrivalDate,
      departureDate,
      newDepartureDate: shortenedDepartureDate
    });
    await checkInOnArrival(db, inHouseShortening, `${suffix}-shorten`);
    await checkInOnArrival(db, earlyCheckout, `${suffix}-early-checkout`);
    await checkInOnArrival(db, arrivalDayBlocked, `${suffix}-arrival-day`);
    await checkInOnArrival(db, retrospectiveBlocked, `${suffix}-retrospective`);
    await checkInOnArrival(db, balancedCollection, `${suffix}-balanced`);
    await checkInOnArrival(db, supplementCollection, `${suffix}-supplement`);
    await checkInOnArrival(db, externalChannel, `${suffix}-external`);
    await checkInOnArrival(db, wecomManualPrice, `${suffix}-manual`);
    await checkInOnArrival(db, freeStay, `${suffix}-free`);
    await checkInOnArrival(db, memberStay, `${suffix}-member-stay`);
    await checkInOnArrival(db, historicalMoveBase, `${suffix}-historical-move`);
    await checkInOnArrival(db, futureMoveBase, `${suffix}-future-move`);
    const historicalDestinationRow = await unitByCode(db, historicalDestination);
    await execute(db, "MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId: historicalMoveBase.orderId,
      newInventoryUnitId: historicalDestinationRow.id,
      effectiveDate: businessDate
    }, `${suffix}-historical-move-command`);
    const futureDestinationRow = await unitByCode(db, futureDestination);
    await execute(db, "MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId: futureMoveBase.orderId,
      newInventoryUnitId: futureDestinationRow.id,
      effectiveDate: addDays(businessDate, 1)
    }, `${suffix}-future-move-command`);
    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      inHouseShortening,
      earlyCheckout,
      arrivalDayBlocked,
      retrospectiveBlocked,
      balancedCollection,
      supplementCollection,
      externalChannel: {
        ...externalChannel,
        targetContractYuan: String(externalPolicyMinor * 2 / 100),
        channelPriceDifferenceReason: "携程缩短后重新确认渠道金额，超过政策基础金额 15%"
      },
      wecomManualPrice: {
        ...wecomManualPrice,
        targetContractYuan: String(Math.max(0, manualPolicyMinor - 100) / 100),
        manualPriceAdjustmentReason: "住客协商后本次主动优惠一元"
      },
      freeStay,
      memberStay: { ...memberStay, memberId },
      historicalMove: {
        ...historicalMoveBase,
        destinationUnitId: historicalDestinationRow.id,
        destinationUnitCode: historicalDestinationRow.code
      },
      futureMoveBlocked: {
        ...futureMoveBase,
        destinationUnitId: futureDestinationRow.id,
        destinationUnitCode: futureDestinationRow.code
      }
    };
  } finally {
    await db.destroy();
  }
}

export async function prepareStage10MobileAcceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { suffix?: string; unitCode?: string } = {}
): Promise<Stage10MobileAcceptanceFixture> {
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `mobile-${businessDate.replaceAll("-", "")}`;
    const earlyCheckout = await createStay(db, {
      key: `${suffix}-early-checkout`,
      unitCode: options.unitCode ?? "109",
      nickname: `手机提前退房-${suffix}`,
      arrivalDate: addDays(businessDate, -1),
      departureDate: addDays(businessDate, 2),
      newDepartureDate: businessDate,
      collection: true
    });
    await checkInOnArrival(db, earlyCheckout, `${suffix}-early-checkout`);
    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      earlyCheckout
    };
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const fixture = await prepareStage10Acceptance(defaultDatabaseUrl, { reset: true });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-stage10-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
