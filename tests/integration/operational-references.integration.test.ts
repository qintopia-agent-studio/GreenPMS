import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { AuthPrincipal, BookingChannelCode, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import {
  confirmCommandPreview,
  createCommandPreview,
  createDatabase,
  databaseReady,
  getOrderView,
  type ConfirmRequest,
  type Database
} from "@qintopia/db";
import { sql, type Kysely, type Transaction } from "kysely";
import { sha256, stableHash } from "@qintopia/domain";
import { buildServer } from "../../apps/api/src/server.ts";
import { createQuoteForTesting as createQuote } from "../../packages/db/src/pricing-service.ts";
import { demo, seedDemo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.OPERATIONAL_REFERENCES_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_operational_references";
const historicalDatabaseUrl = process.env.OPERATIONAL_REFERENCES_HISTORY_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_operational_references_history";

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
    reason: { code: "OPERATIONAL_REFERENCE_TEST", note: `Operational reference acceptance for ${prefix}` }
  }, metadata(`${prefix}-confirm`));
}

async function createChannelOrder(options: {
  code: BookingChannelCode;
  channelOrderReference: string | null;
  day: number;
  prefix: string;
}) {
  const day = String(options.day).padStart(2, "0");
  const nextDay = String(options.day + 1).padStart(2, "0");
  const quote = await createQuote(db, {
    propertyId: demo.propertyId,
    inventoryUnitId: demo.roomId,
    stayType: "TRANSIENT",
    arrivalDate: `2028-12-${day}`,
    departureDate: `2028-12-${nextDay}`,
    pricingPolicyVersionId: demo.transientPolicyId
  });
  const preview = await createCommandPreview(db, principal, {
    commandType: "CREATE_ORDER",
    input: {
      propertyId: demo.propertyId,
      quoteId: quote.quoteId,
      primaryGuest: { fullName: `Channel Guest ${options.code}`, nickname: `Channel ${options.code}` },
      bookingChannelCode: options.code,
      channelOrderReference: options.channelOrderReference,
      targetCurrentContractAmountMinor: quote.currentContractAmount.minorUnits
    }
  }, metadata(`${options.prefix}-preview`));
  const expectedReference = options.channelOrderReference?.trim() || null;
  expect(preview.preview.effect).toMatchObject({
    bookingChannelCode: options.code,
    channelOrderReference: expectedReference
  });
  const confirmation: ConfirmRequest = {
    propertyId: demo.propertyId,
    commandType: "CREATE_ORDER",
    confirmation: true,
    expectedEffectHash: preview.preview.effectHash,
    reason: { code: "CREATE_STANDARD_ORDER", note: "" }
  };
  const confirmMetadata = metadata(`${options.prefix}-confirm`);
  const receipt = await confirmCommandPreview(db, principal, preview.preview.previewId, confirmation, confirmMetadata);
  expect(receipt.result).toMatchObject({
    bookingChannelCode: options.code,
    channelOrderReference: expectedReference
  });
  return { receipt, previewId: preview.preview.previewId, confirmation, confirmMetadata };
}

async function commandArtifactCounts() {
  const [facts, executions, receipts] = await Promise.all([
    db.selectFrom("collection_facts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [facts, executions, receipts].map((row) => Number(row.count));
}

async function orderArtifactCounts() {
  const [orders, previews, executions, receipts] = await Promise.all([
    db.selectFrom("orders").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_previews").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_executions").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("command_receipts").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow()
  ]);
  return [orders, previews, executions, receipts].map((row) => Number(row.count));
}

async function recreateDatabaseThrough008(url: string): Promise<Kysely<Database>> {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const directory = resolve(process.cwd(), "packages/db/src/migrations");
    const migrations = (await readdir(directory)).filter((name) => /^00[1-8].*\.sql$/.test(name)).sort();
    for (const migration of migrations) {
      await client.query(await readFile(resolve(directory, migration), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING", [migration]);
    }
  } finally {
    await client.end();
  }
  const historicalDb = createDatabase(url);
  await historicalDb.insertInto("properties").values({
    id: demo.propertyId,
    code: "QTP-SH",
    name: "QinTopia legacy migration fixture",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await historicalDb.insertInto("inventory_units").values([
    { id: demo.roomId, property_id: demo.propertyId, kind: "ROOM", parent_room_id: null, code: "101", name: "Room 101", active: true },
    { id: demo.bedAId, property_id: demo.propertyId, kind: "BED", parent_room_id: demo.roomId, code: "101-A", name: "Room 101 / Bed A", active: true },
    { id: demo.bedBId, property_id: demo.propertyId, kind: "BED", parent_room_id: demo.roomId, code: "101-B", name: "Room 101 / Bed B", active: true },
    { id: demo.secondRoomId, property_id: demo.propertyId, kind: "ROOM", parent_room_id: null, code: "102", name: "Room 102", active: true }
  ]).execute();
  await historicalDb.insertInto("pricing_policy_versions").values([
    {
      id: demo.transientPolicyId,
      property_id: demo.propertyId,
      code: "LEGACY-TRANSIENT-FLAT",
      version: 1,
      stay_type: "TRANSIENT",
      calculation_kind: "FLAT_NIGHTLY",
      nightly_rate_minor: 12_000,
      currency: "CNY",
      status: "PUBLISHED"
    },
    {
      id: demo.freePolicyId,
      property_id: demo.propertyId,
      code: "FREE",
      version: 1,
      stay_type: "FREE",
      calculation_kind: "FREE",
      nightly_rate_minor: 0,
      currency: "CNY",
      status: "PUBLISHED"
    }
  ]).execute();
  await historicalDb.insertInto("subjects").values({
    id: demo.agentSubjectId,
    username: "legacy-migration-agent",
    display_name: "Legacy Migration Agent",
    password_salt: "legacy-migration-fixture",
    password_hash: "legacy-migration-fixture",
    status: "ACTIVE",
    auth_version: 1
  }).execute();
  await historicalDb.insertInto("subject_property_grants").values({
    subject_id: demo.agentSubjectId,
    property_id: demo.propertyId,
    access_level: "WRITE"
  }).execute();
  await historicalDb.insertInto("api_tokens").values({
    id: "token_demo_write",
    subject_id: demo.agentSubjectId,
    label: "Legacy migration write Token",
    secret_hash: sha256(demo.writeToken),
    access_ceiling: "WRITE",
    property_scope: demo.propertyId,
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null
  }).execute();
  return historicalDb;
}

async function dropDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const databaseName = parsed.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/qintopia";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
}

describe.sequential("booking channels and external transaction references on PostgreSQL", () => {
  beforeEach(async () => {
    db = await resetDatabase(databaseUrl);
  });

  afterEach(async () => {
    if (db) await db.destroy();
  });

  it("persists all four stable booking channels through Preview, Receipt, amendment, and Query", async () => {
    const cases: Array<{ code: BookingChannelCode; reference: string | null; day: number }> = [
      { code: "YOUMUDAO", reference: "  TEST-CHANNEL-YOUMUDAO  ", day: 1 },
      { code: "CTRIP", reference: "TEST-CHANNEL-CTRIP", day: 3 },
      { code: "MEITUAN", reference: "TEST-CHANNEL-MEITUAN", day: 5 },
      { code: "WECOM", reference: null, day: 7 }
    ];

    for (const item of cases) {
      const created = await createChannelOrder({
        code: item.code,
        channelOrderReference: item.reference,
        day: item.day,
        prefix: `channel-${item.code.toLowerCase()}`
      });
      const orderId = created.receipt.result!.orderId as string;
      const view = await getOrderView(db, orderId);
      expect(view.order.booking_channel_code).toBe(item.code);
      expect(view.order.channel_order_reference).toBe(item.reference?.trim() || null);
      expect(view.amendments[0]!.payload).toMatchObject({
        bookingChannelCode: item.code,
        channelOrderReference: item.reference?.trim() || null
      });

      if (item.code === "WECOM") {
        const replay = await confirmCommandPreview(
          db,
          principal,
          created.previewId,
          created.confirmation,
          created.confirmMetadata
        );
        expect(replay.receiptId).toBe(created.receipt.receiptId);
        expect(await db.selectFrom("orders").select("id").where("id", "=", orderId).execute()).toHaveLength(1);
      }
    }
  });

  it("rejects missing, free-text, and WECOM-incompatible channels before creating any command artifact", async () => {
    const quote = await createQuote(db, {
      propertyId: demo.propertyId,
      inventoryUnitId: demo.roomId,
      stayType: "TRANSIENT",
      arrivalDate: "2028-12-20",
      departureDate: "2028-12-21",
      pricingPolicyVersionId: demo.transientPolicyId
    });
    const before = await orderArtifactCounts();
    for (const fields of [
      { channelOrderReference: null },
      { bookingChannelCode: "LEGACY", channelOrderReference: null },
      { bookingChannelCode: "WECOM", channelOrderReference: "MUST-NOT-PERSIST" }
    ]) {
      await expect(createCommandPreview(db, principal, {
        commandType: "CREATE_ORDER",
        input: {
          propertyId: demo.propertyId,
          quoteId: quote.quoteId,
          primaryGuest: { fullName: "Rejected channel command", nickname: "Rejected Channel" },
          ...fields
        }
      }, metadata("invalid-order-channel"))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await orderArtifactCounts()).toEqual(before);
  });

  it("rejects missing references with zero command artifacts and records independent collection/refund references exactly once", async () => {
    const created = await createChannelOrder({ code: "WECOM", channelOrderReference: null, day: 10, prefix: "fund-order" });
    const orderId = created.receipt.result!.orderId as string;
    const before = await commandArtifactCounts();
    for (const transactionReference of [undefined, " \t\n "]) {
      await expect(createCommandPreview(db, principal, {
        commandType: "RECORD_COLLECTION",
        input: { propertyId: demo.propertyId, orderId, amountMinor: 100, method: "WECOM", transactionReference }
      }, metadata("missing-transaction-reference"))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "必须填写企业微信交易单号" });
    }
    await expect(createCommandPreview(db, principal, {
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 100, method: "CASH" }
    }, metadata("missing-cash-payee"))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "必须填写收款人" });
    await expect(createCommandPreview(db, principal, {
      commandType: "RECORD_COLLECTION",
      input: { propertyId: demo.propertyId, orderId, amountMinor: 100, method: "OTHER" }
    }, metadata("missing-other-note"))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "必须填写其他收款说明" });
    expect(await commandArtifactCounts()).toEqual(before);

    const collectionPreview = await createCommandPreview(db, principal, {
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 5_000,
        method: "WECOM",
        transactionReference: "  TEST-TXN-COLLECTION-ONE  ",
        note: "First independent collection"
      }
    }, metadata("collection-one-preview"));
    expect(collectionPreview.preview.effect).toMatchObject({ transactionReference: "TEST-TXN-COLLECTION-ONE" });
    const collectionConfirmation: ConfirmRequest = {
      propertyId: demo.propertyId,
      commandType: "RECORD_COLLECTION",
      confirmation: true,
      expectedEffectHash: collectionPreview.preview.effectHash,
      reason: { code: "FACT_TEST", note: "Confirm first independent collection" }
    };
    const collectionMetadata = { idempotencyKey: "collection-one-confirm-stable", correlationId: "collection-one-confirm-stable" };
    const collectionOne = await confirmCommandPreview(db, principal, collectionPreview.preview.previewId, collectionConfirmation, collectionMetadata);
    const collectionReplay = await confirmCommandPreview(db, principal, collectionPreview.preview.previewId, collectionConfirmation, collectionMetadata);
    expect(collectionReplay.receiptId).toBe(collectionOne.receiptId);
    expect(collectionOne.result).toMatchObject({ transactionReference: "TEST-TXN-COLLECTION-ONE" });

    const beforeInvalidRefunds = await commandArtifactCounts();
    for (const note of [undefined, " \t\n "]) {
      await expect(createCommandPreview(db, principal, {
        commandType: "RECORD_REFUND",
        input: {
          propertyId: demo.propertyId,
          orderId,
          amountMinor: 100,
          referencesFactId: collectionOne.factRefs[0],
          method: "WECOM",
          note
        }
      }, metadata("missing-refund-reason"))).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "必须填写退款原因" });
    }
    expect(await commandArtifactCounts()).toEqual(beforeInvalidRefunds);

    const collectionTwo = await previewAndConfirm({
      commandType: "RECORD_COLLECTION",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 4_000,
        method: "BANK_TRANSFER",
        transactionReference: "TEST-TXN-COLLECTION-TWO",
        note: "Second independent collection"
      }
    }, "collection-two");
    const refund = await previewAndConfirm({
      commandType: "RECORD_REFUND",
      input: {
        propertyId: demo.propertyId,
        orderId,
        amountMinor: 1_500,
        referencesFactId: collectionOne.factRefs[0],
        method: "WECOM",
        note: "WECOM original-route refund"
      }
    }, "refund-one");
    const reversal = await previewAndConfirm({
      commandType: "REVERSE_FACT",
      input: { propertyId: demo.propertyId, orderId, reversesFactId: collectionTwo.factRefs[0], note: "Reverse second collection" }
    }, "reverse-second-collection");
    expect(reversal.result).toMatchObject({ factType: "REVERSAL", transactionReference: null });

    const facts = await db.selectFrom("collection_facts").selectAll().where("order_id", "=", orderId).orderBy("created_at").orderBy("fact_id").execute();
    expect(facts).toHaveLength(4);
    expect(facts.filter((fact) => fact.transaction_reference === "TEST-TXN-COLLECTION-ONE")).toHaveLength(1);
    expect(facts.find((fact) => fact.fact_id === collectionTwo.factRefs[0])?.transaction_reference).toBe("TEST-TXN-COLLECTION-TWO");
    expect(facts.find((fact) => fact.fact_id === refund.factRefs[0])).toMatchObject({
      fact_type: "REFUND",
      references_fact_id: collectionOne.factRefs[0],
      method: "WECOM",
      transaction_reference: null
    });
    expect(facts.find((fact) => fact.fact_id === reversal.factRefs[0])?.transaction_reference).toBeNull();
  });

  it("enforces the new-write rules for direct database inserts and keeps order channel identity immutable", async () => {
    const completeDirectOrder = async (
      trx: Transaction<Database>,
      id: string,
      arrivalDate: string,
      departureDate: string,
      snapshot: { fullName: string; nickname: string }
    ) => {
      const commandId = `command_${id}`;
      await trx.insertInto("command_executions").values({
        id: commandId,
        subject_id: demo.agentSubjectId,
        credential_id: "token_demo_write",
        property_id: demo.propertyId,
        command_type: "CREATE_ORDER",
        idempotency_key: `direct-${id}`,
        request_hash: "d".repeat(64),
        correlation_id: `direct-${id}`,
        state: "APPLIED",
        completed_at: new Date()
      }).execute();
      await trx.insertInto("order_occupants").values({
        id: `occupant_${id}`,
        order_id: id,
        ordinal: 1,
        role: "PRIMARY",
        full_name: snapshot.fullName,
        nickname: snapshot.nickname,
        phone: null,
        document_number: null,
        created_by_command_id: commandId
      }).execute();
      await trx.insertInto("stays").values({ id: `stay_${id}`, order_id: id, status: "PLANNED" }).execute();
      await trx.insertInto("amendments").values({
        id: `amend_${id}`,
        order_id: id,
        sequence: 1,
        amendment_type: "CREATE_ORDER",
        reason_code: "DIRECT_DATABASE_GUARD",
        reason_note: "Direct database guard fixture",
        prior_version: 0,
        new_version: 1,
        payload: {},
        command_id: commandId
      }).execute();
      await trx.insertInto("stay_segments").values({
        id: `segment_${id}`,
        stay_id: `stay_${id}`,
        sequence: 1,
        inventory_unit_id: demo.secondRoomId,
        arrival_date: arrivalDate,
        departure_date: departureDate,
        segment_type: "INITIAL",
        supersedes_segment_id: null,
        amendment_id: `amend_${id}`
      }).execute();
    };
    const directOrder = async (
      id: string,
      bookingChannelCode: BookingChannelCode | null,
      channelOrderReference: string | null,
      primaryGuestSnapshot: unknown = { fullName: "Direct database guard probe", nickname: "Direct Guard" }
    ) => db.transaction().execute(async (trx) => {
      await trx.insertInto("orders").values({
        id,
        property_id: demo.propertyId,
        status: "RESERVED",
        stay_type: "TRANSIENT",
        arrival_date: "2029-01-01",
        departure_date: "2029-01-02",
        primary_guest_snapshot: primaryGuestSnapshot,
        booking_channel_code: bookingChannelCode,
        channel_order_reference: channelOrderReference,
        free_stay_reason: null,
        pricing_policy_version_id: demo.transientPolicyId,
        member_contract_id: null,
        current_revision_id: null,
        version: 1
      }).execute();
      if (primaryGuestSnapshot && typeof primaryGuestSnapshot === "object" && !Array.isArray(primaryGuestSnapshot)) {
        await completeDirectOrder(trx, id, "2029-01-01", "2029-01-02", primaryGuestSnapshot as { fullName: string; nickname: string });
      }
    });

    await expect(directOrder("order_direct_missing_channel", null, null)).rejects.toMatchObject({ constraint: "orders_new_booking_channel_required" });
    await expect(directOrder("order_direct_wecom_reference", "WECOM", "MUST-NOT-PERSIST")).rejects.toMatchObject({ constraint: "orders_wecom_has_no_channel_order_reference" });
    const directMemberOrder = (id: string, bookingChannelCode: BookingChannelCode | null) => db.transaction().execute(async (trx) => {
      const snapshot = { fullName: "Direct member database guard probe", nickname: "Member Guard" };
      await trx.insertInto("orders").values({
        id,
        property_id: demo.propertyId,
        status: "RESERVED",
        stay_type: "TRANSIENT",
        arrival_date: "2029-01-03",
        departure_date: "2029-01-04",
        primary_guest_snapshot: snapshot,
        booking_channel_code: bookingChannelCode,
        channel_order_reference: null,
        free_stay_reason: null,
        pricing_policy_version_id: demo.transientPolicyId,
        member_id: demo.memberId,
        member_contract_id: demo.memberContractId,
        current_revision_id: null,
        version: 1
      }).execute();
      await completeDirectOrder(trx, id, "2029-01-03", "2029-01-04", snapshot);
    });
    await directMemberOrder("order_direct_member_without_channel", null);
    await expect(directMemberOrder("order_direct_member_with_channel", "WECOM")).rejects.toMatchObject({ constraint: "orders_member_booking_channel_null" });
    const directFreeOrder = (id: string, bookingChannelCode: BookingChannelCode | null, freeStayCategoryCode: string | null = "VOLUNTEER") => db.transaction().execute(async (trx) => {
      const snapshot = { fullName: "Direct free database guard probe", nickname: "Free Guard" };
      await trx.insertInto("orders").values({
        id,
        property_id: demo.propertyId,
        status: "RESERVED",
        stay_type: "FREE",
        arrival_date: "2029-01-05",
        departure_date: "2029-01-06",
        primary_guest_snapshot: snapshot,
        booking_channel_code: bookingChannelCode,
        channel_order_reference: null,
        free_stay_reason: "Direct free database guard fixture",
        free_stay_category_code: freeStayCategoryCode,
        pricing_policy_version_id: demo.freePolicyId,
        member_contract_id: null,
        current_revision_id: null,
        version: 1
      }).execute();
      await completeDirectOrder(trx, id, "2029-01-05", "2029-01-06", snapshot);
    });
    await directFreeOrder("order_direct_free_without_channel", null);
    await expect(directFreeOrder("order_direct_free_with_channel", "WECOM")).rejects.toMatchObject({ constraint: "orders_free_stay_booking_channel_null" });
    await expect(directFreeOrder("order_direct_free_missing_category", null, null)).rejects.toMatchObject({ constraint: "orders_new_free_stay_category_required" });
    await expect(directFreeOrder("order_direct_free_invalid_category", null, "SPONSORED")).rejects.toMatchObject({ constraint: "orders_free_stay_category_code_check" });
    await expect(db.updateTable("orders")
      .set({ free_stay_category_code: "RECEPTION" })
      .where("id", "=", "order_direct_free_without_channel")
      .execute()).rejects.toMatchObject({ code: "55000" });
    await expect(directOrder("order_direct_blank_reference", "CTRIP", " \t\n "))
      .rejects.toMatchObject({ constraint: "orders_new_channel_order_reference_required" });

    const orderCountBeforeNicknameRejections = await db.selectFrom("orders")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    await expect(directOrder(
      "order_direct_missing_nickname",
      "CTRIP",
      "DIRECT-MISSING-NICKNAME",
      { fullName: "Direct missing nickname probe" }
    )).rejects.toMatchObject({ constraint: "orders_new_primary_guest_nickname_required" });
    await expect(directOrder(
      "order_direct_null_nickname",
      "CTRIP",
      "DIRECT-NULL-NICKNAME",
      { fullName: "Direct null nickname probe", nickname: null }
    )).rejects.toMatchObject({ constraint: "orders_new_primary_guest_nickname_required" });
    await expect(directOrder(
      "order_direct_blank_nickname",
      "CTRIP",
      "DIRECT-BLANK-NICKNAME",
      { fullName: "Direct blank nickname probe", nickname: " \t\n " }
    )).rejects.toMatchObject({ constraint: "orders_new_primary_guest_nickname_required" });
    await expect(directOrder(
      "order_direct_oversized_nickname",
      "CTRIP",
      "DIRECT-OVERSIZED-NICKNAME",
      { fullName: "Direct oversized nickname probe", nickname: "N".repeat(201) }
    )).rejects.toMatchObject({ constraint: "orders_new_primary_guest_nickname_length" });
    await expect(directOrder(
      "order_direct_non_object_guest_snapshot",
      "CTRIP",
      "DIRECT-NON-OBJECT-GUEST",
      sql<unknown>`'[]'::jsonb`
    )).rejects.toMatchObject({ constraint: "orders_new_primary_guest_snapshot_object" });
    const orderCountAfterNicknameRejections = await db.selectFrom("orders")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(orderCountAfterNicknameRejections.count)).toBe(Number(orderCountBeforeNicknameRejections.count));
    await directOrder(
      "order_direct_padded_nickname",
      "CTRIP",
      "DIRECT-PADDED-NICKNAME",
      { fullName: "Direct padded nickname probe", nickname: " \t Direct Guard \n " }
    );
    expect(await db.selectFrom("orders")
      .select("primary_guest_snapshot")
      .where("id", "=", "order_direct_padded_nickname")
      .executeTakeFirstOrThrow()).toEqual({
      primary_guest_snapshot: { fullName: "Direct padded nickname probe", nickname: "Direct Guard" }
    });

    const created = await createChannelOrder({ code: "CTRIP", channelOrderReference: "TEST-IMMUTABLE-CHANNEL", day: 12, prefix: "immutable-channel" });
    const orderId = created.receipt.result!.orderId as string;
    const secondOrder = await createChannelOrder({ code: "WECOM", channelOrderReference: null, day: 14, prefix: "refund-other-order" });
    const secondOrderId = secondOrder.receipt.result!.orderId as string;
    const pricingRevisionId = (await getOrderView(db, orderId)).order.current_revision_id!;
    const secondPricingRevisionId = (await getOrderView(db, secondOrderId)).order.current_revision_id!;
    await expect(db.updateTable("orders").set({ booking_channel_code: "MEITUAN" }).where("id", "=", orderId).execute()).rejects.toThrow(/booking channel.*immutable/);
    await expect(db.updateTable("orders").set({ channel_order_reference: "CHANGED" }).where("id", "=", orderId).execute()).rejects.toThrow(/booking channel.*immutable/);

    const externalBaseFact = {
      order_id: orderId,
      amount_minor: 100,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: null,
      method: "CASH",
      note: "Direct fact guard probe",
      pricing_revision_id: pricingRevisionId,
      command_id: "command_direct_fact_guard"
    };
    await expect(db.insertInto("collection_facts").values({
      ...externalBaseFact,
      fact_id: "fact_direct_external_collection_forbidden",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      method: "WECOM",
      transaction_reference: "TEST-DIRECT-EXTERNAL-COLLECTION-FORBIDDEN"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_external_channel_money_forbidden" });
    await expect(db.insertInto("collection_facts").values({
      ...externalBaseFact,
      fact_id: "fact_direct_external_refund_forbidden",
      fact_type: "REFUND",
      net_effect_minor: -100,
      method: "WECOM",
      transaction_reference: "TEST-DIRECT-EXTERNAL-REFUND-FORBIDDEN"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_external_channel_money_forbidden" });
    const wecomOrder = await createChannelOrder({ code: "WECOM", channelOrderReference: null, day: 16, prefix: "direct-wecom-method" });
    const wecomOrderId = wecomOrder.receipt.result!.orderId as string;
    const wecomPricingRevisionId = (await getOrderView(db, wecomOrderId)).order.current_revision_id!;
    const baseFact = {
      ...externalBaseFact,
      order_id: wecomOrderId,
      pricing_revision_id: wecomPricingRevisionId,
      command_id: "command_direct_wecom_fact_guard"
    };
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_wecom_cash_collection",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      method: "CASH",
      transaction_reference: null,
      command_id: "command_direct_wecom_cash_collection"
    }).execute();
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_wecom_valid_collection",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      method: "WECOM",
      transaction_reference: "TEST-DIRECT-WECOM-VALID-COLLECTION",
      command_id: "command_direct_wecom_valid_collection"
    }).execute();
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_wecom_refund_cash_method",
      fact_type: "REFUND",
      net_effect_minor: -10,
      amount_minor: 10,
      references_fact_id: "fact_direct_wecom_valid_collection",
      method: "CASH",
      transaction_reference: null,
      command_id: "command_direct_wecom_refund_cash_method"
    }).execute();
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_wecom_refund_original_route",
      fact_type: "REFUND",
      net_effect_minor: -10,
      amount_minor: 10,
      references_fact_id: "fact_direct_wecom_valid_collection",
      method: "WECOM",
      transaction_reference: null,
      command_id: "command_direct_wecom_refund_original_route"
    }).execute();
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_missing_pricing_revision",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      pricing_revision_id: null,
      transaction_reference: "TEST-DIRECT-MISSING-PRICING-REVISION"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_new_pricing_revision_required" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_missing_transaction",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      method: "WECOM",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_method_transaction_reference_required" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_blank_transaction",
      fact_type: "REFUND",
      amount_minor: 10,
      net_effect_minor: -10,
      references_fact_id: "fact_direct_wecom_valid_collection",
      method: "BANK_TRANSFER",
      transaction_reference: "\t\n",
      command_id: "command_direct_blank_refund_transaction"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_method_transaction_reference_required" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_transaction",
      fact_type: "REVERSAL",
      net_effect_minor: -100,
      transaction_reference: "MUST-NOT-PERSIST"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_transaction_reference_null" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_missing_reference",
      fact_type: "REFUND",
      net_effect_minor: -100,
      transaction_reference: "TEST-DIRECT-REFUND-MISSING-REFERENCE"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_reference_required" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_collection_wrong_currency",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      currency: "USD",
      transaction_reference: "TEST-DIRECT-COLLECTION-WRONG-CURRENCY"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_order_currency_match" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_collection_wrong_net",
      fact_type: "COLLECTION",
      net_effect_minor: -100,
      transaction_reference: "TEST-DIRECT-COLLECTION-WRONG-NET"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_collection_net_effect" });

    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_valid_collection",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      transaction_reference: "TEST-DIRECT-VALID-COLLECTION",
      command_id: "command_direct_valid_fact"
    }).execute();
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_collection_reference",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-COLLECTION-REFERENCE"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_collection_reference_null" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_collection_reversal",
      fact_type: "COLLECTION",
      net_effect_minor: 100,
      reverses_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-COLLECTION-REVERSAL"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_collection_reversal_null" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_wrong_net",
      fact_type: "REFUND",
      net_effect_minor: 50,
      amount_minor: 50,
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-REFUND-WRONG-NET"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_net_effect" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_reversal",
      fact_type: "REFUND",
      net_effect_minor: -50,
      amount_minor: 50,
      references_fact_id: "fact_direct_valid_collection",
      reverses_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-REFUND-REVERSAL"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_reversal_null" });
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_valid_refund",
      fact_type: "REFUND",
      net_effect_minor: -50,
      amount_minor: 50,
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-VALID-REFUND",
      command_id: "command_direct_valid_fact"
    }).execute();
    expect(await db.selectFrom("collection_facts").select(["references_fact_id", "transaction_reference"]).where("fact_id", "=", "fact_direct_valid_refund").executeTakeFirstOrThrow()).toEqual({
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-VALID-REFUND"
    });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_over_remaining",
      fact_type: "REFUND",
      net_effect_minor: -60,
      amount_minor: 60,
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-REFUND-OVER-REMAINING"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_remaining_amount" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_collection_with_active_refund",
      fact_type: "REVERSAL",
      amount_minor: 100,
      net_effect_minor: -100,
      reverses_fact_id: "fact_direct_valid_collection",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_collection_has_active_refunds" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_non_collection",
      fact_type: "REFUND",
      net_effect_minor: -10,
      amount_minor: 10,
      references_fact_id: "fact_direct_valid_refund",
      transaction_reference: "TEST-DIRECT-REFUND-NON-COLLECTION"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_reference_collection" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_cross_order",
      order_id: secondOrderId,
      pricing_revision_id: secondPricingRevisionId,
      fact_type: "REFUND",
      net_effect_minor: -10,
      amount_minor: 10,
      references_fact_id: "fact_direct_valid_collection",
      transaction_reference: "TEST-DIRECT-REFUND-CROSS-ORDER"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_reference_same_order" });

    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_source",
      fact_type: "COLLECTION",
      amount_minor: 70,
      net_effect_minor: 70,
      transaction_reference: "TEST-DIRECT-REVERSAL-SOURCE",
      command_id: "command_direct_valid_reversal_source"
    }).execute();
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_missing_target",
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: -70,
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_target_required" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_with_reference",
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: -70,
      references_fact_id: "fact_direct_valid_collection",
      reverses_fact_id: "fact_direct_reversal_source",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_reference_null" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_wrong_net",
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: 70,
      reverses_fact_id: "fact_direct_reversal_source",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_net_effect" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_wrong_amount",
      fact_type: "REVERSAL",
      amount_minor: 60,
      net_effect_minor: -70,
      reverses_fact_id: "fact_direct_reversal_source",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_amount" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_cross_order",
      order_id: secondOrderId,
      pricing_revision_id: secondPricingRevisionId,
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: -70,
      reverses_fact_id: "fact_direct_reversal_source",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_same_order" });
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_valid_reversal",
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: -70,
      reverses_fact_id: "fact_direct_reversal_source",
      transaction_reference: null,
      command_id: "command_direct_valid_reversal"
    }).execute();
    expect(await db.selectFrom("collection_facts")
      .select(["fact_type", "amount_minor", "net_effect_minor", "currency", "references_fact_id", "reverses_fact_id"])
      .where("fact_id", "=", "fact_direct_valid_reversal").executeTakeFirstOrThrow()).toEqual({
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: -70,
      currency: "CNY",
      references_fact_id: null,
      reverses_fact_id: "fact_direct_reversal_source"
    });
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_after_reversal_source",
      fact_type: "COLLECTION",
      amount_minor: 80,
      net_effect_minor: 80,
      transaction_reference: "TEST-DIRECT-REFUND-AFTER-REVERSAL-SOURCE",
      command_id: "command_direct_refund_after_reversal_source"
    }).execute();
    await db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_valid_source_reversal",
      fact_type: "REVERSAL",
      amount_minor: 80,
      net_effect_minor: -80,
      reverses_fact_id: "fact_direct_refund_after_reversal_source",
      transaction_reference: null,
      command_id: "command_direct_valid_source_reversal"
    }).execute();
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_refund_after_reversed_collection",
      fact_type: "REFUND",
      amount_minor: 10,
      net_effect_minor: -10,
      references_fact_id: "fact_direct_refund_after_reversal_source",
      transaction_reference: "TEST-DIRECT-REFUND-AFTER-REVERSED-COLLECTION"
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_refund_reference_reversed" });
    await expect(db.insertInto("collection_facts").values({
      ...baseFact,
      fact_id: "fact_direct_reversal_of_reversal",
      fact_type: "REVERSAL",
      amount_minor: 70,
      net_effect_minor: 70,
      reverses_fact_id: "fact_direct_valid_reversal",
      transaction_reference: null
    }).execute()).rejects.toMatchObject({ constraint: "collection_facts_reversal_target_not_reversal" });
    expect(await db.selectFrom("collection_facts").select("fact_id").where("command_id", "=", "command_direct_fact_guard").execute()).toHaveLength(0);
  });

  it("applies migrations 009 through 032, preserves historical facts, and upgrades the legacy demo catalog", async () => {
    let historicalDb: Kysely<Database> | undefined;
    try {
      historicalDb = await recreateDatabaseThrough008(historicalDatabaseUrl);
      const client = new pg.Client({ connectionString: historicalDatabaseUrl });
      await client.connect();
      try {
        await client.query(`
          INSERT INTO orders(id, property_id, status, stay_type, arrival_date, departure_date, primary_guest_snapshot, pricing_policy_version_id, member_contract_id, current_revision_id, version)
          VALUES ('order_historical_nulls', '${demo.propertyId}', 'RESERVED', 'FREE', '2029-02-01', '2029-02-02', '{"fullName":"Historical Null Guest"}'::jsonb, '${demo.freePolicyId}', NULL, NULL, 1);
          INSERT INTO stays(id, order_id, status) VALUES ('stay_historical_nulls', 'order_historical_nulls', 'PLANNED');
          INSERT INTO amendments(id, order_id, sequence, amendment_type, reason_code, reason_note, prior_version, new_version, payload, created_at)
          VALUES ('amend_historical_nulls', 'order_historical_nulls', 1, 'CREATE_ORDER', 'HISTORICAL', 'Created before channel capture', 0, 1, '{"quoteId":"quote_historical","inventoryUnitId":"${demo.roomId}","arrivalDate":"2029-02-01","departureDate":"2029-02-02"}'::jsonb, '2025-12-01T00:00:00Z');
          INSERT INTO stay_segments(id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date, segment_type, supersedes_segment_id, amendment_id)
          VALUES ('segment_historical_nulls', 'stay_historical_nulls', 1, '${demo.roomId}', '2029-02-01', '2029-02-02', 'INITIAL', NULL, 'amend_historical_nulls');
          INSERT INTO inventory_claims(id, property_id, room_id, inventory_unit_id, service_date, source_type, source_id, active, released_at)
          VALUES ('claim_historical_nulls', '${demo.propertyId}', '${demo.roomId}', '${demo.roomId}', '2029-02-01', 'ORDER_SEGMENT', 'segment_historical_nulls', true, NULL);
          INSERT INTO pricing_revisions(id, order_id, revision_no, amendment_id, policy_version_id, arrival_date, departure_date, coverage_set, cash_lines, manual_adjustment_minor, current_contract_amount_minor, currency)
          VALUES ('revision_historical_nulls', 'order_historical_nulls', 1, 'amend_historical_nulls', '${demo.freePolicyId}', '2029-02-01', '2029-02-02', '[]'::jsonb, '[]'::jsonb, 0, 0, 'CNY');
          UPDATE orders SET current_revision_id = 'revision_historical_nulls' WHERE id = 'order_historical_nulls';
          INSERT INTO collection_facts(fact_id, order_id, fact_type, amount_minor, net_effect_minor, currency, references_fact_id, reverses_fact_id, method, note, command_id, created_at)
          VALUES ('fact_historical_nulls', 'order_historical_nulls', 'COLLECTION', 100, 90, 'USD', NULL, NULL, 'CASH', 'Recorded before transaction reference and shape guards', 'command_historical_nulls', '2028-12-02T00:00:00Z');

          INSERT INTO orders(id, property_id, status, stay_type, arrival_date, departure_date, primary_guest_snapshot, pricing_policy_version_id, member_contract_id, current_revision_id, version)
          VALUES ('order_historical_explicit_null', '${demo.propertyId}', 'RESERVED', 'FREE', '2029-02-03', '2029-02-04', '{"fullName":"Historical Explicit Null Guest","nickname":null}'::jsonb, '${demo.freePolicyId}', NULL, NULL, 1);
          INSERT INTO stays(id, order_id, status) VALUES ('stay_historical_explicit_null', 'order_historical_explicit_null', 'PLANNED');
          INSERT INTO amendments(id, order_id, sequence, amendment_type, reason_code, reason_note, prior_version, new_version, payload)
          VALUES ('amend_historical_explicit_null', 'order_historical_explicit_null', 1, 'CREATE_ORDER', 'HISTORICAL', 'Created with an explicit null nickname', 0, 1, '{"quoteId":"quote_historical_explicit_null","inventoryUnitId":"${demo.secondRoomId}","arrivalDate":"2029-02-03","departureDate":"2029-02-04"}'::jsonb);
          INSERT INTO stay_segments(id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date, segment_type, supersedes_segment_id, amendment_id)
          VALUES ('segment_historical_explicit_null', 'stay_historical_explicit_null', 1, '${demo.secondRoomId}', '2029-02-03', '2029-02-04', 'INITIAL', NULL, 'amend_historical_explicit_null');
          INSERT INTO inventory_claims(id, property_id, room_id, inventory_unit_id, service_date, source_type, source_id, active, released_at)
          VALUES ('claim_historical_explicit_null', '${demo.propertyId}', '${demo.secondRoomId}', '${demo.secondRoomId}', '2029-02-03', 'ORDER_SEGMENT', 'segment_historical_explicit_null', true, NULL);
          INSERT INTO pricing_revisions(id, order_id, revision_no, amendment_id, policy_version_id, arrival_date, departure_date, coverage_set, cash_lines, manual_adjustment_minor, current_contract_amount_minor, currency)
          VALUES ('revision_historical_explicit_null', 'order_historical_explicit_null', 1, 'amend_historical_explicit_null', '${demo.freePolicyId}', '2029-02-03', '2029-02-04', '[]'::jsonb, '[]'::jsonb, 0, 0, 'CNY');
          UPDATE orders SET current_revision_id = 'revision_historical_explicit_null' WHERE id = 'order_historical_explicit_null';
        `);
        const migration009 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/009_booking_channels_and_transaction_references.sql"), "utf8");
        await client.query(migration009);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('009_booking_channels_and_transaction_references.sql')");
        await client.query(`
          INSERT INTO command_previews(id, subject_id, property_id, command_type, normalized_input, input_hash, effect, effect_hash, basis_versions, expires_at, status)
          VALUES
          (
            'preview_historical_create', '${demo.agentSubjectId}', '${demo.propertyId}', 'CREATE_ORDER', '{}'::jsonb, repeat('a', 64),
            jsonb_build_object(
              'quoteId', 'quote_historical',
              'primaryGuest', jsonb_build_object('fullName', 'Historical Preview Guest'),
              'inventoryUnit', jsonb_build_object(
                'id', '${demo.roomId}', 'propertyId', '${demo.propertyId}', 'kind', 'ROOM', 'roomId', '${demo.roomId}', 'code', '101', 'name', 'Room 101',
                'catalogVersion', NULL, 'buildingCode', NULL, 'roomTypeCode', NULL, 'pricingProductCode', NULL,
                'inventoryBasis', NULL, 'codeProvenance', NULL, 'physicalBedCount', NULL
              ),
              'stayType', 'FREE', 'arrivalDate', '2029-02-01', 'departureDate', '2029-02-02',
              'pricingPolicyVersionId', '${demo.freePolicyId}', 'memberContractId', NULL,
              'pricing', jsonb_build_object(
                'coverageSet', '[]'::jsonb, 'cashLines', '[]'::jsonb,
                'cashRemainder', jsonb_build_object('currency', 'CNY', 'minorUnits', 0),
                'currentContractAmount', jsonb_build_object('currency', 'CNY', 'minorUnits', 0)
              )
            ),
            repeat('b', 64), '{}'::jsonb, '2035-01-01T00:00:00Z', 'OPEN'
          ),
          (
            'preview_historical_collection', '${demo.agentSubjectId}', '${demo.propertyId}', 'RECORD_COLLECTION', '{}'::jsonb, repeat('c', 64),
            jsonb_build_object('orderId', 'order_historical_nulls', 'amountMinor', 100, 'currency', 'CNY', 'method', 'CASH', 'note', 'Historical collection preview'),
            repeat('d', 64), '{}'::jsonb, '2035-01-01T00:00:00Z', 'OPEN'
          );

          INSERT INTO command_previews(id, subject_id, property_id, command_type, normalized_input, input_hash, effect, effect_hash, basis_versions, expires_at, status)
          SELECT
            'preview_historical_create_explicit_null', subject_id, property_id, command_type, normalized_input, repeat('7', 64),
            jsonb_set(effect, '{primaryGuest,nickname}', 'null'::jsonb, true), repeat('8', 64), basis_versions, expires_at, status
          FROM command_previews
          WHERE id = 'preview_historical_create';

          INSERT INTO command_executions(id, subject_id, credential_id, property_id, command_type, idempotency_key, request_hash, correlation_id, state, completed_at)
          VALUES
            ('command_historical_create_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'CREATE_ORDER', 'historical-create-receipt', repeat('e', 64), 'historical-create-receipt', 'APPLIED', now()),
            ('command_historical_collection_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'RECORD_COLLECTION', 'historical-collection-receipt', repeat('f', 64), 'historical-collection-receipt', 'APPLIED', now()),
            ('command_historical_refund_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'RECORD_REFUND', 'historical-refund-receipt', repeat('1', 64), 'historical-refund-receipt', 'APPLIED', now()),
            ('command_historical_reversal_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'REVERSE_FACT', 'historical-reversal-receipt', repeat('2', 64), 'historical-reversal-receipt', 'APPLIED', now()),
            ('command_historical_preview_create_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'PREVIEW:CREATE_ORDER', 'historical-preview-create-receipt', repeat('3', 64), 'historical-preview-create-receipt', 'APPLIED', now()),
            ('command_historical_preview_create_explicit_null_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'PREVIEW:CREATE_ORDER', 'historical-preview-create-explicit-null-receipt', repeat('7', 64), 'historical-preview-create-explicit-null-receipt', 'APPLIED', now()),
            ('command_historical_preview_collection_receipt', '${demo.agentSubjectId}', 'token_demo_write', '${demo.propertyId}', 'PREVIEW:RECORD_COLLECTION', 'historical-preview-collection-receipt', repeat('4', 64), 'historical-preview-collection-receipt', 'APPLIED', now());

          INSERT INTO command_receipts(id, command_id, execution_status, business_committed, result, error, resource_refs, fact_refs, committed_at)
          VALUES
            ('receipt_historical_create', 'command_historical_create_receipt', 'EXECUTED', true, '{"orderId":"order_historical_nulls","stayId":"stay_historical_nulls","segmentId":"segment_historical_nulls","pricingRevisionId":"revision_historical_nulls"}'::jsonb, NULL, '["order_historical_nulls"]'::jsonb, '[]'::jsonb, now()),
            ('receipt_historical_collection', 'command_historical_collection_receipt', 'EXECUTED', true, '{"orderId":"order_historical_nulls","factId":"fact_historical_collection_receipt","factType":"COLLECTION","netEffectMinor":100}'::jsonb, NULL, '["order_historical_nulls"]'::jsonb, '["fact_historical_collection_receipt"]'::jsonb, now()),
            ('receipt_historical_refund', 'command_historical_refund_receipt', 'EXECUTED', true, '{"orderId":"order_historical_nulls","factId":"fact_historical_refund_receipt","factType":"REFUND","netEffectMinor":-50}'::jsonb, NULL, '["order_historical_nulls"]'::jsonb, '["fact_historical_refund_receipt"]'::jsonb, now()),
            ('receipt_historical_reversal', 'command_historical_reversal_receipt', 'EXECUTED', true, '{"orderId":"order_historical_nulls","factId":"fact_historical_reversal_receipt","factType":"REVERSAL","netEffectMinor":-100}'::jsonb, NULL, '["order_historical_nulls"]'::jsonb, '["fact_historical_reversal_receipt"]'::jsonb, now()),
            (
              'receipt_historical_preview_create', 'command_historical_preview_create_receipt', 'EXECUTED', true,
              jsonb_build_object('preview', jsonb_build_object(
                'previewId', 'preview_historical_create', 'commandType', 'CREATE_ORDER', 'effectHash', repeat('b', 64),
                'effect', (SELECT effect FROM command_previews WHERE id = 'preview_historical_create'), 'expiresAt', '2035-01-01T00:00:00.000Z'
              )), NULL, '["preview_historical_create"]'::jsonb, '[]'::jsonb, now()
            ),
            (
              'receipt_historical_preview_collection', 'command_historical_preview_collection_receipt', 'EXECUTED', true,
              jsonb_build_object('preview', jsonb_build_object(
                'previewId', 'preview_historical_collection', 'commandType', 'RECORD_COLLECTION', 'effectHash', repeat('d', 64),
                'effect', (SELECT effect FROM command_previews WHERE id = 'preview_historical_collection'), 'expiresAt', '2035-01-01T00:00:00.000Z'
              )), NULL, '["preview_historical_collection"]'::jsonb, '[]'::jsonb, now()
            ),
            (
              'receipt_historical_preview_create_explicit_null', 'command_historical_preview_create_explicit_null_receipt', 'EXECUTED', true,
              jsonb_build_object('preview', jsonb_build_object(
                'previewId', 'preview_historical_create_explicit_null', 'commandType', 'CREATE_ORDER', 'effectHash', repeat('8', 64),
                'effect', (SELECT effect FROM command_previews WHERE id = 'preview_historical_create_explicit_null'), 'expiresAt', '2035-01-01T00:00:00.000Z'
              )), NULL, '["preview_historical_create_explicit_null"]'::jsonb, '[]'::jsonb, now()
            );
        `);
        const migration010 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/010_qintopia_2026_catalog_pricing_and_free_stays.sql"), "utf8");
        await client.query(migration010);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('010_qintopia_2026_catalog_pricing_and_free_stays.sql')");
        await client.query(`
          INSERT INTO members(id, identity_card_number, full_name, phone, wechat)
          VALUES ('member_historical_identity', 'HISTORICAL-MEMBER-ID', 'Historical Member', '13900008881', 'historical-member');
          INSERT INTO member_contracts(id, property_id, member_id, member_name, status, valid_from, valid_until, version)
          VALUES ('contract_historical_identity', '${demo.propertyId}', 'member_historical_identity', 'Historical Member', 'ACTIVE', '2028-01-01', '2030-12-31', 1);
          INSERT INTO quotes(id, property_id, inventory_unit_id, stay_type, arrival_date, departure_date, policy_version_id, member_contract_id, input_hash, coverage_set, cash_lines, cash_remainder_minor, current_contract_amount_minor, currency, expires_at)
          VALUES ('quote_historical_member_identity', '${demo.propertyId}', '${demo.roomId}', 'TRANSIENT', '2029-01-01', '2029-01-02', '${demo.transientPolicyId}', 'contract_historical_identity', repeat('9', 64), '[]'::jsonb, '[]'::jsonb, 12000, 12000, 'CNY', '2035-01-01T00:00:00Z');
          INSERT INTO orders(id, property_id, status, stay_type, arrival_date, departure_date, primary_guest_snapshot, pricing_policy_version_id, member_contract_id, current_revision_id, version, booking_channel_code, channel_order_reference, free_stay_reason)
          VALUES ('order_historical_member_identity', '${demo.propertyId}', 'RESERVED', 'TRANSIENT', '2029-01-01', '2029-01-02', '{"fullName":"Historical Member Guest","nickname":"Historical Member"}'::jsonb, '${demo.transientPolicyId}', 'contract_historical_identity', NULL, 1, 'CTRIP', 'HISTORICAL-MEMBER-ORDER', NULL);
        `);
        const migration011 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/011_core_fact_shape_guards.sql"), "utf8");
        await client.query(migration011);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('011_core_fact_shape_guards.sql')");
        const migration012 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/012_legacy_demo_inventory_catalog_backfill.sql"), "utf8");
        await client.query(migration012);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('012_legacy_demo_inventory_catalog_backfill.sql')");
        const migration013 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/013_room_status_operations.sql"), "utf8");
        await client.query(migration013);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('013_room_status_operations.sql')");
        const migration014 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/014_new_order_primary_guest_nickname.sql"), "utf8");
        await client.query(migration014);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('014_new_order_primary_guest_nickname.sql')");
        const migration015 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/015_generated_room_operational_codes.sql"), "utf8");
        await client.query(migration015);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('015_generated_room_operational_codes.sql')");
        const migration016 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/016_member_property_links.sql"), "utf8");
        await client.query(migration016);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('016_member_property_links.sql')");
        const migration017 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/017_membership_orders.sql"), "utf8");
        await client.query(migration017);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('017_membership_orders.sql')");
        const migration018 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/018_member_stay_identity_and_coverage_guards.sql"), "utf8");
        await client.query(migration018);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('018_member_stay_identity_and_coverage_guards.sql')");
        const migration019 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/019_member_stay_booking_channel_rules.sql"), "utf8");
        await client.query(migration019);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('019_member_stay_booking_channel_rules.sql')");
        const migration020 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/020_whole_room_occupants.sql"), "utf8");
        await client.query(migration020);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('020_whole_room_occupants.sql')");
        const migration021 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/021_defer_internal_use.sql"), "utf8");
        await client.query(migration021);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('021_defer_internal_use.sql')");
        const migration022 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/022_order_occupant_corrections.sql"), "utf8");
        await client.query(migration022);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('022_order_occupant_corrections.sql')");
        const migration023 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/023_collection_fact_pricing_revision.sql"), "utf8");
        await client.query(migration023);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('023_collection_fact_pricing_revision.sql')");
        const migration024 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/024_free_stay_category_code.sql"), "utf8");
        await client.query(migration024);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('024_free_stay_category_code.sql')");
        const migration025 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/025_channel_order_atomic_pricing.sql"), "utf8");
        await client.query(migration025);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('025_channel_order_atomic_pricing.sql')");
        const legacyMoney = (minorUnits: number) => ({ currency: "CNY", minorUnits });
        const legacyPricing = {
          coverageSet: [],
          cashLines: [],
          cashRemainder: legacyMoney(11_600),
          currentContractAmount: legacyMoney(11_600)
        };
        const legacyPricingDecision = {
          pricingBasis: "POLICY",
          policyBaseAmount: legacyMoney(11_600),
          targetCurrentContractAmount: legacyMoney(11_600),
          differenceFromPolicy: legacyMoney(0),
          manualAdjustmentMinor: 0,
          differenceExceedsThreshold: false,
          reason: { code: "STAY_CHANGE_POLICY", note: "" }
        };
        const legacyStayChangeEffect = {
          operation: "RESCHEDULE_STAY",
          orderId: "order_legacy_stage9",
          stayId: "stay_legacy_stage9",
          inventoryUnitId: demo.roomId,
          before: {
            arrivalDate: "2026-07-28",
            departureDate: "2026-07-30",
            nights: 2,
            currentContractAmount: legacyMoney(11_600)
          },
          after: {
            arrivalDate: "2026-07-29",
            departureDate: "2026-07-31",
            nights: 2,
            stayTimeline: [
              { serviceDate: "2026-07-29", inventoryUnitId: demo.roomId },
              { serviceDate: "2026-07-30", inventoryUnitId: demo.roomId }
            ],
            pricing: legacyPricing
          },
          pricingDecision: legacyPricingDecision,
          inventoryChange: {
            preservedDates: ["2026-07-29"],
            releasedDates: ["2026-07-28"],
            addedDates: ["2026-07-30"]
          },
          entitlementChange: {
            preservedCoverageDates: [],
            releasedCoverageDates: [],
            addedCoverageDates: [],
            consumedCoverageDates: []
          },
          fundsSummary: {
            netRecordedCollection: legacyMoney(0),
            collectionDifference: legacyMoney(11_600)
          }
        };
        const legacyShortenEffect = {
          operation: "SHORTEN_STAY",
          orderId: "order_legacy_stage10",
          stayId: "stay_legacy_stage10",
          inventoryUnitId: demo.roomId,
          businessDate: "2026-07-30",
          completionMode: "SHORTEN_IN_HOUSE",
          before: {
            arrivalDate: "2026-07-28",
            departureDate: "2026-08-02",
            nights: 5,
            currentContractAmount: legacyMoney(29_000)
          },
          after: {
            arrivalDate: "2026-07-28",
            departureDate: "2026-07-31",
            nights: 3,
            stayTimeline: [
              { serviceDate: "2026-07-28", inventoryUnitId: demo.roomId },
              { serviceDate: "2026-07-29", inventoryUnitId: demo.roomId },
              { serviceDate: "2026-07-30", inventoryUnitId: demo.roomId }
            ],
            pricing: { ...legacyPricing, cashRemainder: legacyMoney(17_400), currentContractAmount: legacyMoney(17_400) }
          },
          pricingDecision: {
            ...legacyPricingDecision,
            policyBaseAmount: legacyMoney(17_400),
            targetCurrentContractAmount: legacyMoney(17_400)
          },
          inventoryChange: {
            preservedDates: ["2026-07-28", "2026-07-29", "2026-07-30"],
            releasedDates: ["2026-07-31", "2026-08-01"],
            addedDates: []
          },
          entitlementSummary: {
            currentConsumedCoverageDates: [],
            retainedHistoricalConsumedCoverageDates: [],
            ledgerWriteCount: 0
          },
          fundsSummary: {
            netRecordedCollection: legacyMoney(0),
            collectionDifference: legacyMoney(17_400),
            factCount: 0
          },
          refundReferenceAmount: legacyMoney(0)
        };
        const legacyUnit = (id: string, code: string) => ({
          id,
          propertyId: demo.propertyId,
          kind: "ROOM",
          roomId: id,
          code,
          name: `Room ${code}`,
          catalogVersion: null,
          buildingCode: null,
          roomTypeCode: null,
          pricingProductCode: null,
          inventoryBasis: null,
          codeProvenance: null,
          physicalBedCount: null
        });
        const legacyMoveEffect = {
          orderId: "order_legacy_stage10_move",
          fromInventoryUnit: legacyUnit(demo.roomId, "101"),
          toInventoryUnit: legacyUnit(demo.secondRoomId, "102"),
          effectiveDate: "2026-07-30",
          occupantCount: 1,
          occupancyCapacity: 4,
          stayTimeline: [
            { serviceDate: "2026-07-29", inventoryUnitId: demo.roomId },
            { serviceDate: "2026-07-30", inventoryUnitId: demo.secondRoomId }
          ],
          pricing: legacyPricing
        };
        const legacyFixtures = [
          {
            suffix: "stage9",
            commandType: "RESCHEDULE_STAY",
            protocolVersion: "LEGACY_STAGE_9_10",
            effect: legacyStayChangeEffect,
            input: {
              propertyId: demo.propertyId,
              orderId: legacyStayChangeEffect.orderId,
              newArrivalDate: legacyStayChangeEffect.after.arrivalDate,
              newDepartureDate: legacyStayChangeEffect.after.departureDate
            },
            result: {
              orderId: legacyStayChangeEffect.orderId,
              stayId: legacyStayChangeEffect.stayId,
              amendmentId: "amend_legacy_stage9",
              staySegmentId: "segment_legacy_stage9",
              pricingRevisionId: "revision_legacy_stage9",
              arrivalDate: legacyStayChangeEffect.after.arrivalDate,
              departureDate: legacyStayChangeEffect.after.departureDate,
              before: legacyStayChangeEffect.before,
              after: legacyStayChangeEffect.after,
              pricingDecision: legacyStayChangeEffect.pricingDecision,
              inventoryChange: legacyStayChangeEffect.inventoryChange,
              entitlementChange: legacyStayChangeEffect.entitlementChange,
              fundsSummary: legacyStayChangeEffect.fundsSummary
            }
          },
          {
            suffix: "stage10",
            commandType: "SHORTEN_STAY",
            protocolVersion: "LEGACY_STAGE_10",
            effect: legacyShortenEffect,
            input: {
              propertyId: demo.propertyId,
              orderId: legacyShortenEffect.orderId,
              newDepartureDate: legacyShortenEffect.after.departureDate
            },
            result: {
              orderId: legacyShortenEffect.orderId,
              stayId: legacyShortenEffect.stayId,
              arrangementAmendmentId: "amend_legacy_stage10",
              checkoutAmendmentId: null,
              staySegmentId: "segment_legacy_stage10",
              pricingRevisionId: "revision_legacy_stage10",
              completionMode: legacyShortenEffect.completionMode,
              arrivalDate: legacyShortenEffect.after.arrivalDate,
              departureDate: legacyShortenEffect.after.departureDate,
              before: legacyShortenEffect.before,
              after: legacyShortenEffect.after,
              pricingDecision: legacyShortenEffect.pricingDecision,
              inventoryChange: legacyShortenEffect.inventoryChange,
              entitlementSummary: legacyShortenEffect.entitlementSummary,
              fundsSummary: legacyShortenEffect.fundsSummary,
              refundReferenceAmount: legacyShortenEffect.refundReferenceAmount,
              fulfillmentTiming: null
            }
          },
          {
            suffix: "pre_stage11",
            commandType: "MOVE_UNIT",
            protocolVersion: "PRE_STAGE_11",
            effect: legacyMoveEffect,
            input: {
              propertyId: demo.propertyId,
              orderId: legacyMoveEffect.orderId,
              newInventoryUnitId: legacyMoveEffect.toInventoryUnit.id,
              effectiveDate: legacyMoveEffect.effectiveDate
            },
            result: {
              orderId: legacyMoveEffect.orderId,
              amendmentId: "amend_legacy_stage10_move",
              staySegmentId: "segment_legacy_stage10_move",
              pricingRevisionId: "revision_legacy_stage10_move"
            }
          }
        ] as const;
        for (const fixture of legacyFixtures) {
          const previewId = `preview_legacy_${fixture.suffix}`;
          const previewCommandId = `command_preview_legacy_${fixture.suffix}`;
          const commandId = `command_legacy_${fixture.suffix}`;
          const confirmation = {
            propertyId: demo.propertyId,
            commandType: fixture.commandType,
            confirmation: true,
            expectedEffectHash: "9".repeat(64),
            reason: { code: "HISTORICAL_EXACT_REPLAY", note: "历史命令精确重放" }
          };
          const preview = {
            previewId,
            commandType: fixture.commandType,
            effectHash: "9".repeat(64),
            effect: fixture.effect,
            expiresAt: "2035-01-01T00:00:00.000Z"
          };
          await client.query(`
            INSERT INTO command_previews(
              id, subject_id, property_id, command_type, normalized_input, input_hash,
              effect, effect_hash, basis_versions, expires_at, status
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, repeat('9', 64), '{}'::jsonb, '2035-01-01T00:00:00Z', 'OPEN')
          `, [
            previewId,
            demo.agentSubjectId,
            demo.propertyId,
            fixture.commandType,
            JSON.stringify(fixture.input),
            stableHash(fixture.input),
            JSON.stringify(fixture.effect)
          ]);
          await client.query(`
            INSERT INTO command_executions(
              id, subject_id, credential_id, property_id, command_type, idempotency_key,
              request_hash, correlation_id, state, completed_at
            ) VALUES
              ($1, $2, 'token_demo_write', $3, $4, $5, $6, $5, 'APPLIED', now()),
              ($7, $2, 'token_demo_write', $3, $8, $9, $10, $9, 'APPLIED', now())
          `, [
            previewCommandId,
            demo.agentSubjectId,
            demo.propertyId,
            `PREVIEW:${fixture.commandType}`,
            `legacy-preview-${fixture.suffix}`,
            stableHash({ commandType: fixture.commandType, input: fixture.input }),
            commandId,
            fixture.commandType,
            `legacy-command-${fixture.suffix}`,
            stableHash({ previewId, confirmation })
          ]);
          await client.query(`
            INSERT INTO command_receipts(
              id, command_id, execution_status, business_committed, result, error,
              resource_refs, fact_refs, committed_at
            ) VALUES
              ($1, $2, 'EXECUTED', true, $3::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, now()),
              ($4, $5, 'EXECUTED', true, $6::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, now())
          `, [
            `receipt_preview_legacy_${fixture.suffix}`,
            previewCommandId,
            JSON.stringify({ preview }),
            `receipt_legacy_${fixture.suffix}`,
            commandId,
            JSON.stringify(fixture.result)
          ]);
        }
        await client.query(`
          INSERT INTO command_executions(
            id, subject_id, credential_id, property_id, command_type, idempotency_key,
            request_hash, correlation_id, state, completed_at, created_at
          ) VALUES (
            'command_post_epoch_legacy_shape', $1, 'token_demo_write', $2, 'RESCHEDULE_STAY',
            'post-epoch-legacy-shape', repeat('3', 64), 'post-epoch-legacy-shape', 'APPLIED',
            '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
          )
        `, [demo.agentSubjectId, demo.propertyId]);
        await client.query(`
          INSERT INTO command_receipts(
            id, command_id, execution_status, business_committed, result, error,
            resource_refs, fact_refs, committed_at, created_at
          ) VALUES (
            'receipt_post_epoch_legacy_shape', 'command_post_epoch_legacy_shape',
            'EXECUTED', true, $1::jsonb, NULL, '[]'::jsonb, '[]'::jsonb,
            '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
          )
        `, [JSON.stringify(legacyFixtures[0].result)]);
        const historicalOrderLegacyMoveEffect = {
          ...legacyMoveEffect,
          orderId: "order_historical_nulls",
          effectiveDate: "2029-02-01",
          stayTimeline: [{ serviceDate: "2029-02-01", inventoryUnitId: demo.secondRoomId }],
          pricing: {
            coverageSet: [],
            cashLines: [],
            cashRemainder: legacyMoney(0),
            currentContractAmount: legacyMoney(0)
          }
        };
        await client.query(`
          INSERT INTO amendments(
            id, order_id, sequence, amendment_type, reason_code, reason_note,
            prior_version, new_version, payload, command_id, created_at
          ) VALUES (
            'amend_historical_legacy_move', 'order_historical_nulls', 2, 'MOVE_UNIT',
            'ROOM_MOVE', '迁移前历史换房', 1, 2, $1::jsonb, NULL, now()
          )
        `, [JSON.stringify(historicalOrderLegacyMoveEffect)]);
        await client.query(`
          INSERT INTO stay_segments(
            id, stay_id, sequence, inventory_unit_id, arrival_date, departure_date,
            segment_type, supersedes_segment_id, amendment_id
          ) VALUES (
            'segment_historical_legacy_move', 'stay_historical_nulls', 2, $1,
            '2029-02-01', '2029-02-02', 'MOVE', 'segment_historical_nulls',
            'amend_historical_legacy_move'
          )
        `, [demo.secondRoomId]);
        await client.query(`
          INSERT INTO pricing_revisions(
            id, order_id, revision_no, amendment_id, policy_version_id,
            arrival_date, departure_date, coverage_set, cash_lines,
            policy_base_amount_minor, pricing_basis, manual_adjustment_minor,
            current_contract_amount_minor, currency, created_at
          )
          SELECT
            'revision_historical_legacy_move', order_id, 2, 'amend_historical_legacy_move',
            policy_version_id, arrival_date, departure_date, coverage_set, cash_lines,
            policy_base_amount_minor, pricing_basis, manual_adjustment_minor,
            current_contract_amount_minor, currency, now()
          FROM pricing_revisions
          WHERE id = 'revision_historical_nulls'
        `);
        await client.query(`
          UPDATE inventory_claims
          SET active = false, released_at = now()
          WHERE id = 'claim_historical_nulls'
        `);
        await client.query(`
          INSERT INTO inventory_claims(
            id, property_id, room_id, inventory_unit_id, service_date,
            source_type, source_id, active, released_at
          ) VALUES (
            'claim_historical_legacy_move', $1, $2, $2, '2029-02-01',
            'ORDER_SEGMENT', 'segment_historical_legacy_move', true, NULL
          )
        `, [demo.propertyId, demo.secondRoomId]);
        await client.query(`
          UPDATE orders
          SET current_revision_id = 'revision_historical_legacy_move', version = 2
          WHERE id = 'order_historical_nulls'
        `);
        const migration026 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/026_stage9_stay_change_guards.sql"), "utf8");
        await client.query(migration026);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('026_stage9_stay_change_guards.sql')");
        const migration027 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/027_stage10_stay_shortening_guards.sql"), "utf8");
        await client.query(migration027);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('027_stage10_stay_shortening_guards.sql')");
        const migration028 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/028_stage11_move_unit_guards.sql"), "utf8");
        await client.query(migration028);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('028_stage11_move_unit_guards.sql')");
        const migration029 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/029_stage12_terminal_order_guards.sql"), "utf8");
        await client.query(migration029);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('029_stage12_terminal_order_guards.sql')");
        const migration030 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/030_collection_fact_historical_pricing_revision.sql"), "utf8");
        await client.query(migration030);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('030_collection_fact_historical_pricing_revision.sql')");
        const migration031 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/031_collection_fact_method_transaction_rules.sql"), "utf8");
        await client.query(migration031);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('031_collection_fact_method_transaction_rules.sql')");
        const migration032 = await readFile(resolve(process.cwd(), "packages/db/src/migrations/032_wecom_refund_original_route.sql"), "utf8");
        await client.query(migration032);
        await client.query("INSERT INTO schema_migrations(name) VALUES ('032_wecom_refund_original_route.sql')");
        await client.query("ALTER TABLE collection_facts DISABLE TRIGGER collection_facts_append_only");
        await client.query("UPDATE collection_facts SET pricing_revision_id = NULL WHERE fact_id = 'fact_historical_nulls'");
        await client.query("ALTER TABLE collection_facts ENABLE TRIGGER collection_facts_append_only");
      } finally {
        await client.end();
      }

      const historicalNicknameSnapshots = await historicalDb.selectFrom("orders")
        .select(["id", "primary_guest_snapshot"])
        .where("id", "in", ["order_historical_nulls", "order_historical_explicit_null"])
        .orderBy("id")
        .execute();
      expect(historicalNicknameSnapshots).toEqual([
        {
          id: "order_historical_explicit_null",
          primary_guest_snapshot: { fullName: "Historical Explicit Null Guest", nickname: null }
        },
        {
          id: "order_historical_nulls",
          primary_guest_snapshot: { fullName: "Historical Null Guest" }
        }
      ]);
      expect(await historicalDb.selectFrom("order_occupants")
        .select(["order_id", "ordinal", "role", "full_name", "nickname"])
        .where("order_id", "in", ["order_historical_nulls", "order_historical_explicit_null"])
        .orderBy("order_id")
        .execute()).toEqual([
        {
          order_id: "order_historical_explicit_null",
          ordinal: 1,
          role: "PRIMARY",
          full_name: "Historical Explicit Null Guest",
          nickname: null
        },
        {
          order_id: "order_historical_nulls",
          ordinal: 1,
          role: "PRIMARY",
          full_name: "Historical Null Guest",
          nickname: null
        }
      ]);
      const historicalMemberIdentities = await historicalDb.selectFrom("orders")
        .select(["id", "member_id"])
        .where("id", "in", ["order_historical_member_identity", "order_historical_nulls", "order_historical_explicit_null"])
        .orderBy("id")
        .execute();
      expect(historicalMemberIdentities).toEqual([
        { id: "order_historical_explicit_null", member_id: null },
        { id: "order_historical_member_identity", member_id: "member_historical_identity" },
        { id: "order_historical_nulls", member_id: null }
      ]);
      expect(await historicalDb.selectFrom("quotes").select(["id", "member_id"])
        .where("id", "=", "quote_historical_member_identity").executeTakeFirstOrThrow())
        .toEqual({ id: "quote_historical_member_identity", member_id: "member_historical_identity" });
      const historicalOrderCountBeforeRejectedInsert = await historicalDb.selectFrom("orders")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      await expect(historicalDb.insertInto("orders").values({
        id: "order_post_migration_missing_nickname",
        property_id: demo.propertyId,
        status: "RESERVED",
        stay_type: "FREE",
        arrival_date: "2029-02-05",
        departure_date: "2029-02-06",
        primary_guest_snapshot: { fullName: "Post-migration missing nickname probe" },
        booking_channel_code: null,
        channel_order_reference: null,
        free_stay_reason: "Post-migration nickname guard fixture",
        free_stay_category_code: "VOLUNTEER",
        pricing_policy_version_id: demo.freePolicyId,
        member_contract_id: null,
        current_revision_id: null,
        version: 1
      }).execute()).rejects.toMatchObject({ constraint: "orders_new_primary_guest_nickname_required" });
      const historicalOrderCountAfterRejectedInsert = await historicalDb.selectFrom("orders")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      expect(Number(historicalOrderCountAfterRejectedInsert.count)).toBe(Number(historicalOrderCountBeforeRejectedInsert.count));

      const upgradedLegacyUnits = await historicalDb.selectFrom("inventory_units")
        .select([
          "id",
          "catalog_version",
          "building_code",
          "room_type_code",
          "pricing_product_code",
          "inventory_basis",
          "code_provenance",
          "physical_bed_count",
          "occupancy_capacity"
        ])
        .where("id", "in", [demo.roomId, demo.secondRoomId, demo.bedAId, demo.bedBId])
        .orderBy("id")
        .execute();
      expect(upgradedLegacyUnits).toEqual([
        {
          id: demo.roomId,
          catalog_version: "qintopia-2026-feishu-revision-561-user-confirmed-v4",
          building_code: "1",
          room_type_code: "shared_bath_quad",
          pricing_product_code: "shared_bath_quad_whole_room",
          inventory_basis: "WHOLE_ROOM_COMBINATION",
          code_provenance: "SOURCE_EXPLICIT",
          physical_bed_count: 4
          , occupancy_capacity: 4
        },
        {
          id: demo.bedAId,
          catalog_version: "qintopia-2026-feishu-revision-561-user-confirmed-v4",
          building_code: "1",
          room_type_code: "shared_bath_quad",
          pricing_product_code: "shared_bath_quad_bed",
          inventory_basis: "INDEPENDENT",
          code_provenance: "SOURCE_EXPLICIT",
          physical_bed_count: null
          , occupancy_capacity: 1
        },
        {
          id: demo.bedBId,
          catalog_version: "qintopia-2026-feishu-revision-561-user-confirmed-v4",
          building_code: "1",
          room_type_code: "shared_bath_quad",
          pricing_product_code: "shared_bath_quad_bed",
          inventory_basis: "INDEPENDENT",
          code_provenance: "SOURCE_EXPLICIT",
          physical_bed_count: null
          , occupancy_capacity: 1
        },
        {
          id: demo.secondRoomId,
          catalog_version: "qintopia-2026-feishu-revision-561-user-confirmed-v4",
          building_code: "1",
          room_type_code: "shared_bath_quad",
          pricing_product_code: "shared_bath_quad_whole_room",
          inventory_basis: "WHOLE_ROOM_COMBINATION",
          code_provenance: "SOURCE_EXPLICIT",
          physical_bed_count: 4
          , occupancy_capacity: 4
        }
      ]);

      await seedDemo(historicalDb, { includeProtocolFixturePolicy: true });
      const [rooms, beds, baseUnits, combinations, physicalBeds] = await Promise.all([
        historicalDb.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("property_id", "=", demo.propertyId).where("kind", "=", "ROOM").executeTakeFirstOrThrow(),
        historicalDb.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("property_id", "=", demo.propertyId).where("kind", "=", "BED").executeTakeFirstOrThrow(),
        historicalDb.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("property_id", "=", demo.propertyId).where("inventory_basis", "=", "INDEPENDENT").executeTakeFirstOrThrow(),
        historicalDb.selectFrom("inventory_units").select(({ fn }) => fn.countAll<number>().as("count")).where("property_id", "=", demo.propertyId).where("inventory_basis", "=", "WHOLE_ROOM_COMBINATION").executeTakeFirstOrThrow(),
        historicalDb.selectFrom("inventory_units").select(({ fn }) => fn.sum<number>("physical_bed_count").as("count")).where("property_id", "=", demo.propertyId).where("kind", "=", "ROOM").executeTakeFirstOrThrow()
      ]);
      expect([
        Number(rooms.count),
        Number(beds.count),
        Number(baseUnits.count),
        Number(combinations.count),
        Number(physicalBeds.count)
      ]).toEqual([44, 46, 77, 13, 91]);

      const upgradedBedQuotes = await Promise.all([demo.bedAId, demo.bedBId].map((inventoryUnitId) => createQuote(historicalDb!, {
        propertyId: demo.propertyId,
        inventoryUnitId,
        stayType: "TRANSIENT",
        arrivalDate: "2026-02-25",
        departureDate: "2026-02-26",
        pricingPolicyVersionId: demo.publicPricingPolicyId
      })));
      expect(upgradedBedQuotes.map((quote) => quote.currentContractAmount.minorUnits)).toEqual([5_800, 5_800]);
      await expect(historicalDb.updateTable("inventory_units")
        .set({ physical_bed_count: 2 })
        .where("id", "=", demo.roomId)
        .execute()).rejects.toMatchObject({ code: "55000" });

      const view = await getOrderView(historicalDb, "order_historical_nulls");
      expect(view.order.booking_channel_code).toBeNull();
      expect(view.order.channel_order_reference).toBeNull();
      expect(view.order.primary_guest_snapshot).toEqual({ fullName: "Historical Null Guest" });
      expect(view.collectionFacts[0]).toMatchObject({
        amount_minor: 100,
        net_effect_minor: 90,
        currency: "USD",
        transaction_reference: null,
        pricing_revision_id: null
      });
      expect(await databaseReady(historicalDb)).toBe(true);

      const app = await buildServer(historicalDb);
      await app.ready();
      try {
        const detail = await app.inject({
          method: "GET",
          url: "/api/v1/orders/order_historical_nulls",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json()).toMatchObject({
          order: { booking_channel_code: null, channel_order_reference: null, free_stay_category_code: null },
          collectionFacts: [{ transaction_reference: null, pricing_revision_id: null }],
          amendments: [{}, {
            id: "amend_historical_legacy_move",
            protocolVersion: "PRE_STAGE_11",
            recoveryMode: "HISTORICAL_READ_ONLY"
          }],
          effectiveArrangement: {
            intervals: [{
              inventoryUnitId: demo.secondRoomId,
              arrivalDate: "2029-02-01",
              departureDate: "2029-02-02"
            }]
          }
        });
        expect(Object.hasOwn(detail.json().order.primary_guest_snapshot, "nickname")).toBe(false);
        const fact = await app.inject({
          method: "GET",
          url: "/api/v1/facts/fact_historical_nulls",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(fact.statusCode, fact.body).toBe(200);
        expect(fact.json()).toMatchObject({ fact_id: "fact_historical_nulls", transaction_reference: null, pricing_revision_id: null });

        const historicalCreatePreview = await app.inject({
          method: "GET",
          url: "/api/v1/command-previews/preview_historical_create",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(historicalCreatePreview.statusCode, historicalCreatePreview.body).toBe(200);
        const historicalCreateEffect = historicalCreatePreview.json().effect;
        expect(historicalCreateEffect).toMatchObject({
          primaryGuest: { fullName: "Historical Preview Guest" },
          bookingChannelCode: null,
          channelOrderReference: null
        });
        expect(Object.hasOwn(historicalCreateEffect.primaryGuest, "nickname")).toBe(false);
        const historicalCollectionPreview = await app.inject({
          method: "GET",
          url: "/api/v1/command-previews/preview_historical_collection",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(historicalCollectionPreview.statusCode, historicalCollectionPreview.body).toBe(200);
        expect(historicalCollectionPreview.json().effect).toMatchObject({ transactionReference: null });
        const historicalCreatePreviewReceipt = await app.inject({
          method: "GET",
          url: "/api/v1/receipts/receipt_historical_preview_create",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(historicalCreatePreviewReceipt.statusCode, historicalCreatePreviewReceipt.body).toBe(200);
        const historicalReceiptEffect = historicalCreatePreviewReceipt.json().result.preview.effect;
        expect(historicalReceiptEffect).toMatchObject({
          primaryGuest: { fullName: "Historical Preview Guest" },
          bookingChannelCode: null,
          channelOrderReference: null
        });
        expect(Object.hasOwn(historicalReceiptEffect.primaryGuest, "nickname")).toBe(false);

        const explicitNullDetail = await app.inject({
          method: "GET",
          url: "/api/v1/orders/order_historical_explicit_null",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(explicitNullDetail.statusCode, explicitNullDetail.body).toBe(200);
        expect(Object.hasOwn(explicitNullDetail.json().order.primary_guest_snapshot, "nickname")).toBe(true);
        expect(explicitNullDetail.json().order.primary_guest_snapshot.nickname).toBeNull();
        const explicitNullPreview = await app.inject({
          method: "GET",
          url: "/api/v1/command-previews/preview_historical_create_explicit_null",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(explicitNullPreview.statusCode, explicitNullPreview.body).toBe(200);
        expect(Object.hasOwn(explicitNullPreview.json().effect.primaryGuest, "nickname")).toBe(true);
        expect(explicitNullPreview.json().effect.primaryGuest.nickname).toBeNull();
        const explicitNullPreviewReceipt = await app.inject({
          method: "GET",
          url: "/api/v1/receipts/receipt_historical_preview_create_explicit_null",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(explicitNullPreviewReceipt.statusCode, explicitNullPreviewReceipt.body).toBe(200);
        expect(Object.hasOwn(explicitNullPreviewReceipt.json().result.preview.effect.primaryGuest, "nickname")).toBe(true);
        expect(explicitNullPreviewReceipt.json().result.preview.effect.primaryGuest.nickname).toBeNull();

        const historicalCollectionPreviewReceipt = await app.inject({
          method: "GET",
          url: "/api/v1/receipts/receipt_historical_preview_collection",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(historicalCollectionPreviewReceipt.statusCode, historicalCollectionPreviewReceipt.body).toBe(200);
        expect(historicalCollectionPreviewReceipt.json().result.preview.effect).toMatchObject({ transactionReference: null });

        for (const [receiptId, expected] of [
          ["receipt_historical_create", { primaryGuest: null, bookingChannelCode: null, channelOrderReference: null }],
          ["receipt_historical_collection", { factType: "COLLECTION", transactionReference: null }],
          ["receipt_historical_refund", { factType: "REFUND", transactionReference: null }],
          ["receipt_historical_reversal", { factType: "REVERSAL", transactionReference: null }]
        ] as const) {
          const response = await app.inject({
            method: "GET",
            url: `/api/v1/receipts/${receiptId}`,
            headers: { authorization: `Bearer ${demo.writeToken}` }
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().result).toMatchObject(expected);
        }
        const historicalCommand = await app.inject({
          method: "GET",
          url: "/api/v1/commands/command_historical_reversal_receipt",
          headers: { authorization: `Bearer ${demo.writeToken}` }
        });
        expect(historicalCommand.statusCode, historicalCommand.body).toBe(200);
        expect(historicalCommand.json().result).toMatchObject({ factType: "REVERSAL", transactionReference: null });

        const historicalPreviewFactsBeforeConfirm = await historicalDb.selectFrom("command_previews")
          .select(["id", "normalized_input", "input_hash", "effect", "effect_hash", "status", "used_at"])
          .where("id", "in", ["preview_legacy_stage9", "preview_legacy_stage10", "preview_legacy_pre_stage11"])
          .orderBy("id")
          .execute();
        for (const fixture of [
          {
            suffix: "stage9",
            commandType: "RESCHEDULE_STAY",
            protocolVersion: "LEGACY_STAGE_9_10",
            input: {
              propertyId: demo.propertyId,
              orderId: "order_legacy_stage9",
              newArrivalDate: "2026-07-29",
              newDepartureDate: "2026-07-31"
            }
          },
          {
            suffix: "stage10",
            commandType: "SHORTEN_STAY",
            protocolVersion: "LEGACY_STAGE_10",
            input: {
              propertyId: demo.propertyId,
              orderId: "order_legacy_stage10",
              newDepartureDate: "2026-07-31"
            }
          },
          {
            suffix: "pre_stage11",
            commandType: "MOVE_UNIT",
            protocolVersion: "PRE_STAGE_11",
            input: {
              propertyId: demo.propertyId,
              orderId: "order_legacy_stage10_move",
              newInventoryUnitId: demo.secondRoomId,
              effectiveDate: "2026-07-30"
            }
          }
        ] as const) {
          const previewId = `preview_legacy_${fixture.suffix}`;
          const replayConfirmation = {
            propertyId: demo.propertyId,
            commandType: fixture.commandType,
            confirmation: true,
            expectedEffectHash: "9".repeat(64),
            reason: { code: "HISTORICAL_EXACT_REPLAY", note: "历史命令精确重放" }
          };
          const replayedPreview = await app.inject({
            method: "POST",
            url: "/api/v1/command-previews",
            headers: {
              authorization: `Bearer ${demo.writeToken}`,
              "content-type": "application/json",
              "idempotency-key": `legacy-preview-${fixture.suffix}`,
              "x-correlation-id": `legacy-preview-replay-${fixture.suffix}`
            },
            payload: { commandType: fixture.commandType, input: fixture.input }
          });
          expect(replayedPreview.statusCode, replayedPreview.body).toBe(200);
          expect(replayedPreview.json()).toMatchObject({
            preview: { previewId, commandType: fixture.commandType },
            receipt: {
              protocolVersion: fixture.protocolVersion,
              recoveryMode: "HISTORICAL_READ_ONLY"
            }
          });

          const replayedConfirm = await app.inject({
            method: "POST",
            url: `/api/v1/command-previews/${previewId}/confirm`,
            headers: {
              authorization: `Bearer ${demo.writeToken}`,
              "content-type": "application/json",
              "idempotency-key": `legacy-command-${fixture.suffix}`,
              "x-correlation-id": `legacy-command-replay-${fixture.suffix}`
            },
            payload: replayConfirmation
          });
          expect(replayedConfirm.statusCode, replayedConfirm.body).toBe(200);
          expect(replayedConfirm.json()).toMatchObject({
            protocolVersion: fixture.protocolVersion,
            recoveryMode: "HISTORICAL_READ_ONLY"
          });

          const previewResponse = await app.inject({
            method: "GET",
            url: `/api/v1/command-previews/${previewId}`,
            headers: { authorization: `Bearer ${demo.writeToken}` }
          });
          expect(previewResponse.statusCode, previewResponse.body).toBe(200);
          expect(previewResponse.json()).toMatchObject({
            command_type: fixture.commandType,
            protocolVersion: fixture.protocolVersion,
            recoveryMode: "HISTORICAL_READ_ONLY",
            confirmable: false
          });

          for (const url of [
            `/api/v1/receipts/receipt_legacy_${fixture.suffix}`,
            `/api/v1/receipts/receipt_preview_legacy_${fixture.suffix}`,
            `/api/v1/commands/command_legacy_${fixture.suffix}`,
            `/api/v1/command-results?propertyId=${demo.propertyId}&commandType=${fixture.commandType}&idempotencyKey=legacy-command-${fixture.suffix}`
          ]) {
            const response = await app.inject({
              method: "GET",
              url,
              headers: { authorization: `Bearer ${demo.writeToken}` }
            });
            expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
            expect(response.json()).toMatchObject({
              protocolVersion: fixture.protocolVersion,
              recoveryMode: "HISTORICAL_READ_ONLY"
            });
          }

          const rejectedConfirm = await app.inject({
            method: "POST",
            url: `/api/v1/command-previews/${previewId}/confirm`,
            headers: {
              authorization: `Bearer ${demo.writeToken}`,
              "content-type": "application/json",
              "idempotency-key": `legacy-confirm-${fixture.suffix}`,
              "x-correlation-id": `legacy-confirm-${fixture.suffix}`
            },
            payload: {
              propertyId: demo.propertyId,
              commandType: fixture.commandType,
              confirmation: true,
              expectedEffectHash: "9".repeat(64),
              reason: { code: "HISTORICAL_REPLAY_PROBE", note: "历史预览只读验证" }
            }
          });
          expect(rejectedConfirm.statusCode, rejectedConfirm.body).toBe(409);
          expect(rejectedConfirm.json().error?.code).toBe("PREVIEW_STALE");
        }
        const historicalPreviewFactsAfterConfirm = await historicalDb.selectFrom("command_previews")
          .select(["id", "normalized_input", "input_hash", "effect", "effect_hash", "status", "used_at"])
          .where("id", "in", ["preview_legacy_stage9", "preview_legacy_stage10", "preview_legacy_pre_stage11"])
          .orderBy("id")
          .execute();
        expect(historicalPreviewFactsAfterConfirm).toEqual(historicalPreviewFactsBeforeConfirm);
        expect(historicalPreviewFactsAfterConfirm.every((preview) => preview.status === "OPEN" && preview.used_at === null)).toBe(true);

        const legacyStoredBefore = await historicalDb.selectFrom("command_previews")
          .select(["id", "effect"])
          .where("id", "in", ["preview_legacy_stage9", "preview_legacy_stage10", "preview_legacy_pre_stage11"])
          .orderBy("id")
          .execute();
        const legacyEffectsById = new Map(legacyStoredBefore.map((row) => [row.id, row.effect]));
        const postEpochLegacyEffect = legacyEffectsById.get("preview_legacy_stage9") as Record<string, unknown>;
        expect(postEpochLegacyEffect).toMatchObject({ operation: "RESCHEDULE_STAY" });
        expect(Object.hasOwn(postEpochLegacyEffect.before as object, "stayTimeline")).toBe(false);
        expect(legacyEffectsById.get("preview_legacy_stage10")).toMatchObject({ operation: "SHORTEN_STAY" });
        expect(legacyEffectsById.get("preview_legacy_pre_stage11")).toMatchObject({
          orderId: "order_legacy_stage10_move",
          effectiveDate: "2026-07-30"
        });
        const epoch = await historicalDb.selectFrom("schema_migrations")
          .select("applied_at")
          .where("name", "=", "028_stage11_move_unit_guards.sql")
          .executeTakeFirstOrThrow();
        await historicalDb.insertInto("command_previews").values({
          id: "preview_post_epoch_legacy_shape",
          subject_id: demo.agentSubjectId,
          property_id: demo.propertyId,
          command_type: "RESCHEDULE_STAY",
          normalized_input: {},
          input_hash: "5".repeat(64),
          effect: postEpochLegacyEffect,
          effect_hash: "4".repeat(64),
          basis_versions: {},
          expires_at: new Date("2035-01-01T00:00:00.000Z"),
          status: "OPEN",
          created_at: epoch.applied_at
        }).execute();
        for (const url of [
          "/api/v1/command-previews/preview_post_epoch_legacy_shape",
          "/api/v1/receipts/receipt_post_epoch_legacy_shape",
          "/api/v1/commands/command_post_epoch_legacy_shape"
        ]) {
          const response = await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${demo.writeToken}` }
          });
          expect(response.statusCode, `${url}: ${response.body}`).toBe(500);
          expect(response.json().code).toBe("INTERNAL_ERROR");
        }
        await expect(historicalDb.insertInto("amendments").values({
          id: "amend_post_epoch_legacy_shape",
          order_id: "order_historical_nulls",
          sequence: 3,
          amendment_type: "MOVE_UNIT",
          reason_code: "ROOM_MOVE",
          reason_note: "迁移后旧协议写入探针",
          prior_version: 2,
          new_version: 3,
          payload: legacyEffectsById.get("preview_legacy_pre_stage11")!,
          command_id: null,
          created_at: epoch.applied_at
        }).execute()).rejects.toBeDefined();
        expect(await historicalDb.selectFrom("amendments")
          .select("id")
          .where("id", "=", "amend_post_epoch_legacy_shape")
          .executeTakeFirst()).toBeUndefined();

        const storedPreviews = await historicalDb.selectFrom("command_previews")
          .select(["id", "effect"])
          .where("id", "in", ["preview_historical_create", "preview_historical_collection"])
          .orderBy("id")
          .execute();
        expect(Object.hasOwn(storedPreviews[0]!.effect as object, "transactionReference")).toBe(false);
        expect(Object.hasOwn(storedPreviews[1]!.effect as object, "bookingChannelCode")).toBe(false);
        const storedReceipts = await historicalDb.selectFrom("command_receipts")
          .select(["id", "result"])
          .where("id", "in", [
            "receipt_historical_create",
            "receipt_historical_collection",
            "receipt_historical_refund",
            "receipt_historical_reversal",
            "receipt_historical_preview_create",
            "receipt_historical_preview_collection"
          ])
          .execute();
        for (const receipt of storedReceipts) {
          const result = receipt.result as object;
          expect(Object.hasOwn(result, "bookingChannelCode")).toBe(false);
          expect(Object.hasOwn(result, "transactionReference")).toBe(false);
        }
        const storedPreviewReceiptById = new Map(storedReceipts.map((receipt) => [receipt.id, receipt.result as Record<string, unknown>]));
        const storedCreatePreviewResult = storedPreviewReceiptById.get("receipt_historical_preview_create")!;
        const storedCreatePreview = storedCreatePreviewResult.preview as Record<string, unknown>;
        expect(Object.hasOwn((storedCreatePreview.effect as object), "bookingChannelCode")).toBe(false);
        const storedCollectionPreviewResult = storedPreviewReceiptById.get("receipt_historical_preview_collection")!;
        const storedCollectionPreview = storedCollectionPreviewResult.preview as Record<string, unknown>;
        expect(Object.hasOwn((storedCollectionPreview.effect as object), "transactionReference")).toBe(false);
      } finally {
        await app.close();
        historicalDb = undefined;
      }
    } finally {
      if (historicalDb) await historicalDb.destroy();
      await dropDatabase(historicalDatabaseUrl);
    }
  }, 120_000);
});
