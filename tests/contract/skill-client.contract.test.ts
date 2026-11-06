import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, propertyLocalToday, withPropertyClockForTesting, type Database } from "@qintopia/db";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetTestDatabase, testDatabaseUrl } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";

const executeFile = promisify(execFile);
const script = resolve("skills/greenpms-api/scripts/greenpms.py");
// Apple Python/LibreSSL can ignore SSL_CERT_FILE when loading its default CA
// store. Select the test CA explicitly while retaining certificate and hostname
// verification, then execute the unchanged CLI in this child process.
const pythonEntry = "import functools, os, runpy, ssl, sys; "
  + "ssl._create_default_https_context = functools.partial(ssl.create_default_context, cafile=os.environ['SSL_CERT_FILE']); "
  + "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')";
let db: Kysely<Database>;
let app: FastifyInstance;
let bridge: Server;
let directory: string;
let environment: NodeJS.ProcessEnv;
let businessDate: string;
let apiClock: Date;
let loseNextConfirmationResponse = false;
const requests: { method: string; path: string; query: string; key: string | undefined }[] = [];
const bridgeErrors: Error[] = [];

function shiftDate(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
const stateFile = (name: string) => join(directory, `${name}.json`);
const posts = () => requests.filter(request => request.method === "POST").length;

async function cli(args: string[], expectedExit = 0) {
  let output: { stdout: string; stderr: string; code: number | string };
  try {
    const result = await executeFile("python3", ["-B", "-c", pythonEntry, script, ...args], {
      env: environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 45_000
    });
    output = { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    if (result.stdout === undefined || result.code === undefined) throw error;
    output = { stdout: result.stdout, stderr: result.stderr ?? "", code: result.code };
  }
  expect(output.stdout).not.toContain(demo.writeToken);
  expect(output.stderr).not.toContain(demo.writeToken);
  expect(bridgeErrors).toEqual([]);
  expect(output.code, output.stdout).toBe(expectedExit);
  return JSON.parse(output.stdout);
}
const prepare = (command: string, input: Record<string, unknown>, name: string) =>
  cli(["prepare", command, "--input", JSON.stringify(input), "--state", stateFile(name)]);
const confirmArgs = (name: string, code: string, note = "Synthetic staff authorized this business operation") =>
  ["commit", "--state", stateFile(name), "--reason", JSON.stringify({ code, note }), "--confirmed",
    "--readback", "/api/v1/orders/{result.orderId}"];
const readOrder = async (orderId: string) => (await cli(["get", `/api/v1/orders/${orderId}`])).data;

beforeAll(async () => {
  db = await resetTestDatabase();
  businessDate = await propertyLocalToday(db, demo.propertyId);
  apiClock = new Date(`${shiftDate(businessDate, -1)}T04:00:00Z`);
  app = await buildServer(createDatabase(runtimeDatabaseUrlForTesting(testDatabaseUrl)));
  await app.ready();
  directory = await mkdtemp(join(tmpdir(), "greenpms-skill-contract-"));
  const key = join(directory, "localhost.key"), cert = join(directory, "localhost.crt");
  const config = join(directory, "openssl.cnf");
  await writeFile(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  await executeFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-config", config]);
  // The client keeps real TLS verification. Only this test process trusts the
  // ephemeral localhost certificate; no production HTTPS or API guards change.
  bridge = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    void (async () => {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const url = new URL(request.url!, "https://localhost");
      requests.push({ method: request.method!, path: url.pathname, query: url.search,
        key: request.headers["idempotency-key"] as string | undefined });
      // app.inject returns a lazy thenable: await it inside the clock scope so
      // Fastify starts request handling with the intended business date.
      const result = await withPropertyClockForTesting(apiClock, async () => await app.inject({
        method: request.method as "GET" | "POST", url: request.url!, headers: request.headers,
        ...(buffers.length ? { payload: Buffer.concat(buffers).toString("utf8") } : {})
      }));
      if (loseNextConfirmationResponse && request.method === "POST" && url.pathname.endsWith("/confirm")) {
        loseNextConfirmationResponse = false;
        expect(result.statusCode, result.body).toBe(200);
        response.destroy(); // API committed; the CLI has not received a result.
        return;
      }
      response.writeHead(result.statusCode, { "content-type": "application/json" });
      response.end(result.body);
    })().catch(error => {
      bridgeErrors.push(error as Error);
      response.destroy(error as Error);
    });
  });
  bridge.on("tlsClientError", error => bridgeErrors.push(error));
  await new Promise<void>((resolveListen, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", () => resolveListen());
  });
  environment = { ...process.env, GREENPMS_BASE_URL: `https://localhost:${(bridge.address() as AddressInfo).port}`,
    GREENPMS_API_TOKEN: demo.writeToken, GREENPMS_PROPERTY_ID: demo.propertyId, SSL_CERT_FILE: cert,
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
});
afterAll(async () => {
  if (bridge?.listening) {
    bridge.closeAllConnections();
    await new Promise<void>((done, reject) => bridge.close(error => error ? reject(error) : done()));
  }
  await app?.close();
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("installed Skill client against the public HTTPS API", () => {
  it("quotes, books, checks in and recovers a lost checkout response without duplicating the business action", async () => {
    const quote = await cli(["quote", "--input", JSON.stringify({ inventoryUnitId: demo.roomId, stayType: "FREE",
      arrivalDate: shiftDate(businessDate, -1), departureDate: businessDate, pricingPolicyVersionId: demo.freePolicyId }),
    "--state", stateFile("quote")]);
    expect(quote).toMatchObject({ phase: "COMMITTED", commandType: "CREATE_QUOTE", businessVerified: false,
      receipt: { commandType: "CREATE_QUOTE", executionStatus: "EXECUTED", businessCommitted: true } });
    expect(quote.quote.quoteId).toEqual(expect.any(String));
    expect(await db.selectFrom("orders").select("id").execute()).toEqual([]);

    const booking = await prepare("CREATE_ORDER", { quoteId: quote.quote.quoteId,
      primaryGuest: { fullName: "Synthetic Skill Guest", nickname: "skill-contract" },
      freeStayReason: "Synthetic Skill API verification", freeStayCategoryCode: "VOLUNTEER" }, "booking");
    expect(booking).toMatchObject({ phase: "PREPARED", businessVerified: false,
      previewReceipt: { commandType: "PREVIEW:CREATE_ORDER" } });
    expect(await db.selectFrom("orders").select("id").execute()).toEqual([]);
    const booked = await cli(confirmArgs("booking", "CREATE_STANDARD_ORDER", ""));
    const orderId = booked.receipt.result.orderId as string;
    expect(booked).toMatchObject({ phase: "COMMITTED", receipt: { commandType: "CREATE_ORDER" },
      readback: { ok: true, data: { order: { id: orderId, status: "RESERVED" }, stay: { status: "PLANNED" } } } });

    await prepare("CHECK_IN", { orderId }, "checkin");
    expect((await readOrder(orderId)).order.status).toBe("RESERVED");
    const checkedIn = await cli(confirmArgs("checkin", "CHECK_IN"));
    expect(checkedIn).toMatchObject({ phase: "COMMITTED", businessVerified: false,
      readback: { data: { order: { id: orderId, status: "CHECKED_IN" }, stay: { status: "IN_HOUSE" } } } });
    const postCount = posts();
    expect((await cli(confirmArgs("checkin", "CHECK_IN"))).receipt).toEqual(checkedIn.receipt);
    expect(posts()).toBe(postCount);

    apiClock = new Date(`${businessDate}T04:00:00Z`);
    const beforeCheckout = await readOrder(orderId);
    const prepared = await prepare("CHECK_OUT", { orderId }, "checkout");
    expect(prepared).toMatchObject({ phase: "PREPARED", previewReceipt: { commandType: "PREVIEW:CHECK_OUT" } });
    const afterPreview = await readOrder(orderId);
    expect(afterPreview.order).toEqual(beforeCheckout.order);
    expect(afterPreview.amendments).toEqual(beforeCheckout.amendments);
    expect(afterPreview.fulfillment.checkOut).toBeNull();

    loseNextConfirmationResponse = true;
    const uncertain = await cli(confirmArgs("checkout", "CHECK_OUT"), 2);
    expect(uncertain).toMatchObject({ phase: "UNKNOWN", businessVerified: false });
    const durable = JSON.parse(await readFile(stateFile("checkout"), "utf8"));
    expect(durable.phase).toBe("UNKNOWN");
    const checkoutPosts = posts();
    expect((await cli(confirmArgs("checkout", "CHECK_OUT"), 2)).phase).toBe("UNKNOWN");
    expect(posts()).toBe(checkoutPosts);

    const recovered = await cli(["recover", "--state", stateFile("checkout")]);
    expect(recovered).toMatchObject({ phase: "COMMITTED", businessVerified: false,
      receipt: { commandType: "CHECK_OUT", executionStatus: "EXECUTED", businessCommitted: true,
        result: { orderId, status: "CHECKED_OUT" } },
      readback: { ok: true, data: { order: { id: orderId, status: "CHECKED_OUT" }, stay: { status: "COMPLETED" } } } });
    const recoveryRequest = requests.find(request => request.path === "/api/v1/command-results");
    expect(new URLSearchParams(recoveryRequest!.query).get("idempotencyKey")).toBe(durable.confirmKey);
    expect(new URLSearchParams(recoveryRequest!.query).get("commandType")).toBe("CHECK_OUT");
    expect(posts()).toBe(checkoutPosts);
    expect(recovered.readback.data.fulfillment.checkOut).not.toBeNull();
    expect(recovered.readback.data.amendments.filter((item: { amendment_type: string }) => item.amendment_type === "CHECK_OUT")).toHaveLength(1);
    const segmentIds = recovered.readback.data.segments.map((segment: { id: string }) => segment.id) as string[];
    expect(await db.selectFrom("inventory_claims").select("id").where("active", "=", true)
      .where("source_type", "=", "ORDER_SEGMENT").where("source_id", "in", segmentIds).execute()).toEqual([]);
    expect((await cli(confirmArgs("checkout", "CHECK_OUT"))).receipt).toEqual(recovered.receipt);
    expect(posts()).toBe(checkoutPosts);
  }, 120_000);
});
