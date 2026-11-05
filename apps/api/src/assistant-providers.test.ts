import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@qintopia/contracts";
import { abortable, AssistantFailure } from "./assistant-lifetime.ts";
import { upstreamModelFailure } from "./assistant-model-diagnostics.ts";
import { AssistantProviderRouter, assertConnectionTest, connectionTestInput, createProviderTestReceipts, providerFault, providerRetryable, selectProviderSnapshot, type ProviderSettingsRow } from "./assistant-providers.ts";
const row = (extra = {}): ProviderSettingsRow => ({ scope_id: "installation", management_property_id: "p", version: 1, conversation_version: 1, enabled: true,
  base_url: "https://primary.example/v1", model: "primary", encrypted_key: "opaque", updated_by: "a", updated_at: new Date(),
  provider_name: "Primary", provider_enabled: true, provider_tested_at: null,
  backup_name: "Backup", backup_enabled: true, backup_base_url: "https://backup.example/v1", backup_model: "backup", backup_encrypted_key: "opaque-backup", backup_tested_at: new Date(), ...extra });
const failed = () => new AssistantFailure("AI_HTTP_503", "provider unavailable");
afterEach(() => vi.useRealTimers());
describe("assistant primary/backup recovery", () => {
  it("uses private upstream classification without retrying explicit request errors or PMS denials", () => {
    const quota = upstreamModelFailure({ error: { code: "insufficient_quota" } }, undefined, 429);
    expect(providerFault(quota)).toBe(true); expect(providerRetryable(quota)).toBe(false);
    const invalid = upstreamModelFailure({ error: { type: "invalid_request_error", code: "unsupported_parameter", message: "The parameter rate_limit is not supported." } }, undefined, 503);
    expect(providerFault(invalid)).toBe(false); expect(providerRetryable(invalid)).toBe(false);
    const denied = upstreamModelFailure({ error: { code: "permission_denied" } }, undefined, 403);
    expect(providerFault(denied)).toBe(true); expect(providerRetryable(denied)).toBe(false);
    const filtered = upstreamModelFailure({ error: { code: "content_policy_violation" } }, undefined, 403);
    expect(providerFault(filtered)).toBe(false);
    expect(providerFault(new DomainError("INSUFFICIENT_ACCESS", "PMS denied", 403))).toBe(false);
    expect(providerFault(new AssistantFailure("AI_HTTP_403", "unclassified"))).toBe(false);
  });
  it("separates retryable transport and stream failures from credentials, quota and invalid requests", () => {
    for (const code of ["AI_HTTP_429", "AI_HTTP_503", "AI_MODEL_IDLE_TIMEOUT", "AI_DNS_FAILED", "AI_ECONNRESET", "AI_UPSTREAM_STREAM_ERROR", "AI_UPSTREAM_RATE_LIMITED", "AI_STREAM_INCOMPLETE"]) {
      const error = new AssistantFailure(code, "safe");
      expect(providerFault(error), code).toBe(true); expect(providerRetryable(error), code).toBe(true);
    }
    for (const code of ["AI_HTTP_401", "AI_HTTP_402", "AI_UPSTREAM_AUTH_FAILED", "AI_UPSTREAM_QUOTA_EXCEEDED", "AI_INVALID_RESPONSE_JSON", "AI_INVALID_RESPONSE_TOOL_CALLS"]) {
      const error = new AssistantFailure(code, "safe");
      expect(providerFault(error), code).toBe(true); expect(providerRetryable(error), code).toBe(false);
    }
    for (const code of ["AI_UPSTREAM_INVALID_REQUEST", "AI_UPSTREAM_CONTEXT_LIMIT", "AI_UPSTREAM_CONTENT_FILTER", "AI_INVALID_RESPONSE_FINISH_LENGTH", "AI_TLS_FAILED", "AI_CANCELLED", "AI_PROGRESS_FAILED", "AI_HTTP_400"]) {
      const error = new AssistantFailure(code, "safe");
      expect(providerFault(error), code).toBe(false); expect(providerRetryable(error), code).toBe(false);
    }
  });
  it("routes new questions through backup for ten minutes, without creating a scheduled probe", async () => {
    vi.useFakeTimers(); const router = new AssistantProviderRouter(), settings = row();
    expect(router.select(settings)).toBe("primary"); router.failure(1, failed());
    expect(router.select(settings)).toBe("backup"); expect(router.needsProbe(settings)).toBe(false);
    await vi.advanceTimersByTimeAsync(599_999); expect(router.needsProbe(settings)).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(router.needsProbe(settings)).toBe(true);
    expect(router.select(settings)).toBe("backup"); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the user on backup and permits only one independent probe until complete", async () => {
    vi.useFakeTimers(); const router = new AssistantProviderRouter(), settings = row();
    router.select(settings); router.failure(1, failed()); await vi.advanceTimersByTimeAsync(600_000);
    let complete!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const pending = router.probe(settings, work); await Promise.resolve();
    expect(router.probe(settings, work)).toBe(pending); expect(work).toHaveBeenCalledOnce();
    expect(router.status(settings).state).toBe("checking"); expect(router.select(settings)).toBe("backup");
    complete(); expect(await pending).toBe(true); expect(router.select(settings)).toBe("primary");
  });
  it("restarts the ten-minute delay after a failed probe and supports an explicit early probe", async () => {
    vi.useFakeTimers(); const router = new AssistantProviderRouter(), settings = row();
    router.select(settings); router.failure(1, failed()); await vi.advanceTimersByTimeAsync(600_000);
    expect(await router.probe(settings, async () => { throw failed(); })).toBe(false);
    expect(router.needsProbe(settings)).toBe(false); expect(router.select(settings)).toBe("backup");
    expect(await router.probe(settings, async () => {}, true)).toBe(true);
    expect(router.select(settings)).toBe("primary");
  });
  it("cancels stale recovery on configuration changes and cannot resurrect a stopped provider", async () => {
    const router = new AssistantProviderRouter(), settings = row(); router.select(settings); router.failure(1, failed());
    let signal!: AbortSignal, complete!: () => void;
    const pending = router.probe(settings, async value => { signal = value; await new Promise<void>(resolve => { complete = resolve; }); }, true);
    await Promise.resolve(); const changed = row({ version: 2, enabled: false }); router.sync(changed);
    expect(signal.aborted).toBe(true); complete(); expect(await pending).toBe(false);
    expect(router.status(changed).state).toBe("unavailable");
  });
  it("ignores stale configuration snapshots instead of reverting a newer route", async () => {
    const router = new AssistantProviderRouter(), old = row(), current = row({ version: 2 });
    router.select(current); router.failure(2, failed());
    expect(() => router.select(old)).toThrow("配置已变化"); expect(router.needsProbe(old)).toBe(false);
    expect(await router.probe(old, async () => {}, true)).toBe(false);
    expect(router.select(current)).toBe("backup");
  });
  it("reloads an overtaken priority snapshot without resetting the newer route or conversation", async () => {
    const router = new AssistantProviderRouter(), old = row(), current = row({ version: 2 });
    router.select(current); router.failure(2, failed());
    const readLatest = vi.fn(async () => current);
    expect(await selectProviderSnapshot(router, old, readLatest)).toEqual({ settings: current, provider: "backup" });
    expect(readLatest).toHaveBeenCalledOnce(); expect(router.status(current).lastFailure).toBe("AI_HTTP_503");
  });
  it("does not cross a configuration save while refreshing an overtaken priority snapshot", async () => {
    const router = new AssistantProviderRouter(), old = row(), saved = row({ version: 2, conversation_version: 2 });
    router.sync(saved);
    await expect(selectProviderSnapshot(router, old, async () => saved)).rejects.toThrow("配置已变化");
  });
  it("delays another recovery check after TLS or safety rejection without making them fallback faults", async () => {
    vi.useFakeTimers(); const router = new AssistantProviderRouter(), settings = row();
    router.select(settings); router.failure(1, failed()); await vi.advanceTimersByTimeAsync(600_000);
    const tls = new AssistantFailure("AI_TLS_FAILED", "certificate rejected"); expect(providerFault(tls)).toBe(false);
    expect(await router.probe(settings, async () => { throw tls; })).toBe(false);
    expect(router.needsProbe(settings)).toBe(false); expect(router.status(settings).lastFailure).toBe("AI_RECOVERY_FAILED");
    await vi.advanceTimersByTimeAsync(600_000); expect(router.needsProbe(settings)).toBe(true);
  });
  it("releases a probe even when its work ignores cancellation", async () => {
    const router = new AssistantProviderRouter(), settings = row(); router.select(settings);
    const pending = router.probe(settings, () => new Promise<void>(() => {}), true);
    await Promise.resolve(); await router.close(); expect(await pending).toBe(false);
  });
  it("does not let an older recovery success override a newer primary failure", async () => {
    const router = new AssistantProviderRouter(), settings = row(); router.select(settings); router.failure(1, failed());
    let complete!: () => void;
    const pending = router.probe(settings, () => new Promise<void>(resolve => { complete = resolve; }), true);
    await Promise.resolve(); router.failure(1, failed()); complete(); expect(await pending).toBe(false);
    expect(router.select(settings)).toBe("backup");
  });
  it("keeps enabled legacy connections available in either slot after a priority swap", () => {
    const router = new AssistantProviderRouter(), settings = row({ backup_tested_at: null });
    expect(router.select(settings, true)).toBe("backup");
    router.failure(1, failed()); expect(router.select(settings)).toBe("backup");
  });
  it("never routes to disabled or incomplete backup and ignores cancellation/access faults", () => {
    const router = new AssistantProviderRouter(), settings = row({ backup_enabled: false });
    router.select(settings); router.failure(1, failed()); expect(router.select(settings)).toBe("primary");
    expect(() => router.select(settings, true)).toThrow("备用");
    expect(() => router.select(row({ version: 2, backup_encrypted_key: "" }), true)).toThrow("备用");
    for (const error of [new DomainError("INSUFFICIENT_ACCESS", "denied", 403), new AssistantFailure("AI_CANCELLED", "stop"), new AssistantFailure("AI_TLS_FAILED", "TLS"), new AssistantFailure("AI_HTTP_400", "request"), new AssistantFailure("AI_PROGRESS_FAILED", "database"), new AssistantFailure("AI_INVALID_RESPONSE_FINISH_CONTENT_FILTER", "filtered")]) expect(providerFault(error)).toBe(false);
    for (const code of ["AI_HTTP_401", "AI_HTTP_429", "AI_HTTP_503", "AI_DNS_TIMEOUT", "AI_MODEL_IDLE_TIMEOUT", "AI_ECONNRESET"]) expect(providerFault(new AssistantFailure(code, "safe"))).toBe(true);
  });
  it("closes an in-flight probe and does not start another after shutdown", async () => {
    const router = new AssistantProviderRouter(), settings = row(); router.select(settings);
    const pending = router.probe(settings, signal => abortable(new Promise<void>(() => {}), signal), true);
    await Promise.resolve(); await router.close(); expect(await pending).toBe(false);
    expect(await router.probe(settings, async () => {}, true)).toBe(false);
  });
});

describe("provider test proofs", () => {
  it("binds successful tests to actor/session/configuration/provider/connection and expires them", async () => {
    vi.useFakeTimers(); const tests = createProviderTestReceipts();
    const context = { actor: "a", session: "s", property: "p", version: 1, role: "backup", baseUrl: "https://b.example/v1", model: "b", key: "private" };
    const token = tests.issue(context);
    expect(token).not.toContain("private"); expect(tests.matches(context, token)).toBe(true); expect(tests.matches(context)).toBe(true);
    for (const field of Object.keys(context)) expect(tests.matches({ ...context, [field]: "different" }, token)).toBe(false);
    expect(tests.matches(context, "invented")).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000); expect(tests.matches(context, token)).toBe(false);
  });
  it("clears all proof validity when settings are saved", () => {
    const tests = createProviderTestReceipts(), context = { key: "private" }, token = tests.issue(context);
    tests.clear(); expect(tests.matches(context, token)).toBe(false);
  });
  it("uses a small synthetic tool request and only accepts the complete expected tool result", () => {
    expect(connectionTestInput()).toMatchObject({ maxTokens: 2048, toolChoice: "connection_check" });
    const valid = { content: null, tool_calls: [{ id: "t", type: "function" as const, function: { name: "connection_check", arguments: '{ "ok" : true }' } }] };
    expect(() => assertConnectionTest(valid)).not.toThrow();
    for (const result of [{ content: "hello" }, { ...valid, tool_calls: [] }, { ...valid, tool_calls: [...valid.tool_calls, ...valid.tool_calls] }, { ...valid, tool_calls: [{ ...valid.tool_calls[0]!, function: { name: "connection_check", arguments: '{"ok":true,"extra":1}' } }] }]) expect(() => assertConnectionTest(result)).toThrow("工具调用");
  });
});
