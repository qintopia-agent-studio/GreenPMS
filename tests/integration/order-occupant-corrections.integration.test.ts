import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  getOrderView,
  getRoomStatusBoard,
  type Database
} from "@qintopia/db";
import type { Kysely } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.ORDER_OCCUPANT_CORRECTIONS_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_order_occupant_corrections";

const writePrincipal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};
const readPrincipal: AuthPrincipal = {
  ...writePrincipal,
  credentialId: "token_demo_read",
  propertyAccess: new Map([[demo.propertyId, "READ"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function createTwoPersonOrder() {
  const unit = await db.selectFrom("inventory_units")
    .select("id")
    .where("property_id", "=", demo.propertyId)
    .where("kind", "=", "ROOM")
    .where("occupancy_capacity", "=", 2)
    .where("inventory_basis", "=", "INDEPENDENT")
    .orderBy("code")
    .executeTakeFirstOrThrow();
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unit.id,
    stayType: "TRANSIENT",
    arrivalDate: "2033-05-01",
    departureDate: "2033-05-03",
    pricingPolicyVersionId: demo.transientPolicyId
  });
  const preview = await createCommandPreview(db, writePrincipal, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: "张小满", nickname: "小满", phone: "13800000001", documentNumber: "DOC-1" },
      additionalGuests: [{ fullName: "李山风", nickname: "山风" }],
      bookingChannelCode: "YOUMUDAO",
      channelOrderReference: "CORRECTION-FIXTURE"
    }
  }, metadata("create-preview"));
  const receipt = await confirmCommandPreview(db, writePrincipal, preview.preview.previewId, {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "Create correction fixture" }
  }, metadata("create-confirm"));
  return {
    unitId: unit.id,
    orderId: receipt.result!.orderId as string,
    occupantId: (receipt.result!.occupants as Array<{ id: string }>)[1]!.id
  };
}

async function previewCorrection(orderId: string, occupantId: string, nickname: string) {
  const current = (await getOrderView(db, orderId)).occupants.find((occupant) => occupant.id === occupantId)!;
  return createCommandPreview(db, writePrincipal, {
    commandType: "CORRECT_ORDER_OCCUPANT",
    input: {
      propertyId: demo.propertyId,
      orderId,
      occupantId,
      expectedPriorSnapshot: {
        fullName: current.fullName,
        nickname: current.nickname,
        phone: current.phone,
        documentNumber: current.documentNumber
      },
      correctedSnapshot: {
        fullName: "李山风（已核对）",
        nickname,
        phone: "13800000002",
        documentNumber: "DOC-2"
      }
    }
  }, metadata(`correct-${nickname}-preview`));
}

async function confirmCorrection(preview: Awaited<ReturnType<typeof previewCorrection>>, prefix: string) {
  const confirmMetadata = metadata(`${prefix}-confirm`);
  const confirmation = {
    propertyId: demo.propertyId,
    commandType: "CORRECT_ORDER_OCCUPANT" as const,
    confirmation: true as const,
    expectedEffectHash: preview.preview.effectHash,
    reason: { code: "DATA_ENTRY_CORRECTION", note: "人工核对住宿人资料后更正" }
  };
  const receipt = await confirmCommandPreview(db, writePrincipal, preview.preview.previewId, confirmation, confirmMetadata);
  return { receipt, confirmation, confirmMetadata };
}

beforeEach(async () => {
  db = await resetDatabase(databaseUrl);
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("order occupant corrections", () => {
  it("appends a complete audited correction while preserving the initial row and projecting the latest occupant everywhere", async () => {
    const fixture = await createTwoPersonOrder();
    const initial = await db.selectFrom("order_occupants").selectAll().where("id", "=", fixture.occupantId).executeTakeFirstOrThrow();
    const revisionBefore = await db.selectFrom("room_status_revisions").select("revision").where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow();

    const prepared = await previewCorrection(fixture.orderId, fixture.occupantId, "清风");
    expect(prepared.preview.effect).toEqual({
      operation: "CORRECT_ORDER_OCCUPANT",
      orderId: fixture.orderId,
      occupantId: fixture.occupantId,
      ordinal: 2,
      role: "ADDITIONAL",
      before: { fullName: "李山风", nickname: "山风", phone: null, documentNumber: null },
      after: { fullName: "李山风（已核对）", nickname: "清风", phone: "13800000002", documentNumber: "DOC-2" }
    });

    const { receipt, confirmation, confirmMetadata } = await confirmCorrection(prepared, "correct-main");
    expect(receipt).toMatchObject({ executionStatus: "EXECUTED", businessCommitted: true, factRefs: [] });
    expect(receipt.result).toMatchObject({
      orderId: fixture.orderId,
      occupantId: fixture.occupantId,
      occupant: { nickname: "清风" }
    });
    expect(receipt.resourceRefs).toEqual([
      fixture.orderId,
      fixture.occupantId,
      receipt.result!.correctionId,
      receipt.result!.amendmentId
    ]);
    expect(await db.selectFrom("order_occupants").selectAll().where("id", "=", fixture.occupantId).executeTakeFirstOrThrow()).toEqual(initial);

    const correction = await db.selectFrom("order_occupant_corrections").selectAll().where("id", "=", receipt.result!.correctionId as string).executeTakeFirstOrThrow();
    expect(correction).toMatchObject({
      order_id: fixture.orderId,
      occupant_id: fixture.occupantId,
      sequence: 1,
      prior_full_name: "李山风",
      prior_nickname: "山风",
      prior_phone: null,
      prior_document_number: null,
      corrected_full_name: "李山风（已核对）",
      corrected_nickname: "清风",
      corrected_phone: "13800000002",
      corrected_document_number: "DOC-2",
      reason_code: "DATA_ENTRY_CORRECTION",
      reason_note: "人工核对住宿人资料后更正",
      actor_subject_id: demo.agentSubjectId,
      amendment_id: receipt.result!.amendmentId,
      created_by_command_id: receipt.commandId
    });

    const view = await getOrderView(db, fixture.orderId, "WRITE");
    expect(view.occupants[1]).toMatchObject({ id: fixture.occupantId, nickname: "清风", phone: "13800000002", documentNumber: "DOC-2" });
    expect(view.occupantCorrections).toEqual([
      expect.objectContaining({
        id: receipt.result!.correctionId,
        priorSnapshot: { fullName: "李山风", nickname: "山风", phone: null, documentNumber: null },
        correctedSnapshot: { fullName: "李山风（已核对）", nickname: "清风", phone: "13800000002", documentNumber: "DOC-2" },
        reason: { code: "DATA_ENTRY_CORRECTION", note: "人工核对住宿人资料后更正" },
        actor: { subjectId: demo.agentSubjectId, displayName: writePrincipal.displayName }
      })
    ]);
    expect(view.allowedActions.find((action) => action.code === "CORRECT_ORDER_OCCUPANT")).toEqual({
      code: "CORRECT_ORDER_OCCUPANT",
      enabled: true,
      disabledReason: null
    });
    expect((await getOrderView(db, fixture.orderId, "READ")).allowedActions).toEqual([]);

    const board = await getRoomStatusBoard(db, {
      propertyId: demo.propertyId,
      arrivalDate: "2033-05-01",
      departureDate: "2033-05-03",
      accessLevel: "WRITE",
      requestingSubjectId: demo.agentSubjectId
    });
    expect(board.rooms.find((room) => room.id === fixture.unitId)?.intervals[0]?.occupants)
      .toEqual(expect.arrayContaining([{ occupantId: fixture.occupantId, nickname: "清风" }]));
    const revisionAfter = await db.selectFrom("room_status_revisions").select("revision").where("property_id", "=", demo.propertyId).executeTakeFirstOrThrow();
    expect(BigInt(revisionAfter.revision)).toBeGreaterThan(BigInt(revisionBefore.revision));

    expect(await confirmCommandPreview(db, writePrincipal, prepared.preview.previewId, confirmation, confirmMetadata)).toEqual(receipt);
    expect(await db.selectFrom("order_occupant_corrections").select("id").where("occupant_id", "=", fixture.occupantId).execute()).toHaveLength(1);

    const app = await buildServer(db);
    await app.ready();
    try {
      const readDetail = await app.inject({
        method: "GET",
        url: `/api/v1/orders/${fixture.orderId}`,
        headers: { authorization: `Bearer ${demo.readToken}` }
      });
      expect(readDetail.statusCode, readDetail.body).toBe(200);
      expect(readDetail.json()).toMatchObject({
        accessLevel: "READ",
        allowedActions: [],
        occupants: [
          expect.objectContaining({ nickname: "小满" }),
          expect.objectContaining({ id: fixture.occupantId, nickname: "清风" })
        ],
        occupantCorrections: [expect.objectContaining({ id: receipt.result!.correctionId })]
      });
    } finally {
      await app.close();
    }
  });

  it("fails closed for missing reason, READ access, stale previews, no-op input, and direct mutation", async () => {
    const fixture = await createTwoPersonOrder();
    const noReason = await previewCorrection(fixture.orderId, fixture.occupantId, "青山");
    await expect(confirmCommandPreview(db, writePrincipal, noReason.preview.previewId, {
      propertyId: demo.propertyId,
      commandType: "CORRECT_ORDER_OCCUPANT",
      confirmation: true,
      expectedEffectHash: noReason.preview.effectHash,
      reason: { code: "", note: "" }
    }, metadata("missing-reason"))).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(createCommandPreview(db, readPrincipal, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: { propertyId: demo.propertyId, orderId: fixture.orderId, occupantId: fixture.occupantId, expectedPriorSnapshot: { fullName: "李山风", nickname: "山风", phone: null, documentNumber: null }, correctedSnapshot: { fullName: "李山风", nickname: "青山", phone: null, documentNumber: null } }
    }, metadata("read-denied"))).rejects.toMatchObject({ code: "INSUFFICIENT_ACCESS" });

    const stale = await previewCorrection(fixture.orderId, fixture.occupantId, "旧预览");
    await confirmCorrection(await previewCorrection(fixture.orderId, fixture.occupantId, "新资料"), "fresh");
    const staleResult = await confirmCorrection(stale, "stale");
    expect(staleResult.receipt).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE" },
      resourceRefs: [],
      factRefs: []
    });
    expect(await db.selectFrom("order_occupant_corrections").select("id").where("occupant_id", "=", fixture.occupantId).execute()).toHaveLength(1);

    await expect(createCommandPreview(db, writePrincipal, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        occupantId: fixture.occupantId,
        expectedPriorSnapshot: { fullName: "李山风", nickname: "山风", phone: null, documentNumber: null },
        correctedSnapshot: { fullName: "李山风", nickname: "旧表单", phone: null, documentNumber: null }
      }
    }, metadata("stale-form-before-preview"))).rejects.toMatchObject({ code: "AGGREGATE_VERSION_CONFLICT" });
    expect(await db.selectFrom("order_occupant_corrections").select("id").where("occupant_id", "=", fixture.occupantId).execute()).toHaveLength(1);

    const latest = (await getOrderView(db, fixture.orderId)).occupants[1]!;
    await expect(createCommandPreview(db, writePrincipal, {
      commandType: "CORRECT_ORDER_OCCUPANT",
      input: {
        propertyId: demo.propertyId,
        orderId: fixture.orderId,
        occupantId: fixture.occupantId,
        expectedPriorSnapshot: { fullName: latest.fullName, nickname: latest.nickname, phone: latest.phone, documentNumber: latest.documentNumber },
        correctedSnapshot: { fullName: latest.fullName!, nickname: latest.nickname!, phone: latest.phone, documentNumber: latest.documentNumber }
      }
    }, metadata("noop"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(db.updateTable("order_occupants").set({ nickname: "覆盖" }).where("id", "=", fixture.occupantId).execute())
      .rejects.toMatchObject({ code: "55000" });
    const correctionId = (await db.selectFrom("order_occupant_corrections").select("id").where("occupant_id", "=", fixture.occupantId).executeTakeFirstOrThrow()).id;
    await expect(db.updateTable("order_occupant_corrections").set({ corrected_nickname: "覆盖" }).where("id", "=", correctionId).execute())
      .rejects.toMatchObject({ code: "55000" });

    const current = (await getOrderView(db, fixture.orderId)).occupants[1]!;
    await expect(db.transaction().execute(async (trx) => {
      const commandId = "command_forged_occupant_correction";
      const amendmentId = "amend_forged_occupant_correction";
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: "RECORD_COLLECTION",
        idempotency_key: "forged-occupant-correction",
        request_hash: "f".repeat(64),
        correlation_id: "forged-occupant-correction",
        state: "EXECUTING",
        completed_at: null
      }).execute();
      const order = await trx.selectFrom("orders").select("version").where("id", "=", fixture.orderId).executeTakeFirstOrThrow();
      await trx.insertInto("amendments").values({
        id: amendmentId,
        order_id: fixture.orderId,
        sequence: order.version + 1,
        amendment_type: "CORRECT_ORDER_OCCUPANT",
        reason_code: "FORGED",
        reason_note: "Must be rejected by the database command guard",
        prior_version: order.version,
        new_version: order.version + 1,
        payload: {},
        command_id: commandId
      }).execute();
      await trx.insertInto("order_occupant_corrections").values({
        id: "fact_forged_occupant_correction",
        order_id: fixture.orderId,
        occupant_id: fixture.occupantId,
        sequence: 2,
        prior_full_name: current.fullName,
        prior_nickname: current.nickname,
        prior_phone: current.phone,
        prior_document_number: current.documentNumber,
        corrected_full_name: current.fullName!,
        corrected_nickname: "伪造",
        corrected_phone: current.phone,
        corrected_document_number: current.documentNumber,
        reason_code: "FORGED",
        reason_note: "Must be rejected by the database command guard",
        actor_subject_id: demo.agentSubjectId,
        amendment_id: amendmentId,
        created_by_command_id: commandId
      }).execute();
    })).rejects.toMatchObject({ constraint: "order_occupant_corrections_command_shape" });
    expect(await db.selectFrom("command_executions").select("id").where("id", "=", "command_forged_occupant_correction").executeTakeFirst()).toBeUndefined();
  });

  it("serializes concurrent corrections to one applied fact and one durable stale receipt", async () => {
    const fixture = await createTwoPersonOrder();
    const first = await previewCorrection(fixture.orderId, fixture.occupantId, "清风一");
    const second = await previewCorrection(fixture.orderId, fixture.occupantId, "清风二");

    const [firstResult, secondResult] = await Promise.all([
      confirmCorrection(first, "concurrent-first"),
      confirmCorrection(second, "concurrent-second")
    ]);
    const receipts = [firstResult.receipt, secondResult.receipt];
    expect(receipts.filter((receipt) => receipt.executionStatus === "EXECUTED")).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.error?.code === "PREVIEW_STALE")).toHaveLength(1);
    expect(await db.selectFrom("order_occupant_corrections")
      .select("id")
      .where("occupant_id", "=", fixture.occupantId)
      .execute()).toHaveLength(1);
    const view = await getOrderView(db, fixture.orderId);
    expect(["清风一", "清风二"]).toContain(view.occupants[1]!.nickname);
    expect(view.order.version).toBe(2);
  });
});
