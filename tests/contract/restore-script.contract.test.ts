import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const restoreScript = fileURLToPath(new URL("../../scripts/restore.sh", import.meta.url));

async function fakeDockerEnvironment(
  targetExists: boolean,
  failRestore = false,
  replacementOid?: string,
  options: {
    baselineMigrationCount?: string;
    failMigration?: boolean;
    finalMigrationCount?: string;
    stage10FunctionCount?: string;
    stage10TriggerCount?: string;
    stage10ImmediateTriggerCount?: string;
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
  *"schema_migrations"*)
    if [ -f "$FAKE_MIGRATION_STATE_FILE" ]; then
      printf '%s' "$FAKE_FINAL_MIGRATION_COUNT"
    else
      printf '%s' "$FAKE_BASELINE_MIGRATION_COUNT"
    fi
    ;;
  *"qintopia_assert_stage10_shorten_combination"*) printf '%s' "$FAKE_STAGE10_FUNCTION_COUNT" ;;
  *"pricing_revisions_stage10_validate"*) printf '%s' "$FAKE_STAGE10_IMMEDIATE_TRIGGER_COUNT" ;;
  *"pg_trigger"*) printf '%s' "$FAKE_STAGE10_TRIGGER_COUNT" ;;
  *" pg_restore "*) if [ "$FAKE_RESTORE_FAILURE" = "1" ]; then exit 1; fi ;;
esac
`, { mode: 0o700 });
  await chmod(docker, 0o700);
  const npm = join(bin, "npm");
  await writeFile(npm, `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$FAKE_MIGRATION_FAILURE" = "1" ]; then exit 1; fi
touch "$FAKE_MIGRATION_STATE_FILE"
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
      FAKE_BASELINE_MIGRATION_COUNT: options.baselineMigrationCount ?? "26",
      FAKE_FINAL_MIGRATION_COUNT: options.finalMigrationCount ?? "27",
      FAKE_STAGE10_FUNCTION_COUNT: options.stage10FunctionCount ?? "3",
      FAKE_STAGE10_TRIGGER_COUNT: options.stage10TriggerCount ?? "2",
      FAKE_STAGE10_IMMEDIATE_TRIGGER_COUNT: options.stage10ImmediateTriggerCount ?? "3",
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

  it("creates a new target, upgrades a stage 9 backup, and validates the complete stage 10 schema", async () => {
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
      expect(calls).toContain("pricing_revisions_stage10_validate");
      expect(calls).toContain("amendments_stage10_reject_checkout_bypass");
      expect(calls).toContain("entitlement_ledger_stage10_reject_write");
      expect(calls).toContain("qintopia_validate_stage10_pricing_revision");
      expect(calls).toContain("qintopia_reject_stage10_checkout_bypass");
      expect(calls).toContain("qintopia_reject_stage10_entitlement_write");
      expect(calls).toContain("qintopia_validate_stage10_shorten_combination");
      expect(calls).toContain("qintopia_validate_stage10_shorten_execution");
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("rejects a backup below the supported stage 9 baseline before running migrations", async () => {
    const fixture = await fakeDockerEnvironment(false, false, undefined, { baselineMigrationCount: "25" });
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "unsupported_restore_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 1 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).not.toContain("npm run db:migrate");
      expect(calls).toContain("dropdb -U qintopia --if-exists unsupported_restore_target");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("removes the new target when migration or final stage 10 object validation fails", async () => {
    for (const [target, options] of [
      ["failed_migration_target", { failMigration: true }],
      ["incomplete_stage10_target", { stage10FunctionCount: "2" }],
      ["missing_stage10_immediate_trigger_target", { stage10ImmediateTriggerCount: "2" }]
    ] as const) {
      const fixture = await fakeDockerEnvironment(false, false, undefined, options);
      try {
        await expect(execFileAsync("bash", [restoreScript, fixture.backup, target], { env: fixture.env }))
          .rejects.toMatchObject({ code: 1 });
        const calls = await readFile(fixture.log, "utf8");
        expect(calls).toContain("npm run db:migrate");
        expect(calls).toContain(`dropdb -U qintopia --if-exists ${target}`);
      } finally {
        await rm(fixture.workdir, { recursive: true, force: true });
      }
    }
  });

  it("drops only the newly created partial target when restore fails", async () => {
    const fixture = await fakeDockerEnvironment(false, true);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "failed_restore_target"], { env: fixture.env }))
        .rejects.toMatchObject({ code: 1 });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia failed_restore_target");
      expect(calls).toContain("pg_restore");
      expect(calls).toContain("dropdb -U qintopia --if-exists failed_restore_target");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });

  it("does not drop a same-name database whose identity changed before failure cleanup", async () => {
    const fixture = await fakeDockerEnvironment(false, true, "42002");
    try {
      const failure = await execFileAsync("bash", [restoreScript, fixture.backup, "replaced_restore_target"], { env: fixture.env })
        .then(() => undefined, (error: unknown) => error as { code?: number; stderr?: string });
      expect(failure).toMatchObject({ code: 1 });
      expect(failure?.stderr).toContain("no longer has the OID created by this restore");
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia replaced_restore_target");
      expect(calls).not.toContain("dropdb -U qintopia --if-exists replaced_restore_target");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
    }
  });
});
