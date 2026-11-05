import { createHmac, randomBytes } from "node:crypto";
import { AssistantFailure } from "./assistant-lifetime.ts";
import type { ModelInput } from "./assistant-model.ts";

export type ModelFailureCategory = "upstream" | "rate_limit" | "authentication" | "quota" | "invalid_request" | "context_limit" | "content_filter" | "incomplete_stream" | "protocol";
export interface ModelFailureDiagnostic {
  category: ModelFailureCategory;
  reason: string;
  upstreamType?: string;
  upstreamCode?: string;
  requestId?: string;
  httpStatus?: number;
  messageLength?: number;
  messageHash?: string;
}
export type ModelDiagnosticContext = Pick<ModelInput, "apiKey" | "messages">;
// Provider text never enters an Error property or DomainError.details. The
// process-local HMAC permits correlation without exposing a reusable hash of a key.
const diagnostics = new WeakMap<AssistantFailure, Readonly<ModelFailureDiagnostic>>();
const hashKey = randomBytes(32);
export function modelFailureDiagnostic(error: unknown): Readonly<ModelFailureDiagnostic> | undefined {
  return error instanceof AssistantFailure ? diagnostics.get(error) : undefined;
}
export function diagnosedModelFailure(code: string, message: string, diagnostic: ModelFailureDiagnostic): AssistantFailure {
  const error = new AssistantFailure(code, message);
  diagnostics.set(error, Object.freeze(diagnostic));
  return error;
}
const identifiers: Record<string, ModelFailureCategory> = {
  upstream_error: "upstream", server_error: "upstream", internal_error: "upstream", internal_server_error: "upstream", overloaded_error: "upstream", service_unavailable: "upstream", api_error: "upstream",
  rate_limit_error: "rate_limit", rate_limit_exceeded: "rate_limit", rate_limit_reached: "rate_limit", too_many_requests: "rate_limit",
  authentication_error: "authentication", invalid_api_key: "authentication", invalid_authentication: "authentication", unauthorized: "authentication", permission_error: "authentication", permission_denied: "authentication",
  insufficient_quota: "quota", quota_exceeded: "quota", insufficient_balance: "quota", billing_error: "quota", billing_hard_limit_reached: "quota", credit_balance_too_low: "quota",
  invalid_request_error: "invalid_request", invalid_request: "invalid_request", invalid_parameter: "invalid_request", unsupported_parameter: "invalid_request", model_not_found: "invalid_request",
  context_length_exceeded: "context_limit", context_window_exceeded: "context_limit", max_tokens_exceeded: "context_limit",
  content_filter: "content_filter", content_policy_violation: "content_filter", safety_violation: "content_filter",
  premature_eof: "incomplete_stream", unexpected_eof: "incomplete_stream", incomplete_stream: "incomplete_stream", connection_closed: "incomplete_stream", stream_incomplete: "incomplete_stream"
};
const reasons: Record<ModelFailureCategory, string> = {
  upstream: "上游服务报告处理失败，未提供可识别的具体原因。",
  rate_limit: "上游服务报告请求限流。", authentication: "上游服务报告凭证或访问授权失败。",
  quota: "上游服务报告余额或额度不足。", invalid_request: "上游服务报告请求参数或模型不被接受。",
  context_limit: "上游服务报告上下文或输出预算超限。", content_filter: "上游服务报告内容过滤。",
  incomplete_stream: "上游服务报告响应流提前结束或缺少结束标记。", protocol: "上游响应结构未通过完整性校验。"
};
const messages: Record<ModelFailureCategory, string> = {
  upstream: "模型服务在处理本次请求时报告异常，未完成回答。",
  rate_limit: "模型服务当前请求过多，暂时未能完成回答。", authentication: "模型服务的访问凭证或授权不可用，请联系管理员检查配置。",
  quota: "模型服务的余额或额度不足，请联系管理员检查。", invalid_request: "模型服务未接受本次请求参数，请联系管理员检查模型配置。",
  context_limit: "本次问题的上下文或输出超出模型限制，请缩小问题范围。", content_filter: "模型服务未能通过本次内容检查，请调整问题后重试。",
  incomplete_stream: "模型响应流提前结束，尚未收到完整回答。", protocol: "模型返回了不完整或不兼容的内容。"
};
const streamCodes: Record<ModelFailureCategory, string> = {
  upstream: "AI_UPSTREAM_STREAM_ERROR", rate_limit: "AI_UPSTREAM_RATE_LIMITED", authentication: "AI_UPSTREAM_AUTH_FAILED", quota: "AI_UPSTREAM_QUOTA_EXCEEDED",
  invalid_request: "AI_UPSTREAM_INVALID_REQUEST", context_limit: "AI_UPSTREAM_CONTEXT_LIMIT", content_filter: "AI_UPSTREAM_CONTENT_FILTER",
  incomplete_stream: "AI_STREAM_INCOMPLETE", protocol: "AI_INVALID_RESPONSE"
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(identifiers, value.toLowerCase()) ? value.toLowerCase() : undefined;
}
function sensitiveText(context?: ModelDiagnosticContext): string[] {
  if (!context) return [];
  return [context.apiKey, ...context.messages.flatMap(message => [message.content, message.reasoning_content,
    message.tool_call_id, ...(message.tool_calls?.flatMap(tool => [tool.id, tool.function.name, tool.function.arguments]) ?? [])])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
function requestId(value: unknown, sensitive: string[]): string | undefined {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:req[-_])?[a-f0-9]{24,80})$/i.test(value)) return;
  const normalized = value.normalize("NFKC").toLowerCase();
  if (sensitive.some(text => {
    const source = text.normalize("NFKC").toLowerCase();
    return source.includes(normalized) || normalized.includes(source) || source.includes(normalized.replace(/^req[-_]/, ""));
  })) return;
  return value;
}
function messageCategory(text: string, sensitive: string[]): ModelFailureCategory | undefined {
  // Only fixed categories are retained. Strip request echoes before classifying
  // so a quoted user question cannot masquerade as the provider's error reason.
  let safe = text.slice(0, 4096);
  for (const value of sensitive) safe = safe.replaceAll(value, " ");
  if (/insufficient[_ ](?:quota|balance|credit)|quota[_ ]exceeded|credit balance.*too low|余额不足|额度不足/i.test(safe)) return "quota";
  if (/invalid[_ ]api[_ ]key|authentication (?:failed|error)|unauthorized|鉴权失败|密钥无效/i.test(safe)) return "authentication";
  if (/context[_ ](?:length|window)[_ ](?:exceeded|limit)|maximum context length|上下文.*(?:超限|过长)/i.test(safe)) return "context_limit";
  if (/content[_ ](?:filter|policy violation)|safety[_ ]violation|内容审核未通过/i.test(safe)) return "content_filter";
  if (/invalid[_ ](?:request|parameter)|unsupported[_ ]parameter|model[_ ]not[_ ]found|参数无效/i.test(safe)) return "invalid_request";
  if (/rate[_ -]?limit|too many requests|请求限流/i.test(safe)) return "rate_limit";
  if (/premature (?:eof|end)|unexpected (?:eof|end of (?:file|stream))|connection (?:was )?closed|stream.*(?:ended|closed).*(?:before|without)|missing (?:terminal|terminator|\[DONE\])|流.*提前结束/i.test(safe)) return "incomplete_stream";
  return;
}

/** Parse an error envelope without retaining its raw message or unknown fields. */
export function upstreamModelFailure(value: unknown, context?: ModelDiagnosticContext, httpStatus?: number, headerRequestId?: unknown): AssistantFailure {
  const envelope = record(value), error = record(envelope.error ?? value);
  const type = identifier(error.type), code = identifier(error.code);
  const text = typeof error.message === "string" ? error.message : typeof envelope.error === "string" ? envelope.error : "";
  const sensitive = sensitiveText(context);
  const codeCategory = code ? identifiers[code] : undefined, typeCategory = type ? identifiers[type] : undefined;
  const detailCategory = messageCategory(text, sensitive);
  const statusCategory = httpStatus === 401 || httpStatus === 403 ? "authentication" : httpStatus === 402 ? "quota" : httpStatus === 429 ? "rate_limit"
    : httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 ? "invalid_request" : "upstream";
  let category: ModelFailureCategory;
  // A parameter named "rate_limit" is not evidence of throttling. Specific
  // structured codes win; generic request errors may only become non-retryable
  // context/filter failures. Free text cannot turn an HTTP 400 into a retry.
  if (codeCategory && codeCategory !== "upstream") category = codeCategory;
  else if (typeCategory && typeCategory !== "upstream") category = typeCategory === "invalid_request"
    && (detailCategory === "context_limit" || detailCategory === "content_filter") ? detailCategory : typeCategory;
  else if (["authentication", "quota", "invalid_request"].includes(statusCategory)) category = statusCategory === "invalid_request"
    && (detailCategory === "context_limit" || detailCategory === "content_filter") ? detailCategory : statusCategory;
  else category = detailCategory ?? (statusCategory !== "upstream" ? statusCategory : codeCategory ?? typeCategory ?? "upstream");
  const id = [error.request_id, envelope.request_id, headerRequestId].map(value => requestId(value, sensitive)).find(Boolean);
  const diagnostic: ModelFailureDiagnostic = { category, reason: reasons[category], ...(type ? { upstreamType: type } : {}), ...(code ? { upstreamCode: code } : {}),
    ...(id ? { requestId: id } : {}), ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(text ? { messageLength: text.length, messageHash: createHmac("sha256", hashKey).update(text).digest("hex") } : {}) };
  return diagnosedModelFailure(httpStatus === undefined ? streamCodes[category] : `AI_HTTP_${httpStatus}`, messages[category], diagnostic);
}
