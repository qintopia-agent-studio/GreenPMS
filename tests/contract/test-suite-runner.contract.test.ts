import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseTestRunnerPlatform,
  assertLockDatabaseIsNotResetTarget,
  resolveLockDatabaseUrl
} from "../helpers/database-test-lock-config.ts";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const runnerPath = fileURLToPath(new URL("../helpers/run-database-test-suite.ts", import.meta.url));

describe("database-backed test suite script contract", () => {
  it("keeps reset-capable suites locked and runs the lock runner's signal self-tests outside its own process tree", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["test:integration"])
      .toBe("npm run test:integration:lock-runner && node --import tsx tests/helpers/run-database-test-suite.ts -- npm run test:integration:run --");
    expect(packageJson.scripts["test:integration:lock-runner"])
      .toBe("vitest run tests/integration/test-suite-runner.integration.test.ts");
    expect(packageJson.scripts["test:integration:run"])
      .toBe("node --import tsx tests/helpers/assert-database-test-lock.ts && vitest run tests/integration --exclude tests/integration/test-suite-runner.integration.test.ts");
    expect(packageJson.scripts["test:contract"])
      .toBe("node --import tsx tests/helpers/run-database-test-suite.ts -- npm run test:contract:run --");
    expect(packageJson.scripts["test:contract:run"])
      .toBe("node --import tsx tests/helpers/assert-database-test-lock.ts && npm run build && vitest run tests/contract");
    expect(packageJson.scripts["test:e2e"])
      .toBe("node --import tsx tests/helpers/run-database-test-suite.ts -- npm run test:e2e:run --");
    expect(packageJson.scripts["test:e2e:run"])
      .toBe("node --import tsx tests/helpers/assert-database-test-lock.ts && VITE_DEMO_LOGIN=true WEB_BUILD_OUT_DIR=dist-e2e npm run build && node --import tsx tests/e2e/setup-database.ts && playwright test");

    const runner = await readFile(runnerPath, "utf8");
    expect(runner).toContain("pg_try_advisory_lock");
    expect(runner).toContain("execFile(");
    expect(runner).toContain('["-axo", "pid=,ppid=,pgid="]');
    expect(runner).toContain('["-o", "pid=,ppid=,pgid="]');
    expect(runner).not.toMatch(/\b(?:create|drop)\s+database\b/i);
    expect(runner).not.toContain("pg_terminate_backend");
  });

  it("preserves connection query parameters while deriving a stable coordinator and rejects reset targets", () => {
    const environment = {
      TEST_DATABASE_URL: "postgres://test:test@db.example:5433/qintopia_test?sslmode=require&connect_timeout=4#ignored"
    } as NodeJS.ProcessEnv;
    const derived = new URL(resolveLockDatabaseUrl(environment));
    expect(derived.pathname).toBe("/postgres");
    expect(derived.searchParams.get("sslmode")).toBe("require");
    expect(derived.searchParams.get("connect_timeout")).toBe("4");
    expect(derived.hash).toBe("");
    expect(() => assertLockDatabaseIsNotResetTarget(derived.toString(), environment)).not.toThrow();

    expect(() => assertLockDatabaseIsNotResetTarget(environment.TEST_DATABASE_URL!, environment))
      .toThrow(/is also a database reset target \(TEST_DATABASE_URL\)/);

    expect(() => assertLockDatabaseIsNotResetTarget(
      "postgres://lock:lock@localhost:55432/qintopia_test",
      { TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55432/qintopia_test" }
    )).toThrow(/database qintopia_test is also a database reset target/);

    expect(() => assertLockDatabaseIsNotResetTarget(
      "postgres://lock:lock@127.0.0.1:55432/qintopia_test",
      { TEST_DATABASE_URL: "postgres://test:test@not-the-server.invalid/qintopia_test?host=127.0.0.1&port=55432" }
    )).toThrow(/database qintopia_test is also a database reset target/);

    expect(() => assertLockDatabaseIsNotResetTarget(
      "postgres://lock:lock@127.0.0.1:55432/qintopia_reference_catalog",
      { REFERENCE_CATALOG_INTEGRATION_DATABASE_URL: "postgres://test:test@127.0.0.1:55432/qintopia_reference_catalog" }
    )).toThrow(/REFERENCE_CATALOG_INTEGRATION_DATABASE_URL/);

    for (const [name, database] of [
      ["OPERATIONAL_REFERENCES_INTEGRATION_DATABASE_URL", "qintopia_operational_references"],
      ["OPERATIONAL_REFERENCES_HISTORY_DATABASE_URL", "qintopia_operational_references_history"]
    ] as const) {
      expect(() => assertLockDatabaseIsNotResetTarget(
        `postgres://lock:lock@127.0.0.1:55432/${database}`,
        { [name]: `postgres://test:test@127.0.0.1:55432/${database}` }
      )).toThrow(new RegExp(name));
    }
  });

  it("fails closed on Windows before attempting database coordination", () => {
    expect(() => assertDatabaseTestRunnerPlatform("win32"))
      .toThrow(/requires a POSIX platform/);
    expect(() => assertDatabaseTestRunnerPlatform("darwin")).not.toThrow();
    expect(() => assertDatabaseTestRunnerPlatform("linux")).not.toThrow();
  });

  it("refuses direct invocation of private suite commands before the test runner starts", () => {
    const environment = { ...process.env };
    delete environment.QINTOPIA_DATABASE_TEST_LOCK_HELD;
    const result = spawnSync("npm", ["run", "test:integration:run", "--", "--help"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8"
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(78);
    expect(result.stderr).toContain("private *:run script refused");
    expect(result.stdout).not.toMatch(/RUN\s+v\d/);
  });
});
