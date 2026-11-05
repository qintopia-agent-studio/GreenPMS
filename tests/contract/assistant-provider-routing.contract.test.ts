import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createDatabase, type Database } from "@qintopia/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { buildServer } from "../../apps/api/src/server.ts";
import { AssistantFailure } from "../../apps/api/src/assistant-lifetime.ts";
import type { ModelInput, ModelTransport } from "../../apps/api/src/assistant-model.ts";
import { demo } from "../../packages/db/src/seed.ts";
import { resetDatabase } from "../helpers/database.ts";
import { runtimeDatabaseUrlForTesting } from "../helpers/runtime-database.ts";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
const url = process.env.ASSISTANT_TEST_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_ai_contract";
let owner: Kysely<Database>, runtime: Kysely<Database>, app: FastifyInstance, admin: string, staff: string;
let mode = "healthy", sequence = 10, primarySignal: AbortSignal | undefined, releaseProbe: (() => void) | undefined, releaseAnswer: (() => void) | undefined;
const calls: ModelInput[] = [];
const fail = () => new AssistantFailure("AI_HTTP_503", "模型服务暂时不可用。");
const transport: ModelTransport = async input => {
  calls.push({ ...input, messages: structuredClone(input.messages) });
  if (input.toolChoice) {
    if (input.model === "primary" && mode === "probe-hold") await new Promise<void>(resolve => { releaseProbe = resolve; });
    if (input.model === "primary" && mode === "primary-fails") throw fail();
    return { content: null, finishReason: "tool_calls", tool_calls: [{ id: "check", type: "function", function: { name: "connection_check", arguments: '{"ok":true}' } }] };
  }
  if (input.model === "primary") {
    primarySignal = input.signal;
    if (mode === "primary-waits") return new Promise((_, reject) => { input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }); });
    if (mode === "primary-tool-hold" && input.messages.at(-1)?.role !== "tool") {
      await input.onDelta?.("primary正在查询");
      await new Promise<void>(resolve => { releaseAnswer = resolve; });
      await input.onProgress?.();
      return { content: null, tool_calls: [{ id: "find", type: "function", function: { name: "search_orders", arguments: '{"query":""}' } }] };
    }
    if (mode === "primary-fails") { await input.onProgress?.(); throw fail(); }
    if (mode === "primary-partial") { await input.onDelta?.("未完成的主回答"); throw fail(); }
    if (mode === "primary-after-tool") {
      if (input.messages.at(-1)?.role === "tool") throw fail();
      return { content: null, tool_calls: [{ id: "find", type: "function", function: { name: "search_orders", arguments: '{"query":""}' } }] };
    }
    if (mode === "application-error") throw new AssistantFailure("AI_PROGRESS_FAILED", "内部进度查询未完成。");
  }
  if (input.model === "backup" && mode === "both-fail") throw fail();
  if (input.model === "primary" && mode === "both-fail") throw fail();
  await input.onDelta?.(`${input.model}完整回答`);
  return { content: `${input.model}完整回答`, finishReason: "stop" };
};
const cookie = (value = admin) => ({ qintopia_session: value });
const peer = () => `127.0.0.${++sequence}`;
const get = (value = admin) => app.inject({ url: `/api/v1/assistant/settings?propertyId=${demo.propertyId}`, cookies: cookie(value), remoteAddress: peer() });
const draft = (role: "primary" | "backup", version: number, extra = {}) => ({ propertyId: demo.propertyId, expectedVersion: version, enabled: true, provider: role,
  name: role === "primary" ? "便宜主服务" : "稳定备用", providerEnabled: true, baseUrl: `https://${role}.example/v1`, model: role, apiKey: `synthetic-${role}-key`, ...extra });
const test = (payload: object, value = admin) => app.inject({ method: "POST", url: "/api/v1/assistant/test", cookies: cookie(value), remoteAddress: peer(), payload });
const save = (payload: object) => app.inject({ method: "PUT", url: "/api/v1/assistant/settings", cookies: cookie(), remoteAddress: peer(), payload });
const chat = (extra = {}, streaming = false) => app.inject({ method: "POST", url: "/api/v1/assistant/chat", cookies: cookie(staff), remoteAddress: peer(),
  headers: streaming ? { accept: "text/event-stream" } : {}, payload: { propertyId: demo.propertyId, message: "合成业务问题", page: "房态", ...extra } });
const action = async (name: string, extra = {}) => app.inject({ method: "POST", url: `/api/v1/assistant/${name}`, cookies: cookie(), remoteAddress: peer(),
  payload: { propertyId: demo.propertyId, expectedVersion: (await get()).json().version, ...extra } });
async function testedSave(role: "primary" | "backup", version: number) {
  const body = draft(role, version), result = await test(body); expect(result.statusCode, result.body).toBe(200);
  const saved = await save({ ...body, testToken: result.json().testToken }); expect(saved.statusCode, saved.body).toBe(200);
  return saved;
}
beforeAll(async () => {
  vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64")); vi.stubEnv("LOG_LEVEL", "silent"); vi.stubEnv("STAFF_PROFILE_MANIFEST_NAME", "demo");
  owner = await resetDatabase(url); runtime = createDatabase(runtimeDatabaseUrlForTesting(url));
  app = await buildServer(runtime, { assistantTransport: transport });
  for (const name of ["admin", "operator"]) {
    const result = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: name, password: "demo-pass-2026" } });
    expect(result.statusCode, result.body).toBe(200); const value = result.cookies.find(c => c.name === "qintopia_session")!.value;
    if (name === "admin") admin = value; else staff = value;
  }
}, 120_000);
beforeEach(async () => {
  await app.close(); await owner.deleteFrom("ai_model_settings").execute();
  runtime = createDatabase(runtimeDatabaseUrlForTesting(url));
  app = await buildServer(runtime, { assistantTransport: transport });
  mode = "healthy"; primarySignal = undefined; releaseProbe = undefined; releaseAnswer = undefined;
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  await testedSave("primary", 0); await testedSave("backup", 1); calls.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { releaseProbe?.(); releaseAnswer?.(); await app?.close(); await runtime?.destroy(); await owner?.destroy(); vi.unstubAllEnvs(); });

describe.sequential("assistant provider failover API", () => {
  it("exposes independent tested provider cards only to the managing administrator", async () => {
    const response = await get(); expect(response.json()).toMatchObject({ version: 2, backupAvailable: true, providers: {
      primary: { name: "便宜主服务", enabled: true, hasKey: true, model: "primary", testedAt: expect.any(String) },
      backup: { name: "稳定备用", enabled: true, hasKey: true, model: "backup", testedAt: expect.any(String) }
    }, routing: { state: "primary" } });
    expect(response.body).not.toContain("synthetic-primary-key"); expect(response.body).not.toContain("synthetic-backup-key");
    const employee = await get(staff); expect(employee.json()).toMatchObject({ canManage: false, baseUrl: "", model: "", backupAvailable: true });
    expect(employee.json()).not.toHaveProperty("providers"); expect(employee.json()).not.toHaveProperty("routing");
  });
  it("rejects invented/stale/wrong-connection test proofs and preserves keys on a failed save", async () => {
    const body = draft("backup", 2, { model: "changed" });
    expect((await save({ ...body, testToken: "invented" })).statusCode).toBe(400);
    const tested = await test(body); expect(tested.statusCode).toBe(200);
    expect((await save({ ...body, model: "different", testToken: tested.json().testToken })).statusCode).toBe(400);
    const saved = await save({ ...body, testToken: tested.json().testToken }); expect(saved.statusCode, saved.body).toBe(200);
    expect((await save({ ...body, expectedVersion: 3, testToken: tested.json().testToken })).statusCode).toBe(400);
    expect((await get()).json().providers.backup.model).toBe("changed");
  });
  it("automatically falls back once before visible output and aborts the failed attempt", async () => {
    mode = "primary-fails";
    const response = await chat({}, true); expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"phase":"fallback"'); expect(response.body).toContain("backup完整回答");
    expect(calls.map(c => c.model)).toEqual(["primary", "backup"]); expect(primarySignal?.aborted).toBe(true);
    expect((await get()).json().routing).toMatchObject({ state: "backup", lastFailure: "AI_HTTP_503" });
    calls.length = 0; const second = await chat(); expect(second.json().text).toBe("backup完整回答"); expect(calls.map(c => c.model)).toEqual(["backup"]);
  });
  it("does not automatically mix an already visible answer, and offers explicit backup regeneration", async () => {
    mode = "primary-partial"; const failed = await chat({}, true);
    expect(failed.body).toContain("未完成的主回答"); expect(failed.body).toContain('"backupRetryAvailable":true');
    expect(failed.body).not.toContain('"type":"done"'); expect(calls.map(c => c.model)).toEqual(["primary"]);
    calls.length = 0; const retried = await chat({ useBackup: true }); expect(retried.json().text).toBe("backup完整回答"); expect(calls.map(c => c.model)).toEqual(["backup"]);
    expect(calls[0]!.messages.filter(m => m.role === "assistant")).toEqual([]);
  });
  it("does not restart automatically after a completed tool even when no text was shown", async () => {
    mode = "primary-after-tool"; const response = await chat(); expect(response.statusCode, response.body).toBe(400);
    expect(response.json().details, response.body + " calls=" + calls.map(c => c.model).join(",")).toMatchObject({ backupRetryAvailable: true }); expect(calls.map(c => c.model)).toEqual(["primary", "primary"]);
    expect(calls[1]!.messages.some(m => m.role === "tool")).toBe(true);
  });
  it("does not loop back to primary when backup fails, or misclassify application failures", async () => {
    mode = "both-fail"; const failed = await chat(); expect(failed.statusCode).toBe(400); expect(calls.map(c => c.model)).toEqual(["primary", "backup"]);
    expect(failed.json().details?.backupRetryAvailable).not.toBe(true);
    mode = "healthy"; await action("recover-primary"); calls.length = 0;
    mode = "application-error"; expect((await chat()).statusCode).toBe(400); expect(calls.map(c => c.model)).toEqual(["primary"]);
    expect((await get()).json().routing.state).toBe("primary");
  });
  it("lets the user's question finish on backup while an independent bounded recovery check is pending", async () => {
    mode = "primary-fails"; await chat(); calls.length = 0;
    const now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now + 600_001);
    mode = "probe-hold"; const response = await chat(); expect(response.json().text).toBe("backup完整回答");
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
    const probes = calls.filter(c => c.toolChoice === "connection_check"); expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ model: "primary", maxTokens: 2048 });
    expect(JSON.stringify(probes[0]!.messages)).not.toContain("合成业务问题"); expect(probes[0]!.tools).toHaveLength(1);
    await chat(); expect(calls.filter(c => c.toolChoice)).toHaveLength(1);
    releaseProbe!(); await vi.waitFor(async () => expect((await get()).json().routing.state).toBe("primary"));
    calls.length = 0; mode = "healthy"; expect((await chat()).json().text).toBe("primary完整回答"); expect(calls.map(c => c.model)).toEqual(["primary"]);
  });
  it("requires admin authority for recovery and allows a successful check before ten minutes", async () => {
    mode = "primary-fails"; await chat(); mode = "healthy";
    const denied = await app.inject({ method: "POST", url: "/api/v1/assistant/recover-primary", cookies: cookie(staff), remoteAddress: peer(), payload: { propertyId: demo.propertyId, expectedVersion: 2 } });
    expect(denied.statusCode).toBe(403);
    const recovered = await action("recover-primary"); expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().settings.routing.state).toBe("primary");
    expect((await get()).json().version).toBe(2);
  });
  it("preserves the active streamed answer, later tool rounds, and conversation when priorities swap", async () => {
    const first = await chat({ message: "第一条上下文" }); expect(first.statusCode, first.body).toBe(200);
    const conversationId = first.json().conversationId;
    calls.length = 0; mode = "primary-tool-hold";
    const pending = chat({ conversationId, message: "第二条需要查询" }, true); await vi.waitFor(() => expect(releaseAnswer).toBeTypeOf("function"));
    const swapped = await action("promote-backup"); expect(swapped.statusCode, swapped.body).toBe(200);
    expect(swapped.json()).toMatchObject({ version: 3, providers: { primary: { model: "backup", name: "稳定备用", hasKey: true, enabled: true }, backup: { model: "primary", name: "便宜主服务", hasKey: true, enabled: true } } });
    expect(primarySignal?.aborted).toBe(false); releaseAnswer!();
    const completed = await pending; expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.body).toContain('"type":"done"'); expect(completed.body).toContain("primary完整回答"); expect(completed.body).not.toContain('"type":"error"');
    expect(calls.map(c => c.model)).toEqual(["primary", "primary"]);
    expect(calls.every(c => c.baseUrl === "https://primary.example/v1" && c.apiKey === "synthetic-primary-key")).toBe(true);
    expect(calls[1]!.messages.some(m => m.role === "tool")).toBe(true);
    mode = "healthy"; calls.length = 0;
    const next = await chat({ conversationId, message: "第三条继续上下文" }); expect(next.statusCode, next.body).toBe(200);
    expect(next.json()).toMatchObject({ conversationId, text: "backup完整回答" }); expect(calls[0]!.apiKey).toBe("synthetic-backup-key");
    expect(calls[0]!.messages.filter(m => m.role === "user").map(m => m.content)).toEqual(["第一条上下文", "第二条需要查询", "第三条继续上下文"]);
  });
  it("keeps enabled legacy providers usable through both swap directions without inventing test history", async () => {
    await owner.updateTable("ai_model_settings").set({ provider_tested_at: null }).execute();
    const original = await chat(); const conversationId = original.json().conversationId;
    const first = await action("promote-backup"); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().providers.backup).toMatchObject({ model: "primary", enabled: true, testedAt: null });
    expect(first.json().backupAvailable).toBe(true);
    expect((await chat({ conversationId, useBackup: true })).json().text).toBe("primary完整回答");
    const second = await action("promote-backup"); expect(second.statusCode, second.body).toBe(200);
    expect(second.json().providers.primary).toMatchObject({ model: "primary", enabled: true, testedAt: null });
    expect(second.json().providers.backup).toMatchObject({ model: "backup", enabled: true });
    expect((await chat({ conversationId })).json()).toMatchObject({ conversationId, text: "primary完整回答" });
  });
  it("still cancels active questions and expires conversations after a real configuration save", async () => {
    const first = await chat(); const conversationId = first.json().conversationId;
    primarySignal = undefined; mode = "primary-waits";
    const pending = chat({ conversationId }); await vi.waitFor(() => expect(primarySignal).toBeDefined());
    const signal = calls.at(-1)!.signal;
    const body = draft("primary", 2, { name: "更新配置" }); delete (body as { apiKey?: string }).apiKey;
    const saved = await save(body); expect(saved.statusCode, saved.body).toBe(200);
    expect(signal?.aborted).toBe(true); const interrupted = await pending;
    expect(interrupted.statusCode).toBe(400); expect(interrupted.body).toContain("配置已变化");
    mode = "healthy"; const stale = await chat({ conversationId }); expect(stale.statusCode).toBe(400); expect(stale.body).toContain("对话已过期");
    expect((await chat()).statusCode).toBe(200);
  });
  it("lets an active connection test finish after a swap but rejects its stale proof", async () => {
    mode = "probe-hold"; const pending = test(draft("primary", 2));
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
    const signal = calls.at(-1)!.signal;
    const swapped = await action("promote-backup"); expect(swapped.statusCode, swapped.body).toBe(200);
    expect(signal?.aborted).toBe(false); releaseProbe!();
    const stale = await pending; expect(stale.statusCode).toBe(400); expect(stale.body).toContain("配置已变化");
    expect(stale.json()).not.toHaveProperty("testToken");
  });
  it("cancels an obsolete background recovery probe when priorities swap", async () => {
    mode = "primary-fails"; await chat(); mode = "probe-hold";
    const pending = action("recover-primary"); await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
    const signal = calls.at(-1)!.signal;
    const swapped = await action("promote-backup"); expect(swapped.statusCode, swapped.body).toBe(200);
    expect(signal?.aborted).toBe(true); expect((await pending).statusCode).toBe(200);
    releaseProbe!(); expect((await get()).json().routing.state).toBe("primary");
    mode = "healthy"; expect((await chat()).json().text).toBe("backup完整回答");
  });
  it("can disable a provider without DNS or decryption, preserving the other provider", async () => {
    vi.mocked(lookup).mockRejectedValue(new Error("synthetic DNS outage"));
    const before = await owner.selectFrom("ai_model_settings").selectAll().executeTakeFirstOrThrow();
    const encryption = process.env.AI_SETTINGS_ENCRYPTION_KEY; vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", "");
    try {
      const body = draft("primary", 2, { providerEnabled: false }); delete (body as { apiKey?: string }).apiKey;
      const result = await save(body); expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ enabled: true, providers: { primary: { enabled: false }, backup: { enabled: true } } });
      const after = await owner.selectFrom("ai_model_settings").selectAll().executeTakeFirstOrThrow();
      expect(after.backup_encrypted_key).toBe(before.backup_encrypted_key); expect(after.encrypted_key).toBe(before.encrypted_key);
    } finally { vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", encryption); }
  });
});
