import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { resetE2eDatabase } from "./reset-database.ts";

// Keep Playwright's browser-test loader away from seed.ts, which intentionally uses import.meta.
// These are the stable IDs created by tests/e2e/setup-database.ts.
const demo = {
  propertyId: "prop_qintopia_demo",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STAGE9_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage9_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 9 Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

export interface Stage9StayFixture {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
}

export interface Stage9RescheduleFixture extends Stage9StayFixture {
  newArrivalDate: string;
  newDepartureDate: string;
  targetContractYuan?: string;
  channelPriceDifferenceReason?: string;
}

export interface Stage9ExtensionFixture extends Stage9StayFixture {
  newDepartureDate: string;
  originalContractYuan: string;
  expectedContractYuan: string;
}

export interface Stage9AcceptanceFixture {
  businessDate: string;
  rangeArrivalDate: string;
  rangeDepartureDate: string;
  operator: { username: string; password: string };
  earlyArrival: Stage9RescheduleFixture;
  lateArrival: Stage9RescheduleFixture;
  earlyDeparture: Stage9RescheduleFixture;
  lateDeparture: Stage9RescheduleFixture;
  shift: Stage9RescheduleFixture;
  collected: Stage9RescheduleFixture & { recordedCollectionYuan: string };
  external: Stage9RescheduleFixture & {
    targetContractYuan: string;
    channelPriceDifferenceReason: string;
  };
  wecomDeviation: Stage9RescheduleFixture & {
    originalManualContractYuan: string;
  };
  memberReserved: Stage9RescheduleFixture & { memberId: string };
  memberInHouse: Stage9StayFixture & { newDepartureDate: string; memberId: string };
  departureDay: Stage9ExtensionFixture;
  overdue: Stage9ExtensionFixture;
  free: Stage9RescheduleFixture;
  conflict: Stage9RescheduleFixture & {
    blockerOrderId: string;
    blockerNickname: string;
  };
  multiUnit: Stage9StayFixture & { destinationUnitId: string; destinationUnitCode: string };
}

export interface Stage9MobileAcceptanceFixture {
  businessDate: string;
  rangeArrivalDate: string;
  rangeDepartureDate: string;
  operator: { username: string; password: string };
  free: Stage9RescheduleFixture;
}

const defaultStage9UnitCodes = {
  "101": "101",
  "102": "102",
  "103": "103",
  "104": "104",
  "105": "105",
  "106": "106",
  "107": "107",
  "108": "108",
  "109": "109",
  "201": "201",
  "202": "202",
  "203": "203",
  "204": "204",
  D01: "D01",
  D02: "D02"
} as const;

type Stage9LogicalUnitCode = keyof typeof defaultStage9UnitCodes;
export type Stage9UnitCodeOverrides = Partial<Record<Stage9LogicalUnitCode, string>>;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function withOrdinaryOrderCreationClock<T>(
  businessDate: string,
  arrivalDate: string,
  operation: () => Promise<T>
): Promise<T> {
  return arrivalDate < businessDate
    ? withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00+08:00`), operation)
    : operation();
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
      : { code: "STAGE9_ACCEPTANCE", note: "准备 4.2 自动化与人工验收数据" }
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

type Stage9CreateStayOptions = {
  key: string;
  unitId: string;
  unitCode: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  stayType?: "TRANSIENT" | "FREE";
  memberId?: string;
  channel?: "WECOM" | "CTRIP";
  targetCurrentContractAmountMinor?: number;
  manualAdjustmentMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
};

async function createStayAtCreationClock(
  db: Kysely<Database>,
  options: Stage9CreateStayOptions
): Promise<Stage9StayFixture & { contractAmountMinor: number }> {
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
  const channel = options.channel ?? "WECOM";
  const targetCurrentContractAmountMinor = options.targetCurrentContractAmountMinor
    ?? quote.currentContractAmount.minorUnits + (options.manualAdjustmentMinor ?? 0);
  if (targetCurrentContractAmountMinor < 0 || targetCurrentContractAmountMinor % 100 !== 0) {
    throw new Error(`${options.key} produced an invalid whole-yuan contract amount`);
  }
  const receipt = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: `${options.nickname}完整姓名`,
      nickname: options.nickname,
      phone: "13800009009",
      documentNumber: `STAGE9-${options.key}`
    },
    ...(!options.memberId && stayType !== "FREE" ? {
      bookingChannelCode: channel,
      channelOrderReference: channel === "WECOM" ? null : `CTRIP-${options.key}`,
      targetCurrentContractAmountMinor,
      ...(options.channelPriceDifferenceReason ? { channelPriceDifferenceReason: options.channelPriceDifferenceReason } : {}),
      ...(options.manualPriceAdjustmentReason ? { manualPriceAdjustmentReason: options.manualPriceAdjustmentReason } : {})
    } : {}),
    ...(stayType === "FREE" ? {
      freeStayReason: "阶段 9 免费住宿日期调整验收",
      freeStayCategoryCode: "RECEPTION"
    } : {})
  }, `${options.key}-create`);
  const orderId = receipt.result?.orderId;
  const stayId = receipt.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") throw new Error(`${options.key} did not create an order`);
  return {
    orderId,
    stayId,
    unitId: options.unitId,
    unitCode: options.unitCode,
    nickname: options.nickname,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    contractAmountMinor: targetCurrentContractAmountMinor
  };
}

async function createStay(
  db: Kysely<Database>,
  businessDate: string,
  options: Stage9CreateStayOptions
): Promise<Stage9StayFixture & { contractAmountMinor: number }> {
  return withOrdinaryOrderCreationClock(businessDate, options.arrivalDate, () => {
    return createStayAtCreationClock(db, options);
  });
}

async function createMember(
  db: Kysely<Database>,
  key: string,
  roomTypeCode: string | null
): Promise<string> {
  const membership = roomTypeCode === "shared_bath_single"
    ? { productId: "membership_product_shared_bath_single_v1", priceMinor: 162_000 }
    : roomTypeCode === "private_bath_single"
      ? { productId: "membership_product_private_bath_single_v1", priceMinor: 216_000 }
      : null;
  if (!membership) throw new Error(`Stage 9 member fixture does not support room type ${roomTypeCode ?? "unknown"}`);
  const profile = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: `阶段九会员-${key}`,
    nickname: `阶段九会员-${key}`,
    identityCardNumber: `STAGE9-ID-${key}`,
    phone: "13800009019",
    wechat: `wx-stage9-${key}`
  }, `${key}-profile`);
  const memberId = profile.result?.memberId;
  if (typeof memberId !== "string") throw new Error("Stage 9 member profile was not created");
  const membershipOrder = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: membership.productId,
    agreedPriceMinor: membership.priceMinor
  }, `${key}-membership`);
  const membershipOrderId = membershipOrder.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Stage 9 membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: membership.priceMinor,
    transactionReference: `WX-STAGE9-${key}`
  }, `${key}-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${key}-activate`);
  return memberId;
}

async function markHistoricalOrderInHouse(
  _db: Kysely<Database>,
  stay: Stage9StayFixture,
  checkInBusinessDate: string
): Promise<void> {
  const simulatedInstant = new Date(`${checkInBusinessDate}T12:00:00+08:00`);
  await withPropertyClockForTesting(simulatedInstant, async () => {
    await execute(_db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: stay.orderId
    }, `stage9-historical-check-in-${stay.orderId}`);
  });
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
    pricingPolicyVersionId: demo.publicPricingPolicyId,
    stayType: "TRANSIENT"
  });
  return quote.currentContractAmount.minorUnits;
}

export async function prepareStage9Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: {
    reset?: boolean;
    dayOffset?: number;
    suffix?: string;
    unitCodeOverrides?: Stage9UnitCodeOverrides;
  } = {}
): Promise<Stage9AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const dayOffset = options.dayOffset ?? 2;
    const suffix = options.suffix ?? `manual-${businessDate.replaceAll("-", "")}`;
    const unitCodes = {
      ...defaultStage9UnitCodes,
      ...options.unitCodeOverrides
    } satisfies Record<Stage9LogicalUnitCode, string>;
    const actualUnitCodes = Object.values(unitCodes);
    if (new Set(actualUnitCodes).size !== actualUnitCodes.length) {
      throw new Error("Stage 9 unit-code overrides must resolve every logical room to a distinct actual room");
    }
    const units = Object.fromEntries(await Promise.all(
      (Object.entries(unitCodes) as Array<[Stage9LogicalUnitCode, string]>).map(async ([logicalCode, actualCode]) => [
        logicalCode,
        await unitByCode(db, actualCode)
      ])
    )) as Record<Stage9LogicalUnitCode, Awaited<ReturnType<typeof unitByCode>>>;
    const at = (offset: number) => addDays(businessDate, dayOffset + offset);
    const ordinary = (key: string, logicalUnitCode: Stage9LogicalUnitCode, nickname: string, arrival: number, departure: number) => createStay(db, businessDate, {
      key: `${suffix}-${key}`,
      unitId: units[logicalUnitCode].id,
      unitCode: units[logicalUnitCode].code,
      nickname: `${nickname}-${suffix}`,
      arrivalDate: at(arrival),
      departureDate: at(departure)
    });

    // Five independent date-change shapes remain visible in the default 21-day room-status range.
    const earlyArrival = await ordinary("early-arrival", "101", "提前到店", 1, 4);
    const lateArrival = await ordinary("late-arrival", "102", "延后到店", 2, 5);
    const earlyDeparture = await ordinary("early-departure", "103", "缩短预订", 3, 7);
    const lateDeparture = await ordinary("late-departure", "104", "延长预订", 4, 6);
    const shift = await ordinary("shift", "105", "整体平移", 5, 7);
    const collected = await ordinary("collected", "106", "已有收款", 6, 8);
    const collectedMinor = Math.max(100, Math.floor(collected.contractAmountMinor / 2 / 100) * 100);
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId: collected.orderId,
      amountMinor: collectedMinor,
      method: "WECOM",
      transactionReference: `WX-STAGE9-${suffix}-COLLECTED`,
      note: "4.2 已登记收款改期验收"
    }, `${suffix}-collected-receipt`);

    const external = await createStay(db, businessDate, {
      key: `${suffix}-external`,
      unitId: units["107"]!.id,
      unitCode: units["107"].code,
      nickname: `携程改期-${suffix}`,
      arrivalDate: at(7),
      departureDate: at(10),
      channel: "CTRIP"
    });
    const externalTargetMinor = external.contractAmountMinor * 2;

    const wecomDeviation = await createStay(db, businessDate, {
      key: `${suffix}-wecom-deviation`,
      unitId: units["108"]!.id,
      unitCode: units["108"].code,
      nickname: `企微偏价-${suffix}`,
      arrivalDate: at(8),
      departureDate: at(10),
      manualAdjustmentMinor: -100,
      manualPriceAdjustmentReason: "创建时人工优惠，不应继承到改期"
    });

    const memberId = await createMember(db, `${suffix}-member`, units.D01.room_type_code);
    const memberReserved = await createStay(db, businessDate, {
      key: `${suffix}-member-reserved`,
      unitId: units.D01!.id,
      unitCode: units.D01.code,
      nickname: `会员改期-${suffix}`,
      arrivalDate: at(9),
      departureDate: at(11),
      memberId
    });
    const memberInHouse = await createStay(db, businessDate, {
      key: `${suffix}-member-in-house`,
      unitId: units.D01.id,
      unitCode: units.D01.code,
      nickname: `会员续住-${suffix}`,
      arrivalDate: businessDate,
      departureDate: addDays(businessDate, 2),
      memberId
    });
    await execute(db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: memberInHouse.orderId
    }, `${suffix}-member-check-in`);

    const departureDayArrival = addDays(businessDate, -1);
    const departureDayNewDeparture = addDays(businessDate, 1);
    const departureDayExpectedMinor = await contractAmountForInterval(
      db,
      units["202"]!.id,
      departureDayArrival,
      departureDayNewDeparture
    );
    const departureDay = await createStay(db, businessDate, {
      key: `${suffix}-departure-day`,
      unitId: units["202"]!.id,
      unitCode: units["202"].code,
      nickname: `退房日续住-${suffix}`,
      arrivalDate: departureDayArrival,
      departureDate: businessDate
    });
    await markHistoricalOrderInHouse(db, departureDay, departureDay.arrivalDate);

    const overdueArrival = addDays(businessDate, -3);
    const overdueNewDeparture = addDays(businessDate, 1);
    const overdueExpectedMinor = await contractAmountForInterval(
      db,
      units.D02!.id,
      overdueArrival,
      overdueNewDeparture
    );
    const overdue = await createStay(db, businessDate, {
      key: `${suffix}-overdue`,
      unitId: units.D02!.id,
      unitCode: units.D02.code,
      nickname: `逾期续住-${suffix}`,
      arrivalDate: overdueArrival,
      departureDate: addDays(businessDate, -1)
    });
    await markHistoricalOrderInHouse(db, overdue, overdue.arrivalDate);

    const free = await createStay(db, businessDate, {
      key: `${suffix}-free`,
      unitId: units["109"]!.id,
      unitCode: units["109"].code,
      nickname: `免费改期-${suffix}`,
      arrivalDate: at(10),
      departureDate: at(12),
      stayType: "FREE"
    });

    const conflict = await ordinary("conflict", "201", "库存冲突", 11, 13);
    const blocker = await createStay(db, businessDate, {
      key: `${suffix}-conflict-blocker`,
      unitId: units["201"]!.id,
      unitCode: units["201"].code,
      nickname: `冲突占用-${suffix}`,
      arrivalDate: at(13),
      departureDate: at(17)
    });

    const multiUnitStay = await createStay(db, businessDate, {
      key: `${suffix}-multi`,
      unitId: units["203"]!.id,
      unitCode: units["203"].code,
      nickname: `多房源门禁-${suffix}`,
      arrivalDate: at(14),
      departureDate: at(17),
      stayType: "FREE"
    });
    await execute(db, "MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId: multiUnitStay.orderId,
      newInventoryUnitId: units["204"]!.id,
      effectiveDate: at(15)
    }, `${suffix}-multi-move`);
    const multiSegments = await db.selectFrom("stay_segments")
      .select("id")
      .where("stay_id", "=", multiUnitStay.stayId)
      .execute();
    if (multiSegments.length !== 2) throw new Error("Stage 9 multi-unit gate fixture is incomplete");

    return {
      businessDate,
      rangeArrivalDate: businessDate,
      rangeDepartureDate: addDays(businessDate, 21),
      operator: { username: "operator", password: "demo-pass-2026" },
      earlyArrival: {
        ...earlyArrival,
        newArrivalDate: at(0),
        newDepartureDate: at(4)
      },
      lateArrival: {
        ...lateArrival,
        newArrivalDate: at(3),
        newDepartureDate: at(6)
      },
      earlyDeparture: {
        ...earlyDeparture,
        newArrivalDate: earlyDeparture.arrivalDate,
        newDepartureDate: at(6)
      },
      lateDeparture: {
        ...lateDeparture,
        newArrivalDate: lateDeparture.arrivalDate,
        newDepartureDate: at(8)
      },
      shift: {
        ...shift,
        newArrivalDate: at(7),
        newDepartureDate: at(9)
      },
      collected: {
        ...collected,
        newArrivalDate: at(7),
        newDepartureDate: at(9),
        recordedCollectionYuan: String(collectedMinor / 100)
      },
      external: {
        ...external,
        newArrivalDate: at(8),
        newDepartureDate: at(11),
        targetContractYuan: String(externalTargetMinor / 100),
        channelPriceDifferenceReason: "携程活动价格重新确认，超过政策基础金额 15%"
      },
      wecomDeviation: {
        ...wecomDeviation,
        newArrivalDate: at(9),
        newDepartureDate: at(11),
        originalManualContractYuan: String(wecomDeviation.contractAmountMinor / 100)
      },
      memberReserved: {
        ...memberReserved,
        newArrivalDate: at(11),
        newDepartureDate: at(13),
        memberId
      },
      memberInHouse: {
        ...memberInHouse,
        newDepartureDate: addDays(memberInHouse.departureDate, 1),
        memberId
      },
      departureDay: {
        ...departureDay,
        newDepartureDate: departureDayNewDeparture,
        originalContractYuan: String(departureDay.contractAmountMinor / 100),
        expectedContractYuan: String(departureDayExpectedMinor / 100)
      },
      overdue: {
        ...overdue,
        newDepartureDate: overdueNewDeparture,
        originalContractYuan: String(overdue.contractAmountMinor / 100),
        expectedContractYuan: String(overdueExpectedMinor / 100)
      },
      free: {
        ...free,
        newArrivalDate: at(11),
        newDepartureDate: at(13)
      },
      conflict: {
        ...conflict,
        newArrivalDate: at(13),
        newDepartureDate: at(16),
        blockerOrderId: blocker.orderId,
        blockerNickname: blocker.nickname
      },
      multiUnit: {
        ...multiUnitStay,
        destinationUnitId: units["204"]!.id,
        destinationUnitCode: units["204"].code
      }
    };
  } finally {
    await db.destroy();
  }
}

export async function prepareStage9MobileAcceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; suffix?: string; unitCodeOverride?: string } = {}
): Promise<Stage9MobileAcceptanceFixture> {
  if (options.reset === true) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `mobile-${businessDate.replaceAll("-", "")}`;
    const unit = await unitByCode(db, options.unitCodeOverride ?? "D02");
    const arrivalDate = addDays(businessDate, 2);
    const departureDate = addDays(businessDate, 4);
    const free = await createStay(db, businessDate, {
      key: `${suffix}-free`,
      unitId: unit.id,
      unitCode: unit.code,
      nickname: `免费改期-${suffix}`,
      arrivalDate,
      departureDate,
      stayType: "FREE"
    });
    return {
      businessDate,
      rangeArrivalDate: businessDate,
      rangeDepartureDate: addDays(businessDate, 21),
      operator: { username: "operator", password: "demo-pass-2026" },
      free: {
        ...free,
        newArrivalDate: addDays(businessDate, 3),
        newDepartureDate: addDays(businessDate, 5)
      }
    };
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const fixture = await prepareStage9Acceptance(defaultDatabaseUrl, { reset: true });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-stage9-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
