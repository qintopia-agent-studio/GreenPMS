import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import type { Database } from "@qintopia/db";
import { DomainError } from "@qintopia/contracts";
import type { AssistantProviderRole, AssistantProviderSettings, AssistantRoutingStatus } from "../../../packages/contracts/src/assistant.ts";
import { aiError, decryptKey, type ModelInput, type ModelResponse } from "./assistant-model.ts";
import { abortable, AssistantFailure } from "./assistant-lifetime.ts";

export type ProviderSettingsRow = Selectable<Database["ai_model_settings"]>;
export const PROVIDER_RECOVERY_DELAY_MS = 10 * 60_000;
export function providerSettings(row: ProviderSettingsRow | undefined, role: AssistantProviderRole): AssistantProviderSettings {
  return role === "primary" ? {
    name: row?.provider_name ?? "主供应商", enabled: row?.provider_enabled ?? true,
    baseUrl: row?.base_url ?? "", model: row?.model ?? "", hasKey: Boolean(row?.encrypted_key),
    testedAt: row?.provider_tested_at?.toISOString() ?? null
  } : {
    name: row?.backup_name ?? "备用供应商", enabled: row?.backup_enabled ?? false,
    baseUrl: row?.backup_base_url ?? "", model: row?.backup_model ?? "", hasKey: Boolean(row?.backup_encrypted_key),
    testedAt: row?.backup_tested_at?.toISOString() ?? null
  };
}
export function providerAvailable(row: ProviderSettingsRow | undefined, role: AssistantProviderRole): boolean {
  const value = providerSettings(row, role);
  return value.enabled && value.hasKey && Boolean(value.baseUrl && value.model) && (role === "primary" || Boolean(value.testedAt));
}
export function providerCredentials(row: ProviderSettingsRow, role: AssistantProviderRole) {
  const provider = providerSettings(row, role);
  return { baseUrl: provider.baseUrl, model: provider.model,
    apiKey: decryptKey(role === "primary" ? row.encrypted_key : row.backup_encrypted_key) };
}
// Only faults attributable to a provider may change routing. In particular, PMS access,
// cancellation, malformed requests, SSRF guards and certificate failures are never retried.
export function providerFault(error: unknown): error is AssistantFailure {
  return error instanceof AssistantFailure && /^(AI_HTTP_(401|402|429|500|502|503|504)|AI_MODEL_(FIRST_RESPONSE_TIMEOUT|IDLE_TIMEOUT|CONNECTION_FAILED)|AI_(DNS_TIMEOUT|DNS_FAILED|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT)|AI_INVALID_RESPONSE(?:_[A-Z0-9_]+)?)$/.test(error.diagnostic)
    && !/AI_INVALID_RESPONSE_FINISH_(CONTENT_FILTER|LENGTH)/.test(error.diagnostic);
}
export function connectionTestInput(): Pick<ModelInput, "messages" | "tools" | "toolChoice" | "maxTokens"> {
  return { messages: [{ role: "user", content: "Call connection_check with ok=true." }],
    tools: [{ type: "function", function: { name: "connection_check", description: "Connection test", parameters: {
      type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false
    } } }], toolChoice: "connection_check", maxTokens: 2048 };
}
export function recoveryCancelled(error: unknown): boolean {
  return error instanceof AssistantFailure && ["AI_CANCELLED", "AI_CONFIG_CHANGED", "AI_RECOVERY_SUPERSEDED", "AI_ATTEMPT_FINISHED"].includes(error.diagnostic)
    || error instanceof DomainError && ["INSUFFICIENT_ACCESS", "AUTHENTICATION_REQUIRED", "SESSION_EXPIRED", "INVALID_CREDENTIALS", "AGGREGATE_VERSION_CONFLICT"].includes(error.code)
    || error instanceof Error && error.name === "AbortError";
}
export function assertConnectionTest(result: ModelResponse): void {
  const tool = result.tool_calls?.[0];
  let args: unknown;
  try { args = JSON.parse(tool?.function.arguments ?? ""); } catch { /* fixed public error below */ }
  if (result.tool_calls?.length !== 1 || tool?.function.name !== "connection_check" || !args || typeof args !== "object"
    || Object.keys(args).length !== 1 || (args as { ok?: unknown }).ok !== true)
    throw new AssistantFailure("AI_INVALID_RESPONSE_CONNECTION_TEST", "连接已响应，但模型未正确返回工具调用；请使用支持 function tools 的模型。");
}

// Test proofs never contain the key. They are scoped to the exact actor/session/version,
// provider slot and connection, so a stale browser or another administrator cannot reuse one.
export function createProviderTestReceipts() {
  const secret = randomBytes(32);
  const values = new Map<string, { fingerprint: string; expiresAt: number }>();
  const fingerprint = (context: object) => createHmac("sha256", secret).update(JSON.stringify(context)).digest("hex");
  const prune = () => { for (const [token, value] of values) if (value.expiresAt <= Date.now()) values.delete(token); };
  return {
    issue(context: object) {
      prune();
      if (values.size >= 200) values.delete(values.keys().next().value!);
      const token = randomUUID(); values.set(token, { fingerprint: fingerprint(context), expiresAt: Date.now() + 10 * 60_000 }); return token;
    },
    matches(context: object, token?: string) {
      prune(); const expected = fingerprint(context);
      return token ? values.get(token)?.fingerprint === expected : [...values.values()].some(value => value.fingerprint === expected);
    },
    clear() { values.clear(); }
  };
}

/** One installation/one API process, matching the existing in-memory conversations.
 * No scheduler or paid probe runs while nobody asks a question. */
export class AssistantProviderRouter {
  private version = -1;
  private generation = 0;
  private retryAt: number | null = null;
  private lastFailure: string | null = null;
  private lastCheckedAt: string | null = null;
  private running: { controller: AbortController; promise: Promise<boolean> } | undefined;
  private closed = false;
  sync(row: ProviderSettingsRow | undefined) {
    const version = row?.version ?? 0;
    if (version < this.version) return false;
    if (this.version !== version || !row?.enabled) {
      this.generation++; this.running?.controller.abort(new AssistantFailure("AI_CONFIG_CHANGED", "模型配置已变化。"));
      this.running = undefined; this.retryAt = null; this.lastFailure = null; this.lastCheckedAt = null;
      this.version = version;
    }
    return true;
  }
  select(row: ProviderSettingsRow, useBackup = false): AssistantProviderRole {
    if (!this.sync(row)) throw new AssistantFailure("AI_CONFIG_CHANGED", "模型配置已变化，请新建对话后重试。");
    if (!row.enabled || this.closed) throw aiError("AI 助手尚未启用。");
    if (useBackup) {
      if (!providerAvailable(row, "backup")) throw aiError("备用供应商尚未启用或未通过测试，请联系管理员。");
      return "backup";
    }
    if (providerAvailable(row, "primary") && (this.retryAt === null || !providerAvailable(row, "backup"))) return "primary";
    if (providerAvailable(row, "backup")) return "backup";
    throw aiError("当前没有可用的模型供应商，请管理员检查配置。");
  }
  failure(version: number, error: unknown) {
    if (this.closed || version !== this.version || !providerFault(error)) return;
    this.generation++;
    this.running?.controller.abort(new AssistantFailure("AI_RECOVERY_SUPERSEDED", "主供应商出现新的故障。"));
    this.running = undefined;
    this.retryAt = Date.now() + PROVIDER_RECOVERY_DELAY_MS; this.lastFailure = error.diagnostic;
  }
  status(row: ProviderSettingsRow | undefined): AssistantRoutingStatus {
    if (!this.sync(row)) throw new AssistantFailure("AI_CONFIG_CHANGED", "模型配置已变化，请重新载入。");
    const primary = providerAvailable(row, "primary"), backup = providerAvailable(row, "backup");
    return { state: !row?.enabled || (!primary && !backup) ? "unavailable" : this.running ? "checking" : (!primary || this.retryAt !== null) && backup ? "backup" : "primary",
      retryAfter: this.retryAt === null ? null : new Date(this.retryAt).toISOString(), lastFailure: this.lastFailure, lastCheckedAt: this.lastCheckedAt };
  }
  needsProbe(row: ProviderSettingsRow): boolean {
    if (!this.sync(row)) return false;
    return !this.closed && row.enabled && providerAvailable(row, "primary") && providerAvailable(row, "backup")
      && this.retryAt !== null && Date.now() >= this.retryAt && !this.running;
  }
  probe(row: ProviderSettingsRow, run: (signal: AbortSignal) => Promise<void>, force = false): Promise<boolean> {
    if (!this.sync(row)) return Promise.resolve(false);
    if (this.running) return this.running.promise;
    if (this.closed || !row.enabled || !providerAvailable(row, "primary") || (!force && !this.needsProbe(row))) return Promise.resolve(false);
    const generation = this.generation, version = this.version, controller = new AbortController();
    const promise = abortable(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }), controller.signal).then(() => {
      if (controller.signal.aborted || generation !== this.generation || version !== this.version || this.closed) return false;
      this.retryAt = null; this.lastFailure = null; this.lastCheckedAt = new Date().toISOString(); return true;
    }, error => {
      if (!controller.signal.aborted && generation === this.generation && version === this.version && !this.closed && !recoveryCancelled(error)) {
        this.retryAt = Date.now() + PROVIDER_RECOVERY_DELAY_MS;
        this.lastFailure = providerFault(error) ? error.diagnostic : "AI_RECOVERY_FAILED";
        this.lastCheckedAt = new Date().toISOString();
      }
      return false;
    }).finally(() => { if (this.running?.controller === controller) this.running = undefined; });
    this.running = { controller, promise }; return promise;
  }
  async close() {
    this.closed = true; this.generation++;
    const pending = this.running; pending?.controller.abort(new AssistantFailure("AI_CANCELLED", "助手服务已关闭。"));
    this.running = undefined; await pending?.promise;
  }
}
