import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  getRoomStatusBoard,
  type Database
} from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { authScope } from "../helpers/auth-principals.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.WHOLE_ROOM_OCCUPANTS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_whole_room_occupants";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  ...authScope()
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function roomWithCapacity(capacity: number) {
  return db.selectFrom("inventory_units")
    .select(["id", "code", "occupancy_capacity"])
    .where("property_id", "=", demo.propertyId)
    .where("kind", "=", "ROOM")
    .where("occupancy_capacity", "=", capacity)
    .where("inventory_basis", "=", "INDEPENDENT")
    .orderBy("code")
    .executeTakeFirstOrThrow();
}

async function quotedCreateOrderInput(unitId: string, arrivalDate: string, departureDate: string) {
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: demo.transientPolicyId
  });
  return {
    propertyId: demo.propertyId,
    quoteId: quote.quoteId,
    primaryGuest: {
      fullName: "主要居住人姓名",
      nickname: "小满",
      phone: "13800000001",
      documentNumber: "PRIMARY-DOC"
    },
    bookingChannelCode: "YOUMUDAO",
    channelOrderReference: "WHOLE-ROOM-OCCUPANTS",
    targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
  } satisfies CommandEnvelope["input"];
}

async function createTwoOccupantOrder(unitId: string, arrivalDate: string, departureDate: string, prefix: string) {
  const input = {
    ...await quotedCreateOrderInput(unitId, arrivalDate, departureDate),
    additionalGuests: [{ fullName: "同行居住人", nickname: "山风" }]
  };
  const prepared = await createCommandPreview(
    db,
    principal,
    { commandType: "CREATE_ORDER", input },
    metadata(`${prefix}-preview`)
  );
  const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "" }
  }, metadata(`${prefix}-confirm`));
  return { prepared, receipt };
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("whole-room occupants", () => {
  it("freezes and persists two same-nickname occupants in order while room-status exposes only minimal identity", async () => {
    const unit = await roomWithCapacity(2);
    const input = {
      ...await quotedCreateOrderInput(unit.id, "2032-03-01", "2032-03-03"),
      additionalGuests: [{
        fullName: "同行居住人姓名",
        nickname: "小满",
        phone: "13800000002",
        documentNumber: "ADDITIONAL-DOC"
      }]
    };
    const previewMetadata = metadata("whole-room-two-preview");
    const prepared = await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input }, previewMetadata);
    const effect = prepared.preview.effect as {
      occupancyCapacity: number;
      occupants: Array<{ id: string; ordinal: number; role: string; nickname: string }>;
    };
    expect(effect.occupancyCapacity).toBe(2);
    expect(effect.occupants).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^occupant_/), ordinal: 1, role: "PRIMARY", nickname: "小满" }),
      expect.objectContaining({ id: expect.stringMatching(/^occupant_/), ordinal: 2, role: "ADDITIONAL", nickname: "小满" })
    ]);
    expect(new Set(effect.occupants.map((occupant) => occupant.id)).size).toBe(2);

    const storedPreview = await db.selectFrom("command_previews")
      .select(["normalized_input", "basis_versions"])
      .where("id", "=", prepared.preview.previewId)
      .executeTakeFirstOrThrow();
    expect(storedPreview.normalized_input).toMatchObject({ _occupantIds: effect.occupants.map((occupant) => occupant.id) });
    expect(storedPreview.basis_versions).toMatchObject({ occupancyCapacity: 2 });

    const confirmMetadata = metadata("whole-room-two-confirm");
    const confirmation = {
      propertyId: demo.propertyId,
      commandType: "CREATE_ORDER" as const,
      confirmation: true as const,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    };
    const concurrent = await Promise.allSettled([
      confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmMetadata),
      confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmMetadata)
    ]);
    const fulfilled = concurrent.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmCommandPreview>>> => (
      outcome.status === "fulfilled"
    ));
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const rejected of concurrent.filter((outcome) => outcome.status === "rejected")) {
      expect(rejected.reason).toMatchObject({ code: "COMMAND_STATUS_UNKNOWN", retryable: true });
    }
    const receipt = fulfilled[0]!.value;
    expect(fulfilled.every((outcome) => outcome.value.receiptId === receipt.receiptId)).toBe(true);
    const replay = await confirmCommandPreview(db, principal, prepared.preview.previewId, confirmation, confirmMetadata);
    expect(replay).toEqual(receipt);
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true });
    const resultOccupants = receipt.result!.occupants as Array<{ id: string; ordinal: number; role: string; nickname: string }>;
    expect(resultOccupants.map(({ id, ordinal, role, nickname }) => ({ id, ordinal, role, nickname }))).toEqual(
      effect.occupants.map(({ id, ordinal, role, nickname }) => ({ id, ordinal, role, nickname }))
    );
    expect(receipt.resourceRefs).toEqual(expect.arrayContaining(effect.occupants.map((occupant) => occupant.id)));

    const orderId = receipt.result!.orderId as string;
    const view = await getOrderView(db, orderId);
    expect(view.occupants).toEqual([
      expect.objectContaining({ id: effect.occupants[0]!.id, ordinal: 1, role: "PRIMARY", fullName: "主要居住人姓名", nickname: "小满", phone: "13800000001", documentNumber: "PRIMARY-DOC" }),
      expect.objectContaining({ id: effect.occupants[1]!.id, ordinal: 2, role: "ADDITIONAL", fullName: "同行居住人姓名", nickname: "小满", phone: "13800000002", documentNumber: "ADDITIONAL-DOC" })
    ]);
    expect(await db.selectFrom("order_occupants").select("id").where("order_id", "=", orderId).orderBy("ordinal").execute())
      .toEqual(effect.occupants.map((occupant) => ({ id: occupant.id })));
    expect(await db.selectFrom("command_executions")
      .select("id")
      .where("idempotency_key", "=", confirmMetadata.idempotencyKey)
      .execute()).toHaveLength(1);

    const board = await getRoomStatusBoard(db, {
      propertyId: demo.propertyId,
      arrivalDate: "2032-03-01",
      departureDate: "2032-03-03",
      accessLevel: "WRITE",
      commandGrants: principal.propertyCommandGrants.get(demo.propertyId)!,
      requestingSubjectId: demo.agentSubjectId
    });
    const projectedUnit = board.rooms.find((room) => room.id === unit.id)!;
    expect(projectedUnit).toMatchObject({ capacity: 2, occupancyCapacity: 2 });
    const kingRoom = await db.selectFrom("inventory_units")
      .select(["id", "physical_bed_count", "occupancy_capacity"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("room_type_code", "=", "private_bath_king")
      .executeTakeFirstOrThrow();
    expect(kingRoom).toMatchObject({ physical_bed_count: 1, occupancy_capacity: 2 });
    expect(board.rooms.find((room) => room.id === kingRoom.id)).toMatchObject({
      capacity: 1,
      occupancyCapacity: 2
    });
    expect(projectedUnit.intervals).toEqual([
      expect.objectContaining({
        occupantCount: 2,
        occupants: [
          { occupantId: effect.occupants[0]!.id, nickname: "小满" },
          { occupantId: effect.occupants[1]!.id, nickname: "小满" }
        ]
      })
    ]);
    const projectionJson = JSON.stringify(board);
    expect(projectionJson).not.toContain("主要居住人姓名");
    expect(projectionJson).not.toContain("同行居住人姓名");
    expect(projectionJson).not.toContain("1380000000");
    expect(projectionJson).not.toContain("PRIMARY-DOC");
    expect(projectionJson).not.toContain("ADDITIONAL-DOC");

    const audits = await db.selectFrom("audit_entries")
      .select(["metadata", "reason"])
      .where("correlation_id", "in", [previewMetadata.correlationId, confirmMetadata.correlationId])
      .execute();
    expect(JSON.stringify(audits)).not.toContain("主要居住人姓名");
    expect(JSON.stringify(audits)).not.toContain("1380000000");
    expect(JSON.stringify(audits)).not.toContain("PRIMARY-DOC");
  });

  it("rejects a second bed occupant and a whole-room overflow before Preview with zero command or business writes", async () => {
    const room = await roomWithCapacity(2);
    const scenarios = [
      {
        prefix: "bed-second",
        unitId: demo.bedAId,
        additionalGuests: [{ fullName: "床位第二人", nickname: "小满" }]
      },
      {
        prefix: "room-overflow",
        unitId: room.id,
        additionalGuests: [
          { fullName: "同行一", nickname: "小满" },
          { fullName: "同行二", nickname: "山风" }
        ]
      },
      {
        prefix: "additional-blank-name",
        unitId: room.id,
        additionalGuests: [{ fullName: "   ", nickname: "小满" }]
      },
      {
        prefix: "additional-blank-nickname",
        unitId: room.id,
        additionalGuests: [{ fullName: "同行人", nickname: "   " }]
      }
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const input = {
        ...await quotedCreateOrderInput(scenario.unitId, `2032-04-0${index + 1}`, `2032-04-0${index + 2}`),
        additionalGuests: scenario.additionalGuests
      };
      const before = await Promise.all([
        db.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("order_occupants").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("command_previews").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("command_executions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow()
      ]);
      await expect(createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input }, metadata(scenario.prefix)))
        .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const after = await Promise.all([
        db.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("order_occupants").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("command_previews").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
        db.selectFrom("command_executions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow()
      ]);
      expect(after).toEqual(before);
    }
  });

  it("replays the same occupant list but rejects a reused Preview key with a different list", async () => {
    const room = await roomWithCapacity(2);
    const input = {
      ...await quotedCreateOrderInput(room.id, "2032-05-01", "2032-05-02"),
      additionalGuests: [{ fullName: "同行甲", nickname: "小满" }]
    };
    const requestMetadata = metadata("occupant-idempotency");
    const first = await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input }, requestMetadata);
    expect(await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input }, requestMetadata)).toEqual(first);
    await expect(createCommandPreview(db, principal, {
      commandType: "CREATE_ORDER",
      input: { ...input, additionalGuests: [{ fullName: "同行乙", nickname: "山风" }] }
    }, requestMetadata)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("turns a capacity change after Preview into PREVIEW_STALE without writing an order", async () => {
    const room = await roomWithCapacity(2);
    const input = {
      ...await quotedCreateOrderInput(room.id, "2032-06-01", "2032-06-02"),
      additionalGuests: [{ fullName: "容量变化同行", nickname: "小满" }]
    };
    const prepared = await createCommandPreview(db, principal, { commandType: "CREATE_ORDER", input }, metadata("capacity-stale-preview"));
    const beforeOrders = await db.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    await sql`alter table inventory_units disable trigger inventory_units_protect_identity`.execute(db);
    try {
      await db.updateTable("inventory_units").set({ occupancy_capacity: 1 }).where("id", "=", room.id).execute();
      const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CREATE_ORDER",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "CREATE_STANDARD_ORDER", note: "" }
      }, metadata("capacity-stale-confirm"));
      expect(receipt).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "VALIDATION_ERROR" } }
      });
      expect(await db.selectFrom("orders").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow())
        .toEqual(beforeOrders);
    } finally {
      await db.updateTable("inventory_units").set({ occupancy_capacity: 2 }).where("id", "=", room.id).execute();
      await sql`alter table inventory_units enable trigger inventory_units_protect_identity`.execute(db);
    }
  });

  it("rejects moving a two-occupant order to capacity one before Preview with zero writes", async () => {
    const source = await roomWithCapacity(2);
    const target = await roomWithCapacity(1);
    const { receipt } = await createTwoOccupantOrder(source.id, "2032-07-01", "2032-07-03", "move-overflow");
    const orderId = receipt.result!.orderId as string;
    const before = await Promise.all([
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").select(({ fn }) => fn.countAll<string>().as("count")).where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("stay_segments as segment")
        .innerJoin("stays as stay", "stay.id", "segment.stay_id")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("stay.order_id", "=", orderId)
        .executeTakeFirstOrThrow()
    ]);
    await expect(createCommandPreview(db, principal, {
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: target.id,
        effectiveDate: "2032-07-02"
      }
    }, metadata("move-overflow-denied"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const after = await Promise.all([
      db.selectFrom("command_previews").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("command_executions").select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow(),
      db.selectFrom("amendments").select(({ fn }) => fn.countAll<string>().as("count")).where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("stay_segments as segment")
        .innerJoin("stays as stay", "stay.id", "segment.stay_id")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("stay.order_id", "=", orderId)
        .executeTakeFirstOrThrow()
    ]);
    expect(after).toEqual(before);
  });

  it("freezes MOVE_UNIT occupant count and destination capacity and rejects stale capacity with no amendment", async () => {
    const capacityTwoRooms = await db.selectFrom("inventory_units")
      .select(["id", "occupancy_capacity"])
      .where("property_id", "=", demo.propertyId)
      .where("kind", "=", "ROOM")
      .where("inventory_basis", "=", "INDEPENDENT")
      .where("occupancy_capacity", "=", 2)
      .orderBy("code")
      .limit(2)
      .execute();
    expect(capacityTwoRooms).toHaveLength(2);
    const source = capacityTwoRooms[0]!;
    const target = capacityTwoRooms[1]!;
    const { receipt } = await createTwoOccupantOrder(source.id, "2032-08-01", "2032-08-03", "move-capacity-stale");
    const orderId = receipt.result!.orderId as string;
    const currentAmountMinor = (await getOrderView(db, orderId)).amounts.currentContractAmount.minorUnits;
    const prepared = await createCommandPreview(db, principal, {
      commandType: "MOVE_UNIT",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newInventoryUnitId: target.id,
        effectiveDate: "2032-08-02",
        targetCurrentContractAmountMinor: currentAmountMinor
      }
    }, metadata("move-capacity-stale-preview"));
    expect(prepared.preview.effect).toMatchObject({ occupantCount: 2, occupancyCapacity: 2 });
    expect((await db.selectFrom("command_previews")
      .select("basis_versions")
      .where("id", "=", prepared.preview.previewId)
      .executeTakeFirstOrThrow()).basis_versions).toMatchObject({
      occupantCount: 2,
      destinationInventoryUnit: {
        id: target.id,
        occupancyCapacity: 2
      }
    });
    const before = await Promise.all([
      db.selectFrom("amendments").select(({ fn }) => fn.countAll<string>().as("count")).where("order_id", "=", orderId).executeTakeFirstOrThrow(),
      db.selectFrom("stay_segments as segment")
        .innerJoin("stays as stay", "stay.id", "segment.stay_id")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("stay.order_id", "=", orderId)
        .executeTakeFirstOrThrow()
    ]);
    await sql`alter table inventory_units disable trigger inventory_units_protect_identity`.execute(db);
    try {
      await db.updateTable("inventory_units").set({ occupancy_capacity: 1 }).where("id", "=", target.id).execute();
      const rejected = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "MOVE_UNIT",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "MOVE_CAPACITY_STALE", note: "Confirm stale destination capacity" }
      }, metadata("move-capacity-stale-confirm"));
      expect(rejected).toMatchObject({
        executionStatus: "NOT_EXECUTED",
        businessCommitted: false,
        error: { code: "PREVIEW_STALE", details: { causeCode: "VALIDATION_ERROR" } }
      });
      const after = await Promise.all([
        db.selectFrom("amendments").select(({ fn }) => fn.countAll<string>().as("count")).where("order_id", "=", orderId).executeTakeFirstOrThrow(),
        db.selectFrom("stay_segments as segment")
          .innerJoin("stays as stay", "stay.id", "segment.stay_id")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("stay.order_id", "=", orderId)
          .executeTakeFirstOrThrow()
      ]);
      expect(after).toEqual(before);
    } finally {
      await db.updateTable("inventory_units").set({ occupancy_capacity: 2 }).where("id", "=", target.id).execute();
      await sql`alter table inventory_units enable trigger inventory_units_protect_identity`.execute(db);
    }
  });

  it("rejects direct and concurrent occupant appends and direct low-capacity stay segments", async () => {
    const source = await roomWithCapacity(2);
    const target = await roomWithCapacity(1);
    const { receipt } = await createTwoOccupantOrder(source.id, "2032-09-01", "2032-09-03", "frozen-occupants");
    const orderId = receipt.result!.orderId as string;
    const commandId = receipt.commandId;
    const append = (id: string, ordinal: number) => db.insertInto("order_occupants").values({
      id,
      order_id: orderId,
      ordinal,
      role: "ADDITIONAL",
      full_name: `追加住宿人 ${ordinal}`,
      nickname: `追加 ${ordinal}`,
      phone: null,
      document_number: null,
      created_by_command_id: commandId
    }).execute();
    await expect(append("occupant_direct_append", 3)).rejects.toMatchObject({
      constraint: "order_occupants_initial_list_frozen"
    });
    const concurrent = await Promise.allSettled([
      append("occupant_concurrent_append_3", 3),
      append("occupant_concurrent_append_4", 4)
    ]);
    expect(concurrent).toHaveLength(2);
    expect(concurrent.every((outcome) => outcome.status === "rejected"
      && outcome.reason?.constraint === "order_occupants_initial_list_frozen")).toBe(true);
    expect(await db.selectFrom("order_occupants").select("id").where("order_id", "=", orderId).execute()).toHaveLength(2);

    const view = await getOrderView(db, orderId);
    await expect(db.transaction().execute(async (trx) => {
      const moveCommandId = "command_direct_low_capacity_move";
      await trx.insertInto("command_executions").values({
        id: moveCommandId,
        subject_id: principal.subjectId,
        credential_id: principal.credentialId,
        property_id: demo.propertyId,
        command_type: "MOVE_UNIT",
        idempotency_key: "direct-low-capacity-move",
        request_hash: "a".repeat(64),
        correlation_id: "direct-low-capacity-move",
        state: "EXECUTING",
        completed_at: null
      }).execute();
      const amendmentId = "amend_direct_low_capacity_move";
      await trx.insertInto("amendments").values({
        id: amendmentId,
        order_id: orderId,
        sequence: 2,
        amendment_type: "MOVE_UNIT",
        reason_code: "DIRECT_CAPACITY_GUARD",
        reason_note: "Probe database segment capacity guard",
        prior_version: 1,
        new_version: 2,
        payload: {},
        command_id: moveCommandId
      }).execute();
      await trx.insertInto("stay_segments").values({
        id: "segment_direct_low_capacity_move",
        stay_id: view.stay.id,
        sequence: 2,
        inventory_unit_id: target.id,
        arrival_date: "2032-09-02",
        departure_date: "2032-09-03",
        segment_type: "MOVE",
        supersedes_segment_id: view.currentSegment.id,
        amendment_id: amendmentId
      }).execute();
      await sql`set constraints stay_segments_validate_occupant_set immediate`.execute(trx);
    })).rejects.toMatchObject({ constraint: "orders_occupancy_capacity_exceeded" });
    expect((await getOrderView(db, orderId)).segments).toHaveLength(1);
  });
});
