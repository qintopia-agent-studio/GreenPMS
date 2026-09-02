import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseReady, type Database } from "@qintopia/db";
import { newOpaqueSecret, sha256 } from "@qintopia/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import { resetDatabase } from "../helpers/database.ts";

const databaseUrl = process.env.READINESS_INTEGRATION_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_database_readiness";
const demoOwnerReadinessOptions = {
  identity: "maintenance-owner",
  staffProfileManifestName: "demo"
} as const;

let db: Kysely<Database>;

const stage13CriticalConstraints = [
  ["membership_payment_facts", "membership_payment_facts_source_order_id_fkey"],
  ["membership_payment_facts", "membership_payment_facts_source_collection_fact_id_fkey"],
  ["membership_payment_facts", "membership_payment_source_type_check"],
  ["membership_payment_facts", "membership_payment_direct_source_null"],
  ["membership_payment_facts", "membership_payment_transfer_source_required"],
  ["collection_facts", "collection_facts_fact_id_order_id_unique"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfers_pkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfers_property_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfers_order_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_trans_source_collection_fact_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfe_source_reversal_fact_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfers_membership_order_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_tran_membership_payment_fact_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfers_command_id_fkey"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transf_source_collection_fact_id_key"],
  ["stay_collection_membership_transfers", "stay_collection_membership_transfer_source_reversal_fact_id_key"],
  ["stay_collection_membership_transfers", "stay_collection_membership_trans_membership_payment_fact_id_key"],
  ["stay_collection_membership_transfers", "stay_collection_membership_tr_source_collection_fact_id_or_fkey"],
  ["entitlement_ledger", "entitlement_ledger_entry_type_check"]
] as const;

async function expectReadinessFailure(
  label: string,
  damage: (trx: Transaction<Database>) => Promise<void>
): Promise<void> {
  const rollback = new Error(`rollback readiness probe: ${label}`);
  await expect(db.transaction().execute(async (trx) => {
    await damage(trx);
    expect(await databaseReady(trx, demoOwnerReadinessOptions), label).toBe(false);
    throw rollback;
  })).rejects.toBe(rollback);
  expect(await databaseReady(db, demoOwnerReadinessOptions), `${label} rollback`).toBe(true);
}

beforeAll(async () => {
  db = await resetDatabase(databaseUrl);
});

afterAll(async () => {
  await db.destroy();
});

describe.sequential("authoritative database readiness", () => {
  it("binds readiness to the configured reviewed staff-profile manifest", async () => {
    expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);
    expect(await databaseReady(db, {
      identity: "maintenance-owner",
      staffProfileManifestName: "unconfigured"
    })).toBe(false);

    const previousManifestName = process.env.STAFF_PROFILE_MANIFEST_NAME;
    try {
      process.env.STAFF_PROFILE_MANIFEST_NAME = "unconfigured";
      expect(await databaseReady(db, { identity: "maintenance-owner" })).toBe(false);
      expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);

      process.env.STAFF_PROFILE_MANIFEST_NAME = "demo";
      expect(await databaseReady(db, { identity: "maintenance-owner" })).toBe(true);

      process.env.STAFF_PROFILE_MANIFEST_NAME = "not-reviewed";
      expect(await databaseReady(db, { identity: "maintenance-owner" })).toBe(false);
    } finally {
      if (previousManifestName === undefined) delete process.env.STAFF_PROFILE_MANIFEST_NAME;
      else process.env.STAFF_PROFILE_MANIFEST_NAME = previousManifestName;
    }
  });

  it("requires every migration from terminal-order handling through runtime database role hardening", async () => {
    expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);
    for (const migrationName of [
      "029_stage12_terminal_order_guards.sql",
      "030_collection_fact_historical_pricing_revision.sql",
      "031_collection_fact_method_transaction_rules.sql",
      "032_wecom_refund_original_route.sql",
      "033_stay_collection_membership_conversion.sql",
      "034_stay_conversion_reversal_bridge_guard.sql",
      "035_stage13_conversion_execution_state_guards.sql",
      "036_qintopia_prelaunch_room_catalog_corrections.sql",
      "037_member_phone_identity_and_nickname.sql",
      "038_backfill_completed_stay_checkout_guard.sql",
      "039_inhouse_zero_collection_conversion.sql",
      "040_conversion_order_membership_link.sql",
      "041_completed_stay_backfill_atomicity.sql",
      "042_complete_overdue_reserved_stay.sql",
      "043_complete_stay_guard_hardening.sql",
      "044_inhouse_membership_fulfillment_guards.sql",
      "045_stay_membership_net_wecom_transfer.sql",
      "046_command_authorization.sql",
      "047_runtime_database_role.sql",
      "048_runtime_isolation_guards.sql"
    ]) {
      await expectReadinessFailure(migrationName, async (trx) => {
        await trx.deleteFrom("schema_migrations").where("name", "=", migrationName).execute();
      });
    }
  });

  it("keeps legal dynamic Token lifecycle rows outside the reconciled staff-profile projection", async () => {
    const rollback = new Error("rollback legal dynamic Token lifecycle readiness probe");
    const issuedTokenId = `token_readiness_issue_${process.pid}`;
    const rotatedTokenId = `token_readiness_rotate_${process.pid}`;
    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto("api_tokens").values({
        id: issuedTokenId,
        subject_id: "subject_demo_administrator",
        label: "Readiness issue probe",
        secret_hash: sha256(newOpaqueSecret("qtp")),
        access_ceiling: "WRITE",
        property_scope: "prop_qintopia_demo",
        expires_at: "2029-12-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: null,
        replaced_by_id: null
      }).execute();
      await trx.insertInto("token_command_ceilings").values({
        token_id: issuedTokenId,
        subject_id: "subject_demo_administrator",
        property_id: "prop_qintopia_demo",
        command_type: "REPRICE_ORDER"
      }).execute();
      expect(await databaseReady(trx, demoOwnerReadinessOptions), "legal issue").toBe(true);

      await trx.insertInto("api_tokens").values({
        id: rotatedTokenId,
        subject_id: "subject_demo_administrator",
        label: "Readiness rotate probe",
        secret_hash: sha256(newOpaqueSecret("qtp")),
        access_ceiling: "WRITE",
        property_scope: "prop_qintopia_demo",
        expires_at: "2029-06-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: issuedTokenId,
        replaced_by_id: null
      }).execute();
      await trx.insertInto("token_command_ceilings").values({
        token_id: rotatedTokenId,
        subject_id: "subject_demo_administrator",
        property_id: "prop_qintopia_demo",
        command_type: "REPRICE_ORDER"
      }).execute();
      await trx.updateTable("api_tokens")
        .set({ revoked_at: new Date(), replaced_by_id: rotatedTokenId })
        .where("id", "=", issuedTokenId)
        .execute();
      expect(await databaseReady(trx, demoOwnerReadinessOptions), "legal rotate").toBe(true);

      await trx.updateTable("api_tokens")
        .set({ revoked_at: new Date() })
        .where("id", "=", rotatedTokenId)
        .execute();
      expect(await databaseReady(trx, demoOwnerReadinessOptions), "legal revoke").toBe(true);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(db, demoOwnerReadinessOptions)).toBe(true);
  });

  it("keeps illegal dynamic Token ceiling policy drift readiness-fatal", async () => {
    await expectReadinessFailure("READ Token with a write-command ceiling", async (trx) => {
      await trx.insertInto("token_command_ceilings").values({
        token_id: "token_demo_read",
        subject_id: "subject_demo_agent",
        property_id: "prop_qintopia_demo",
        command_type: "REPRICE_ORDER"
      }).execute();
    });

    await expectReadinessFailure("FUTURE_DISABLED command in an existing Token ceiling", async (trx) => {
      await trx.insertInto("token_command_ceilings").values({
        token_id: "token_demo_admin_write",
        subject_id: "subject_demo_administrator",
        property_id: "prop_qintopia_demo",
        command_type: "CORRECT_HISTORICAL_STAY_ARRANGEMENTS"
      }).execute();
    });

    await expectReadinessFailure("disabled HUMAN_COMMAND feature in an existing Token ceiling", async (trx) => {
      await trx.insertInto("token_command_ceilings").values({
        token_id: "token_demo_admin_write",
        subject_id: "subject_demo_administrator",
        property_id: "prop_qintopia_demo",
        command_type: "COMPLETE_CLEANING"
      }).execute();
    });
  });

  it("requires the exact owner-controlled runtime Token guard function and trigger bindings", async () => {
    await expectReadinessFailure("runtime Token guard function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_guard_runtime_token_mutation()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("runtime Token guard function owner", async (trx) => {
      await sql`ALTER FUNCTION qintopia_guard_runtime_token_mutation() OWNER TO qintopia_runtime`.execute(trx);
    });

    await expectReadinessFailure("runtime Token guard function EXECUTE grant", async (trx) => {
      await sql`GRANT EXECUTE ON FUNCTION qintopia_guard_runtime_token_mutation() TO qintopia_runtime`.execute(trx);
    });

    await expectReadinessFailure("runtime Token guard function execution metadata", async (trx) => {
      await sql`ALTER FUNCTION qintopia_guard_runtime_token_mutation() SECURITY DEFINER STABLE SET search_path = public`.execute(trx);
    });

    await expectReadinessFailure("API Token mutation guard missing", async (trx) => {
      await sql`DROP TRIGGER api_tokens_runtime_token_mutation_guard ON api_tokens`.execute(trx);
    });

    await expectReadinessFailure("ceiling insertion guard missing", async (trx) => {
      await sql`DROP TRIGGER token_command_ceilings_runtime_token_mutation_guard ON token_command_ceilings`.execute(trx);
    });

    await expectReadinessFailure("API Token mutation guard rebound", async (trx) => {
      await sql`DROP TRIGGER api_tokens_runtime_token_mutation_guard ON api_tokens`.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER api_tokens_runtime_token_mutation_guard
        AFTER INSERT ON token_command_ceilings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("API Token mutation guard non-deferred", async (trx) => {
      await sql`DROP TRIGGER api_tokens_runtime_token_mutation_guard ON api_tokens`.execute(trx);
      await sql`
        CREATE TRIGGER api_tokens_runtime_token_mutation_guard
        AFTER INSERT OR UPDATE ON api_tokens
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("API Token mutation guard event set", async (trx) => {
      await sql`DROP TRIGGER api_tokens_runtime_token_mutation_guard ON api_tokens`.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER api_tokens_runtime_token_mutation_guard
        AFTER INSERT ON api_tokens
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("ceiling insertion guard rebound", async (trx) => {
      await sql`DROP TRIGGER token_command_ceilings_runtime_token_mutation_guard ON token_command_ceilings`.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER token_command_ceilings_runtime_token_mutation_guard
        AFTER INSERT ON api_tokens
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("ceiling insertion guard non-deferred", async (trx) => {
      await sql`DROP TRIGGER token_command_ceilings_runtime_token_mutation_guard ON token_command_ceilings`.execute(trx);
      await sql`
        CREATE TRIGGER token_command_ceilings_runtime_token_mutation_guard
        AFTER INSERT ON token_command_ceilings
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("ceiling insertion guard event set", async (trx) => {
      await sql`DROP TRIGGER token_command_ceilings_runtime_token_mutation_guard ON token_command_ceilings`.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER token_command_ceilings_runtime_token_mutation_guard
        AFTER INSERT OR UPDATE ON token_command_ceilings
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION qintopia_guard_runtime_token_mutation()
      `.execute(trx);
    });
  });

  it("rejects damaged foundational audit, identity, and idempotency controls", async () => {
    await expectReadinessFailure("command receipt append-only trigger", async (trx) => {
      await sql`DROP TRIGGER command_receipts_append_only ON command_receipts`.execute(trx);
    });

    await expectReadinessFailure("audit entry append-only trigger", async (trx) => {
      await sql`DROP TRIGGER audit_entries_append_only ON audit_entries`.execute(trx);
    });

    await expectReadinessFailure("command execution identity trigger", async (trx) => {
      await sql`DROP TRIGGER command_executions_protect_identity ON command_executions`.execute(trx);
    });

    await expectReadinessFailure("API token identity trigger", async (trx) => {
      await sql`DROP TRIGGER api_tokens_protect_identity ON api_tokens`.execute(trx);
    });

    await expectReadinessFailure("property-scoped idempotency uniqueness", async (trx) => {
      await sql`
        ALTER TABLE command_executions
        DROP CONSTRAINT command_executions_idempotency_scope_key
      `.execute(trx);
    });

    await expectReadinessFailure("append-only invariant body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_prevent_fact_mutation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });
  });

  it("rejects damaged member phone identity columns, constraints, normalization, and trigger bindings", async () => {
    await expectReadinessFailure("member identity card remains nullable", async (trx) => {
      await sql`DROP TRIGGER members_protect_identity ON members`.execute(trx);
      await sql`
        UPDATE members
        SET identity_card_number = 'READINESS-' || id
        WHERE identity_card_number IS NULL
      `.execute(trx);
      await sql`ALTER TABLE members ALTER COLUMN identity_card_number SET NOT NULL`.execute(trx);
      await sql`
        CREATE TRIGGER members_protect_identity
        BEFORE UPDATE OR DELETE ON members
        FOR EACH ROW EXECUTE FUNCTION qintopia_protect_member_identity()
      `.execute(trx);
    });

    await expectReadinessFailure("member nickname remains required", async (trx) => {
      await sql`ALTER TABLE members ALTER COLUMN nickname DROP NOT NULL`.execute(trx);
    });

    await expectReadinessFailure("member phone uniqueness", async (trx) => {
      await sql`ALTER TABLE members DROP CONSTRAINT members_phone_unique`.execute(trx);
    });

    await expectReadinessFailure("member optional identity nonblank constraint", async (trx) => {
      await sql`ALTER TABLE members DROP CONSTRAINT members_identity_card_number_nonblank`.execute(trx);
      await sql`
        ALTER TABLE members ADD CONSTRAINT members_identity_card_number_nonblank CHECK (true)
      `.execute(trx);
    });

    await expectReadinessFailure("member nickname nonblank constraint", async (trx) => {
      await sql`ALTER TABLE members DROP CONSTRAINT members_nickname_nonblank`.execute(trx);
      await sql`
        ALTER TABLE members ADD CONSTRAINT members_nickname_nonblank CHECK (true)
      `.execute(trx);
    });

    await expectReadinessFailure("member normalization trigger binding", async (trx) => {
      await sql`DROP TRIGGER members_normalize_new_identity ON members`.execute(trx);
    });

    await expectReadinessFailure("member normalization function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_normalize_new_member_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });
  });

  it("rejects missing, disabled, or incorrectly bound membership immutability controls", async () => {
    await expectReadinessFailure("membership payment append-only trigger missing", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_facts_append_only
        ON membership_payment_facts
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment append-only trigger disabled", async (trx) => {
      await sql`
        ALTER TABLE membership_payment_facts
        DISABLE TRIGGER membership_payment_facts_append_only
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment append-only trigger event binding", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_facts_append_only
        ON membership_payment_facts
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_payment_facts_append_only
        BEFORE UPDATE ON membership_payment_facts
        FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment append-only trigger predicate", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_facts_append_only
        ON membership_payment_facts
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_payment_facts_append_only
        BEFORE UPDATE OR DELETE ON membership_payment_facts
        FOR EACH ROW
        WHEN (false)
        EXECUTE FUNCTION qintopia_prevent_fact_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment append-only trigger column subset", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_facts_append_only
        ON membership_payment_facts
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_payment_facts_append_only
        BEFORE UPDATE OF amount_minor OR DELETE ON membership_payment_facts
        FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity trigger missing", async (trx) => {
      await sql`
        DROP TRIGGER membership_orders_protect_identity
        ON membership_orders
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity trigger disabled", async (trx) => {
      await sql`
        ALTER TABLE membership_orders
        DISABLE TRIGGER membership_orders_protect_identity
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity trigger function binding", async (trx) => {
      await sql`
        DROP TRIGGER membership_orders_protect_identity
        ON membership_orders
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_orders_protect_identity
        BEFORE UPDATE ON membership_orders
        FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity trigger predicate", async (trx) => {
      await sql`
        DROP TRIGGER membership_orders_protect_identity
        ON membership_orders
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_orders_protect_identity
        BEFORE UPDATE ON membership_orders
        FOR EACH ROW
        WHEN (false)
        EXECUTE FUNCTION qintopia_protect_membership_order_identity()
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity trigger column subset", async (trx) => {
      await sql`
        DROP TRIGGER membership_orders_protect_identity
        ON membership_orders
      `.execute(trx);
      await sql`
        CREATE TRIGGER membership_orders_protect_identity
        BEFORE UPDATE OF status ON membership_orders
        FOR EACH ROW EXECUTE FUNCTION qintopia_protect_membership_order_identity()
      `.execute(trx);
    });

    await expectReadinessFailure("membership order identity function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_protect_membership_order_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });
  });

  it("holds the shared migration lock for the complete readiness inspection", async () => {
    await db.transaction().execute(async (readinessTransaction) => {
      expect(await databaseReady(readinessTransaction, demoOwnerReadinessOptions)).toBe(true);

      const acquiredWhileReadinessIsOpen = await db.transaction().execute(async (contender) => {
        const result = await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended('qintopia:migrate', 0::bigint)
          ) AS acquired
        `.execute(contender);
        return result.rows[0]?.acquired;
      });
      expect(acquiredWhileReadinessIsOpen).toBe(false);
    });

    const acquiredAfterReadiness = await db.transaction().execute(async (contender) => {
      const result = await sql<{ acquired: boolean }>`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended('qintopia:migrate', 0::bigint)
        ) AS acquired
      `.execute(contender);
      return result.rows[0]?.acquired;
    });
    expect(acquiredAfterReadiness).toBe(true);
  });

  it("rejects damaged collection and terminal-order guards even when migration history is intact", async () => {
    await expectReadinessFailure("collection transaction-reference trigger", async (trx) => {
      await sql`DROP TRIGGER collection_facts_validate_new_transaction_reference ON collection_facts`.execute(trx);
    });

    await expectReadinessFailure("completed-stay backfill cash evidence trigger", async (trx) => {
      await sql`DROP TRIGGER collection_facts_validate_backfill_cash ON collection_facts`.execute(trx);
    });

    await expectReadinessFailure("completed-stay backfill checkout chain guard", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_reject_stage10_checkout_bypass() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
      `.execute(trx);
    });

    await expectReadinessFailure("complete-stay fulfillment uniqueness index", async (trx) => {
      await sql`DROP INDEX amendments_one_fulfillment_type_per_command`.execute(trx);
      await sql`
        CREATE INDEX amendments_one_fulfillment_type_per_command
        ON amendments (command_id)
        WHERE command_id IS NOT NULL
      `.execute(trx);
    });

    await expectReadinessFailure("complete-stay command exact-pair trigger", async (trx) => {
      await sql`
        DROP TRIGGER command_executions_complete_stay_exact_pair
        ON command_executions
      `.execute(trx);
    });

    await expectReadinessFailure("complete-stay amendment exact-pair trigger binding", async (trx) => {
      await sql`DROP TRIGGER amendments_complete_stay_exact_pair ON amendments`.execute(trx);
      await sql`
        CREATE TRIGGER amendments_complete_stay_exact_pair
        AFTER INSERT ON amendments
        FOR EACH ROW EXECUTE FUNCTION qintopia_validate_complete_stay_execution_chain()
      `.execute(trx);
    });

    await expectReadinessFailure("complete-stay exact-pair function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_complete_stay_execution_chain() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$
      `.execute(trx);
    });

    await expectReadinessFailure("terminal order status constraint", async (trx) => {
      await sql`ALTER TABLE orders DROP CONSTRAINT orders_status_check`.execute(trx);
      await sql`ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IS NOT NULL)`.execute(trx);
    });

    await expectReadinessFailure("terminal status trigger column binding", async (trx) => {
      await sql`DROP TRIGGER orders_stage12_protect_terminal_status ON orders`.execute(trx);
      await sql`
        CREATE TRIGGER orders_stage12_protect_terminal_status
        BEFORE UPDATE ON orders
        FOR EACH ROW EXECUTE FUNCTION qintopia_protect_stage12_terminal_status()
      `.execute(trx);
    });

    await expectReadinessFailure("restore uniqueness index", async (trx) => {
      await sql`DROP INDEX entitlement_ledger_one_restore_per_coverage_idx`.execute(trx);
      await sql`
        CREATE INDEX entitlement_ledger_one_restore_per_coverage_idx
        ON entitlement_ledger (coverage_id)
        WHERE entry_type = 'RESTORE'
      `.execute(trx);
    });

    await expectReadinessFailure("terminal command invariant body", async (trx) => {
      await sql`
        ALTER FUNCTION qintopia_assert_stage12_terminal_command(text)
        RENAME TO qintopia_assert_stage12_terminal_command_missing
      `.execute(trx);
    });
  });

  it("rejects damaged stay-conversion tables, constraints, indexes, and exact trigger bindings", async () => {
    for (const [tableName, constraintName] of stage13CriticalConstraints) {
      await expectReadinessFailure(`${tableName}.${constraintName}`, async (trx) => {
        await sql`
          ALTER TABLE ${sql.table(tableName)}
          DROP CONSTRAINT ${sql.id(constraintName)} CASCADE
        `.execute(trx);
        await sql`
          ALTER TABLE ${sql.table(tableName)}
          ADD CONSTRAINT ${sql.id(constraintName)} CHECK (true)
        `.execute(trx);
      });
    }

    await expectReadinessFailure("membership funds closure trigger", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_stage13_reject_after_transfer
        ON membership_payment_facts
      `.execute(trx);
    });

    await expectReadinessFailure("net-transfer collection shape trigger", async (trx) => {
      await sql`
        DROP TRIGGER collection_facts_validate_new_write_shape
        ON collection_facts
      `.execute(trx);
    });

    await expectReadinessFailure("net-transfer collection shape trigger binding", async (trx) => {
      await sql`
        DROP TRIGGER collection_facts_validate_new_write_shape
        ON collection_facts
      `.execute(trx);
      await sql`
        CREATE TRIGGER collection_facts_validate_new_write_shape
        BEFORE UPDATE ON collection_facts
        FOR EACH ROW EXECUTE FUNCTION qintopia_validate_new_collection_fact_shape()
      `.execute(trx);
    });

    await expectReadinessFailure("net-transfer collection shape function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_shape()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("WeCom refund transaction trigger false predicate", async (trx) => {
      await sql`
        DROP TRIGGER collection_facts_validate_new_transaction_reference
        ON collection_facts
      `.execute(trx);
      await sql`
        CREATE TRIGGER collection_facts_validate_new_transaction_reference
        BEFORE INSERT ON collection_facts
        FOR EACH ROW
        WHEN (false)
        EXECUTE FUNCTION qintopia_validate_new_collection_fact_transaction_reference()
      `.execute(trx);
    });

    await expectReadinessFailure("WeCom refund transaction function body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_new_collection_fact_transaction_reference()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            RAISE EXCEPTION 'dead original-route refund guard';
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment conversion child trigger", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_facts_stage13_validate_stay_conversion
        ON membership_payment_facts
      `.execute(trx);
    });

    await expectReadinessFailure("conversion child trigger false predicate", async (trx) => {
      await sql`
        DROP TRIGGER collection_facts_stage13_validate_stay_conversion
        ON collection_facts
      `.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER collection_facts_stage13_validate_stay_conversion
        AFTER INSERT ON collection_facts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (false)
        EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()
      `.execute(trx);
    });

    await expectReadinessFailure("conversion bridge trigger weakened predicate", async (trx) => {
      await sql`
        DROP TRIGGER membership_payment_transfer_bridge_required
        ON membership_payment_facts
      `.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER membership_payment_transfer_bridge_required
        AFTER INSERT ON membership_payment_facts
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (NEW.source_type = 'STAY_COLLECTION_TRANSFER' AND false)
        EXECUTE FUNCTION qintopia_require_transfer_membership_payment_bridge()
      `.execute(trx);
    });

    await expectReadinessFailure("conversion transfer append-only trigger column subset", async (trx) => {
      await sql`
        DROP TRIGGER stay_collection_membership_transfers_append_only
        ON stay_collection_membership_transfers
      `.execute(trx);
      await sql`
        CREATE TRIGGER stay_collection_membership_transfers_append_only
        BEFORE UPDATE OF membership_order_id OR DELETE ON stay_collection_membership_transfers
        FOR EACH ROW EXECUTE FUNCTION qintopia_prevent_fact_mutation()
      `.execute(trx);
    });

    await expectReadinessFailure("entitlement conversion child trigger predicate", async (trx) => {
      await sql`
        DROP TRIGGER entitlement_ledger_stage13_validate_stay_conversion
        ON entitlement_ledger
      `.execute(trx);
      await sql`
        CREATE CONSTRAINT TRIGGER entitlement_ledger_stage13_validate_stay_conversion
        AFTER INSERT ON entitlement_ledger
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (NEW.entry_type = 'CONVERSION_CONSUME')
        EXECUTE FUNCTION qintopia_validate_stage13_stay_conversion_child()
      `.execute(trx);
    });

    await expectReadinessFailure("membership order conversion child trigger", async (trx) => {
      await sql`
        DROP TRIGGER membership_orders_stage13_validate_stay_conversion
        ON membership_orders
      `.execute(trx);
    });

    await expectReadinessFailure("conversion consumption uniqueness index", async (trx) => {
      await sql`DROP INDEX entitlement_ledger_one_conversion_consume_per_lot_order_date_idx`.execute(trx);
      await sql`
        CREATE INDEX entitlement_ledger_one_conversion_consume_per_lot_order_date_idx
        ON entitlement_ledger (lot_id, order_id, service_date)
        WHERE entry_type = 'CONVERSION_CONSUME'
      `.execute(trx);
    });

    await expectReadinessFailure("conversion consumption uniqueness predicate", async (trx) => {
      await sql`DROP INDEX entitlement_ledger_one_conversion_consume_per_lot_order_date_idx`.execute(trx);
      await sql`
        CREATE UNIQUE INDEX entitlement_ledger_one_conversion_consume_per_lot_order_date_idx
        ON entitlement_ledger (lot_id, order_id, service_date)
        WHERE entry_type = 'CONVERSION_CONSUME' AND false
      `.execute(trx);
    });

    await expectReadinessFailure("stay conversion transfer table", async (trx) => {
      await sql`
        ALTER TABLE stay_collection_membership_transfers
        RENAME TO stay_collection_membership_transfers_missing
      `.execute(trx);
    });

    await expectReadinessFailure("membership funds closure invariant body", async (trx) => {
      await sql`
        ALTER FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
        RENAME TO qintopia_reject_membership_funds_after_stay_transfer_missing
      `.execute(trx);
    });

    await expectReadinessFailure("membership funds closure exact-command body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_reject_membership_funds_after_stay_transfer()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion execution-state invariant body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command(target_command_id text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion core invariant markers hidden in a dead branch", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command(target_command_id text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            RAISE EXCEPTION 'stage13_conversion_execution_state stage13_conversion_remaining_payment_binding qintopia_assert_stage13_stay_conversion_command_v033';
          END IF;
          RETURN;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion v033 invariant markers hidden in a dead branch", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command_v033(target_command_id text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            RAISE EXCEPTION 'stage13_conversion_funds_conserved stage13_conversion_direct_reference_new stage13_conversion_one_per_order stage13_conversion_entitlement';
          END IF;
          RETURN;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion execution wrapper body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_execution()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion execution wrapper dead call", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_execution()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.id);
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion child wrapper body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_child()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion child wrapper dead call", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_child()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.command_id);
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion child wrapper execution metadata", async (trx) => {
      await sql`
        ALTER FUNCTION qintopia_validate_stage13_stay_conversion_child()
        SECURITY DEFINER
      `.execute(trx);
    });

    await expectReadinessFailure("conversion membership-order wrapper body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion membership-order wrapper dead calls", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_stage13_stay_conversion_membership_order()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF false THEN
            PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.created_by_command_id);
            IF NEW.activated_by_command_id IS DISTINCT FROM NEW.created_by_command_id THEN
              PERFORM qintopia_assert_stage13_stay_conversion_command(NEW.activated_by_command_id);
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("membership payment validator body", async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION qintopia_validate_membership_payment_fact()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `.execute(trx);
    });

    await expectReadinessFailure("conversion reversal bridge trigger", async (trx) => {
      await sql`
        DROP TRIGGER collection_facts_stage13_require_conversion_reversal_bridge
        ON collection_facts
      `.execute(trx);
    });

    await expectReadinessFailure("conversion reversal bridge invariant body", async (trx) => {
      await sql`
        ALTER FUNCTION qintopia_require_stage13_conversion_reversal_bridge()
        RENAME TO qintopia_require_stage13_conversion_reversal_bridge_missing
      `.execute(trx);
    });
  });
});
