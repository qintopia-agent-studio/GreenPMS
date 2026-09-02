import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { hashPassword, todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const demo = {
  propertyId: "prop_qintopia_demo",
  bedAId: "unit_room_101_bed_a",
  bedBId: "unit_room_101_bed_b",
  bedDId: "unit_room_101_bed_d",
  publicPricingPolicyId: "policy_qintopia_public_2026_rev561_v1",
  freePolicyId: "policy_free_v1",
  agentSubjectId: "subject_demo_agent"
} as const;

const defaultDatabaseUrl = process.env.STAGE7_ACCEPTANCE_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stage7_acceptance";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 7 Acceptance Setup",
  ...authScope()
};

export const stage7ReadOnlyOperator = {
  id: "subject_stage7_acceptance_reader",
  username: "stage7-reader",
  password: "stage7-read-2026",
  displayName: "阶段七只读验收员"
} as const;

export interface Stage7AcceptanceFixture {
  database: string;
  property: string;
  dates: {
    arrivalDate: string;
    moveDate: string;
    originalDepartureDate: string;
    departureDate: string;
  };
  splitBed: {
    roomId: string;
    room: string;
    bedAId: string;
    bedAOrderId: string;
    bedBId: string;
    bedBOrderId: string;
    maintenanceBedId: string;
    maintenanceLockId: string;
  };
  wholeRoom: {
    roomId: string;
    room: string;
    orderId: string;
    primaryOccupantId: string;
    nicknames: string[];
  };
  adjacentSameNickname: Array<{
    roomId: string;
    room: string;
    orderId: string;
    nickname: string;
  }>;
  movedStay: {
    orderId: string;
    stayId: string;
    fromRoomId: string;
    fromRoom: string;
    toRoomId: string;
    toRoom: string;
  };
  stage6: {
    releasableMaintenanceRoomId: string;
    releasableMaintenanceRoom: string;
    releasableMaintenanceLockId: string;
    emptyCreationRoomId: string;
    emptyCreationRoom: string;
    freeStayRoomId: string;
    freeStayRoom: string;
    freeStayOrderId: string;
  };
  readOnlyLogin: {
    username: string;
    password: string;
    displayName: string;
  };
}

export interface PrepareStage7AcceptanceOptions {
  reset?: boolean;
  dayOffset?: number;
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
      : {
          code: "STAGE7_ACCEPTANCE",
          note: "Prepare the isolated stage 6 and stage 7 combined acceptance dataset"
        }
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

async function inventoryUnitByCode(db: Kysely<Database>, code: string) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "name"])
    .where("property_id", "=", demo.propertyId)
    .where("code", "=", code)
    .executeTakeFirstOrThrow();
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
  stayType?: "TRANSIENT" | "FREE";
}): Promise<{ orderId: string; stayId: string; primaryOccupantId: string }> {
  const stayType = options.stayType ?? "TRANSIENT";
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.unitId,
    stayType,
    arrivalDate: options.arrivalDate,
    departureDate: options.departureDate,
    pricingPolicyVersionId: stayType === "FREE" ? demo.freePolicyId : demo.publicPricingPolicyId
  });
  const receipt = await execute(db, "CREATE_ORDER", {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: options.fullName,
      nickname: options.nickname,
      phone: "13800000001",
      documentNumber: `STAGE7-${options.key}`
    },
    additionalGuests: options.additionalGuests ?? [],
    ...(stayType !== "FREE" ? {
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    } : {}),
    ...(stayType === "FREE" ? { freeStayReason: "阶段 6/7 合并人工验收免费住宿", freeStayCategoryCode: "RECEPTION" } : {})
  }, options.key);
  const orderId = receipt.result?.orderId;
  const stayId = receipt.result?.stayId;
  const occupants = receipt.result?.occupants;
  const primaryOccupantId = Array.isArray(occupants) && typeof occupants[0] === "object" && occupants[0]
    ? (occupants[0] as { id?: unknown }).id
    : undefined;
  if (typeof orderId !== "string" || typeof stayId !== "string" || typeof primaryOccupantId !== "string") {
    throw new Error(`${options.key} did not create a complete order/stay/occupant fixture`);
  }
  return { orderId, stayId, primaryOccupantId };
}

async function ensureReadOnlyPrincipal(db: Kysely<Database>): Promise<void> {
  const salt = "stage7-acceptance-reader-v1";
  await db.insertInto("subjects").values({
    id: stage7ReadOnlyOperator.id,
    username: stage7ReadOnlyOperator.username,
    display_name: stage7ReadOnlyOperator.displayName,
    password_salt: salt,
    password_hash: hashPassword(stage7ReadOnlyOperator.password, salt),
    status: "ACTIVE",
    auth_version: 1
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({
    username: stage7ReadOnlyOperator.username,
    display_name: stage7ReadOnlyOperator.displayName,
    password_salt: salt,
    password_hash: hashPassword(stage7ReadOnlyOperator.password, salt),
    status: "ACTIVE",
    auth_version: 1
  })).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: stage7ReadOnlyOperator.id,
    property_id: demo.propertyId,
    access_level: "READ"
  }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
    access_level: "READ"
  })).execute();
}

export async function prepareStage7Acceptance(
  databaseUrl = defaultDatabaseUrl,
  options: PrepareStage7AcceptanceOptions = {}
): Promise<Stage7AcceptanceFixture> {
  if (options.reset !== false) await resetE2eDatabase(databaseUrl);
  const db = createDatabase(databaseUrl);
  try {
    await ensureReadOnlyPrincipal(db);
    const arrivalDate = addDays(todayInTimeZone("Asia/Shanghai"), options.dayOffset ?? 0);
    const day2 = addDays(arrivalDate, 1);
    const moveDate = addDays(arrivalDate, 2);
    const originalDepartureDate = addDays(arrivalDate, 3);
    const departureDate = addDays(arrivalDate, 5);
    const fixturePrefix = `stage7-${arrivalDate}`;

    const [room101, room102, room103, room104, roomA01, roomA02, roomA03, roomB01, roomB02] = await Promise.all([
      inventoryUnitByCode(db, "101"),
      inventoryUnitByCode(db, "102"),
      inventoryUnitByCode(db, "103"),
      inventoryUnitByCode(db, "104"),
      inventoryUnitByCode(db, "A01"),
      inventoryUnitByCode(db, "A02"),
      inventoryUnitByCode(db, "A03"),
      inventoryUnitByCode(db, "B01"),
      inventoryUnitByCode(db, "B02")
    ]);

    const bedA = await createStay(db, {
      key: `${fixturePrefix}-bed-a`,
      unitId: demo.bedAId,
      arrivalDate,
      departureDate,
      fullName: "阶段七床位住客甲",
      nickname: "山峰"
    });
    const bedB = await createStay(db, {
      key: `${fixturePrefix}-bed-b`,
      unitId: demo.bedBId,
      arrivalDate,
      departureDate,
      fullName: "阶段七床位住客乙",
      nickname: "小满"
    });

    const bedMaintenance = await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.bedDId,
      arrivalDate: day2,
      departureDate: originalDepartureDate,
      reason: "D 床检修"
    }, `${fixturePrefix}-bed-d-maintenance`);

    const wholeRoom = await createStay(db, {
      key: `${fixturePrefix}-whole-room`,
      unitId: room104.id,
      arrivalDate,
      departureDate,
      fullName: "阶段七整房主要住客",
      nickname: "小川",
      additionalGuests: [{
        fullName: "阶段七整房同行住客",
        nickname: "阿宁",
        phone: "13800000002",
        documentNumber: "STAGE7-WHOLE-ROOM-02"
      }]
    });

    const adjacentA = await createStay(db, {
      key: `${fixturePrefix}-same-name-a`,
      unitId: roomA01.id,
      arrivalDate,
      departureDate: originalDepartureDate,
      fullName: "相邻同昵称住客甲",
      nickname: "小满"
    });
    const adjacentB = await createStay(db, {
      key: `${fixturePrefix}-same-name-b`,
      unitId: roomA02.id,
      arrivalDate,
      departureDate: originalDepartureDate,
      fullName: "相邻同昵称住客乙",
      nickname: "小满"
    });

    const moved = await createStay(db, {
      key: `${fixturePrefix}-moved-stay`,
      unitId: roomB01.id,
      arrivalDate,
      departureDate: originalDepartureDate,
      fullName: "跨分段住宿住客",
      nickname: "小满"
    });
    await execute(db, "RESCHEDULE_STAY", {
      propertyId: demo.propertyId,
      orderId: moved.orderId,
      newArrivalDate: arrivalDate,
      newDepartureDate: departureDate
    }, `${fixturePrefix}-reschedule`);
    await execute(db, "MOVE_UNIT", {
      propertyId: demo.propertyId,
      orderId: moved.orderId,
      newInventoryUnitId: roomB02.id,
      effectiveDate: moveDate
    }, `${fixturePrefix}-move`);

    const releasableMaintenance = await execute(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: room102.id,
      arrivalDate,
      departureDate: originalDepartureDate,
      reason: "空调检修"
    }, `${fixturePrefix}-room-102-maintenance`);
    const freeStay = await createStay(db, {
      key: `${fixturePrefix}-free-stay`,
      unitId: roomA03.id,
      arrivalDate,
      departureDate: originalDepartureDate,
      fullName: "阶段七免费住宿住客",
      nickname: "云舒",
      stayType: "FREE"
    });

    return {
      database: new URL(databaseUrl).pathname.slice(1),
      property: "QTP-XA · QinTopia",
      dates: { arrivalDate, moveDate, originalDepartureDate, departureDate },
      splitBed: {
        roomId: room101.id,
        room: "1栋 101 四人间（公卫）",
        bedAId: demo.bedAId,
        bedAOrderId: bedA.orderId,
        bedBId: demo.bedBId,
        bedBOrderId: bedB.orderId,
        maintenanceBedId: demo.bedDId,
        maintenanceLockId: String(bedMaintenance.result?.maintenanceLockId ?? "")
      },
      wholeRoom: {
        roomId: room104.id,
        room: "1栋 104 四人间（公卫）",
        orderId: wholeRoom.orderId,
        primaryOccupantId: wholeRoom.primaryOccupantId,
        nicknames: ["小川", "阿宁"]
      },
      adjacentSameNickname: [
        { roomId: roomA01.id, room: "A栋 A01 标间（独卫）", orderId: adjacentA.orderId, nickname: "小满" },
        { roomId: roomA02.id, room: "A栋 A02 标间（独卫）", orderId: adjacentB.orderId, nickname: "小满" }
      ],
      movedStay: {
        orderId: moved.orderId,
        stayId: moved.stayId,
        fromRoomId: roomB01.id,
        fromRoom: "B栋 B01 单人间（独卫）",
        toRoomId: roomB02.id,
        toRoom: "B栋 B02 单人间（独卫）"
      },
      stage6: {
        releasableMaintenanceRoomId: room102.id,
        releasableMaintenanceRoom: "1栋 102 四人间（公卫）",
        releasableMaintenanceLockId: String(releasableMaintenance.result?.maintenanceLockId ?? ""),
        emptyCreationRoomId: room103.id,
        emptyCreationRoom: "1栋 103 四人间（公卫）",
        freeStayRoomId: roomA03.id,
        freeStayRoom: "A栋 A03 大床房（独卫）",
        freeStayOrderId: freeStay.orderId
      },
      readOnlyLogin: {
        username: stage7ReadOnlyOperator.username,
        password: stage7ReadOnlyOperator.password,
        displayName: stage7ReadOnlyOperator.displayName
      }
    };
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const fixture = await prepareStage7Acceptance(defaultDatabaseUrl, { dayOffset: 7 });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("setup-stage7-acceptance.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
