import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import {
  confirmCommandPreview,
  createCommandPreview,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAGE5_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage5_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 5 Acceptance Setup",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

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
      : { code: "STAGE5_ACCEPTANCE", note: "Prepare the isolated stage 5 manual acceptance dataset" }
  }, {
    idempotencyKey: `${key}-confirm`,
    correlationId: key
  });
  if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
    const detail = receipt.error ? `${receipt.error.code}: ${receipt.error.message}` : "no receipt error detail";
    throw new Error(`${key} ${commandType} failed (${receipt.executionStatus}, committed=${receipt.businessCommitted}): ${detail}`);
  }
  return receipt;
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  fullName: string;
  nickname: string;
  additionalGuests?: Array<{
    fullName: string;
    nickname: string;
    phone?: string;
    documentNumber?: string;
  }>;
  stayType: "TRANSIENT" | "FREE";
}): Promise<string> {
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType: options.stayType,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: options.stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId
  });
  const receipt = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: { fullName: options.fullName, nickname: options.nickname },
    additionalGuests: options.additionalGuests ?? [],
    ...(options.stayType !== "FREE" ? {
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    } : {}),
    ...(options.stayType === "FREE" ? { freeStayReason: "阶段 5 免费住宿显示对照", freeStayCategoryCode: "RECEPTION" } : {})
  }, options.key);
  const orderId = receipt.result?.orderId;
  if (typeof orderId !== "string") throw new Error(`${options.key} did not create an order`);
  return orderId;
}

async function roomIdByCode(db: Kysely<Database>, code: string): Promise<string> {
  const room = await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("kind", "=", "ROOM")
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
  return room.id;
}

async function main(): Promise<void> {
  const db = await resetDatabase(databaseUrl);
  try {
    const today = todayInTimeZone("Asia/Shanghai");
    const day2 = addDays(today, 1);
    const day3 = addDays(today, 2);
    const departureDate = addDays(today, 4);
    const primaryNickname = "山风";
    const [kingRoomId, doubleRoomId] = await Promise.all([
      roomIdByCode(db, "A03"),
      roomIdByCode(db, "104")
    ]);

    const orderA = await createStay(db, {
      key: "stage5-bed-a-normal",
      unitId: demo.bedAId,
      arrivalDate: today,
      departureDate,
      fullName: "阶段五住客甲",
      nickname: primaryNickname,
      stayType: "TRANSIENT"
    });
    await createStay(db, {
      key: "stage5-bed-b-free",
      unitId: demo.bedBId,
      arrivalDate: today,
      departureDate,
      fullName: "阶段五住客乙",
      nickname: "小满",
      stayType: "FREE"
    });
    await createStay(db, {
      key: "stage5-bed-c-normal",
      unitId: demo.bedCId,
      arrivalDate: day2,
      departureDate,
      fullName: "阶段五住客丙",
      nickname: "小满",
      stayType: "TRANSIENT"
    });
    const historicalOrder = await createStay(db, {
      key: "stage5-bed-d-historical-free",
      unitId: demo.bedDId,
      arrivalDate: day3,
      departureDate,
      fullName: "历史法定姓名不得冒充昵称",
      nickname: "待转换为历史空昵称",
      stayType: "FREE"
    });
    const kingRoomOrder = await createStay(db, {
      key: "stage5-king-room-two-occupants",
      unitId: kingRoomId,
      arrivalDate: today,
      departureDate,
      fullName: "大床房主要入住人",
      nickname: "山峰",
      additionalGuests: [{ fullName: "大床房同行人", nickname: "小满" }],
      stayType: "TRANSIENT"
    });
    const doubleRoomOrder = await createStay(db, {
      key: "stage5-double-room-two-occupants",
      unitId: doubleRoomId,
      arrivalDate: today,
      departureDate,
      fullName: "双人间主要入住人",
      nickname: "小川",
      additionalGuests: [{ fullName: "双人间同行人", nickname: "阿宁" }],
      stayType: "TRANSIENT"
    });

    await execute(db, "CHECK_IN", { propertyId: demo.propertyId, orderId: orderA }, "stage5-bed-a-check-in");
    await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedDId,
      arrivalDate: day2,
      departureDate: day3,
      reason: "阶段 5 维修对照：不计入住比例"
    }, "stage5-bed-d-maintenance");

    await sql`alter table orders disable trigger orders_protect_identity`.execute(db);
    await sql`alter table order_occupants disable trigger order_occupants_append_only`.execute(db);
    try {
      await db.updateTable("orders")
        .set({ primary_guest_snapshot: { fullName: "历史法定姓名不得冒充昵称" } })
        .where("id", "=", historicalOrder)
        .execute();
      await db.updateTable("order_occupants")
        .set({ nickname: null })
        .where("order_id", "=", historicalOrder)
        .where("ordinal", "=", 1)
        .execute();
    } finally {
      await sql`alter table order_occupants enable trigger order_occupants_append_only`.execute(db);
      await sql`alter table orders enable trigger orders_protect_identity`.execute(db);
    }

    process.stdout.write(`${JSON.stringify({
      database: new URL(databaseUrl).pathname.slice(1),
      property: "QTP-SH · QinTopia",
      room: "1栋 101 四人间（公卫）",
      wholeRoomExamples: [
        { room: "A栋 A03 大床房（独卫）", orderId: kingRoomOrder, nicknames: ["山峰", "小满"] },
        { room: "1栋 104 双人间（公卫）", orderId: doubleRoomOrder, nicknames: ["小川", "阿宁"] }
      ],
      dates: {
        twoOfFour: today,
        threeOfFourWithMaintenance: day2,
        fourOfFour: day3,
        departureDate
      },
      nicknames: [primaryNickname, "小满", "小满", "历史未记录"]
    }, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
