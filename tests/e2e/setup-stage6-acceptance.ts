import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import {
  confirmCommandPreview,
  createCommandPreview,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.STAGE6_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage6_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 6 Acceptance Setup",
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
    reason: { code: "STAGE6_ACCEPTANCE", note: "Prepare the isolated stage 6 manual acceptance dataset" }
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

async function roomIdByCode(db: Kysely<Database>, code: string): Promise<string> {
  const room = await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("kind", "=", "ROOM")
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
  return room.id;
}

async function createStay(db: Kysely<Database>, options: {
  key: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  nickname: string;
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
    primaryGuest: { fullName: `阶段六${options.nickname}`, nickname: options.nickname },
    additionalGuests: [],
    bookingChannelCode: "WECOM",
    channelOrderReference: null,
    ...(options.stayType === "FREE" ? { freeStayReason: "阶段 6 免费入住名称对照" } : {})
  }, options.key);
  const orderId = receipt.result?.orderId;
  if (typeof orderId !== "string") throw new Error(`${options.key} did not create an order`);
  return orderId;
}

async function main(): Promise<void> {
  const db = await resetDatabase(databaseUrl);
  try {
    const today = todayInTimeZone("Asia/Shanghai");
    const day2 = addDays(today, 1);
    const day3 = addDays(today, 2);
    const day4 = addDays(today, 3);
    const day5 = addDays(today, 4);
    const [freeRoomId, emptyCreationRoomId] = await Promise.all([
      roomIdByCode(db, "A03"),
      roomIdByCode(db, "103")
    ]);

    const occupiedOrderId = await createStay(db, {
      key: "stage6-bed-a-occupied",
      unitId: demo.bedAId,
      arrivalDate: today,
      departureDate: day5,
      nickname: "山峰",
      stayType: "TRANSIENT"
    });
    await execute(db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: occupiedOrderId
    }, "stage6-bed-a-check-in");

    const freeOrderId = await createStay(db, {
      key: "stage6-free-stay",
      unitId: freeRoomId,
      arrivalDate: today,
      departureDate: day3,
      nickname: "小满",
      stayType: "FREE"
    });
    await execute(db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: freeOrderId
    }, "stage6-free-stay-check-in");

    const bedMaintenance = await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedDId,
      arrivalDate: day2,
      departureDate: day4,
      reason: "D 床检修"
    }, "stage6-bed-d-maintenance");
    const releasableMaintenance = await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.secondRoomId,
      arrivalDate: today,
      departureDate: day3,
      reason: "空调检修"
    }, "stage6-room-102-maintenance");

    process.stdout.write(`${JSON.stringify({
      database: new URL(databaseUrl).pathname.slice(1),
      property: "QTP-SH · QinTopia",
      dates: { today, day2, day3, day4, day5 },
      bedMaintenance: {
        room: "1栋 101 四人间（公卫）",
        bed: "D",
        maintenanceLockId: bedMaintenance.result?.maintenanceLockId,
        expectedOccupancyOnDay2: "1/4"
      },
      releasableMaintenance: {
        room: "1栋 102 四人间（公卫）",
        maintenanceLockId: releasableMaintenance.result?.maintenanceLockId,
        interval: [today, day3]
      },
      emptyCreationTarget: {
        room: "1栋 103 四人间（公卫）",
        inventoryUnitId: emptyCreationRoomId
      },
      freeStay: {
        room: "A栋 A03 大床房（独卫）",
        orderId: freeOrderId,
        nickname: "小满"
      }
    }, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
