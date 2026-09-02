import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@qintopia/db";
import { createRuntimeApi, RuntimeDatabaseNotReadyError } from "../../apps/api/src/runtime-startup.ts";
import { seedDemo } from "../../packages/db/src/seed.ts";
import { runtimeDatabaseTestPassword } from "../helpers/runtime-database.ts";
import type { Kysely } from "kysely";

const execFileAsync = promisify(execFile);
const adminUrl = process.env.API_RUNTIME_STARTUP_ADMIN_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";
const databaseName = `qintopia_api_runtime_startup_${process.pid}`;
const runtimePassword = runtimeDatabaseTestPassword;
const ownerUrl = new URL(adminUrl);
ownerUrl.pathname = `/${databaseName}`;
const runtimeUrl = new URL(ownerUrl);
runtimeUrl.username = "qintopia_runtime";
runtimeUrl.password = runtimePassword;
const previousStaffProfileManifestName = process.env.STAFF_PROFILE_MANIFEST_NAME;

type MainOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { kind: "published"; status: number; stderr: string };

let ownerDb: Kysely<Database> | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withClient<T>(connectionString: string, callback: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName.replaceAll('"', '""')}"`);
  });
}

async function recreateDatabase(): Promise<void> {
  await dropDatabase();
  await withClient(adminUrl, async (admin) => {
    await admin.query(`CREATE DATABASE "${databaseName.replaceAll('"', '""')}"`);
  });
}

async function runMigrations(): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/migrate.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: runtimeUrl.toString(),
        MIGRATION_DATABASE_URL: ownerUrl.toString(),
        RUNTIME_DATABASE_PASSWORD: runtimePassword,
        STAFF_PROFILE_MANIFEST_NAME: "unconfigured"
      }
    }
  );
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (address && typeof address === "object") return address.port;
  throw new Error("Could not allocate an API startup test port");
}

async function expectPortAvailable(port: number): Promise<void> {
  const server = createServer();
  const error = new Promise<never>((_resolve, reject) => {
    server.once("error", reject);
  });
  server.listen(port, "127.0.0.1");
  await Promise.race([once(server, "listening"), error]);
  server.close();
  await once(server, "close");
}

function withApplicationName(connectionString: string, applicationName: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function applicationSessionCount(applicationName: string): Promise<number> {
  return withClient(adminUrl, async (admin) => {
    const result = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND application_name = $2",
      [databaseName, applicationName]
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

async function waitForMainOutcome(child: ChildProcess, port: number): Promise<MainOutcome> {
  let stderr = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (exit) return { kind: "exit", ...exit, stderr };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(200)
      });
      return { kind: "published", status: response.status, stderr };
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for API main startup outcome. stderr:\n${stderr}`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(2_000).then(() => {
      child.kill("SIGKILL");
      return once(child, "exit");
    })
  ]);
}

beforeAll(async () => {
  await recreateDatabase();
  await runMigrations();
  ownerDb = createDatabase(ownerUrl.toString());
  try {
    await seedDemo(ownerDb, { includeProtocolFixturePolicy: true });
  } finally {
    await ownerDb.destroy();
    ownerDb = undefined;
  }
  process.env.STAFF_PROFILE_MANIFEST_NAME = "demo";
});

afterAll(async () => {
  if (ownerDb) await ownerDb.destroy();
  if (previousStaffProfileManifestName === undefined) delete process.env.STAFF_PROFILE_MANIFEST_NAME;
  else process.env.STAFF_PROFILE_MANIFEST_NAME = previousStaffProfileManifestName;
  await dropDatabase();
});

describe.sequential("API runtime startup gate", () => {
  it("does not listen when the production main module is imported", async () => {
    const port = await allocatePort();
    const previousPort = process.env.PORT;
    process.env.PORT = String(port);
    try {
      const imported = await import("../../apps/api/src/main.ts");
      expect(typeof imported.main).toBe("function");
      await expectPortAvailable(port);
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });

  it("refuses to publish the production API port when DATABASE_URL uses the migration owner identity", async () => {
    const port = await allocatePort();
    const applicationName = `api-runtime-startup-owner-${process.pid}`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: withApplicationName(ownerUrl.toString(), applicationName),
          PORT: String(port)
        },
        stdio: ["ignore", "ignore", "pipe"]
      }
    );

    const outcome = await waitForMainOutcome(child, port);
    await terminate(child);

    expect(outcome, `stderr:\n${outcome.stderr}`).toMatchObject({ kind: "exit", code: 1 });
    expect(await applicationSessionCount(applicationName)).toBe(0);
  });

  it("rejects a migration-owner startup URL and destroys the failed startup pool", async () => {
    const applicationName = `api-runtime-startup-owner-function-${process.pid}`;

    await expect(createRuntimeApi({
      databaseUrl: withApplicationName(ownerUrl.toString(), applicationName)
    })).rejects.toThrow(RuntimeDatabaseNotReadyError);

    expect(await applicationSessionCount(applicationName)).toBe(0);
  });

  it("rejects a runtime startup URL when readiness detects privilege drift and destroys the failed startup pool", async () => {
    const applicationName = `api-runtime-startup-drift-${process.pid}`;
    await withClient(ownerUrl.toString(), async (owner) => {
      await owner.query("GRANT UPDATE (secret_hash) ON api_tokens TO qintopia_runtime");
    });

    try {
      await expect(createRuntimeApi({
        databaseUrl: withApplicationName(runtimeUrl.toString(), applicationName)
      })).rejects.toThrow(RuntimeDatabaseNotReadyError);
    } finally {
      await withClient(ownerUrl.toString(), async (owner) => {
        await owner.query("REVOKE UPDATE (secret_hash) ON api_tokens FROM qintopia_runtime");
      });
    }

    expect(await applicationSessionCount(applicationName)).toBe(0);
  });

  it("builds a Fastify app with the runtime database identity and keeps /health/ready active", async () => {
    const applicationName = `api-runtime-startup-runtime-${process.pid}`;
    const runtime = await createRuntimeApi({
      databaseUrl: withApplicationName(runtimeUrl.toString(), applicationName)
    });

    try {
      await runtime.app.ready();
      const response = await runtime.app.inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
    } finally {
      await runtime.app.close();
    }

    expect(await applicationSessionCount(applicationName)).toBe(0);
  });
});
