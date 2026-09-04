import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  pricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STEP9_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_step9_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Step 9 Acceptance Setup",
  ...authScope()
};

interface PreparedStay {
  orderId: string;
  stayId: string;
  unitId: string;
  unitCode: string;
  arrivalDate: string;
  departureDate: string;
  amountMinor: number;
}

interface PreparedMember {
  memberId: string;
  fullName: string;
  nickname: string;
  identityCardNumber: string | null;
  phone: string;
  wechat: string;
}

export interface Step9AcceptanceFixture {
  propertyId: string;
  businessDate: string;
  operator: { username: string; password: string };
  administrator: { username: string; password: string };
  runtimeAuditArrears: PreparedStay;
  historicalSingle: PreparedStay & {
    correctedArrivalDate: string;
    correctedDepartureDate: string;
  };
  historicalSwap: {
    left: PreparedStay;
    right: PreparedStay;
  };
  profileCorrection: PreparedMember & {
    correctedFullName: string;
    correctedNickname: string;
    correctedWechat: string;
  };
  effectiveDateCorrection: PreparedMember & {
    membershipOrderId: string;
    originalMembershipDate: string;
    correctedMembershipDate: string;
  };
  historicalBackfill: PreparedMember & {
    membershipProductId: string;
    membershipProductName: string;
    actualMembershipDate: string;
    paymentAmountMinor: number;
    paymentBusinessDate: string;
    paymentTransactionReference: string;
  };
  activeUnderpaidMemberships: Array<PreparedMember & {
    account: "operator" | "administrator";
    membershipOrderId: string;
    agreedPriceMinor: number;
    initiallyCollectedMinor: number;
    outstandingMinor: number;
  }>;
  erroneousMemberships: Array<PreparedMember & {
    oldMembershipOrderId: string;
    oldDirectPaymentMinor: number;
    sourceStay: PreparedStay;
    actualMembershipDate: string;
    replacementPaymentBusinessDate: string;
    replacementPaymentTransactionReference: string;
  }>;
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
      : { code: "STEP9_ACCEPTANCE", note: "准备第 9.3 至 9.5 步隔离验收数据" }
  }, { idempotencyKey: `${key}-confirm`, correlationId: key });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} failed: ${receipt.error?.code ?? receipt.executionStatus} ${receipt.error?.message ?? ""}`.trim());
  }
  return receipt;
}

async function createMember(db: Kysely<Database>, options: {
  key: string;
  fullName: string;
  nickname?: string;
  identityCardNumber?: string | null;
  phone: string;
  wechat: string;
}): Promise<PreparedMember> {
  const receipt = await execute(db, "CREATE_MEMBER", {
    propertyId: demo.propertyId,
    fullName: options.fullName,
    nickname: options.nickname ?? options.fullName,
    identityCardNumber: options.identityCardNumber ?? null,
    phone: options.phone,
    wechat: options.wechat
  }, `${options.key}-member`);
  const memberId = receipt.result?.memberId;
  if (typeof memberId !== "string") throw new Error(`${options.key} did not create a member`);
  return {
    memberId,
    fullName: options.fullName,
    nickname: options.nickname ?? options.fullName,
    identityCardNumber: options.identityCardNumber ?? null,
    phone: options.phone,
    wechat: options.wechat
  };
}

async function unitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "room_type_code"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .where("kind", "=", "ROOM")
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitCode: string;
  nickname: string;
  documentNumber?: string | null;
  phone: string;
  arrivalDate: string;
  departureDate: string;
  collect: boolean;
  finalStatus: "IN_HOUSE" | "CHECKED_OUT";
}): Promise<PreparedStay> {
  const unit = await unitByCode(db, options.unitCode);
  const created = await withPropertyClockForTesting(new Date(`${options.arrivalDate}T12:00:00+08:00`), async () => {
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: unit.id,
      arrivalDate: options.arrivalDate,
      departureDate: options.departureDate,
      pricingPolicyVersionId: demo.pricingPolicyId,
      stayType: "TRANSIENT"
    });
    const receipt = await execute(db, "CREATE_ORDER", {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: {
        fullName: `${options.nickname}完整姓名`,
        nickname: options.nickname,
        phone: options.phone,
        documentNumber: options.documentNumber ?? null
      },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }, `${options.key}-create`);
    return { receipt, amountMinor: quote.currentContractAmount.minorUnits };
  });
  const orderId = created.receipt.result?.orderId;
  const stayId = created.receipt.result?.stayId;
  if (typeof orderId !== "string" || typeof stayId !== "string") {
    throw new Error(`${options.key} did not create a stay`);
  }
  if (options.collect) {
    await execute(db, "RECORD_COLLECTION", {
      propertyId: demo.propertyId,
      orderId,
      amountMinor: created.amountMinor,
      method: "WECOM",
      transactionReference: `WX-STEP9-${options.key.toUpperCase()}-STAY`
    }, `${options.key}-collection`);
  }
  await withPropertyClockForTesting(new Date(`${options.arrivalDate}T12:00:00+08:00`), () => execute(db, "CHECK_IN", {
    propertyId: demo.propertyId,
    orderId
  }, `${options.key}-check-in`));
  if (options.finalStatus === "CHECKED_OUT") {
    await withPropertyClockForTesting(new Date(`${options.departureDate}T12:00:00+08:00`), () => execute(db, "CHECK_OUT", {
      propertyId: demo.propertyId,
      orderId
    }, `${options.key}-check-out`));
  }
  return {
    orderId,
    stayId,
    unitId: unit.id,
    unitCode: unit.code,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    amountMinor: created.amountMinor
  };
}

async function createActiveMembership(db: Kysely<Database>, options: {
  key: string;
  memberId: string;
  membershipProductId: string;
  agreedPriceMinor: number;
  paymentAmountMinor?: number;
  transactionReference: string;
}): Promise<string> {
  const order = await execute(db, "CREATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    memberId: options.memberId,
    membershipProductId: options.membershipProductId,
    agreedPriceMinor: options.agreedPriceMinor,
    ...(options.agreedPriceMinor === 93_600 ? { priceAdjustmentReason: "第 9 步错误办卡验收基线" } : {})
  }, `${options.key}-membership-order`);
  const membershipOrderId = order.result?.membershipOrderId;
  if (typeof membershipOrderId !== "string") throw new Error(`${options.key} did not create a membership order`);
  await execute(db, "RECORD_MEMBERSHIP_PAYMENT", {
    propertyId: demo.propertyId,
    membershipOrderId,
    amountMinor: options.paymentAmountMinor ?? options.agreedPriceMinor,
    transactionReference: options.transactionReference
  }, `${options.key}-membership-payment`);
  await execute(db, "ACTIVATE_MEMBERSHIP_ORDER", {
    propertyId: demo.propertyId,
    membershipOrderId
  }, `${options.key}-membership-activate`);
  return membershipOrderId;
}

export async function prepareStep9Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: { reset?: boolean } = {}
): Promise<Step9AcceptanceFixture> {
  const db = options.reset === false ? createDatabase(databaseUrl) : await resetDatabase(databaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const sharedProduct = await db.selectFrom("membership_products")
      .select(["id", "name", "list_price_minor", "allowed_room_type_code"])
      .where("status", "=", "PUBLISHED")
      .where("allowed_inventory_kind", "=", "ROOM")
      .orderBy("list_price_minor")
      .executeTakeFirstOrThrow();
    if (!sharedProduct.allowed_room_type_code) throw new Error("Step 9 requires a room-scoped membership product");
    const compatibleUnits = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("active", "=", true)
      .where("room_type_code", "=", sharedProduct.allowed_room_type_code)
      .orderBy("code")
      .limit(2)
      .execute();
    if (compatibleUnits.length < 2) throw new Error("Step 9 requires two compatible rooms for the selected membership product");
    const [leftUnit, rightUnit] = compatibleUnits;

    const historicalSingle = await createStay(db, {
      key: "historical-single",
      unitCode: leftUnit!.code,
      nickname: "历史单笔待修改",
      phone: "13800009101",
      arrivalDate: addDays(businessDate, -16),
      departureDate: addDays(businessDate, -14),
      collect: false,
      finalStatus: "CHECKED_OUT"
    });
    const swapDates = { arrivalDate: addDays(businessDate, -12), departureDate: addDays(businessDate, -10) };
    const historicalSwapLeft = await createStay(db, {
      key: "historical-swap-left",
      unitCode: leftUnit!.code,
      nickname: "鹏哥",
      phone: "13800009102",
      ...swapDates,
      collect: false,
      finalStatus: "CHECKED_OUT"
    });
    const historicalSwapRight = await createStay(db, {
      key: "historical-swap-right",
      unitCode: rightUnit!.code,
      nickname: "小尚",
      phone: "13800009103",
      ...swapDates,
      collect: false,
      finalStatus: "CHECKED_OUT"
    });

    const profileCorrection = await createMember(db, {
      key: "profile-correction",
      fullName: "会员资料待修改",
      nickname: "资料待核",
      phone: "13800009111",
      wechat: "step9-profile-wrong"
    });
    const effectiveDateCorrection = await createMember(db, {
      key: "effective-date",
      fullName: "办卡日期待修改",
      phone: "13800009112",
      wechat: "step9-effective-date"
    });
    const effectiveMembershipOrderId = await createActiveMembership(db, {
      key: "effective-date",
      memberId: effectiveDateCorrection.memberId,
      membershipProductId: sharedProduct.id,
      agreedPriceMinor: sharedProduct.list_price_minor,
      transactionReference: "WX-STEP9-EFFECTIVE-DATE"
    });
    const historicalBackfill = await createMember(db, {
      key: "historical-backfill",
      fullName: "历史办卡待补录",
      phone: "13800009113",
      wechat: "step9-historical-backfill"
    });

    const activeUnderpaidMemberships = [];
    for (const [account, suffix] of [["operator", "普通员工"], ["administrator", "管理员"]] as const) {
      const member = await createMember(db, {
        key: `active-underpaid-${account}`,
        fullName: `在职欠款会员-${suffix}`,
        phone: account === "operator" ? "13800009114" : "13800009115",
        wechat: `step9-active-underpaid-${account}`
      });
      const agreedPriceMinor = 93_600;
      const initiallyCollectedMinor = 60_000;
      const membershipOrderId = await createActiveMembership(db, {
        key: `active-underpaid-${account}`,
        memberId: member.memberId,
        membershipProductId: sharedProduct.id,
        agreedPriceMinor,
        paymentAmountMinor: initiallyCollectedMinor,
        transactionReference: `WX-STEP9-ACTIVE-UNDERPAID-${account.toUpperCase()}-INITIAL`
      });
      activeUnderpaidMemberships.push({
        ...member,
        account,
        membershipOrderId,
        agreedPriceMinor,
        initiallyCollectedMinor,
        outstandingMinor: agreedPriceMinor - initiallyCollectedMinor
      });
    }

    const erroneousMemberships = [];
    for (const [index, identity] of [
      { fullName: "Cathy", identityCardNumber: "510000199001010121", phone: "13800009121", wechat: "step9-cathy" },
      { fullName: "晶晶", identityCardNumber: "510000199001010122", phone: "13800009122", wechat: "step9-jingjing" }
    ].entries()) {
      const key = index === 0 ? "cathy" : "jingjing";
      const member = await createMember(db, { key, ...identity });
      const sourceStay = await createStay(db, {
        key: `${key}-source`,
        unitCode: compatibleUnits[index]!.code,
        nickname: identity.fullName,
        documentNumber: identity.identityCardNumber,
        phone: identity.phone,
        arrivalDate: addDays(businessDate, -5),
        departureDate: addDays(businessDate, -4),
        collect: true,
        finalStatus: "CHECKED_OUT"
      });
      const oldMembershipOrderId = await createActiveMembership(db, {
        key,
        memberId: member.memberId,
        membershipProductId: sharedProduct.id,
        agreedPriceMinor: 93_600,
        transactionReference: `WX-STEP9-${key.toUpperCase()}-OLD-936`
      });
      erroneousMemberships.push({
        ...member,
        oldMembershipOrderId,
        oldDirectPaymentMinor: 93_600,
        sourceStay,
        actualMembershipDate: sourceStay.arrivalDate,
        replacementPaymentBusinessDate: sourceStay.arrivalDate,
        replacementPaymentTransactionReference: `WX-STEP9-${key.toUpperCase()}-TRUE-DIFFERENCE`
      });
    }

    const runtimeAuditArrears = await createStay(db, {
      key: "runtime-audit-arrears",
      unitCode: leftUnit!.code,
      nickname: "入住后欠款验收",
      phone: "13800009131",
      arrivalDate: businessDate,
      departureDate: addDays(businessDate, 1),
      collect: false,
      finalStatus: "IN_HOUSE"
    });

    const backfillDate = addDays(businessDate, -20);
    return {
      propertyId: demo.propertyId,
      businessDate,
      operator: { username: "operator", password: "demo-pass-2026" },
      administrator: { username: "admin", password: "demo-pass-2026" },
      runtimeAuditArrears,
      historicalSingle: {
        ...historicalSingle,
        correctedArrivalDate: addDays(historicalSingle.arrivalDate, 1),
        correctedDepartureDate: addDays(historicalSingle.departureDate, 1)
      },
      historicalSwap: { left: historicalSwapLeft, right: historicalSwapRight },
      profileCorrection: {
        ...profileCorrection,
        correctedFullName: "会员资料已核实",
        correctedNickname: "资料已核",
        correctedWechat: "step9-profile-verified"
      },
      effectiveDateCorrection: {
        ...effectiveDateCorrection,
        membershipOrderId: effectiveMembershipOrderId,
        originalMembershipDate: businessDate,
        correctedMembershipDate: addDays(businessDate, -30)
      },
      historicalBackfill: {
        ...historicalBackfill,
        membershipProductId: sharedProduct.id,
        membershipProductName: sharedProduct.name,
        actualMembershipDate: backfillDate,
        paymentAmountMinor: sharedProduct.list_price_minor,
        paymentBusinessDate: backfillDate,
        paymentTransactionReference: "WX-STEP9-HISTORICAL-BACKFILL"
      },
      activeUnderpaidMemberships,
      erroneousMemberships
    };
  } finally {
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("setup-step9-acceptance.ts")) {
  void prepareStep9Acceptance().then((fixture) => {
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
