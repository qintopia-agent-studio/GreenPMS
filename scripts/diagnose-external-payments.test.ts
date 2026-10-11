import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const diagnostic = readFileSync(new URL("./diagnose-external-payments.sql", import.meta.url), "utf8");
const readiness = readFileSync(new URL("../packages/db/src/external-payments-readiness.ts", import.meta.url), "utf8");
const sql = diagnostic.replace(/--[^\n]*/g, "").trim();

function fingerprintItems(source: string, ending: string) {
  const start = source.indexOf("WITH tables AS (");
  const end = source.indexOf(ending, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).trim();
}

describe("external payment read-only diagnostic", () => {
  it("uses exactly the runtime fingerprint inputs and accepted hashes", () => {
    expect(fingerprintItems(diagnostic, "  ), fingerprints AS (")).toBe(fingerprintItems(readiness, "  ) SELECT encode("));
    expect(diagnostic).toContain("encode(sha256(convert_to(jsonb_agg(jsonb_build_array(key,value) ORDER BY key)::text,'UTF8')),'hex') AS runtime_sha256");
    const hashes = (source: string) => [...source.matchAll(/["']([a-f0-9]{64})["']/g)].map(match => match[1]).sort();
    expect(hashes(diagnostic)).toEqual(hashes(readiness));
  });

  it("runs one catalog query in a bounded read-only snapshot, ending with rollback", () => {
    const withoutDescriptions = sql.replace(/'(?:''|[^'])*'/g, "''");
    const commands = withoutDescriptions.split(";").map(statement => statement.trim()).filter(Boolean);
    expect(commands).toHaveLength(6);
    expect(commands[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(commands.slice(1, 4)).toEqual([
      "SET LOCAL statement_timeout = ''",
      "SET LOCAL lock_timeout = ''",
      "SET LOCAL idle_in_transaction_session_timeout = ''"
    ]);
    expect(commands[4]).toMatch(/^WITH tables AS \(/);
    expect(commands[5]).toBe("ROLLBACK");
    expect(sql).toContain("SET LOCAL statement_timeout = '15s'");
    expect(sql).toContain("SET LOCAL lock_timeout = '2s'");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|DO|CALL|COMMIT)\b/i);
    expect(sql).not.toMatch(/SET\s+(?:LOCAL\s+)?(?:ROLE|search_path|TimeZone|TIME\s+ZONE|DateStyle)/i);
    expect(sql).not.toMatch(/\bset_config\s*\(/i);
  });

  it("never queries business rows, credentials or filesystem functions", () => {
    const sources = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map(match => match[1]);
    const allowed = new Set([
      "pg_class", "pg_namespace", "pg_database", "pg_attribute", "pg_attrdef", "pg_constraint",
      "pg_index", "pg_trigger", "pg_proc", "pg_roles", "tables", "items", "fingerprints", "baseline"
    ]);
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.filter(source => !allowed.has(source))).toEqual([]);
    expect(sql).not.toMatch(/\b(?:pg_authid|pg_user|pg_shadow|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_activity)\b/i);
    expect(sql).not.toMatch(/\b(?:inet_server_addr|inet_client_addr|session_user)\b/i);
    expect(sql).not.toMatch(/current_setting\('lc_(?:collate|ctype)'\)/);
    expect(sql).toContain("'database_collate', d.datcollate");
    expect(sql).toContain("'database_ctype', d.datctype");
    expect(sql).toContain("'timezone', current_setting('TimeZone')");
    expect(sql).toContain("'datestyle', current_setting('DateStyle')");
    expect(sql).toContain("AS greenpms_diagnostic");
    expect(sql).toContain("'matches_v1_10_0_fingerprint_only'");
    expect(sql).toContain("'definition_sha256', encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')");
    expect(sql).toContain("'sha256', encode(sha256(convert_to(value,'UTF8')),'hex')");
  });
});
