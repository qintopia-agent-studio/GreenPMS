import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { createDatabase, databaseReady, type Database } from "@qintopia/db";
import { sql } from "kysely";
import { randomBytes } from "node:crypto";
import { buildServer } from "../../apps/api/src/server.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
import type { ModelInput, ModelTransport } from "../../apps/api/src/assistant-model.ts";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
const url = process.env.ASSISTANT_TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_ai_contract";
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance, admin: string, staff: string;
const calls: ModelInput[] = [];
let mode = "guide";
let duringModel: (() => Promise<void>) | undefined;
const transport: ModelTransport = async input => {
  calls.push(input);
  if (duringModel) { const action = duringModel; duringModel = undefined; await action(); }
  if (mode === "fail") throw new Error("DO-NOT-LEAK synthetic-provider-key");
  if (input.toolChoice) return { content: null, tool_calls: [{ id: "ping", type: "function", function: { name: "connection_check", arguments: '{"ok":true}' } }] };
  if (mode === "unknown") return { content: null, tool_calls: [{ id: "evil", type: "function", function: { name: "execute_sql", arguments: '{"sql":"DELETE FROM orders"}' } }] };
  const last = input.messages.at(-1);
  if (last?.role === "tool") return { content: "已找到操作入口，请在正式页面核对并操作。" };
  const name = mode === "members" ? "search_members" : mode === "cross" ? "order_details" : "open_entry";
  const args = mode === "members" ? { query: "Demo" } : mode === "cross" ? { orderId: "foreign-order-id" } : { page: "members" };
  return { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] };
};
const cookies = (value: string) => ({ qintopia_session: value });
const settingsBody = (extra: object = {}) => ({ propertyId: demo.propertyId, expectedVersion: 0, enabled: true, baseUrl: "https://model.example.com/v1", model: "synthetic-model", apiKey: "synthetic-provider-key", ...extra });
const chat = (value = staff, extra: object = {}) => app.inject({ method: "POST", url: "/api/v1/assistant/chat", cookies: cookies(value), payload: { propertyId: demo.propertyId, message: "请打开会员入口", page: "房态", ...extra } });
beforeAll(async () => {
  vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64")); vi.stubEnv("LOG_LEVEL", "silent"); vi.stubEnv("STAFF_PROFILE_MANIFEST_NAME", "demo");
  owner = await resetDatabase(url); runtime = createDatabase(runtimeDatabaseUrlForTesting(url));
  app = await buildServer(runtime, { assistantTransport: transport });
  for (const name of ["admin", "operator"]) {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: "demo-pass-2026" } }); expect(login.statusCode, login.body).toBe(200);
    const value = login.cookies.find(c => c.name === "qintopia_session")!.value; if (name === "admin") admin = value; else staff = value;
  }
}, 120_000);
afterAll(async () => { await app?.close(); await runtime?.destroy(); await owner?.destroy(); vi.unstubAllEnvs(); });
describe.sequential("AI assistant authenticated contract", () => {
  it("keeps database readiness valid after additive migration", async () => expect(await databaseReady(runtime)).toBe(true));
  it("rejects unauthenticated and staff configuration writes", async () => {
    const anonymous = await app.inject({ url: `/api/v1/assistant/settings?propertyId=${demo.propertyId}` }); expect(anonymous.statusCode).toBe(401);
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(staff), payload: settingsBody() }); expect(response.statusCode).toBe(403);
  });
  it("tests tool compatibility without persisting anything", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/assistant/test", cookies: cookies(admin), payload: settingsBody() }); expect(response.statusCode, response.body).toBe(200);
    expect(await owner.selectFrom("ai_model_settings").selectAll().execute()).toEqual([]);
  });
  it("encrypts secrets, masks responses and denies direct runtime writes", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: settingsBody() }); expect(response.statusCode, response.body).toBe(200); expect(response.body).not.toContain("synthetic-provider-key"); expect(response.json().version).toBe(1);
    const row = await owner.selectFrom("ai_model_settings").selectAll().executeTakeFirstOrThrow(); expect(row.encrypted_key).not.toContain("synthetic-provider-key");
    const audit = await sql`SELECT * FROM ai_settings_audit`.execute(owner); expect(JSON.stringify(audit.rows)).not.toContain("synthetic-provider-key");
    await expect(sql`UPDATE ai_model_settings SET model='bypass'`.execute(runtime)).rejects.toThrow("permission denied");
    const staffSettings = await app.inject({ url: `/api/v1/assistant/settings?propertyId=${demo.propertyId}`, cookies: cookies(staff) }); expect(staffSettings.json()).toMatchObject({ canManage: false, baseUrl: "", model: "", hasKey: false });
  });
  it("rejects stale saves, cross-origin requests and Key reuse at a changed host", async () => {
    const stale = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: settingsBody() }); expect(stale.statusCode).toBe(409);
    const cross = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), headers: { origin: "https://evil.example" }, payload: settingsBody({ expectedVersion: 1 }) }); expect(cross.statusCode).toBe(403);
    const changed = settingsBody({ expectedVersion: 1, baseUrl: "https://another.example/v1" }); delete (changed as { apiKey?: string }).apiKey;
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: changed }); expect(response.statusCode).toBe(400);
  });
  it("opens a whitelisted entry through a real tool loop without writing business commands", async () => {
    mode = "guide"; calls.length = 0;
    const before = await owner.selectFrom("command_executions").selectAll().execute();
    const response = await chat(); expect(response.statusCode, response.body).toBe(200); expect(response.json().entries[0].page).toBe("members"); expect(calls).toHaveLength(2); expect(calls[1]!.messages.some(m => m.role === "tool")).toBe(true);
    expect(await owner.selectFrom("command_executions").selectAll().execute()).toHaveLength(before.length);
    const foreignConversation = await chat(admin, { conversationId: response.json().conversationId }); expect(foreignConversation.statusCode).toBe(400);
  });
  it("rejects other properties, unknown write tools and unavailable orders", async () => {
    const other = await chat(staff, { propertyId: "other-property" }); expect(other.statusCode).toBe(403);
    mode = "unknown"; const unknown = await chat(); expect(unknown.statusCode).toBe(400);
    mode = "cross"; const cross = await chat(); expect(cross.statusCode).toBe(404);
  });
  it("never relays provider errors containing secrets", async () => {
    mode = "fail"; const response = await chat(); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("DO-NOT-LEAK"); expect(response.body).not.toContain("synthetic-provider-key");
  });
  it("projects members without full phone or identity documents", async () => {
    mode = "members"; calls.length = 0;
    const response = await chat(); expect(response.statusCode, response.body).toBe(200);
    const toolMessage = calls[1]!.messages.find(m => m.role === "tool")!.content!;
    expect(toolMessage).toContain(demo.memberId); expect(toolMessage).not.toContain("13800000000"); expect(toolMessage).not.toContain("DEMO-ID");
  });
  it("does not accept bearer tokens for chat or settings", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/assistant/chat", headers: { authorization: `Bearer ${demo.administratorWriteToken}` }, payload: { propertyId: demo.propertyId, message: "查房态", page: "房态" } });
    expect(response.statusCode).toBe(403);
  });
  it("rechecks a revoked session after model returns, before returning any result", async () => {
    mode = "guide";
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "operator", password: "demo-pass-2026" } });
    const temporaryCookie = login.cookies.find(c => c.name === "qintopia_session")!.value;
    duringModel = async () => { const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: cookies(temporaryCookie) }); expect(logout.statusCode).toBe(204); };
    const response = await chat(temporaryCookie); expect(response.statusCode).toBe(401); expect(response.json()).not.toHaveProperty("entries");
  });
  it("blocks concurrent work for the same user even across new conversations", async () => {
    mode = "guide";
    duringModel = async () => { const concurrent = await chat(); expect(concurrent.statusCode).toBe(429); };
    const response = await chat(); expect(response.statusCode, response.body).toBe(200);
  });
  it("retains Key on same host, records versions and disables chat", async () => {
    mode = "guide";
    const body = settingsBody({ expectedVersion: 1, enabled: false }); delete (body as { apiKey?: string }).apiKey;
    const response = await app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookies(admin), payload: body }); expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ version: 2, enabled: false, hasKey: true });
    const disabled = await chat(); expect(disabled.statusCode).toBe(400); expect(disabled.body).toContain("尚未启用");
  });
});
