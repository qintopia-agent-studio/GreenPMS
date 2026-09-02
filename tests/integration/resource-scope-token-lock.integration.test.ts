import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { CommandType } from "@qintopia/contracts";
import { buildCommandEffect, type Database } from "@qintopia/db";
import { sha256 } from "@qintopia/domain";
import { lockCommandResources } from "../../packages/db/src/commands/apply.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";

const resourceScopeDatabaseUrl = process.env.RESOURCE_SCOPE_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_resource_scope_integration";

let db: Kysely<Database>;

const foreignPropertyId = "prop_resource_scope_foreign";
const foreignRoomId = "unit_resource_scope_foreign_room";
const foreignPolicyId = "policy_resource_scope_foreign";
const foreignSubjectId = "subject_resource_scope_foreign";
const foreignTokenId = "token_resource_scope_foreign";
const foreignOrderId = "order_resource_scope_foreign";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function seedForeignScope() {
  await db.insertInto("properties").values({
    id: foreignPropertyId,
    code: "FOREIGN",
    name: "Foreign Property",
    timezone: "Asia/Shanghai",
    currency: "CNY"
  }).execute();
  await db.insertInto("inventory_units").values({
    id: foreignRoomId,
    property_id: foreignPropertyId,
    kind: "ROOM",
    parent_room_id: null,
    code: "FOREIGN-101",
    name: "Foreign 101",
    active: true,
    catalog_version: null,
    building_code: null,
    room_type_code: "private_bath_standard",
    pricing_product_code: "private_bath_standard_room",
    inventory_basis: "INDEPENDENT",
    code_provenance: "PMS_GENERATED",
    physical_bed_count: null,
    occupancy_capacity: 2
  }).execute();
  await db.insertInto("pricing_policy_versions").values({
    id: foreignPolicyId,
    property_id: foreignPropertyId,
    code: "FOREIGN-TRANSIENT",
    version: 1,
    stay_type: "TRANSIENT",
    calculation_kind: "FLAT_NIGHTLY",
    nightly_rate_minor: 12_000,
    product_anchor_rates_minor: null,
    effective_from: null,
    effective_until: null,
    rounding_rule: null,
    currency: "CNY",
    status: "PUBLISHED"
  }).execute();
  await db.insertInto("subjects").values({
    id: foreignSubjectId,
    username: "foreign-scope",
    display_name: "Foreign Scope Subject",
    password_salt: "resource-scope",
    password_hash: sha256("resource-scope-password"),
    status: "ACTIVE",
    auth_version: 1
  }).execute();
  await db.insertInto("subject_property_grants").values({
    subject_id: foreignSubjectId,
    property_id: foreignPropertyId,
    access_level: "WRITE"
  }).execute();
  await db.insertInto("api_tokens").values({
    id: foreignTokenId,
    subject_id: foreignSubjectId,
    label: "Foreign scoped token",
    secret_hash: sha256("resource-scope-token"),
    access_ceiling: "WRITE",
    property_scope: foreignPropertyId,
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    rotated_from_id: null,
    replaced_by_id: null
  }).execute();

  const commandId = "command_resource_scope_foreign_order";
  const amendmentId = "amendment_resource_scope_foreign_order";
  const stayId = "stay_resource_scope_foreign";
  const segmentId = "segment_resource_scope_foreign";
  const revisionId = "revision_resource_scope_foreign";
  const primaryGuest = { fullName: "Foreign Guest", nickname: "Foreign Guest" };
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("command_executions").values({
      id: commandId,
      subject_id: foreignSubjectId,
      credential_id: foreignTokenId,
      property_id: foreignPropertyId,
      command_type: "CREATE_ORDER",
      idempotency_key: "resource-scope-foreign-order",
      request_hash: "a".repeat(64),
      correlation_id: "resource-scope-foreign-order",
      state: "APPLIED",
      completed_at: new Date()
    }).execute();
    await trx.insertInto("orders").values({
      id: foreignOrderId,
      property_id: foreignPropertyId,
      status: "RESERVED",
      stay_type: "TRANSIENT",
      arrival_date: "2029-01-01",
      departure_date: "2029-01-02",
      primary_guest_snapshot: primaryGuest,
      booking_channel_code: "WECOM",
      channel_order_reference: null,
      free_stay_reason: null,
      free_stay_category_code: null,
      pricing_policy_version_id: foreignPolicyId,
      member_id: null,
      member_contract_id: null,
      current_revision_id: null,
      version: 1
    }).execute();
    await trx.insertInto("order_occupants").values({
      id: "occupant_resource_scope_foreign",
      order_id: foreignOrderId,
      ordinal: 1,
      role: "PRIMARY",
      full_name: primaryGuest.fullName,
      nickname: primaryGuest.nickname,
      phone: null,
      document_number: null,
      created_by_command_id: commandId
    }).execute();
    await trx.insertInto("stays").values({ id: stayId, order_id: foreignOrderId, status: "PLANNED" }).execute();
    await trx.insertInto("amendments").values({
      id: amendmentId,
      order_id: foreignOrderId,
      sequence: 1,
      amendment_type: "CREATE_ORDER",
      reason_code: "RESOURCE_SCOPE_FIXTURE",
      reason_note: "Foreign scope fixture",
      prior_version: 0,
      new_version: 1,
      payload: {},
      command_id: commandId
    }).execute();
    await trx.insertInto("stay_segments").values({
      id: segmentId,
      stay_id: stayId,
      sequence: 1,
      inventory_unit_id: foreignRoomId,
      arrival_date: "2029-01-01",
      departure_date: "2029-01-02",
      segment_type: "INITIAL",
      supersedes_segment_id: null,
      amendment_id: amendmentId
    }).execute();
    await trx.insertInto("pricing_revisions").values({
      id: revisionId,
      order_id: foreignOrderId,
      revision_no: 1,
      amendment_id: amendmentId,
      policy_version_id: foreignPolicyId,
      arrival_date: "2029-01-01",
      departure_date: "2029-01-02",
      coverage_set: JSON.stringify([]),
      cash_lines: JSON.stringify([]),
      policy_base_amount_minor: 12_000,
      pricing_basis: "POLICY",
      manual_adjustment_minor: 0,
      current_contract_amount_minor: 12_000,
      currency: "CNY"
    }).execute();
    await trx.updateTable("orders").set({ current_revision_id: revisionId }).where("id", "=", foreignOrderId).execute();
  });
}

function lockForeignOrderUntil(release: Promise<void>) {
  const locked = deferred();
  const blocker = db.transaction().execute(async (trx) => {
    await trx.selectFrom("orders")
      .select("id")
      .where("id", "=", foreignOrderId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    locked.resolve();
    await release;
  });
  return { locked: locked.promise, blocker };
}

function lockForeignSubjectUntil(release: Promise<void>) {
  const locked = deferred();
  const blocker = db.transaction().execute(async (trx) => {
    await trx.selectFrom("subjects")
      .select("id")
      .where("id", "=", foreignSubjectId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    locked.resolve();
    await release;
  });
  return { locked: locked.promise, blocker };
}

function lockForeignTokenUntil(release: Promise<void>) {
  const locked = deferred();
  const blocker = db.transaction().execute(async (trx) => {
    await trx.selectFrom("api_tokens")
      .select("id")
      .where("id", "=", foreignTokenId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    locked.resolve();
    await release;
  });
  return { locked: locked.promise, blocker };
}

async function expectScopedLockTo404Quickly(options: {
  lockedBy: (release: Promise<void>) => { locked: Promise<void>; blocker: Promise<unknown> };
  commandType: CommandType;
  input: Record<string, unknown>;
}) {
  const release = deferred();
  const { locked, blocker } = options.lockedBy(release.promise);
  await within(locked, 1_000);
  let attempt: Promise<unknown> | undefined;
  try {
    attempt = db.transaction().execute((trx) => lockCommandResources(trx, options.commandType, options.input));
    await expect(within(attempt, 250)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  } finally {
    release.resolve();
    await blocker;
    await attempt?.catch(() => undefined);
  }
}

beforeAll(async () => {
  db = await resetDatabase(resourceScopeDatabaseUrl);
  await seedForeignScope();
});

afterAll(async () => {
  await db.destroy();
});

describe("command resource scope locks", () => {
  it("returns 404 before building order effects for a foreign-property order", async () => {
    await expect(buildCommandEffect(db, "CHECK_IN", {
      propertyId: demo.propertyId,
      orderId: foreignOrderId
    })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("does not wait on a locked foreign-property order before returning 404", async () => {
    await expectScopedLockTo404Quickly({
      lockedBy: lockForeignOrderUntil,
      commandType: "CHECK_IN",
      input: { propertyId: demo.propertyId, orderId: foreignOrderId }
    });
  });

  it("does not wait on a locked foreign-property Token target before returning 404", async () => {
    await expectScopedLockTo404Quickly({
      lockedBy: lockForeignTokenUntil,
      commandType: "REVOKE_TOKEN",
      input: { propertyId: demo.propertyId, tokenId: foreignTokenId }
    });
  });

  it("does not wait on a locked foreign-property subject target before returning 404", async () => {
    await expectScopedLockTo404Quickly({
      lockedBy: lockForeignSubjectUntil,
      commandType: "ISSUE_TOKEN",
      input: { propertyId: demo.propertyId, subjectId: foreignSubjectId }
    });
  });

  it("waits on the target subject before locking its Token resource", async () => {
    const release = deferred();
    const subjectLocked = deferred();
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom("subjects")
        .select("id")
        .where("id", "=", demo.administratorSubjectId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      subjectLocked.resolve();
      await release.promise;
    });
    await within(subjectLocked.promise, 1_000);

    const attempt = db.transaction().execute((trx) => lockCommandResources(trx, "REVOKE_TOKEN", {
      propertyId: demo.propertyId,
      tokenId: "token_demo_admin_write"
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      await expect(db.transaction().execute(async (trx) => {
        await sql`set local lock_timeout = '250ms'`.execute(trx);
        return trx.selectFrom("api_tokens")
          .select("id")
          .where("id", "=", "token_demo_admin_write")
          .forUpdate()
          .executeTakeFirstOrThrow();
      })).resolves.toEqual({ id: "token_demo_admin_write" });
    } finally {
      release.resolve();
      await blocker;
      await attempt;
    }
  });
});
