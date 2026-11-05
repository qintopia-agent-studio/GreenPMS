import { describe, expect, it } from "vitest";
import { modelFailureDiagnostic, upstreamModelFailure, type ModelDiagnosticContext } from "./assistant-model-diagnostics.ts";

describe("private model diagnostics", () => {
  it.each([
    ["upstream_error", "upstream", "AI_UPSTREAM_STREAM_ERROR"],
    ["rate_limit_exceeded", "rate_limit", "AI_UPSTREAM_RATE_LIMITED"],
    ["invalid_api_key", "authentication", "AI_UPSTREAM_AUTH_FAILED"],
    ["insufficient_quota", "quota", "AI_UPSTREAM_QUOTA_EXCEEDED"],
    ["invalid_request_error", "invalid_request", "AI_UPSTREAM_INVALID_REQUEST"],
    ["context_length_exceeded", "context_limit", "AI_UPSTREAM_CONTEXT_LIMIT"],
    ["content_filter", "content_filter", "AI_UPSTREAM_CONTENT_FILTER"],
    ["premature_eof", "incomplete_stream", "AI_STREAM_INCOMPLETE"]
  ])("classifies a declared upstream %s without retaining its free text", (type, category, code) => {
    const error = upstreamModelFailure({ error: { type, message: "private provider message" } });
    expect(error.diagnostic).toBe(code);
    expect(modelFailureDiagnostic(error)).toMatchObject({ category, upstreamType: type, messageLength: 24, messageHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify([error, modelFailureDiagnostic(error)])).not.toContain("private provider message");
    expect(error.details).toBeUndefined();
  });
  it.each(["stream ended without a terminal event", "Unexpected EOF", "connection was closed", "missing [DONE]"])("recognizes incomplete stream detail: %s", message => {
    const error = upstreamModelFailure({ error: { type: "upstream_error", message } });
    expect(error.diagnostic).toBe("AI_STREAM_INCOMPLETE");
    expect(modelFailureDiagnostic(error)?.category).toBe("incomplete_stream");
  });
  it.each([
    [429, "insufficient_quota", "quota"], [500, "invalid_api_key", "authentication"],
    [503, "invalid_request_error", "invalid_request"], [500, "content_filter", "content_filter"]
  ])("preserves explicit %s/%s semantics over an HTTP retryable status", (status, code, category) => {
    const error = upstreamModelFailure({ error: { code, message: "private" } }, undefined, status);
    expect(error.diagnostic).toBe(`AI_HTTP_${status}`);
    expect(modelFailureDiagnostic(error)).toMatchObject({ httpStatus: status, category, upstreamCode: code });
  });
  it.each([
    [{ type: "invalid_request_error", code: "unsupported_parameter", message: "The parameter rate_limit is not supported." }, undefined],
    [{ type: "invalid_request_error", code: "invalid_parameter", message: "rate limit must be a number" }, 503],
    [{ type: "invalid_request_error", message: "The parameter rate_limit is not supported." }, undefined],
    [{ message: "The parameter rate_limit is not supported." }, 400]
  ])("does not upgrade a request error to retryable based on free text", (body, status) => {
    const error = upstreamModelFailure({ error: body }, undefined, status);
    expect(modelFailureDiagnostic(error)?.category).toBe("invalid_request");
    expect(error.diagnostic).toBe(status === undefined ? "AI_UPSTREAM_INVALID_REQUEST" : `AI_HTTP_${status}`);
  });
  it("allows a generic invalid-request type to describe a non-retryable context error", () => {
    const error = upstreamModelFailure({ error: { type: "invalid_request_error", message: "maximum context length exceeded" } });
    expect(modelFailureDiagnostic(error)?.category).toBe("context_limit");
  });
  it("keeps correlation metadata private, bounded and independent of error serialization", () => {
    const id = "req_0123456789abcdef0123456789abcdef";
    const envelope = { error: { type: "upstream_error", code: "unknown-private-code", message: "provider-only detail", request_id: id } };
    const first = upstreamModelFailure(envelope), second = upstreamModelFailure(envelope);
    const diagnostic = modelFailureDiagnostic(first)!;
    expect(diagnostic).toMatchObject({ requestId: id, upstreamType: "upstream_error", messageLength: 20 });
    expect(diagnostic.upstreamCode).toBeUndefined();
    expect(diagnostic.messageHash).toBe(modelFailureDiagnostic(second)?.messageHash);
    expect(JSON.stringify(first)).not.toContain(id);
    expect(first.details).toBeUndefined();
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(modelFailureDiagnostic(new Error("private"))).toBeUndefined();
  });
  it("rejects a credential or business echo even when it resembles a valid upstream request ID", () => {
    const secrets = Array.from({ length: 5 }, (_, i) => `req_${String(i).repeat(32)}`);
    const context: ModelDiagnosticContext = { apiKey: secrets[0]!, messages: [
      { role: "user", content: `客人资料 ${secrets[1]}` },
      { role: "assistant", content: null, reasoning_content: secrets[2]!, tool_calls: [{ id: "tool-call", type: "function", function: { name: "lookup", arguments: JSON.stringify({ private: secrets[3] }) } }] },
      { role: "tool", tool_call_id: "tool-call", content: JSON.stringify({ private: secrets[4] }) }
    ] };
    for (const secret of secrets) {
      const error = upstreamModelFailure({ error: { type: secret, code: secret, message: `The request included ${secret}`, request_id: secret } }, context, 503, secret);
      const diagnostic = modelFailureDiagnostic(error)!;
      expect(diagnostic.requestId).toBeUndefined();
      expect(JSON.stringify([error, diagnostic])).not.toContain(secret);
      expect(diagnostic.upstreamType).toBeUndefined(); expect(diagnostic.upstreamCode).toBeUndefined();
    }
  });
  it("uses a safe header request ID when the body ID is untrusted, without logging unknown messages", () => {
    const id = "934e4286-95aa-4ae0-8354-4e7028e1e229";
    const error = upstreamModelFailure({ error: { type: "upstream_error", request_id: "guest personal details", message: "An unknown error with private details" } }, undefined, 502, id);
    expect(modelFailureDiagnostic(error)).toMatchObject({ requestId: id, category: "upstream", httpStatus: 502 });
    expect(JSON.stringify(modelFailureDiagnostic(error))).not.toContain("private details");
  });
  it("does not retain a key suffix disguised with a request-ID prefix", () => {
    const key = "sk-abcdef0123456789abcdef0123456789";
    const error = upstreamModelFailure({ error: { request_id: "req_abcdef0123456789abcdef0123456789" } }, { apiKey: key, messages: [] });
    expect(modelFailureDiagnostic(error)?.requestId).toBeUndefined();
  });
});
