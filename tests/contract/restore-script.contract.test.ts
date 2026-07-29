import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const restoreScript = fileURLToPath(new URL("../../scripts/restore.sh", import.meta.url));

async function fakeDockerEnvironment(targetExists: boolean, failRestore = false, replacementOid?: string) {
  const workdir = await mkdtemp(join(tmpdir(), "qintopia-restore-contract-"));
  const bin = join(workdir, "bin");
  const log = join(workdir, "docker.log");
  const backup = join(workdir, "backup.dump");
  const oidQueryCount = join(workdir, "oid-query-count");
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
  *"schema_migrations"*) printf '26' ;;
  *" pg_restore "*) if [ "$FAKE_RESTORE_FAILURE" = "1" ]; then exit 1; fi ;;
esac
`, { mode: 0o700 });
  await chmod(docker, 0o700);
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
      FAKE_CREATED_TARGET_OID: "42001",
      FAKE_CLEANUP_TARGET_OID: replacementOid ?? "42001",
      FAKE_OID_QUERY_COUNT_FILE: oidQueryCount,
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

  it("creates and restores only when the target name is new", async () => {
    const fixture = await fakeDockerEnvironment(false);
    try {
      await expect(execFileAsync("bash", [restoreScript, fixture.backup, "new_restore_target"], { env: fixture.env }))
        .resolves.toMatchObject({ stdout: expect.stringContaining("Restored") });
      const calls = await readFile(fixture.log, "utf8");
      expect(calls).toContain("createdb -U qintopia new_restore_target");
      expect(calls).toContain("pg_restore");
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
      expect(calls).not.toContain("dropdb");
    } finally {
      await rm(fixture.workdir, { recursive: true, force: true });
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
