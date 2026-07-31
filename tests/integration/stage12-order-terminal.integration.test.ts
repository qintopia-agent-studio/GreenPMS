import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  databaseReady,
  getOrderView,
  propertyLocalToday,
  withPropertyClockForTesting,
  type Database
} from "@qintopia/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase } from "../helpers/database.ts";

let db: Kysely<Database>;
let sequence = 0;
const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Stage 12 operator",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function execute(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "STAGE12_ACCEPTANCE", note: `Stage 12 ${envelope.commandType} acceptance reason` }
  }, metadata(`${prefix}-confirm`));
  if (!receipt.businessCommitted) {
    throw new Error(`${envelope.commandType} failed: ${JSON.stringify(receipt.error)}`);
  }
  return receipt;
}

async function createPaidOrder(unitId: string, arrivalDate: string, departureDate: string, prefix: string) {
  const quote = await createQuoteForTesting(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: unitId,
    stayType: "TRANSIENT",
    arrivalDate,
    departureDate,
    pricingPolicyVersionId: arrivalDate.slice(0, 7) === departureDate.slice(0, 7)
      ? demo.transientPolicyId
      : demo.publicPricingPolicyId
  });
  return execute({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Stage 12 ${prefix}`, nickname: prefix },
      bookingChannelCode: "WECOM",
      channelOrderReference: null,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  }, `${prefix}-create`);
}

async function forgeTerminalCombination(trx: Transaction<Database>, options: {
  orderId: string;
  commandId: string;
  commandType: "CANCEL_ORDER" | "MARK_NO_SHOW" | "REVOKE_CHECK_IN";
  executionState: "EXECUTING" | "APPLIED" | "REJECTED";
  executionPropertyId?: string;
  effect: Record<string, unknown>;
  createdAt?: Date;
}) {
  const order = await trx.selectFrom("orders").selectAll().where("id", "=", options.orderId).executeTakeFirstOrThrow();
  const stay = await trx.selectFrom("stays").selectAll().where("order_id", "=", options.orderId).executeTakeFirstOrThrow();
  const currentRevision = await trx.selectFrom("pricing_revisions").selectAll()
    .where("id", "=", order.current_revision_id!).executeTakeFirstOrThrow();
  const segmentIds = (await trx.selectFrom("stay_segments").select("id").where("stay_id", "=", stay.id).execute())
    .map((segment) => segment.id);
  const amendmentId = `${options.commandId}_amendment`;
  const revisionId = `${options.commandId}_revision`;
  const terminalStatus = options.commandType === "CANCEL_ORDER"
    ? "CANCELLED"
    : options.commandType === "MARK_NO_SHOW"
      ? "NO_SHOW"
      : "CHECK_IN_REVOKED";
  const terminalPricingBasis = order.stay_type === "FREE"
    ? "FREE"
    : order.member_id || order.member_contract_id
      ? "MEMBER_ENTITLEMENT"
      : order.booking_channel_code && order.booking_channel_code !== "WECOM"
        ? "CHANNEL_CONTRACT"
        : "POLICY";

  await trx.insertInto("command_executions").values({
    id: options.commandId,
    subject_id: principal.subjectId,
    credential_id: principal.credentialId,
    property_id: options.executionPropertyId ?? order.property_id,
    command_type: options.commandType,
    idempotency_key: options.commandId,
    request_hash: "f".repeat(64),
    correlation_id: options.commandId,
    state: options.executionState,
    completed_at: options.executionState === "EXECUTING" ? null : new Date()
  }).execute();
  await trx.insertInto("amendments").values({
    id: amendmentId,
    order_id: options.orderId,
    sequence: order.version + 1,
    amendment_type: options.commandType,
    reason_code: "DIRECT_STAGE12_GUARD_TEST",
    reason_note: "Direct Stage 12 guard test",
    prior_version: order.version,
    new_version: order.version + 1,
    payload: options.effect,
    command_id: options.commandId,
    ...(options.createdAt ? { created_at: options.createdAt } : {})
  }).execute();
  await trx.insertInto("pricing_revisions").values({
    id: revisionId,
    order_id: options.orderId,
    revision_no: currentRevision.revision_no + 1,
    amendment_id: amendmentId,
    policy_version_id: order.pricing_policy_version_id,
    arrival_date: order.arrival_date,
    departure_date: order.departure_date,
    coverage_set: JSON.stringify([]),
    cash_lines: JSON.stringify([]),
    policy_base_amount_minor: 0,
    pricing_basis: terminalPricingBasis,
    manual_adjustment_minor: 0,
    current_contract_amount_minor: 0,
    currency: currentRevision.currency
  }).execute();
  if (segmentIds.length > 0) {
    await trx.updateTable("inventory_claims").set({ active: false, released_at: new Date() })
      .where("source_type", "=", "ORDER_SEGMENT").where("source_id", "in", segmentIds).execute();
  }
  await trx.updateTable("orders").set({
    status: terminalStatus,
    current_revision_id: revisionId,
    version: order.version + 1
  }).where("id", "=", options.orderId).execute();
  await trx.updateTable("stays").set({ status: terminalStatus }).where("id", "=", stay.id).execute();
}

beforeEach(async () => {
  db = await resetTestDatabase();
});

afterEach(async () => {
  if (db) await db.destroy();
});

describe("Stage 12 cancellation, no-show, and check-in revocation", () => {
  it("rejects direct terminal status bypasses and terminal reopening with zero partial writes", async () => {
    expect(await databaseReady(db)).toBe(true);
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder(demo.roomId, addDays(businessDate, 1), addDays(businessDate, 3), "terminal-guard");
    const orderId = created.result!.orderId as string;
    await expect(db.transaction().execute(async (trx) => {
      await trx.updateTable("orders").set({ status: "CANCELLED" }).where("id", "=", orderId).execute();
      await trx.updateTable("stays").set({ status: "CANCELLED" }).where("order_id", "=", orderId).execute();
    })).rejects.toMatchObject({ constraint: "stage12_terminal_status_typed" });
    expect((await getOrderView(db, orderId)).order.status).toBe("RESERVED");

    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } }, "terminal-guard-cancel");
    await expect(db.updateTable("orders").set({ status: "RESERVED" }).where("id", "=", orderId).execute())
      .rejects.toThrow(/terminal order and stay status cannot be reopened/);
    expect((await getOrderView(db, orderId)).order.status).toBe("CANCELLED");
  });

  it.each(["EXECUTING", "REJECTED"] as const)(
    "rejects a complete direct terminal combination bound to a %s command",
    async (executionState) => {
      const businessDate = await propertyLocalToday(db, demo.propertyId);
      const created = await createPaidOrder(
        demo.roomId,
        addDays(businessDate, 1),
        addDays(businessDate, 3),
        `terminal-${executionState.toLowerCase()}`
      );
      const orderId = created.result!.orderId as string;
      const preview = await createCommandPreview(db, principal, {
        commandType: "CANCEL_ORDER",
        input: { propertyId: demo.propertyId, orderId }
      }, metadata(`terminal-${executionState.toLowerCase()}-preview`));
      const commandId = `command_stage12_terminal_${executionState.toLowerCase()}`;

      await expect(db.transaction().execute((trx) => forgeTerminalCombination(trx, {
        orderId,
        commandId,
        commandType: "CANCEL_ORDER",
        executionState,
        effect: preview.preview.effect as Record<string, unknown>
      }))).rejects.toMatchObject({ constraint: "stage12_terminal_execution_state" });
      expect((await getOrderView(db, orderId)).order.status).toBe("RESERVED");
      expect(await db.selectFrom("command_executions").select("id").where("id", "=", commandId).execute())
        .toHaveLength(0);
    }
  );

  it("rejects a complete terminal combination whose command belongs to another property", async () => {
    const otherPropertyId = "prop_stage12_cross_property";
    await db.insertInto("properties").values({
      id: otherPropertyId,
      code: "STAGE12-XPROP",
      name: "Stage 12 cross-property fixture",
      timezone: "Asia/Shanghai",
      currency: "CNY"
    }).execute();
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder(demo.roomId, addDays(businessDate, 1), addDays(businessDate, 3), "cross-property");
    const orderId = created.result!.orderId as string;
    const preview = await createCommandPreview(db, principal, {
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId }
    }, metadata("cross-property-preview"));
    const commandId = "command_stage12_cross_property";

    await expect(db.transaction().execute((trx) => forgeTerminalCombination(trx, {
      orderId,
      commandId,
      commandType: "CANCEL_ORDER",
      executionState: "APPLIED",
      executionPropertyId: otherPropertyId,
      effect: preview.preview.effect as Record<string, unknown>
    }))).rejects.toMatchObject({ constraint: "stage12_terminal_property_binding" });
    expect((await getOrderView(db, orderId)).order.status).toBe("RESERVED");
    expect(await db.selectFrom("command_executions").select("id").where("id", "=", commandId).execute())
      .toHaveLength(0);
  });

  it("uses the database property clock instead of forgeable amendment timestamps for terminal time gates", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const futureArrivalDate = addDays(businessDate, 1);
    const futureCreated = await createPaidOrder(
      demo.roomId,
      futureArrivalDate,
      addDays(futureArrivalDate, 2),
      "forged-no-show-time"
    );
    const futureOrderId = futureCreated.result!.orderId as string;
    const cancelPreview = await createCommandPreview(db, principal, {
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId: futureOrderId }
    }, metadata("forged-no-show-base-preview"));
    const forgedNoShowEffect = {
      ...(cancelPreview.preview.effect as Record<string, unknown>),
      toStatus: "NO_SHOW",
      businessDate: futureArrivalDate
    };
    await expect(db.transaction().execute((trx) => forgeTerminalCombination(trx, {
      orderId: futureOrderId,
      commandId: "command_stage12_forged_no_show_time",
      commandType: "MARK_NO_SHOW",
      executionState: "APPLIED",
      effect: forgedNoShowEffect,
      createdAt: new Date("2099-01-01T12:00:00.000Z")
    }))).rejects.toMatchObject({ constraint: "stage12_no_show_local_threshold" });
    expect((await getOrderView(db, futureOrderId)).order.status).toBe("RESERVED");

    const pastArrivalDate = addDays(businessDate, -1);
    const inHouseCreated = await createPaidOrder(
      demo.secondRoomId,
      pastArrivalDate,
      addDays(businessDate, 2),
      "forged-revoke-time"
    );
    const inHouseOrderId = inHouseCreated.result!.orderId as string;
    await execute({
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: inHouseOrderId }
    }, "forged-revoke-time-check-in");
    const forgedRevokeEffect = {
      orderId: inHouseOrderId,
      fromStatus: "CHECKED_IN",
      toStatus: "CHECK_IN_REVOKED",
      inventoryUnitId: demo.secondRoomId,
      businessDate: pastArrivalDate,
      effectiveDate: pastArrivalDate,
      recordingMode: "ON_SCHEDULE",
      unusedRoomConfirmed: true,
      currentContractAmount: { currency: "CNY", minorUnits: 0 },
      amounts: {
        netRecordedCollection: { currency: "CNY", minorUnits: 0 },
        refundReferenceAmount: { currency: "CNY", minorUnits: 0 }
      },
      pricingRevision: {
        currentContractAmount: { currency: "CNY", minorUnits: 0 },
        pricingBasis: "POLICY"
      },
      entitlementTransition: { from: "CONSUMED", to: "RESTORED", coverageCount: 0 }
    };
    await expect(db.transaction().execute((trx) => forgeTerminalCombination(trx, {
      orderId: inHouseOrderId,
      commandId: "command_stage12_forged_revoke_time",
      commandType: "REVOKE_CHECK_IN",
      executionState: "APPLIED",
      effect: forgedRevokeEffect,
      createdAt: new Date(`${pastArrivalDate}T12:00:00.000Z`)
    }))).rejects.toMatchObject({ constraint: "stage12_revoke_same_day_unused" });
    expect((await getOrderView(db, inHouseOrderId)).order.status).toBe("CHECKED_IN");
  });

  it("rolls back when a terminal amendment differs from the confirmed Preview", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder(demo.roomId, addDays(businessDate, 1), addDays(businessDate, 3), "tampered-preview");
    const orderId = created.result!.orderId as string;
    const prepared = await createCommandPreview(db, principal, {
      commandType: "CANCEL_ORDER",
      input: { propertyId: demo.propertyId, orderId }
    }, metadata("tampered-preview"));
    const before = await getOrderView(db, orderId);
    await sql.raw(`
      CREATE OR REPLACE FUNCTION qintopia_test_tamper_stage12_terminal_effect() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.amendment_type = 'CANCEL_ORDER' THEN
          NEW.payload := jsonb_set(NEW.payload, '{businessDate}', to_jsonb('2099-01-01'::text), false);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER qintopia_test_tamper_stage12_terminal_effect
        BEFORE INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_tamper_stage12_terminal_effect()
    `).execute(db);
    try {
      const receipt = await confirmCommandPreview(db, principal, prepared.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "CANCEL_ORDER",
        confirmation: true,
        expectedEffectHash: prepared.preview.effectHash,
        reason: { code: "STAGE12_TAMPER_TEST", note: "Verify terminal Preview binding" }
      }, metadata("tampered-preview-confirm"));
      expect(receipt).toMatchObject({ executionStatus: "NOT_EXECUTED", businessCommitted: false });
      const after = await getOrderView(db, orderId);
      expect(after.order.status).toBe("RESERVED");
      expect(after.amendments).toEqual(before.amendments);
      expect(after.pricingRevisions).toEqual(before.pricingRevisions);
    } finally {
      await sql.raw(`
        DROP TRIGGER IF EXISTS qintopia_test_tamper_stage12_terminal_effect ON amendments;
        DROP FUNCTION IF EXISTS qintopia_test_tamper_stage12_terminal_effect()
      `).execute(db);
    }
  });

  it("rejects no-show before local 20:00 without a command preview, then allows Preview at the threshold", async () => {
    const arrivalDate = "2026-08-05";
    const departureDate = "2026-08-07";
    const created = await createPaidOrder(demo.roomId, arrivalDate, departureDate, "no-show-threshold");
    const orderId = created.result!.orderId as string;
    const previewCount = async () => Number((await db.selectFrom("command_previews")
      .select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()).count);
    const before = await previewCount();
    await expect(withPropertyClockForTesting(new Date("2026-08-05T11:59:00.000Z"), () => createCommandPreview(
      db,
      principal,
      { commandType: "MARK_NO_SHOW", input: { propertyId: demo.propertyId, orderId } },
      metadata("no-show-before-threshold")
    ))).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
    expect(await previewCount()).toBe(before);

    const allowed = await withPropertyClockForTesting(new Date("2026-08-05T12:00:00.000Z"), () => createCommandPreview(
      db,
      principal,
      { commandType: "MARK_NO_SHOW", input: { propertyId: demo.propertyId, orderId } },
      metadata("no-show-at-threshold")
    ));
    expect(allowed.preview.effect).toMatchObject({ businessDate: arrivalDate, toStatus: "NO_SHOW" });
  });

  it("cancels with a zero current revision and a full-refund reference without writing a refund fact", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder(demo.roomId, addDays(businessDate, 1), addDays(businessDate, 3), "cancel");
    const orderId = created.result!.orderId as string;
    const original = await getOrderView(db, orderId);
    const collectedMinor = Math.min(10_000, original.amounts.currentContractAmount.minorUnits);
    await execute({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: collectedMinor,
        method: "CASH",
        transactionReference: "STAGE12-CANCEL-COLLECTION"
      }
    }, "cancel-collection");

    await execute({ commandType: "CANCEL_ORDER", input: { propertyId: demo.propertyId, orderId } }, "cancel");
    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe("CANCELLED");
    expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
    expect(view.amounts.refundReferenceAmount.minorUnits).toBe(collectedMinor);
    expect(view.pricingRevisions.at(-1)).toMatchObject({
      current_contract_amount_minor: 0,
      policy_base_amount_minor: 0,
      coverage_set: [],
      cash_lines: []
    });
    expect(view.collectionFacts.filter((fact) => fact.fact_type === "REFUND")).toHaveLength(0);
    expect(view.coverageSet.every((coverage) => coverage.status === "RELEASED")).toBe(true);
    expect(await db.selectFrom("inventory_claims").select("id").where("active", "=", true).execute()).toHaveLength(0);
  });

  it("marks an overdue reserved order no-show as a zero terminal order", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const created = await createPaidOrder(demo.secondRoomId, addDays(businessDate, -1), addDays(businessDate, 2), "no-show");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "MARK_NO_SHOW", input: { propertyId: demo.propertyId, orderId } }, "no-show");
    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe("NO_SHOW");
    expect(view.fulfillment.state).toBe("NO_SHOW");
    expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
    expect(view.pricingRevisions.at(-1)?.current_contract_amount_minor).toBe(0);
    expect(view.allowedActions.every((action) => !action.enabled || action.code === "CORRECT_ORDER_OCCUPANT")).toBe(true);
    const amendmentCount = view.amendments.length;
    await expect(createCommandPreview(db, principal, {
      commandType: "RESCHEDULE_STAY",
      input: {
        propertyId: demo.propertyId,
        orderId,
        newArrivalDate: businessDate,
        newDepartureDate: addDays(businessDate, 2)
      }
    }, metadata("no-show-terminal-reschedule"))).rejects.toMatchObject({ code: "INVALID_ORDER_STATE" });
    expect((await getOrderView(db, orderId)).amendments).toHaveLength(amendmentCount);
  });

  it("keeps an overdue reserved order eligible for a typed late-recorded check-in", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const arrivalDate = addDays(businessDate, -1);
    const created = await createPaidOrder(demo.roomId, arrivalDate, addDays(businessDate, 2), "late-check-in");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "late-check-in");
    const view = await getOrderView(db, orderId);
    expect(view.order.status).toBe("CHECKED_IN");
    expect(view.fulfillment.checkIn).toMatchObject({
      plannedBusinessDate: arrivalDate,
      recordedBusinessDate: businessDate,
      recordingMode: "LATE_RECORDED"
    });
  });

  it("revokes same-day member check-in with one immutable restoration per consumed coverage", async () => {
    const businessDate = await propertyLocalToday(db, demo.propertyId);
    const departureDate = addDays(businessDate, 2);
    const quote = await createQuoteForTesting(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: "unit_room_d_gen_01",
      stayType: "TRANSIENT",
      arrivalDate: businessDate,
      departureDate,
      pricingPolicyVersionId: businessDate.slice(0, 7) === departureDate.slice(0, 7)
        ? demo.transientPolicyId
        : demo.publicPricingPolicyId,
      memberContractId: demo.memberContractId
    });
    const created = await execute({
      commandType: "CREATE_ORDER",
      input: {
        propertyId: demo.propertyId,
        quoteId: quote.quoteId,
        primaryGuest: { fullName: "Stage 12 member", nickname: "撤销入住会员" }
      }
    }, "revoke-create");
    const orderId = created.result!.orderId as string;
    await execute({ commandType: "CHECK_IN", input: { propertyId: demo.propertyId, orderId } }, "revoke-check-in");

    const consumedBefore = await db.selectFrom("coverage_items").select("id")
      .where("order_id", "=", orderId).where("status", "=", "CONSUMED").execute();
    expect(consumedBefore).toHaveLength(2);
    const factsBeforeInvalid = await db.selectFrom("entitlement_ledger").select("fact_id")
      .where("order_id", "=", orderId).execute();
    await expect(createCommandPreview(db, principal, {
      commandType: "REVOKE_CHECK_IN",
      input: { propertyId: demo.propertyId, orderId, unusedRoomConfirmed: false }
    }, metadata("revoke-without-confirmation"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await db.selectFrom("entitlement_ledger").select("fact_id").where("order_id", "=", orderId).execute())
      .toHaveLength(factsBeforeInvalid.length);
    await execute({
      commandType: "REVOKE_CHECK_IN",
      input: { propertyId: demo.propertyId, orderId, unusedRoomConfirmed: true }
    }, "revoke");

    const view = await getOrderView(db, orderId);
    const restores = await db.selectFrom("entitlement_ledger").selectAll()
      .where("order_id", "=", orderId).where("entry_type", "=", "RESTORE").execute();
    expect(view.order.status).toBe("CHECK_IN_REVOKED");
    expect(view.fulfillment.checkIn).not.toBeNull();
    expect(view.fulfillment.checkInRevocation).not.toBeNull();
    expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
    expect(view.coverageSet.every((coverage) => coverage.status === "CONSUMED")).toBe(true);
    expect(restores).toHaveLength(consumedBefore.length);
    expect(new Set(restores.map((fact) => fact.coverage_id)).size).toBe(consumedBefore.length);
    expect(restores.every((fact) => fact.quantity_delta === 1)).toBe(true);
    expect(view.collectionFacts.filter((fact) => fact.fact_type === "REFUND")).toHaveLength(0);
    expect(await db.selectFrom("inventory_claims").select("id").where("active", "=", true).execute()).toHaveLength(0);
  });
});
