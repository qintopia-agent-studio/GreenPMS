import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase, databaseReady, type Database } from "@qintopia/db";
import { sql, type Kysely } from "kysely";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const target = new URL(process.env.ASSISTANT_TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_ai_contract");
target.pathname += "_providers";
let owner: Kysely<Database>, runtime: Kysely<Database>;
const adminSession = "ai-provider-contract-admin", staffSession = "ai-provider-contract-staff";
const primary = { name: "合成主用", enabled: true, url: "https://primary.example/v1", model: "synthetic-primary", key: "cipher-primary-synthetic" };
const backup = { name: "合成备用", enabled: true, url: "https://backup.example/v1", model: "synthetic-backup", key: "cipher-backup-synthetic" };
type SaveInput = { actor: string; session: string; propertyId: string; globalEnabled: boolean; tested: boolean } & typeof primary;
const settings = () => owner.selectFrom("ai_model_settings").selectAll().executeTakeFirstOrThrow();
async function save(role: "primary" | "backup", version: number, input: Partial<SaveInput> = {}) {
  const p = { ...(role === "primary" ? primary : backup), actor: demo.administratorSubjectId, session: adminSession,
    propertyId: demo.propertyId, globalEnabled: true, tested: true, ...input };
  return sql<{ version: number }>`SELECT qintopia_save_ai_provider_settings(${p.actor}, ${p.session}, ${p.propertyId}, ${version},
    ${p.globalEnabled}, ${role}, ${p.name}, ${p.enabled}, ${p.url}, ${p.model}, ${p.key}, ${p.tested}) AS version`.execute(runtime);
}
const promote = (version: number, actor: string = demo.administratorSubjectId, session = adminSession) =>
  sql`SELECT qintopia_promote_ai_backup(${actor}, ${session}, ${demo.propertyId}, ${version})`.execute(runtime);

beforeAll(async () => {
  vi.stubEnv("STAFF_PROFILE_MANIFEST_NAME", "demo");
  owner = await resetDatabase(target.toString());
  runtime = createDatabase(runtimeDatabaseUrlForTesting(target.toString()));
  for (const [id, subjectId] of [[adminSession, demo.administratorSubjectId], [staffSession, demo.operatorSubjectId]]) {
    await owner.insertInto("web_sessions").values({ id: id!, subject_id: subjectId!, secret_hash: `synthetic-${id}`,
      expires_at: new Date(Date.now() + 3_600_000), revoked_at: null }).execute();
  }
}, 120_000);
beforeEach(async () => {
  await sql`TRUNCATE ai_settings_audit`.execute(owner);
  await owner.deleteFrom("ai_model_settings").execute();
  await owner.updateTable("web_sessions").set({ revoked_at: null, expires_at: new Date(Date.now() + 3_600_000) })
    .where("id", "in", [adminSession, staffSession]).execute();
});
afterAll(async () => { await runtime?.destroy(); await owner?.destroy(); vi.unstubAllEnvs(); });

describe.sequential("AI primary/backup settings database contract", () => {
  it("preserves the existing primary during the additive migration without inventing a test result", async () => {
    const before = await readFile(resolve("packages/db/src/migrations/062_ai_assistant.sql"), "utf8");
    const upgrade = await readFile(resolve("packages/db/src/migrations/079_ai_provider_failover.sql"), "utf8");
    const rollback = new Error("rollback synthetic upgrade schema");
    await expect(owner.transaction().execute(async trx => {
      await sql`CREATE SCHEMA ai_provider_upgrade_probe`.execute(trx);
      await sql`SET LOCAL search_path = ai_provider_upgrade_probe, public`.execute(trx);
      await sql.raw(before).execute(trx);
      await sql`INSERT INTO ai_provider_upgrade_probe.ai_model_settings
        (scope_id, management_property_id, version, enabled, base_url, model, encrypted_key, updated_by)
        VALUES ('installation', ${demo.propertyId}, 3, true, ${primary.url}, ${primary.model}, ${primary.key}, ${demo.administratorSubjectId})`.execute(trx);
      await sql.raw(upgrade).execute(trx);
      const row = (await sql<Record<string, unknown>>`SELECT * FROM ai_provider_upgrade_probe.ai_model_settings`.execute(trx)).rows[0]!;
      expect(row).toMatchObject({ version: 3, enabled: true, base_url: primary.url, model: primary.model, encrypted_key: primary.key,
        provider_enabled: true, provider_tested_at: null, backup_enabled: false, backup_base_url: "", backup_model: "", backup_encrypted_key: "", backup_tested_at: null });
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await databaseReady(runtime)).toBe(true);
  });

  it("requires a passing test before activating a new provider and keeps test metadata bound to its configuration", async () => {
    await expect(save("primary", 0, { tested: false })).rejects.toThrow("AI_TEST_REQUIRED");
    await save("primary", 0, { enabled: false, globalEnabled: false, tested: false });
    expect((await settings()).provider_tested_at).toBeNull();
    await expect(save("primary", 1, { tested: false })).rejects.toThrow("AI_TEST_REQUIRED");
    await save("primary", 1);
    expect((await settings()).provider_tested_at).toBeInstanceOf(Date);
    await expect(save("backup", 2, { tested: false })).rejects.toThrow("AI_TEST_REQUIRED");
    await save("backup", 2, { enabled: false, tested: false });
    expect((await settings()).backup_tested_at).toBeNull();
    await save("backup", 3);
    const tested = (await settings()).backup_tested_at;
    await save("backup", 4, { name: "仅重命名", tested: false });
    expect((await settings()).backup_tested_at).toEqual(tested);
    await expect(save("backup", 5, { model: "changed-model", tested: false })).rejects.toThrow("AI_TEST_REQUIRED");
    await save("backup", 5, { enabled: false, model: "changed-model", tested: false });
    expect((await settings()).backup_tested_at).toBeNull();
  });

  it("does not let the legacy signature bypass tests or overwrite the backup", async () => {
    const legacy = (version: number, model: string, enabled = true) => sql`SELECT qintopia_save_ai_settings(
      ${demo.administratorSubjectId}, ${adminSession}, ${demo.propertyId}, ${version}, ${enabled}, ${primary.url}, ${model}, ${primary.key})`.execute(runtime);
    await expect(legacy(0, primary.model)).rejects.toThrow("AI_TEST_REQUIRED");
    await save("primary", 0); await save("backup", 1);
    const original = await settings();
    await legacy(2, primary.model);
    expect(await settings()).toMatchObject({ backup_name: original.backup_name, backup_base_url: original.backup_base_url,
      backup_model: original.backup_model, backup_encrypted_key: original.backup_encrypted_key, backup_enabled: true });
    await expect(legacy(3, "unchecked-change")).rejects.toThrow("AI_TEST_REQUIRED");
  });

  it("keeps an unchanged historical primary running and disables its untested configuration when promoted to backup", async () => {
    await owner.insertInto("ai_model_settings").values({ scope_id: "installation", management_property_id: demo.propertyId,
      version: 1, enabled: true, base_url: primary.url, model: primary.model, encrypted_key: primary.key, updated_by: demo.administratorSubjectId }).execute();
    await save("primary", 1, { tested: false });
    expect((await settings()).provider_tested_at).toBeNull();
    await save("backup", 2);
    await promote(3);
    expect(await settings()).toMatchObject({ base_url: backup.url, encrypted_key: backup.key, provider_enabled: true,
      backup_base_url: primary.url, backup_encrypted_key: primary.key, backup_enabled: false, backup_tested_at: null });
  });

  it("atomically exchanges complete tested configurations and records no credentials in its audit", async () => {
    await save("primary", 0); await save("backup", 1);
    const original = await settings();
    await promote(2);
    const switched = await settings();
    expect(switched).toMatchObject({ version: 3, base_url: backup.url, model: backup.model, encrypted_key: backup.key,
      provider_name: backup.name, provider_enabled: true, provider_tested_at: original.backup_tested_at,
      backup_name: primary.name, backup_base_url: primary.url, backup_model: primary.model, backup_encrypted_key: primary.key,
      backup_enabled: true, backup_tested_at: original.provider_tested_at });
    await promote(3);
    expect(await settings()).toMatchObject({ version: 4, base_url: primary.url, encrypted_key: primary.key, backup_base_url: backup.url, backup_encrypted_key: backup.key });
    const audit = (await sql<Record<string, unknown>>`SELECT * FROM ai_settings_audit ORDER BY id`.execute(owner)).rows;
    expect(audit.map(row => row.operation)).toEqual(["SAVE", "SAVE", "PROMOTE", "PROMOTE"]);
    expect(JSON.stringify(audit)).not.toContain(primary.key);
    expect(JSON.stringify(audit)).not.toContain(backup.key);
  });

  it("cannot activate an untested historical primary by enabling the installation through a backup save", async () => {
    await owner.insertInto("ai_model_settings").values({ scope_id: "installation", management_property_id: demo.propertyId,
      version: 1, enabled: false, base_url: primary.url, model: primary.model, encrypted_key: primary.key, updated_by: demo.administratorSubjectId }).execute();
    await expect(save("backup", 1)).rejects.toThrow("AI_TEST_REQUIRED");
    await save("backup", 1, { globalEnabled: false });
    expect((await settings()).enabled).toBe(false);
    await save("primary", 2);
    expect((await settings()).enabled).toBe(true);
  });

  it("rejects promotion of a disabled or untested backup", async () => {
    await save("primary", 0);
    await expect(promote(1)).rejects.toThrow("AI_TEST_REQUIRED");
    await save("backup", 1, { enabled: false, tested: false });
    await expect(promote(2)).rejects.toThrow("AI_TEST_REQUIRED");
    await save("backup", 2, { enabled: false });
    await expect(promote(3)).rejects.toThrow("AI_TEST_REQUIRED");
  });

  it("rechecks administrator session/property authorization for saves and promotion", async () => {
    await save("primary", 0); await save("backup", 1);
    await expect(save("backup", 2, { actor: demo.operatorSubjectId, session: staffSession })).rejects.toThrow("AI_FORBIDDEN");
    await expect(promote(2, demo.operatorSubjectId, staffSession)).rejects.toThrow("AI_FORBIDDEN");
    await expect(save("backup", 2, { propertyId: "another-property" })).rejects.toThrow("AI_FORBIDDEN");
    await owner.updateTable("web_sessions").set({ revoked_at: new Date() }).where("id", "=", adminSession).execute();
    await expect(save("backup", 2)).rejects.toThrow("AI_FORBIDDEN");
    await expect(promote(2)).rejects.toThrow("AI_FORBIDDEN");
    expect((await settings()).version).toBe(2);
  });

  it("serializes competing writes with CAS and rejects cross-address key reuse", async () => {
    await save("primary", 0);
    const concurrent = await Promise.allSettled([save("backup", 1, { name: "first" }), save("backup", 1, { name: "second" })]);
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((concurrent.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("AI_STALE");
    expect((await settings()).version).toBe(2);
    await expect(sql`SELECT qintopia_save_ai_provider_settings(${demo.administratorSubjectId}, ${adminSession}, ${demo.propertyId}, 2,
      true, 'backup', 'changed', true, 'https://other.example/v1', ${backup.model}, NULL, true)`.execute(runtime)).rejects.toThrow("AI_KEY_REQUIRED");
    await expect(promote(1)).rejects.toThrow("AI_STALE");
  });

  it("denies direct runtime writes and protects readiness against function/ACL drift", async () => {
    expect(await databaseReady(runtime)).toBe(true);
    await expect(sql`UPDATE ai_model_settings SET backup_enabled = true`.execute(runtime)).rejects.toThrow("permission denied");
    await expect(sql`INSERT INTO ai_settings_audit(scope_id) VALUES ('installation')`.execute(runtime)).rejects.toThrow("permission denied");
    const signature = "qintopia_promote_ai_backup(text,text,text,integer)";
    const original = (await sql<{ definition: string }>`SELECT pg_get_functiondef(to_regprocedure(${signature})) AS definition`.execute(owner)).rows[0]!.definition;
    try {
      await sql.raw(original.replace("next_version := expected_version + 1;", "next_version := expected_version + 2;")).execute(owner);
      expect(await databaseReady(runtime)).toBe(false);
    } finally { await sql.raw(original).execute(owner); }
    try {
      await sql`GRANT EXECUTE ON FUNCTION qintopia_promote_ai_backup(text,text,text,integer) TO PUBLIC`.execute(owner);
      expect(await databaseReady(runtime)).toBe(false);
    } finally { await sql`REVOKE EXECUTE ON FUNCTION qintopia_promote_ai_backup(text,text,text,integer) FROM PUBLIC`.execute(owner); }
    try {
      await sql`GRANT UPDATE (backup_name) ON ai_model_settings TO qintopia_runtime`.execute(owner);
      expect(await databaseReady(runtime)).toBe(false);
    } finally { await sql`REVOKE UPDATE (backup_name) ON ai_model_settings FROM qintopia_runtime`.execute(owner); }
    try {
      await sql`ALTER TABLE ai_model_settings DROP CONSTRAINT ai_enabled_backup_tested`.execute(owner);
      await sql`ALTER TABLE ai_model_settings ADD CONSTRAINT ai_enabled_backup_tested CHECK (true)`.execute(owner);
      expect(await databaseReady(runtime)).toBe(false);
    } finally {
      await sql`ALTER TABLE ai_model_settings DROP CONSTRAINT ai_enabled_backup_tested`.execute(owner);
      await sql`ALTER TABLE ai_model_settings ADD CONSTRAINT ai_enabled_backup_tested CHECK (NOT backup_enabled OR backup_tested_at IS NOT NULL)`.execute(owner);
    }
    expect(await databaseReady(runtime)).toBe(true);
  });
});
