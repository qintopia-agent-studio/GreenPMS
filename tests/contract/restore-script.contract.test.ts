import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { databaseUrl } from "../../packages/db/src/database.ts";

const execFileAsync = promisify(execFile);
const restoreScript = fileURLToPath(new URL("../../scripts/restore.sh", import.meta.url));
const verifyBackupRestoreScript = fileURLToPath(new URL("../../scripts/verify-backup-restore.sh", import.meta.url));
const verifyComposeColdStartScript = fileURLToPath(new URL("../../scripts/verify-compose-cold-start.sh", import.meta.url));
const databaseModule = fileURLToPath(new URL("../../packages/db/src/database.ts", import.meta.url));
const migrationsDirectory = fileURLToPath(new URL("../../packages/db/src/migrations/", import.meta.url));
const currentMigrationNames = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();

async function fakeDockerEnvironment(
  targetExists: boolean,
  failRestore = false,
  replacementOid?: string,
  options: {
    baselineMigrationCount?: string;
    failMigration?: boolean;
    failReadiness?: boolean;
    finalMigrationCount?: string;
    stage10FunctionCount?: string;
    stage10TriggerCount?: string;
    stage10ImmediateTriggerCount?: string;
    stage11FunctionCount?: string;
    stage11ReplacementCount?: string;
    stage11BodyMarkerCount?: string;
    stage11TriggerCount?: string;
    stage11ImmediateTriggerCount?: string;
    baselineUnknownMigrationCount?: string;
    finalUnknownMigrationCount?: string;
    restoredMigrationNames?: string[];
  } = {}
) {
  const workdir = await mkdtemp(join(tmpdir(), "qintopia-restore-contract-"));
  const bin = join(workdir, "bin");
  const log = join(workdir, "docker.log");
  const backup = join(workdir, "backup.dump");
  const oidQueryCount = join(workdir, "oid-query-count");
  const migrationState = join(workdir, "migration-state");
  await mkdir(bin);
  await writeFile(backup, "PGDMP-restore-contract");
  const docker = join(bin, "docker");
  await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"SELECT 1 FROM pg_database"*) printf '%s' "$FAKE_TARGET_EXISTS" ;;
  *"SELECT oid FROM pg_database"*)
    count=0
    if [ -f "$FAKE_OID_QUERY_COUNT_FILE" ]; then count=$(cat "$FAKE_OID_QUERY_COUNT_FILE"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_OID_QUERY_COUNT_FILE"
    if [ "$count" -eq 1 ]; then printf '%s' "$FAKE_CREATED_TARGET_OID"; else printf '%s' "$FAKE_CLEANUP_TARGET_OID"; fi
    ;;
  *"name NOT IN"*)
    if [ -f "$FAKE_MIGRATION_STATE_FILE" ]; then
      printf '%s' "$FAKE_FINAL_UNKNOWN_MIGRATION_COUNT"
    else
      printf '%s' "$FAKE_BASELINE_UNKNOWN_MIGRATION_COUNT"
    fi
    ;;
  *"string_agg(name, ',' ORDER BY name)"*)
    printf '%s' "$FAKE_RESTORED_MIGRATION_MANIFEST"
    ;;
  *"schema_migrations"*)
    if [ -f "$FAKE_MIGRATION_STATE_FILE" ]; then
      printf '%s' "$FAKE_FINAL_MIGRATION_COUNT"
    else
      printf '%s' "$FAKE_BASELINE_MIGRATION_COUNT"
    fi
    ;;
  *"reschedule_pair_valid"*) printf '%s' "$FAKE_STAGE11_REPLACEMENT_COUNT" ;;
  *"stage11_move_order_command_chain"*) printf '%s' "$FAKE_STAGE11_BODY_MARKER_COUNT" ;;
  *"qintopia_assert_stage10_shorten_combination"*) printf '%s' "$FAKE_STAGE10_FUNCTION_COUNT" ;;
  *"qintopia_assert_stage11_move_combination"*) printf '%s' "$FAKE_STAGE11_FUNCTION_COUNT" ;;
  *"pricing_revisions_stage10_validate"*) printf '%s' "$FAKE_STAGE10_IMMEDIATE_TRIGGER_COUNT" ;;
  *"pricing_revisions_stage11_validate_move"*) printf '%s' "$FAKE_STAGE11_IMMEDIATE_TRIGGER_COUNT" ;;
  *"amendments_stage11_validate_move_combination"*) printf '%s' "$FAKE_STAGE11_TRIGGER_COUNT" ;;
  *"pg_trigger"*) printf '%s' "$FAKE_STAGE10_TRIGGER_COUNT" ;;
  *" pg_restore "*) if [ "$FAKE_RESTORE_FAILURE" = "1" ]; then exit 1; fi ;;
esac
`, { mode: 0o700 });
  await chmod(docker, 0o700);
const npm = join(bin, "npm");
  await writeFile(npm, `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'pg user=%s password=%s host=%s port=%s database=%s\\n' "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$PGDATABASE" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"run db:migrate"*)
    if [ "$FAKE_MIGRATION_FAILURE" = "1" ]; then exit 1; fi
    touch "$FAKE_MIGRATION_STATE_FILE"
    ;;
  *"run db:ready"*)
    if [ "$FAKE_READINESS_FAILURE" = "1" ]; then exit 1; fi
    ;;
esac
`, { mode: 0o700 });
  await chmod(npm, 0o700);
  return {
    workdir,
    log,
    backup,
    env: {
      ...process.env,
      ALLOW_RESTORE: "true",
      FAKE_DOCKER_LOG: log,
      FAKE_TARGET_EXISTS: targetExists ? "1" : "",
      FAKE_RESTORE_FAILURE: failRestore ? "1" : "",
      FAKE_MIGRATION_FAILURE: options.failMigration ? "1" : "",
      FAKE_READINESS_FAILURE: options.failReadiness ? "1" : "",
      FAKE_BASELINE_MIGRATION_COUNT: options.baselineMigrationCount ?? "26",
      FAKE_FINAL_MIGRATION_COUNT: options.finalMigrationCount ?? String(currentMigrationNames.length),
      FAKE_STAGE10_FUNCTION_COUNT: options.stage10FunctionCount ?? "3",
      FAKE_STAGE10_TRIGGER_COUNT: options.stage10TriggerCount ?? "2",
      FAKE_STAGE10_IMMEDIATE_TRIGGER_COUNT: options.stage10ImmediateTriggerCount ?? "3",
      FAKE_STAGE11_FUNCTION_COUNT: options.stage11FunctionCount ?? "14",
      FAKE_STAGE11_REPLACEMENT_COUNT: options.stage11ReplacementCount ?? "2",
      FAKE_STAGE11_BODY_MARKER_COUNT: options.stage11BodyMarkerCount ?? "8",
      FAKE_STAGE11_TRIGGER_COUNT: options.stage11TriggerCount ?? "4",
      FAKE_STAGE11_IMMEDIATE_TRIGGER_COUNT: options.stage11ImmediateTriggerCount ?? "8",
      FAKE_BASELINE_UNKNOWN_MIGRATION_COUNT: options.baselineUnknownMigrationCount ?? "0",
      FAKE_FINAL_UNKNOWN_MIGRATION_COUNT: options.finalUnknownMigrationCount ?? "0",
      FAKE_RESTORED_MIGRATION_MANIFEST: `${(options.restoredMigrationNames ?? currentMigrationNames.slice(0, 26)).length}:${(options.restoredMigrationNames ?? currentMigrationNames.slice(0, 26)).join(",")}`,
      FAKE_CREATED_TARGET_OID: "42001",
      FAKE_CLEANUP_TARGET_OID: replacementOid ?? "42001",
      FAKE_OID_QUERY_COUNT_FILE: oidQueryCount,
      FAKE_MIGRATION_STATE_FILE: migrationState,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`
    }
  };
}

describe("restore script contract", () => {
  it("refuses an existing target without dropping or recreating it", async () => {
    const fixture = await fakeDockerEnvironment(true);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "existing_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 2 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("psql");
      expect(calls).not.toContain("dropdb");
      expect(calls).not.toContain("createdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("creates a new target, upgrades a stage 9 backup, and validates the current stage 13 schema", async () => {
    const fixture = await fakeDockerEnvironment(false);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "new_restore_target"], { env: fixture.env }))
        .resolves.toMatchObject({ stdout: expect.stringContaining("Restored") });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia new_restore_target");
      expect(calls).toContain("pg_restore");
      expect(calls).toContain("npm run db:migrate");
      expect(calls).toContain("007_reference_catalog.sql");
      expect(calls).toContain("008_reference_catalog_sealing.sql");
      expect(calls).toContain("009_booking_channels_and_transaction_references.sql");
      expect(calls).toContain("010_qintopia_2026_catalog_pricing_and_free_stays.sql");
      expect(calls).toContain("011_core_fact_shape_guards.sql");
      expect(calls).toContain("012_legacy_demo_inventory_catalog_backfill.sql");
      expect(calls).toContain("013_room_status_operations.sql");
      expect(calls).toContain("014_new_order_primary_guest_nickname.sql");
      expect(calls).toContain("015_generated_room_operational_codes.sql");
      expect(calls).toContain("016_member_property_links.sql");
      expect(calls).toContain("017_membership_orders.sql");
      expect(calls).toContain("018_member_stay_identity_and_coverage_guards.sql");
      expect(calls).toContain("019_member_stay_booking_channel_rules.sql");
      expect(calls).toContain("020_whole_room_occupants.sql");
      expect(calls).toContain("021_defer_internal_use.sql");
      expect(calls).toContain("022_order_occupant_corrections.sql");
      expect(calls).toContain("023_collection_fact_pricing_revision.sql");
      expect(calls).toContain("024_free_stay_category_code.sql");
      expect(calls).toContain("025_channel_order_atomic_pricing.sql");
      expect(calls).toContain("026_stage9_stay_change_guards.sql");
      expect(calls).toContain("027_stage10_stay_shortening_guards.sql");
      expect(calls).toContain("028_stage11_move_unit_guards.sql");
      expect(calls).toContain("029_stage12_terminal_order_guards.sql");
      expect(calls).toContain("030_collection_fact_historical_pricing_revision.sql");
      expect(calls).toContain("031_collection_fact_method_transaction_rules.sql");
      expect(calls).toContain("032_wecom_refund_original_route.sql");
      expect(calls).toContain("033_stay_collection_membership_conversion.sql");
      expect(calls).toContain("034_stay_conversion_reversal_bridge_guard.sql");
      expect(calls).toContain("035_stage13_conversion_execution_state_guards.sql");
      expect(calls).toContain("npm run db:ready");
      expect(calls).toContain("pricing_revisions_stage10_validate");
      expect(calls).toContain("amendments_stage10_reject_checkout_bypass");
      expect(calls).toContain("entitlement_ledger_stage10_reject_write");
      expect(calls).toContain("qintopia_validate_stage10_pricing_revision");
      expect(calls).toContain("qintopia_reject_stage10_checkout_bypass");
      expect(calls).toContain("qintopia_reject_stage10_entitlement_write");
      expect(calls).toContain("qintopia_validate_stage10_shorten_combination");
      expect(calls).toContain("qintopia_validate_stage10_shorten_execution");
      expect(calls).toContain("qintopia_assert_stage11_move_combination");
      expect(calls).toContain("qintopia_assert_stage11_date_change_combination");
      expect(calls).toContain("qintopia_assert_stage11_shorten_before_timeline");
      expect(calls).toContain("qintopia_validate_stage11_shorten_before_timeline");
      expect(calls).toContain("qintopia_preserve_stage11_preview_evidence");
      expect(calls).toContain("qintopia_assert_stage11_protocol_evidence");
      expect(calls).toContain("reschedule_pair_valid");
      expect(calls).toContain("stage11_move_order_command_chain");
      expect(calls).toContain("stage11_preview_evidence_immutable");
      expect(calls).toContain("pricing_revisions_stage11_validate_move");
      expect(calls).toContain("amendments_stage11_validate_move_combination");
      expect(calls).toContain("amendments_stage11_validate_shorten_before_timeline");
      expect(calls).toContain("command_executions_stage11_validate_shorten_before_timeline");
      expect(calls).toContain("handler.proname = 'qintopia_validate_stage11_shorten_before_timeline'");
      expect(calls).toContain("inventory_claims_validate_source");
      expect(calls).toContain("handler.proname = 'qintopia_validate_inventory_claim_source'");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("rejects a backup below the supported stage 9 baseline and retains the failed target", async () => {
    const fixture = await fakeDockerEnvironment(false, false, undefined, { baselineMigrationCount: "25" });
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "unsupported_restore_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 1 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).not.toContain("npm run db:migrate");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("rejects unknown future migrations before upgrading or accepting a restore", async () => {
    for (const [target, options, expectsMigration] of [
      ["future_backup_target", { baselineUnknownMigrationCount: "1" }, false],
      ["future_after_upgrade_target", { finalUnknownMigrationCount: "1" }, true]
    ] as const) {
      const fixture = await fakeDockerEnvironment(false, false, undefined, options);
      try {
        await expect(execFileAsync("bash", [restoreScript, fixture.backup, target], { env: fixture.env }))
          .rejects.toMatchObject({ code: 1 });
        const calls = await readFile(fixture.log, "utf8");
        if (expectsMigration) expect(calls).toContain("npm run db:migrate");
        else expect(calls).not.toContain("npm run db:migrate");
        expect(calls).not.toContain("dropdb");
      } finally {
        await rm(fixture.workdir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a restored migration history with a gap before running newer migrations", async () => {
    const fixture = await fakeDockerEnvironment(false, false, undefined, {
      restoredMigrationNames: [...currentMigrationNames.slice(0, 26), currentMigrationNames[27]!]
    });
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "gapped_restore_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("non-contiguous migration history") });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).not.toContain("npm run db:migrate");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("retains the new target when migration or current readiness validation fails", async () => {
    for (const [target, options] of [
      ["failed_migration_target", { failMigration: true }],
      ["failed_readiness_target", { failReadiness: true }],
      ["incomplete_stage10_target", { stage10FunctionCount: "2" }],
      ["missing_stage10_immediate_trigger_target", { stage10ImmediateTriggerCount: "2" }],
      ["incomplete_stage11_target", { stage11FunctionCount: "13" }],
      ["stale_stage11_replacement_target", { stage11ReplacementCount: "1" }],
      ["damaged_stage11_function_body_target", { stage11BodyMarkerCount: "7" }],
      ["missing_stage11_deferred_trigger_target", { stage11TriggerCount: "3" }],
      ["missing_stage11_immediate_trigger_target", { stage11ImmediateTriggerCount: "7" }]
    ] as const) {
      const fixture = await fakeDockerEnvironment(false, false, undefined, options);
      try {
        await expect(execFileAsync("bash", [restoreScript, fixture.backup, target], { env: fixture.env }))
          .rejects.toMatchObject({ code: 1 });
        const calls = await readFile(fixture.log, "utf8");
        expect(calls).toContain("npm run db:migrate");
        expect(calls).not.toContain("dropdb");
      } finally {
        await rm(fixture.workdir, { recursive: true, force: true });
      }
    }
  });

  it("builds the restore fixture from the real stage 10 migration boundary", async () => {
    const script = await readFile(verifyBackupRestoreScript, "utf8");
    expect(script).toContain('migration_number="${migration_name%%_*}"');
    expect(script).toContain("10#$migration_number > 27");
    expect(script).toContain("cat \"$migration_path\"");
    expect(script).toContain("INSERT INTO schema_migrations(name)");
    expect(script).toContain("027_stage10_stay_shortening_guards.sql");
    expect(script).toContain("028_stage11_move_unit_guards.sql");
    expect(script).toContain("037_member_phone_identity_and_nickname.sql");
    expect(script).not.toContain("DROP TRIGGER IF EXISTS");
    expect(script).not.toContain("DELETE FROM schema_migrations");

    const fixtureIndex = script.indexOf("tests/helpers/create-restore-fixture.ts");
    const dumpIndex = script.indexOf('pg_dump -U "$user" -Fc "$source_database"');
    expect(fixtureIndex).toBeGreaterThan(0);
    expect(dumpIndex).toBeGreaterThan(fixtureIndex);
  });

  it("accepts only origin and always enabled guard triggers in readiness and restore gates", async () => {
    const [databaseSource, restoreSource, verifyRestoreSource, composeSource] = await Promise.all([
      readFile(databaseModule, "utf8"),
      readFile(restoreScript, "utf8"),
      readFile(verifyBackupRestoreScript, "utf8"),
      readFile(verifyComposeColdStartScript, "utf8")
    ]);
    for (const source of [databaseSource, restoreSource, verifyRestoreSource, composeSource]) {
      expect(source).toContain("tgenabled IN ('O','A')");
      expect(source).not.toContain("tgenabled <> 'D'");
    }
    for (const source of [verifyRestoreSource, composeSource]) {
      expect(source).toContain("037_member_phone_identity_and_nickname.sql");
    }
  });

  it("passes PostgreSQL credentials discretely so reserved password characters are not parsed as a URI", async () => {
    const fixture = await fakeDockerEnvironment(false);
    const password = "p@ss:/#word";
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "reserved_password_target"], {
        env: { ...fixture.env, POSTGRES_PASSWORD: password }
      })).resolves.toMatchObject({ stdout: expect.stringContaining("Restored") });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain(`pg user=qintopia password=${password} host=127.0.0.1 port=55432 database=reserved_password_target`);
      expect(calls).not.toContain("DATABASE_URL=postgres://");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }

    const [restoreSource, verifyRestoreSource] = await Promise.all([
      readFile(restoreScript, "utf8"),
      readFile(verifyBackupRestoreScript, "utf8")
    ]);
    for (const source of [restoreSource, verifyRestoreSource]) {
      expect(source).not.toContain("DATABASE_URL=postgres://$user:$password@");
      expect(source).toContain('DATABASE_URL=""');
      expect(source).toContain('PGPASSWORD="$password"');
    }
  });

  it("encodes discrete PostgreSQL connection fields without changing their values", () => {
    const names = ["DATABASE_URL", "PGUSER", "PGPASSWORD", "PGHOST", "PGPORT", "PGDATABASE"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      delete process.env.DATABASE_URL;
      process.env.PGUSER = "restore@operator";
      process.env.PGPASSWORD = "p@ss:/#word";
      process.env.PGHOST = "127.0.0.1";
      process.env.PGPORT = "55432";
      process.env.PGDATABASE = "restore_target";
      const parsed = new URL(databaseUrl());
      expect(decodeURIComponent(parsed.username)).toBe("restore@operator");
      expect(decodeURIComponent(parsed.password)).toBe("p@ss:/#word");
      expect(parsed.hostname).toBe("127.0.0.1");
      expect(parsed.port).toBe("55432");
      expect(parsed.pathname).toBe("/restore_target");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("retains the newly created partial target when restore fails", async () => {
    const fixture = await fakeDockerEnvironment(false, true);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "failed_restore_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 1 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia failed_restore_target");
      expect(calls).toContain("pg_restore");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("never queries identity or drops a same-name database during failure cleanup", async () => {
    const fixture = await fakeDockerEnvironment(false, true, "42002");
    try {
      const failure = await execFileAsync("bash", [restoreScript, fixture.backup, "replaced_restore_target"], { env: fixture.env })
        .then(() => undefined, (error: unknown) => error as { code?: number; stderr?: string });
      expect(failure).toMatchObject({ code: 1 });
      expect(failure?.stderr).toContain("retained for manual inspection");
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia replaced_restore_target");
      expect(calls).not.toContain("SELECT oid FROM pg_database");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });
});
