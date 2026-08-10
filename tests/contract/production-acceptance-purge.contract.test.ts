import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { productionAcceptancePurgeSpec } from "../../scripts/purge-production-acceptance-data.ts";

const scriptPath = resolve(process.cwd(), "scripts/purge-production-acceptance-data.ts");
const packagePath = resolve(process.cwd(), "package.json");

describe("production acceptance purge contract", () => {
  it("binds the immutable seven-order production allowlist and inspected row counts", () => {
    expect(productionAcceptancePurgeSpec.orderIds).toEqual([
      "order_b8a87ffe-72b2-4d7e-88c7-ba54ec1ad585",
      "order_567aa352-0453-40e6-a1b3-513cf5b3dd1c",
      "order_3e3eace9-77c7-4988-b5b1-dd779b8d9400",
      "order_694c51f5-b4ed-4a0e-b1ee-89388ee87228",
      "order_57715571-cc3e-464f-8fe3-8c9f03b70334",
      "order_917f942d-94ce-4a0d-a1de-d8ac89090455",
      "order_17efc59c-a331-43eb-a3df-f29221ff94a0"
    ]);
    expect(productionAcceptancePurgeSpec.orderSources).toHaveLength(7);
    expect(productionAcceptancePurgeSpec.expectedCounts).toMatchObject({
      orders: 7,
      stays: 7,
      amendments: 17,
      stay_segments: 9,
      pricing_revisions: 15,
      inventory_claims: 53,
      quotes: 46,
      command_executions: 93,
      command_receipts: 93,
      audit_entries: 93,
      subjects: 2,
      api_tokens: 4,
      web_sessions: 14,
      migration_import_runs: 0
    });
  });

  it("uses one SERIALIZABLE advisory-locked TRUNCATE RESTRICT boundary without trigger or cascade bypasses", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("TRUNCATE TABLE ${truncateList} RESTRICT");
    expect(source).toContain("IN ACCESS EXCLUSIVE MODE");
    expect(source).toContain("IN SHARE MODE");
    expect(source).not.toMatch(/TRUNCATE[^\n]*CASCADE/i);
    expect(source).not.toContain("DISABLE TRIGGER");
    expect(source).not.toContain("session_replication_role");
    expect(source).not.toContain("DROP TABLE");
  });

  it("defaults to inspection and requires an approval token plus owner-private password file for apply", async () => {
    const source = await readFile(scriptPath, "utf8");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["db:purge:production-acceptance"]).toBe(
      "node --import tsx scripts/purge-production-acceptance-data.ts"
    );
    expect(source).toContain('if (arguments_.length === 0) return "inspect"');
    expect(source).toContain("PURGE_PRODUCTION_ACCEPTANCE_APPROVAL_TOKEN");
    expect(source).toContain("PURGE_PRODUCTION_APPLICATION_STOPPED");
    expect(source).toContain("PURGE_PRODUCTION_DEMO_SEED_DISABLED");
    expect(source).toContain("PURGE_PRODUCTION_OPERATOR_PASSWORD_FILE");
    expect(source).toContain("DELETE_EXACT_QINTOPIA_ACCEPTANCE_SNAPSHOT");
    expect(source).toContain("stat.isFile() && !stat.isSymbolicLink()");
    expect(source).toContain("(stat.mode & 0o077) === 0");
    expect(source).toContain("stat.uid === process.geteuid()");
  });
});
