import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { DomainError } from "@qintopia/contracts";
import { SseDecoder } from "../../../packages/contracts/src/sse.ts";
import { abortable, AssistantFailure } from "./assistant-lifetime.ts";

export const aiError = (message: string) => new DomainError("VALIDATION_ERROR", message, 400);
export function encryptionKey(): Buffer {
  const source = process.env.AI_SETTINGS_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(source, "base64");
  if (key.length !== 32 || key.toString("base64") !== source) throw aiError("AI 密钥保护尚未配置，请管理员联系部署人员设置服务端加密密钥。");
  return key;
}
export function keyReady(): boolean { try { encryptionKey(); return true; } catch { return false; } }
export function encryptKey(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("qintopia:ai:installation:v1"));
  return ["v1", iv.toString("base64"), Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
}
export function decryptKey(value: string): string {
  try {
    const [version, iv, content, tag] = value.split(".");
    if (version !== "v1" || !iv || !content || !tag) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from("qintopia:ai:installation:v1"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(content, "base64")), decipher.final()]).toString("utf8");
  } catch { throw aiError("AI 凭证无法解密，请核对服务端加密密钥或重新保存模型凭证。"); }
}
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw aiError("请填写有效的 HTTPS Base URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || input.length > 2048)
    throw aiError("Base URL 必须是 HTTPS 地址，不能包含凭证、查询参数或片段。");
  if (url.pathname.endsWith("/chat/completions")) throw aiError("请填写 API 根地址（通常以 /v1 结尾），不要包含 /chat/completions。");
  return url.toString().replace(/\/+$/, "");
}
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Native global unicast only; deny mapped/translation/tunnel and special-use prefixes.
    return /^[23][0-9a-f]{3}:/.test(lower) && !/^(2001:|2002:|3fff:)/.test(lower);
  }
  return false;
}
export async function resolvePublicEndpoint(baseUrl: string, signal?: AbortSignal) {
  const url = new URL(normalizeBaseUrl(baseUrl) + "/chat/completions");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await abortable(Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(aiError("模型服务域名解析超时。")), 5000); })
    ]), signal);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw aiError("模型服务必须使用公网地址，不能连接内网或本机服务。");
    return { url, address: addresses[0]! };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw aiError("无法解析模型服务地址，请检查 Base URL。");
  } finally { clearTimeout(timer); }
}
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ModelToolCall[]; tool_call_id?: string };
export type ModelToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export interface ModelInput { baseUrl: string; apiKey: string; model: string; messages: ModelMessage[]; tools: ModelTool[]; toolChoice?: string; signal?: AbortSignal; onDelta?: (text: string) => Promise<void> }
export type ModelTransport = (input: ModelInput) => Promise<{ content: string | null; tool_calls?: ModelToolCall[] }>;

const invalidResponse = () => new AssistantFailure("AI_INVALID_RESPONSE", "模型返回了不完整或不兼容的内容，请确认服务支持流式 Chat Completions 和工具调用。");
function validateMessage(message: { content: string | null; tool_calls?: ModelToolCall[] }, finish: unknown) {
  if (!["stop", "tool_calls"].includes(String(finish))) throw invalidResponse();
  if (message.content !== null && typeof message.content !== "string") throw invalidResponse();
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw invalidResponse();
  if ((message.content?.length ?? 0) > 12000 || (message.tool_calls?.length ?? 0) > 6) throw invalidResponse();
  const ids = new Set<string>();
  for (const tool of message.tool_calls ?? []) {
    if (!tool || tool.type !== "function" || typeof tool.id !== "string" || !tool.id || tool.id.length > 200 || typeof tool.function?.name !== "string" || !tool.function.name || tool.function.name.length > 200
      || typeof tool.function.arguments !== "string" || tool.function.arguments.length > 6000) throw invalidResponse();
    if (ids.has(tool.id)) throw invalidResponse();
    ids.add(tool.id);
  }
  if (!message.content?.trim() && !message.tool_calls?.length) throw invalidResponse();
  return message;
}

/** Only assembled, bounded function calls can leave the provider boundary. */
export class ModelStreamDecoder {
  private frames = new SseDecoder();
  private content = "";
  private tools = new Map<number, ModelToolCall>();
  private finish: unknown;
  private done = false;
  get complete() { return this.done; }
  push(text: string): string {
    let delta = "";
    for (const data of this.frames.push(text)) {
      if (this.done) throw invalidResponse();
      if (data === "[DONE]") { this.done = true; continue; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw invalidResponse(); }
      if (!parsed || parsed.error || !Array.isArray(parsed.choices)) throw invalidResponse();
      if (!parsed.choices.length) continue; // optional usage-only chunk
      const choice = parsed.choices[0];
      if (parsed.choices.length !== 1 || !choice || choice.index !== 0 || this.finish || !choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)) throw invalidResponse();
      const part = choice.delta;
      if (part.content != null) {
        if (typeof part.content !== "string") throw invalidResponse();
        this.content += part.content; delta += part.content;
        if (this.content.length > 12000) throw invalidResponse();
      }
      if (part.tool_calls !== undefined) {
        if (!Array.isArray(part.tool_calls) || part.tool_calls.length > 6) throw invalidResponse();
        for (const item of part.tool_calls) {
          if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index > 5 || item.type && item.type !== "function") throw invalidResponse();
          const tool = this.tools.get(item.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
          for (const value of [item.id, item.function?.name, item.function?.arguments]) if (value !== undefined && typeof value !== "string") throw invalidResponse();
          tool.id += item.id ?? "";
          tool.function.name += item.function?.name ?? "";
          tool.function.arguments += item.function?.arguments ?? "";
          if (tool.id.length > 200 || tool.function.name.length > 200 || tool.function.arguments.length > 6000) throw invalidResponse();
          this.tools.set(item.index, tool);
        }
      }
      if (choice.finish_reason != null) {
        if (!["stop", "tool_calls"].includes(choice.finish_reason)) throw invalidResponse();
        this.finish = choice.finish_reason;
      }
    }
    return delta;
  }
  result() {
    if (!this.done) throw invalidResponse();
    const tool_calls = [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
    return validateMessage({ content: this.content || null, ...(tool_calls.length ? { tool_calls } : {}) }, this.finish);
  }
}

export const callModel: ModelTransport = async (input) => {
  const endpoint = await resolvePublicEndpoint(input.baseUrl, input.signal);
  const streaming = Boolean(input.onDelta);
  const body = JSON.stringify({ model: input.model, messages: input.messages, tools: input.tools, stream: streaming,
    max_tokens: 2048, ...(input.toolChoice ? { tool_choice: { type: "function", function: { name: input.toolChoice } } } : {}) });
  try {
    return await new Promise<Awaited<ReturnType<ModelTransport>>>((resolve, reject) => {
      let settled = false, idle: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, result?: Awaited<ReturnType<ModelTransport>>) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); clearTimeout(idle); input.signal?.removeEventListener("abort", abort);
        if (error) { req.destroy(); reject(error); } else resolve(result!);
      };
      const req = request(endpoint.url, {
        method: "POST", family: endpoint.address.family,
        lookup: (_hostname, _options, callback) => callback(null, endpoint.address.address, endpoint.address.family),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}`, "Content-Length": Buffer.byteLength(body) }
      }, async (response) => {
        if (response.statusCode !== 200) { finish(new AssistantFailure(`AI_HTTP_${response.statusCode ?? 0}`, `模型服务返回 HTTP ${response.statusCode ?? "未知"}，请检查模型、凭证或稍后重试。`)); response.destroy(); return; }
        if (streaming && !response.headers["content-type"]?.includes("text/event-stream")) { finish(invalidResponse()); response.destroy(); return; }
        let size = 0, raw = "";
        const decoder = new TextDecoder("utf-8", { fatal: true }), stream = new ModelStreamDecoder();
        const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => finish(new AssistantFailure("AI_MODEL_IDLE_TIMEOUT", "模型响应中断，已停止本次回答，请稍后重试。")), 25_000); };
        resetIdle();
        try {
          for await (const chunk of response) {
            if (settled) return;
            size += chunk.length;
            if (size > 1_000_000) throw new AssistantFailure("AI_RESPONSE_TOO_LARGE", "模型响应过大，请缩小问题范围后重试。");
            resetIdle();
            const text = decoder.decode(chunk, { stream: true });
            if (streaming) {
              const delta = stream.push(text);
              if (delta) await input.onDelta!(delta);
              // The protocol terminator is authoritative; a proxy may keep its socket open.
              if (stream.complete) { finish(undefined, stream.result()); response.destroy(); return; }
            } else raw += text;
          }
          const tail = decoder.decode();
          if (streaming) {
            const delta = stream.push(tail);
            if (delta) await input.onDelta!(delta);
            finish(undefined, stream.result());
          } else {
            const parsed = JSON.parse(raw + tail), choice = parsed.choices?.[0];
            if (!choice?.message) throw invalidResponse();
            finish(undefined, validateMessage({ ...choice.message, content: choice.message.content ?? null }, choice.finish_reason));
          }
        } catch (error) { finish(error); }
      });
      const deadline = setTimeout(() => finish(new AssistantFailure("AI_MODEL_TIMEOUT", "模型回答超时，已停止本次请求。请稍后重试或联系管理员检查连接。")), 60_000);
      const abort = () => finish(input.signal!.reason);
      input.signal?.addEventListener("abort", abort, { once: true });
      req.once("error", error => finish(error));
      if (input.signal?.aborted) abort(); else req.end(body);
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    const diagnostic = ["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code ?? "") ? `AI_${code}` : "AI_MODEL_CONNECTION_FAILED";
    throw new AssistantFailure(diagnostic, "模型服务连接失败，本次未自动重试。请稍后重试或联系管理员检查连接。");
  }
};
