import { describe, expect, it } from "vitest";
import { currentMigrationNames } from "../packages/db/src/database.ts";
import {
  QINTOPIA_LOCAL_DATABASE,
  acceptanceBusinessTables,
  assertPurgeExecutionAuthorized,
  assertQintopiaLocalTarget,
  parsePurgeArguments,
  preservedBaseTables
} from "./purge-local-acceptance-business-data.ts";

describe("local acceptance business-data purge guard", () => {
  it("accepts only the exact local qintopia endpoint", () => {
    expect(assertQintopiaLocalTarget("postgres://qintopia:qintopia@127.0.0.1:55432/qintopia").pathname).toBe("/qintopia");
    for (const databaseUrl of [
      "postgres://qintopia:qintopia@localhost:55432/qintopia",
      "postgres://qintopia:qintopia@127.0.0.1:5432/qintopia",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia?host=evil.example&port=5432",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia?sslmode=require",
      "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia#host=evil.example",
      "https://127.0.0.1:55432/qintopia"
    ]) {
      expect(() => assertQintopiaLocalTarget(databaseUrl)).toThrow("Refusing purge");
    }
  });

  it("requires two explicit execution confirmations while keeping dry-run as the default", () => {
    expect(parsePurgeArguments([])).toEqual({ execute: false, confirmedDatabase: null, writersStopped: false });
    expect(parsePurgeArguments([
      "--execute",
      "--confirm-database=qintopia",
      "--confirm-writers-stopped"
    ])).toEqual({ execute: true, confirmedDatabase: "qintopia", writersStopped: true });
    expect(() => assertPurgeExecutionAuthorized({
      execute: true,
      confirmedDatabase: null,
      writersStopped: true
    })).toThrow("requires --execute");
    expect(() => assertPurgeExecutionAuthorized({
      execute: true,
      confirmedDatabase: "qintopia_e2e",
      writersStopped: true
    })).toThrow("requires --execute");
    expect(() => assertPurgeExecutionAuthorized({
      execute: true,
      confirmedDatabase: "qintopia",
      writersStopped: false
    })).toThrow("confirm-writers-stopped");
    expect(() => assertPurgeExecutionAuthorized({
      execute: true,
      confirmedDatabase: "qintopia",
      writersStopped: true
    })).not.toThrow();
  });

  it("keeps base and session tables outside the explicit no-CASCADE business list", () => {
    expect(preservedBaseTables).toContain("web_sessions");
    expect(preservedBaseTables).toContain("inventory_units");
    expect(preservedBaseTables).toContain("pricing_policy_versions");
    expect(acceptanceBusinessTables).toContain("orders");
    expect(acceptanceBusinessTables).toContain("members");
    expect(acceptanceBusinessTables).not.toContain("web_sessions");
    expect(acceptanceBusinessTables).not.toContain("inventory_units");
    expect(new Set([...preservedBaseTables, ...acceptanceBusinessTables]).size)
      .toBe(preservedBaseTables.length + acceptanceBusinessTables.length);
  });

  it("derives the expected migration count and tip from the authoritative identity list", () => {
    expect(QINTOPIA_LOCAL_DATABASE.migrationCount).toBe(currentMigrationNames.length);
    expect(QINTOPIA_LOCAL_DATABASE.latestMigration).toBe(currentMigrationNames.at(-1));
  });
});
