import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  buildCommandEffect,
  confirmCommandPreview,
  createCommandPreview,
  databaseReady,
  reconcileCoverage,
  type Database
} from "@qintopia/db";
import { newId, sha256 } from "@qintopia/domain";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.INVARIANTS_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_database_invariants";

const principal: AuthPrincipal = {
  subjectId: demo.agentSubjectId,
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Demo Agent",
  propertyAccess: new Map([[demo.propertyId, "WRITE"]])
};

let db: Kysely<Database>;
let sequence = 0;

function metadata(prefix: string) {
  sequence += 1;
  return { idempotencyKey: `${prefix}-${sequence}`, correlationId: `${prefix}-${sequence}` };
}

async function previewAndConfirm(envelope: CommandEnvelope, prefix: string): Promise<ReceiptDto> {
  const preview = await createCommandPreview(db, principal, envelope, metadata(`${prefix}-preview`));
  return confirmCommandPreview(db, principal, preview.preview.previewId, {
    propertyId: envelope.input.propertyId as string,
    commandType: envelope.commandType,
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: envelope.commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "DATABASE_INVARIANT", note: `Database invariant acceptance for ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createOrder(prefix: string, options: { member?: boolean; arrival?: string; departure?: string } = {}): Promise<string> {
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: options.member ? "unit_room_d_gen_01" : demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate: options.arrival ?? "2028-01-01",
    departureDate: options.departure ?? "2028-01-02",
    pricingPolicyVersionId: demo.transientPolicyId,
    ...(options.member ? { memberId: demo.memberId } : {})
  });
  const receipt = await previewAndConfirm({
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Invariant Guest ${prefix}`, nickname: `Invariant ${prefix}` },
      ...(!options.member ? {
        bookingChannelCode: "YOUMUDAO",
        channelOrderReference: `TEST-INVARIANT-ORDER-${prefix}`,
        targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
      } : {})
    }
  }, prefix);
  return receipt.result!.orderId as string;
}

async function insertLot(suffix: string, totalUnits: number): Promise<{ memberId: string; contractId: string; lotId: string }> {
  const memberId = `member_profile_invariant_${suffix}`;
  const contractId = `member_invariant_${suffix}`;
  const lotId = `lot_invariant_${suffix}`;
  await db.insertInto("members").values({
    id: memberId,
    identity_card_number: `TEST-INVARIANT-ID-${suffix}`.toUpperCase(),
    full_name: `Invariant member ${suffix}`,
    phone: `TEST-PHONE-${suffix}`,
    wechat: `test-wechat-${suffix}`
  }).execute();
  await db.insertInto("member_contracts").values({
    id: contractId,
    property_id: demo.propertyId,
    member_id: memberId,
    member_name: `Invariant member ${suffix}`,
    status: "ACTIVE",
    valid_from: "2026-01-01",
    valid_until: "2035-12-31",
    version: 1
  }).execute();
  await db.insertInto("entitlement_lots").values({
    id: lotId,
    contract_id: contractId,
    unit_kind: "ROOM_NIGHT",
    total_units: totalUnits,
    expires_on: "2035-12-31",
    version: 1
  }).execute();
  return { memberId, contractId, lotId };
}

async function insertToken(options: {
  id: string;
  subjectId?: string;
  propertyId?: string;
  rotatedFromId?: string | null;
  revokedAt?: Date | null;
  replacedById?: string | null;
}) {
  await db.insertInto("api_tokens").values({
    id: options.id,
    subject_id: options.subjectId ?? demo.agentSubjectId,
    label: options.id,
    secret_hash: sha256(`secret:${options.id}`),
    access_ceiling: "READ",
    property_scope: options.propertyId ?? demo.propertyId,
    expires_at: "2031-01-01T00:00:00.000Z",
    revoked_at: options.revokedAt ?? null,
    rotated_from_id: options.rotatedFromId ?? null,
    replaced_by_id: options.replacedById ?? null
  }).execute();
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
  await db.insertInto("properties").values({
    id: "prop_invariant_other",
    code: "INV-OTHER",
    name: "Invariant Other Property",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await db.insertInto("inventory_units").values({
    id: "unit_invariant_other_room",
    property_id: "prop_invariant_other",
    kind: "ROOM",
    parent_room_id: null,
    code: "OTHER-1",
    name: "Other room",
    active: true
  }).execute();
});

afterAll(async () => {
  if (db) await db.destroy();
});

describe.sequential("database-owned invariants on PostgreSQL", () => {
  it("requires every BED parent to be a same-property ROOM and freezes inventory identity", async () => {
    await expect(db.insertInto("inventory_units").values({
      id: "unit_invalid_cross_property_bed",
      property_id: demo.propertyId,
      kind: "BED",
      parent_room_id: "unit_invariant_other_room",
      code: "CROSS-BED",
      name: "Invalid cross-property bed",
      active: true
    }).execute()).rejects.toMatchObject({ constraint: "inventory_units_bed_parent_room_same_property" });

    await expect(db.insertInto("inventory_units").values({
      id: "unit_invalid_bed_parent_bed",
      property_id: demo.propertyId,
      kind: "BED",
      parent_room_id: demo.bedAId,
      code: "BED-PARENT",
      name: "Invalid bed parent",
      active: true
    }).execute()).rejects.toMatchObject({ constraint: "inventory_units_bed_parent_room_same_property" });

    await expect(db.updateTable("inventory_units").set({ parent_room_id: demo.secondRoomId })
      .where("id", "=", demo.bedAId).execute()).rejects.toThrow(/inventory unit .*catalog identity.*pricing product are immutable/);
    await expect(db.updateTable("inventory_units").set({ property_id: "prop_invariant_other" })
      .where("id", "=", demo.roomId).execute()).rejects.toThrow(/inventory unit .*catalog identity.*pricing product are immutable/);
    await expect(db.deleteFrom("inventory_units").where("id", "=", demo.secondRoomId).execute())
      .rejects.toThrow(/identity is immutable/);

    await db.updateTable("inventory_units").set({ name: "Room 101 renamed", active: false })
      .where("id", "=", demo.roomId).execute();
    expect(await db.selectFrom("inventory_units").select(["name", "active"]).where("id", "=", demo.roomId).executeTakeFirstOrThrow())
      .toEqual({ name: "Room 101 renamed", active: false });
    await db.updateTable("inventory_units").set({ name: "Room 101", active: true }).where("id", "=", demo.roomId).execute();
  });

  it("freezes coverage identity and permits only HELD to terminal transitions", async () => {
    const orderId = await createOrder("coverage-state", { member: true, arrival: "2028-02-01", departure: "2028-02-03" });
    const coverage = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).orderBy("service_date").execute();
    expect(coverage).toHaveLength(2);

    await expect(db.updateTable("coverage_items").set({ inventory_unit_id: demo.secondRoomId })
      .where("id", "=", coverage[0]!.id).execute()).rejects.toThrow(/coverage identity is immutable/);
    await expect(db.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() })
      .where("id", "=", coverage[0]!.id).execute())
      .rejects.toMatchObject({ constraint: "coverage_items_lifecycle_conserved" });
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("coverage_items").set({ status: "CONSUMED", updated_at: new Date() })
        .where("id", "=", coverage[0]!.id).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: newId("fact"),
        lot_id: coverage[0]!.lot_id,
        entry_type: "CONSUME",
        quantity_delta: 0,
        service_date: coverage[0]!.service_date,
        order_id: orderId,
        coverage_id: coverage[0]!.id,
        reason: "TEST_DIRECT_CONSUME_BALANCE",
        command_id: null
      }).execute();
    });
    await expect(db.updateTable("coverage_items").set({ status: "RELEASED", updated_at: new Date() })
      .where("id", "=", coverage[0]!.id).execute()).rejects.toThrow(/status may only advance/);
    await expect(db.updateTable("coverage_items").set({ status: "RELEASED", updated_at: new Date() })
      .where("id", "=", coverage[1]!.id).execute())
      .rejects.toMatchObject({ constraint: "coverage_items_lifecycle_conserved" });
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("coverage_items").set({ status: "RELEASED", updated_at: new Date() })
        .where("id", "=", coverage[1]!.id).execute();
      await trx.insertInto("entitlement_ledger").values({
        fact_id: newId("fact"),
        lot_id: coverage[1]!.lot_id,
        entry_type: "RELEASE",
        quantity_delta: 1,
        service_date: coverage[1]!.service_date,
        order_id: orderId,
        coverage_id: coverage[1]!.id,
        reason: "TEST_DIRECT_RELEASE_BALANCE",
        command_id: null
      }).execute();
    });
    await expect(db.updateTable("coverage_items").set({ status: "HELD", updated_at: new Date() })
      .where("id", "=", coverage[1]!.id).execute()).rejects.toThrow(/status may only advance/);

    await expect(db.insertInto("coverage_items").values({
      id: "coverage_invalid_initial_state",
      order_id: orderId,
      contract_id: demo.memberContractId,
      lot_id: demo.roomLotId,
      inventory_unit_id: demo.roomId,
      service_date: "2028-02-04",
      unit_kind: "ROOM_NIGHT",
      status: "RELEASED",
      held_by_revision_id: coverage[0]!.held_by_revision_id
    }).execute()).rejects.toThrow(/created in HELD status/);

    await expect(db.insertInto("entitlement_ledger").values({
      fact_id: newId("fact"),
      lot_id: coverage[0]!.lot_id,
      entry_type: "HOLD",
      quantity_delta: -1,
      service_date: coverage[0]!.service_date,
      order_id: orderId,
      coverage_id: coverage[0]!.id,
      reason: "TEST_DUPLICATE_HOLD",
      command_id: null
    }).execute()).rejects.toMatchObject({ constraint: "entitlement_ledger_lifecycle_status" });
    await expect(db.insertInto("entitlement_ledger").values({
      fact_id: newId("fact"),
      lot_id: coverage[1]!.lot_id,
      entry_type: "RELEASE",
      quantity_delta: 1,
      service_date: coverage[1]!.service_date,
      order_id: orderId,
      coverage_id: coverage[1]!.id,
      reason: "TEST_DUPLICATE_RELEASE",
      command_id: null
    }).execute()).rejects.toMatchObject({ constraint: "entitlement_ledger_one_terminal_per_coverage_idx" });
    await expect(db.insertInto("entitlement_ledger").values({
      fact_id: newId("fact"),
      lot_id: coverage[1]!.lot_id,
      entry_type: "CONSUME",
      quantity_delta: 0,
      service_date: coverage[1]!.service_date,
      order_id: orderId,
      coverage_id: coverage[1]!.id,
      reason: "TEST_RELEASE_THEN_CONSUME",
      command_id: null
    }).execute()).rejects.toMatchObject({ constraint: "entitlement_ledger_lifecycle_status" });

    await expect(db.insertInto("coverage_items").values({
      id: "coverage_invalid_membership_product",
      order_id: orderId,
      contract_id: demo.memberContractId,
      lot_id: demo.roomLotId,
      inventory_unit_id: demo.roomId,
      service_date: coverage[1]!.service_date,
      unit_kind: "ROOM_NIGHT",
      status: "HELD",
      held_by_revision_id: coverage[1]!.held_by_revision_id
    }).execute()).rejects.toMatchObject({ constraint: "coverage_items_membership_product_match" });

    const otherOrderId = await createOrder("coverage-revision-owner", { arrival: "2028-02-05", departure: "2028-02-06" });
    const otherRevisionId = (await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", otherOrderId).executeTakeFirstOrThrow()).current_revision_id!;
    await expect(db.insertInto("coverage_items").values({
      id: "coverage_invalid_holding_revision",
      order_id: orderId,
      contract_id: demo.memberContractId,
      lot_id: demo.roomLotId,
      inventory_unit_id: "unit_room_d_gen_01",
      service_date: coverage[1]!.service_date,
      unit_kind: "ROOM_NIGHT",
      status: "HELD",
      held_by_revision_id: otherRevisionId
    }).execute()).rejects.toMatchObject({ constraint: "coverage_items_revision_match" });
  });

  it("requires member identity to belong to the quote property", async () => {
    await expect(db.insertInto("quotes").values({
      id: "quote_cross_property_member_identity",
      property_id: "prop_invariant_other",
      inventory_unit_id: "unit_invariant_other_room",
      stay_type: "TRANSIENT",
      arrival_date: "2028-03-01",
      departure_date: "2028-03-02",
      policy_version_id: demo.transientPolicyId,
      member_id: demo.memberId,
      member_contract_id: null,
      requester_subject_id: null,
      input_hash: "f".repeat(64),
      coverage_set: [],
      cash_lines: [],
      cash_remainder_minor: 0,
      current_contract_amount_minor: 0,
      currency: "CNY",
      expires_at: new Date("2028-03-01T00:15:00.000Z")
    }).execute()).rejects.toMatchObject({ constraint: "quotes_member_property_fk" });
  });

  it("keeps each order current revision scoped to that order while allowing a valid new revision", async () => {
    const firstOrderId = await createOrder("revision-owner-first", { arrival: "2028-07-01", departure: "2028-07-02" });
    const secondOrderId = await createOrder("revision-owner-second", { arrival: "2028-07-03", departure: "2028-07-04" });
    const firstRevisionId = (await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", firstOrderId).executeTakeFirstOrThrow()).current_revision_id!;
    const secondRevisionId = (await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", secondOrderId).executeTakeFirstOrThrow()).current_revision_id!;

    await expect(db.updateTable("orders").set({ current_revision_id: "revision_missing_owner_probe" })
      .where("id", "=", firstOrderId).execute())
      .rejects.toMatchObject({ constraint: "orders_current_revision_required" });
    await expect(db.updateTable("orders").set({ current_revision_id: secondRevisionId })
      .where("id", "=", firstOrderId).execute())
      .rejects.toMatchObject({ constraint: "orders_current_revision_same_order" });
    expect((await db.selectFrom("orders").select("current_revision_id")
      .where("id", "=", firstOrderId).executeTakeFirstOrThrow()).current_revision_id).toBe(firstRevisionId);

    const repriced = await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: { propertyId: demo.propertyId, orderId: firstOrderId, targetCurrentContractAmountMinor: 11_500 }
    }, "revision-owner-valid");
    const current = await db.selectFrom("orders as booking")
      .innerJoin("pricing_revisions as revision", "revision.id", "booking.current_revision_id")
      .select(["booking.id as order_id", "revision.id as revision_id", "revision.order_id as revision_order_id"])
      .where("booking.id", "=", firstOrderId)
      .executeTakeFirstOrThrow();
    expect(current).toEqual({
      order_id: firstOrderId,
      revision_id: repriced.result!.pricingRevisionId,
      revision_order_id: firstOrderId
    });
  });

  it("freezes member and property ownership of a member contract after creation", async () => {
    const first = await insertLot("contract-owner-first", 1);
    const second = await insertLot("contract-owner-second", 1);

    await expect(db.updateTable("member_contracts").set({ member_id: second.memberId })
      .where("id", "=", first.contractId).execute())
      .rejects.toMatchObject({ constraint: "member_contracts_owner_immutable" });
    await expect(db.updateTable("member_contracts").set({ property_id: "prop_invariant_other" })
      .where("id", "=", first.contractId).execute())
      .rejects.toMatchObject({ constraint: "member_contracts_owner_immutable" });

    await db.updateTable("member_contracts").set({ status: "EXPIRED", version: 2 })
      .where("id", "=", first.contractId).execute();
    expect(await db.selectFrom("member_contracts").select(["member_id", "property_id", "status", "version"])
      .where("id", "=", first.contractId).executeTakeFirstOrThrow()).toEqual({
      member_id: first.memberId,
      property_id: demo.propertyId,
      status: "EXPIRED",
      version: 2
    });
  });

  it("requires reciprocal, same-owner Token rotation links and blocks the same-update bypass", async () => {
    await insertToken({ id: "token_invariant_bypass_source" });
    await insertToken({ id: "token_invariant_bypass_target" });
    await expect(db.updateTable("api_tokens").set({
      revoked_at: new Date(),
      replaced_by_id: "token_invariant_bypass_target"
    }).where("id", "=", "token_invariant_bypass_source").execute())
      .rejects.toMatchObject({ constraint: "api_tokens_rotation_chain_consistent" });
    expect(await db.selectFrom("api_tokens").select(["revoked_at", "replaced_by_id"])
      .where("id", "=", "token_invariant_bypass_source").executeTakeFirstOrThrow())
      .toEqual({ revoked_at: null, replaced_by_id: null });

    await insertToken({ id: "token_invariant_cross_property_source" });
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("api_tokens").values({
        id: "token_invariant_cross_property_target",
        subject_id: demo.agentSubjectId,
        label: "Cross property target",
        secret_hash: sha256("cross-property-target"),
        access_ceiling: "READ",
        property_scope: "prop_invariant_other",
        expires_at: "2031-01-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: "token_invariant_cross_property_source",
        replaced_by_id: null
      }).execute();
      await trx.updateTable("api_tokens").set({
        revoked_at: new Date(),
        replaced_by_id: "token_invariant_cross_property_target"
      }).where("id", "=", "token_invariant_cross_property_source").execute();
    })).rejects.toMatchObject({ constraint: "api_tokens_rotation_chain_consistent" });

    await insertToken({ id: "token_invariant_cross_subject_source" });
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("api_tokens").values({
        id: "token_invariant_cross_subject_target",
        subject_id: demo.operatorSubjectId,
        label: "Cross subject target",
        secret_hash: sha256("cross-subject-target"),
        access_ceiling: "READ",
        property_scope: demo.propertyId,
        expires_at: "2031-01-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: "token_invariant_cross_subject_source",
        replaced_by_id: null
      }).execute();
      await trx.updateTable("api_tokens").set({
        revoked_at: new Date(),
        replaced_by_id: "token_invariant_cross_subject_target"
      }).where("id", "=", "token_invariant_cross_subject_source").execute();
    })).rejects.toMatchObject({ constraint: "api_tokens_rotation_chain_consistent" });

    await insertToken({ id: "token_invariant_valid_source" });
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("api_tokens").values({
        id: "token_invariant_valid_target",
        subject_id: demo.agentSubjectId,
        label: "Valid target",
        secret_hash: sha256("valid-target"),
        access_ceiling: "READ",
        property_scope: demo.propertyId,
        expires_at: "2031-01-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: "token_invariant_valid_source",
        replaced_by_id: null
      }).execute();
      await trx.updateTable("api_tokens").set({
        revoked_at: new Date(),
        replaced_by_id: "token_invariant_valid_target"
      }).where("id", "=", "token_invariant_valid_source").execute();
    });
    expect(await db.selectFrom("api_tokens").select("rotated_from_id")
      .where("id", "=", "token_invariant_valid_target").executeTakeFirstOrThrow())
      .toEqual({ rotated_from_id: "token_invariant_valid_source" });

    await insertToken({ id: "token_invariant_self" });
    await expect(db.updateTable("api_tokens").set({ revoked_at: new Date(), replaced_by_id: "token_invariant_self" })
      .where("id", "=", "token_invariant_self").execute())
      .rejects.toMatchObject({ constraint: "api_tokens_rotation_not_self" });
  });

  it("bounds ADJUST balances with bigint-safe sums and serializes concurrent confirmations", async () => {
    const negative = await insertLot("negative", 1);
    await expect(createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: negative.lotId,
        quantityDelta: -2,
        adjustmentReason: "Would make the lot negative"
      }
    }, metadata("adjust-negative"))).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT", statusCode: 409 });

    const overflow = await insertLot("overflow", 1);
    await expect(createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: overflow.lotId,
        quantityDelta: 2_147_483_647,
        adjustmentReason: "Would exceed PostgreSQL integer maximum"
      }
    }, metadata("adjust-overflow"))).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT", statusCode: 409 });

    const rawOverflow = await insertLot("raw-overflow", 0);
    await db.insertInto("entitlement_ledger").values([
      {
        fact_id: newId("fact"), lot_id: rawOverflow.lotId, entry_type: "ADJUST", quantity_delta: 2_147_483_647,
        service_date: null, order_id: null, coverage_id: null, reason: "RAW_OVERFLOW_1", command_id: null
      },
      {
        fact_id: newId("fact"), lot_id: rawOverflow.lotId, entry_type: "ADJUST", quantity_delta: 2_147_483_647,
        service_date: null, order_id: null, coverage_id: null, reason: "RAW_OVERFLOW_2", command_id: null
      }
    ]).execute();
    await expect(createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-03-01",
      departureDate: "2028-03-02",
      pricingPolicyVersionId: demo.transientPolicyId,
      memberContractId: rawOverflow.contractId
    })).rejects.toMatchObject({ code: "ENTITLEMENT_CONFLICT", statusCode: 409 });

    const concurrent = await insertLot("concurrent", 0);
    const largePreview = await createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: concurrent.lotId,
        quantityDelta: 2_147_483_647,
        adjustmentReason: "Concurrent maximum"
      }
    }, metadata("adjust-concurrent-large-preview"));
    const smallPreview = await createCommandPreview(db, principal, {
      commandType: "ADJUST_MEMBER_ENTITLEMENT",
      input: {
        propertyId: demo.propertyId,
        entitlementLotId: concurrent.lotId,
        quantityDelta: 1,
        adjustmentReason: "Concurrent one"
      }
    }, metadata("adjust-concurrent-small-preview"));
    const [large, small] = await Promise.all([
      confirmCommandPreview(db, principal, largePreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "ADJUST_MEMBER_ENTITLEMENT",
        confirmation: true,
        expectedEffectHash: largePreview.preview.effectHash,
        reason: { code: "CONCURRENT_ADJUST", note: "Concurrent maximum adjustment" }
      }, metadata("adjust-concurrent-large-confirm")),
      confirmCommandPreview(db, principal, smallPreview.preview.previewId, {
        propertyId: demo.propertyId,
        commandType: "ADJUST_MEMBER_ENTITLEMENT",
        confirmation: true,
        expectedEffectHash: smallPreview.preview.effectHash,
        reason: { code: "CONCURRENT_ADJUST", note: "Concurrent small adjustment" }
      }, metadata("adjust-concurrent-small-confirm"))
    ]);
    expect([large, small].filter((receipt) => receipt.businessCommitted)).toHaveLength(1);
    expect([large, small].filter((receipt) => !receipt.businessCommitted)).toHaveLength(1);
    expect([large, small].find((receipt) => !receipt.businessCommitted)?.error?.code).toBe("PREVIEW_STALE");
    const final = await db.selectFrom("entitlement_ledger")
      .select(sql<string>`cast(coalesce(sum(quantity_delta), 0) as text)`.as("balance"))
      .where("lot_id", "=", concurrent.lotId)
      .executeTakeFirstOrThrow();
    expect(["1", "2147483647"]).toContain(final.balance);
  });

  it("uses a per-subject quote cap under concurrency without deleting permanent expired Quote references", async () => {
    const activeRows = Array.from({ length: 199 }, (_, index) => ({
      id: `quote_quota_active_${index}`,
      property_id: demo.propertyId,
      inventory_unit_id: demo.roomId,
      stay_type: "TRANSIENT",
      arrival_date: "2028-04-01",
      departure_date: "2028-04-02",
      policy_version_id: demo.transientPolicyId,
      member_contract_id: null,
      requester_subject_id: demo.operatorSubjectId,
      input_hash: "a".repeat(64),
      coverage_set: [],
      cash_lines: [],
      cash_remainder_minor: 12_000,
      current_contract_amount_minor: 12_000,
      currency: "CNY",
      expires_at: "2030-01-01T00:00:00.000Z"
    }));
    await db.insertInto("quotes").values(activeRows).execute();
    await db.insertInto("quotes").values({
      ...activeRows[0]!,
      id: "quote_quota_old_unreferenced",
      expires_at: new Date(Date.now() - 25 * 60 * 60 * 1000)
    }).execute();

    const request = {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT" as const,
      arrivalDate: "2028-04-03",
      departureDate: "2028-04-04",
      pricingPolicyVersionId: demo.transientPolicyId,
      requesterSubjectId: demo.operatorSubjectId
    };
    const results = await Promise.allSettled([createQuote(db, request), createQuote(db, request)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });
    expect(await db.selectFrom("quotes").select("id").where("id", "=", "quote_quota_old_unreferenced").executeTakeFirst())
      .toEqual({ id: "quote_quota_old_unreferenced" });
    const activeCount = await db.selectFrom("quotes")
      .select(sql<string>`cast(count(*) as text)`.as("count"))
      .where("requester_subject_id", "=", demo.operatorSubjectId)
      .where("expires_at", ">", new Date())
      .executeTakeFirstOrThrow();
    expect(activeCount.count).toBe("200");
  });

  it("validates dates before database reads, accepts zero repricing, and forbids reversing a reversal", async () => {
    await expect(buildCommandEffect(db, "LOCK_MAINTENANCE", {
      propertyId: demo.propertyId,
      inventoryUnitId: "missing-unit",
      arrivalDate: "2028-02-30",
      departureDate: "2028-03-02",
      reason: "Invalid date must win"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(buildCommandEffect(db, "EXTEND_STAY", {
      propertyId: demo.propertyId,
      orderId: "missing-order",
      newDepartureDate: "2028-02-30"
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const orderId = await createOrder("zero-reprice", { arrival: "2028-05-01", departure: "2028-05-02" });
    const repriced = await previewAndConfirm({
      commandType: "REPRICE_ORDER",
      input: { propertyId: demo.propertyId, orderId, targetCurrentContractAmountMinor: 12_000 }
    }, "zero-reprice");
    expect(repriced.businessCommitted).toBe(true);
    const latestRevision = await db.selectFrom("pricing_revisions").select("manual_adjustment_minor")
      .where("order_id", "=", orderId).orderBy("revision_no", "desc").executeTakeFirstOrThrow();
    expect(latestRevision.manual_adjustment_minor).toBe(0);

    const collection = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 5_000, method: "CASH", transactionReference: "TEST-INVARIANT-TXN-ORIGINAL", note: "Original collection" }
    }, "reverse-original-collection");
    const reversal = await previewAndConfirm({
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId, reversesFactId: collection.result!.factId, note: "Reverse original" }
    }, "reverse-original");
    await expect(createCommandPreview(db, principal, {
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId, reversesFactId: reversal.result!.factId, note: "Forbidden reversal of reversal" }
    }, metadata("reverse-reversal"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns every released coverage and generated ledger fact from reconciliation", async () => {
    const orderId = await createOrder("reconcile-refs", { member: true, arrival: "2028-06-01", departure: "2028-06-02" });
    const coverage = await db.selectFrom("coverage_items").selectAll().where("order_id", "=", orderId).executeTakeFirstOrThrow();
    const result = await db.transaction().execute((trx) => reconcileCoverage(trx, {
      orderId,
      contractId: demo.memberContractId,
      revisionId: coverage.held_by_revision_id,
      coverageSet: [],
      commandId: "command_test_reconcile_refs"
    }));
    expect(result.coverageIds).toContain(coverage.id);
    expect(result.factIds).toHaveLength(1);
    expect(await db.selectFrom("entitlement_ledger").select(["fact_id", "coverage_id", "entry_type"])
      .where("fact_id", "=", result.factIds[0]!).executeTakeFirstOrThrow())
      .toEqual({ fact_id: result.factIds[0], coverage_id: coverage.id, entry_type: "RELEASE" });
  });

  it("requires every current operational migration for readiness", async () => {
    expect(await databaseReady(db)).toBe(true);
    for (const migrationName of [
      "019_member_stay_booking_channel_rules.sql",
      "020_whole_room_occupants.sql",
      "021_defer_internal_use.sql",
      "026_stage9_stay_change_guards.sql",
      "027_stage10_stay_shortening_guards.sql",
      "028_stage11_move_unit_guards.sql"
    ]) {
      await db.deleteFrom("schema_migrations").where("name", "=", migrationName).execute();
      try {
        expect(await databaseReady(db), migrationName).toBe(false);
      } finally {
        await db.insertInto("schema_migrations").values({ name: migrationName }).execute();
      }
    }
    expect(await databaseReady(db)).toBe(true);
    const rollbackProbe = new Error("rollback readiness object probe");

    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER amendments_stage11_validate_move_combination ON amendments`.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);

    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER coverage_items_stage11_preserve_consumed_update ON coverage_items`.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);

    await expect(db.transaction().execute(async (trx) => {
      await sql`ALTER FUNCTION qintopia_assert_stage11_move_combination(text) RENAME TO qintopia_assert_stage11_move_combination_missing`.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);

    await expect(db.transaction().execute(async (trx) => {
      await sql`DROP TRIGGER amendments_stage10_validate_combination ON amendments`.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);

    for (const trigger of [
      { name: "pricing_revisions_stage10_validate", table: "pricing_revisions" },
      { name: "amendments_stage10_reject_checkout_bypass", table: "amendments" },
      { name: "entitlement_ledger_stage10_reject_write", table: "entitlement_ledger" }
    ] as const) {
      await expect(db.transaction().execute(async (trx) => {
        await sql.raw(`DROP TRIGGER ${trigger.name} ON ${trigger.table}`).execute(trx);
        expect(await databaseReady(trx), trigger.name).toBe(false);
        throw rollbackProbe;
      })).rejects.toBe(rollbackProbe);
      expect(await databaseReady(db), trigger.name).toBe(true);
    }

    await expect(db.transaction().execute(async (trx) => {
      await sql`
        CREATE FUNCTION qintopia_test_stage10_noop_trigger() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
      await sql`DROP TRIGGER pricing_revisions_stage10_validate ON pricing_revisions`.execute(trx);
      await sql`
        CREATE TRIGGER pricing_revisions_stage10_validate
        BEFORE INSERT ON pricing_revisions
        FOR EACH ROW EXECUTE FUNCTION qintopia_test_stage10_noop_trigger()
      `.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);

    await expect(db.transaction().execute(async (trx) => {
      await sql`ALTER FUNCTION qintopia_assert_stage10_shorten_combination(text) RENAME TO qintopia_assert_stage10_shorten_combination_missing`.execute(trx);
      expect(await databaseReady(trx)).toBe(false);
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await databaseReady(db)).toBe(true);
  });
});
