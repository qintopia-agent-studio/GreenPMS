import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STAGE11_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage11_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 11 Acceptance Setup",
  ...authScope()
};

export interface Stage11UnitFixture {
  id: string;
  code: string;
  name: string;
  kind: "ROOM" | "BED";
}

export interface Stage11StayFixture {
  orderId: string;
  stayId: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  source: Stage11UnitFixture;
}

export interface Stage11MoveFixture extends Stage11StayFixture {
  effectiveDate: string;
  target: Stage11UnitFixture;
}

export interface Stage11SchemeFixture extends Stage11MoveFixture {
  newArrivalDate: string;
  newDepartureDate: string;
  expectedIntervals: Array<{ unitCode: string; arrivalDate: string; departureDate: string }>;
}

export interface Stage11AcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  samePrice: Stage11MoveFixture;
  crossPrice: Stage11MoveFixture;
  external: Stage11MoveFixture & { targetContractYuan: string; channelPriceDifferenceReason: string };
  free: Stage11MoveFixture;
  historicalExtend: Stage11MoveFixture & { newDepartureDate: string };
  futureShorten: Stage11MoveFixture & { newDepartureDate: string };
  member: Stage11MoveFixture & { memberId: string };
  capacityBlocked: Stage11MoveFixture;
  conflictBlocked: Stage11MoveFixture & { blockerNickname: string };
  bedMove: Stage11MoveFixture;
  schemes: {
    equal: Stage11SchemeFixture;
    nonEqual: Stage11SchemeFixture;
    whollyEarlier: Stage11SchemeFixture;
    whollyLater: Stage11SchemeFixture;
  };
}

export interface Stage11MobileAcceptanceFixture {
  businessDate: string;
  operator: { username: string; password: string };
  free: Stage11MoveFixture;
  samePrice: Stage11MoveFixture;
  crossPrice: Stage11MoveFixture;
  external: Stage11MoveFixture & { targetContractYuan: string; channelPriceDifferenceReason: string };
  wecomReset: Stage11MoveFixture;
  memberCrossKind: Stage11MoveFixture & { memberId: string };
}

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
      : { code: "STAGE11_ACCEPTANCE", note: "准备 4.4 自动化与人工验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus} ${receipt.error?.message ?? ""}`.trim());
  }
  return receipt;
}

async function unitByCode(db: Kysely<Database>, code: string): Promise<Stage11UnitFixture & { roomTypeCode: string | null }> {
  const unit = await db.selectFrom("inventory_units")
    .select(["id", "code", "name", "kind", "room_type_code"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
  return { id: unit.id, code: unit.code, name: unit.name, kind: unit.kind, roomTypeCode: unit.room_type_code };
}

type Stage11CreateStayOptions = {
  key: string;
  source: Stage11UnitFixture;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  stayType?: "TRANSIENT" | "FREE";
  memberId?: string;
  channel?: "WECOM" | "CTRIP";
  wecomAdjustmentMinor?: number;
  additionalGuestCount?: number;
};

async function createStayAtCreationClock(db: Kysely<Database>, options: Stage11CreateStayOptions): Promise<Stage11StayFixture> {
  const stayType = options.stayType ?? "TRANSIENT";
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.source.id,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId,
    stayType,
    ...(options.memberId ? { memberId: options.memberId } : {})
  });
  const channel = options.channel ?? "WECOM";
  const additionalGuests = Array.from({ length: options.additionalGuestCount ?? 0 }, (_, index) => ({
    fullName: `${options.nickname}同行住客${index + 1}`,
    nickname: `${options.nickname}同行${index + 1}`,
    phone: `138000011${String(index).padStart(2, "0")}`,
    documentNumber: `STAGE11-${options.key}-G${index + 1}`
  }));
  const created = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: `${options.nickname}完整姓名`,
      nickname: options.nickname,
      phone: "13800001111",
      documentNumber: `STAGE11-${options.key}`
    },
    additionalGuests,
    ...(!options.memberId && stayType !== "FREE" ? {
      bookingChannelCode: channel,
      channelOrderReference: channel === "WECOM" ? null : `CTRIP-${options.key}`,
      ...(channel === "WECOM"
        ? options.wecomAdjustmentMinor !== undefined ? {
          targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits + options.wecomAdjustmentMinor,
          manualPriceAdjustmentReason: "4.4 验收夹具保留的一次历史人工偏价"
        } : {}
        : { targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits })
    } : {}),
    ...(stayType === "FREE" ? {
      freeStayReason: "4.4 免费住宿换房验收",
      freeStayCategoryCode: "RECEPTION"
    } : {})
  }, `${options.key}-create`);
  const orderId = created.result?.orderId;
  const stayId = created.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") throw new Error(`${options.key} did not create an order`);
  return {
    orderId,
    stayId,
    nickname: options.nickname,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    source: options.source
  };
}

async function createStay(
  db: Kysely<Database>,
  businessDate: string,
  options: Stage11CreateStayOptions
): Promise<Stage11StayFixture> {
  return withOrdinaryOrderCreationClock(businessDate, options.arrivalDate, () => {
    return createStayAtCreationClock(db, options);
  });
}

async function createMember(db: Kysely<Database>, key: string, phone: string): Promise<string> {
  const profile = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: `阶段十一会员-${key}`,
    nickname: `阶段十一会员-${key}`,
    identityCardNumber: `STAGE11-ID-${key}`,
    phone,
    wechat: `wx-stage11-${key}`
  }, `${key}-profile`);
  const memberId = profile.result?.memberId;
  if (typeof memberId !== "string") throw new Error("Stage 11 member profile was not created");
  const membership = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId,
    membershipProductId: "membership_product_shared_bath_single_v1",
    agreedPriceMinor: 162_000
  }, `${key}-membership`);
  const membershipOrderId = membership.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error("Stage 11 membership order was not created");
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: 162_000,
    transactionReference: `WX-STAGE11-${key}`
  }, `${key}-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${key}-activate`);
  return memberId;
}

async function moveFixture(
  db: Kysely<Database>,
  stay: Stage11StayFixture,
  target: Stage11UnitFixture,
  effectiveDate: string,
  key: string
): Promise<Stage11MoveFixture> {
  await execute(db, "MOVE_UNIT", {
    propertyId: demo.propertyId,
    orderId: stay.orderId,
    newInventoryUnitId: target.id,
    effectiveDate
  }, key);
  return { ...stay, target, effectiveDate };
}

export async function prepareStage11Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean; suffix?: string } = {}
): Promise<Stage11AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `manual-${businessDate.replaceAll("-", "")}`;
    const codes = [
      "205", "206", "206-A", "206-B", "202-A", "202-B", "301", "302", "303", "304",
      "305", "306", "307", "308", "309", "E01", "E02", "E03", "B01", "B02", "C03", "C04"
    ];
    const units = new Map(await Promise.all(codes.map(async (code) => [code, await unitByCode(db, code)] as const)));
    const unit = (code: string) => {
      const value = units.get(code);
      if (!value) throw new Error(`Missing Stage 11 inventory unit ${code}`);
      return value;
    };
    const at = (offset: number) => addDays(businessDate, offset);

    const samePrice = {
      ...await createStay(db, businessDate, { key: `${suffix}-same`, source: unit("302"), nickname: `同价换房-${suffix}`, arrivalDate: at(6), departureDate: at(9) }),
      target: unit("304"), effectiveDate: at(7)
    };
    const crossPrice = {
      ...await createStay(db, businessDate, { key: `${suffix}-cross`, source: unit("307"), nickname: `跨价换房-${suffix}`, arrivalDate: at(6), departureDate: at(9) }),
      target: unit("E03"), effectiveDate: at(7)
    };
    const external = {
      ...await createStay(db, businessDate, { key: `${suffix}-external`, source: unit("308"), nickname: `携程换房-${suffix}`, arrivalDate: at(10), departureDate: at(13), channel: "CTRIP" }),
      target: unit("309"), effectiveDate: at(11), targetContractYuan: "1000",
      channelPriceDifferenceReason: "携程重新确认本单渠道应结金额"
    };
    const free = {
      ...await createStay(db, businessDate, { key: `${suffix}-free`, source: unit("E01"), nickname: `免费换房-${suffix}`, arrivalDate: at(10), departureDate: at(13), stayType: "FREE" }),
      target: unit("E02"), effectiveDate: at(11)
    };

    const historicalBase = await createStay(db, businessDate, {
      key: `${suffix}-history`, source: unit("206-A"), nickname: `历史换房续住-${suffix}`,
      arrivalDate: at(-2), departureDate: at(2)
    });
    await withPropertyClockForTesting(new Date(`${at(-2)}T12:00:00+08:00`), () => execute(db, "CHECK_IN", {
      propertyId: demo.propertyId, orderId: historicalBase.orderId
    }, `${suffix}-history-check-in`));
    const historicalMove = await moveFixture(
      db, historicalBase, unit("206-B"), businessDate, `${suffix}-history-move`
    );
    const historicalExtend = { ...historicalMove, newDepartureDate: at(3) };

    const futureBase = await createStay(db, businessDate, {
      key: `${suffix}-future`, source: unit("309"), nickname: `未来换房裁剪-${suffix}`,
      arrivalDate: at(-1), departureDate: at(4)
    });
    await withPropertyClockForTesting(new Date(`${at(-1)}T12:00:00+08:00`), () => execute(
      db, "CHECK_IN", { propertyId: demo.propertyId, orderId: futureBase.orderId }, `${suffix}-future-check-in`
    ));
    const futureShorten = {
      ...await moveFixture(db, futureBase, unit("206-A"), at(2), `${suffix}-future-move`),
      newDepartureDate: at(2)
    };

    const memberId = await withPropertyClockForTesting(
      new Date(`${at(12)}T09:00:00+08:00`),
      () => createMember(db, `${suffix}-member`, "13800001119")
    );
    const member = {
      ...await createStay(db, businessDate, {
        key: `${suffix}-member-stay`, source: unit("302"), nickname: `会员同产品换房-${suffix}`,
        arrivalDate: at(12), departureDate: at(15), memberId
      }),
      target: unit("308"), effectiveDate: at(13), memberId
    };
    const capacityBlocked = {
      ...await createStay(db, businessDate, {
        key: `${suffix}-capacity`, source: unit("206"), nickname: `容量拒绝-${suffix}`,
        arrivalDate: at(12), departureDate: at(15), additionalGuestCount: 1
      }),
      target: unit("304"), effectiveDate: at(13)
    };
    const conflictBlocked = {
      ...await createStay(db, businessDate, {
        key: `${suffix}-conflict`, source: unit("303"), nickname: `库存拒绝-${suffix}`,
        arrivalDate: at(12), departureDate: at(15)
      }),
      target: unit("304"), effectiveDate: at(13), blockerNickname: `目标占用-${suffix}`
    };
    await createStay(db, businessDate, {
      key: `${suffix}-blocker`, source: unit("304"), nickname: conflictBlocked.blockerNickname,
      arrivalDate: at(13), departureDate: at(15)
    });
    const bedMove = {
      ...await createStay(db, businessDate, {
        key: `${suffix}-bed`, source: unit("202-A"), nickname: `床位换房-${suffix}`,
        arrivalDate: at(12), departureDate: at(15)
      }),
      target: unit("202-B"), effectiveDate: at(13)
    };

    async function scheme(
      key: string,
      sourceCode: string,
      targetCode: string,
      newArrivalDate: string,
      newDepartureDate: string,
      expectedIntervals: Stage11SchemeFixture["expectedIntervals"]
    ): Promise<Stage11SchemeFixture> {
      const stay = await createStay(db, businessDate, {
        key: `${suffix}-${key}`, source: unit(sourceCode), nickname: `${key}-${suffix}`,
        arrivalDate: at(14), departureDate: at(18), stayType: "FREE"
      });
      const moved = await moveFixture(db, stay, unit(targetCode), at(16), `${suffix}-${key}-move`);
      return { ...moved, newArrivalDate, newDepartureDate, expectedIntervals };
    }
    const equal = await scheme("等量平移", "305", "306", at(15), at(19), [
      { unitCode: "305", arrivalDate: at(15), departureDate: at(17) },
      { unitCode: "306", arrivalDate: at(17), departureDate: at(19) }
    ]);
    const nonEqual = await scheme("非等量改期", "307", "308", at(13), at(19), [
      { unitCode: "307", arrivalDate: at(13), departureDate: at(16) },
      { unitCode: "308", arrivalDate: at(16), departureDate: at(19) }
    ]);
    const whollyEarlier = await scheme("完全提前", "B01", "B02", at(9), at(12), [
      { unitCode: "B01", arrivalDate: at(9), departureDate: at(12) }
    ]);
    const whollyLater = await scheme("完全延后", "C03", "C04", at(19), at(21), [
      { unitCode: "C04", arrivalDate: at(19), departureDate: at(21) }
    ]);

    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      samePrice,
      crossPrice,
      external,
      free,
      historicalExtend,
      futureShorten,
      member,
      capacityBlocked,
      conflictBlocked,
      bedMove,
      schemes: { equal, nonEqual, whollyEarlier, whollyLater }
    };
  } finally {
    await db.destroy();
  }
}

export async function prepareStage11MobileAcceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { suffix?: string } = {}
): Promise<Stage11MobileAcceptanceFixture> {
  const db = createDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const suffix = options.suffix ?? `mobile-${businessDate.replaceAll("-", "")}`;
    const mobileDayOffset = 30;
    const at = (offset: number) => addDays(businessDate, mobileDayOffset + offset);
    const freeSource = await unitByCode(db, "305");
    const freeTarget = await unitByCode(db, "306");
    const freeStay = await createStay(db, businessDate, {
      key: `${suffix}-free`, source: freeSource, nickname: `手机免费换房-${suffix}`,
      arrivalDate: at(2), departureDate: at(5), stayType: "FREE"
    });
    const sameSource = await unitByCode(db, "A01");
    const sameTarget = await unitByCode(db, "A02");
    const sameStay = await createStay(db, businessDate, {
      key: `${suffix}-same`, source: sameSource, nickname: `手机同价换房-${suffix}`,
      arrivalDate: at(2), departureDate: at(5)
    });
    const crossSource = await unitByCode(db, "A03");
    const crossTarget = await unitByCode(db, "B01");
    const crossStay = await createStay(db, businessDate, {
      key: `${suffix}-cross`, source: crossSource, nickname: `手机跨价换房-${suffix}`,
      arrivalDate: at(2), departureDate: at(5)
    });
    const externalSource = await unitByCode(db, "B03");
    const externalTarget = await unitByCode(db, "B04");
    const externalStay = await createStay(db, businessDate, {
      key: `${suffix}-external`, source: externalSource, nickname: `手机渠道换房-${suffix}`,
      arrivalDate: at(6), departureDate: at(9), channel: "CTRIP"
    });
    const wecomSource = await unitByCode(db, "C01");
    const wecomTarget = await unitByCode(db, "C02");
    const wecomStay = await createStay(db, businessDate, {
      key: `${suffix}-wecom`, source: wecomSource, nickname: `手机企微换房-${suffix}`,
      arrivalDate: at(6), departureDate: at(9), wecomAdjustmentMinor: -100
    });
    const memberId = await withPropertyClockForTesting(
      new Date(`${at(12)}T09:00:00+08:00`),
      () => createMember(db, `${suffix}-member`, "13800001129")
    );
    const memberSource = await unitByCode(db, "D01");
    const memberTarget = await unitByCode(db, "202-A");
    const memberStay = await createStay(db, businessDate, {
      key: `${suffix}-member-cross-kind`, source: memberSource, nickname: `手机会员跨类型拒绝-${suffix}`,
      arrivalDate: at(12), departureDate: at(15), memberId
    });
    return {
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      free: { ...freeStay, target: freeTarget, effectiveDate: at(3) },
      samePrice: { ...sameStay, target: sameTarget, effectiveDate: at(3) },
      crossPrice: { ...crossStay, target: crossTarget, effectiveDate: at(3) },
      external: {
        ...externalStay,
        target: externalTarget,
        effectiveDate: at(7),
        targetContractYuan: "777",
        channelPriceDifferenceReason: "手机端重新确认本单渠道应结金额"
      },
      wecomReset: { ...wecomStay, target: wecomTarget, effectiveDate: at(7) },
      memberCrossKind: { ...memberStay, target: memberTarget, effectiveDate: at(13), memberId }
    };
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const fixture = await prepareStage11Acceptance(defaultDatabaseUrl, { reset: true });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-stage11-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
