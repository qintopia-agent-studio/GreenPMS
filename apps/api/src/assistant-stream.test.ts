import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { callModel, modelFailureDiagnostic, ModelStreamDecoder, type ModelInput } from "./assistant-model.ts";
import { AssistantFailure } from "./assistant-lifetime.ts";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]) }));
vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const done = "data: [DONE]\n\n";
describe("provider stream contract", () => {
  it("assembles interleaved indexed function calls while keeping reasoning internal", () => {
    const stream = new ModelStreamDecoder();
    const wire = frame({ reasoning_content: "must not escape", tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "open_", arguments: '{"page":' } }, { index: 0, id: "a", type: "function", function: { name: "search_orders", arguments: '{"query":"' } }] })
      + frame({ tool_calls: [{ index: 0, function: { arguments: '张三"}' } }, { index: 1, function: { name: "entry", arguments: '"orders"}' } }] }, "tool_calls")
      + 'data: {"choices":[],"usage":{"total_tokens":42}}\n\n' + done;
    let visible = "";
    for (const char of wire) visible += stream.push(char);
    expect(visible).toBe("");
    expect(stream.result()).toEqual({ content: null, reasoning_content: "must not escape", tool_calls: [
      { id: "a", type: "function", function: { name: "search_orders", arguments: '{"query":"张三"}' } },
      { id: "b", type: "function", function: { name: "open_entry", arguments: '{"page":"orders"}' } }
    ], finishReason: "tool_calls" });
  });
  it("accepts fragmented CRLF frames and rejects premature EOF and filtered/limited answers", () => {
    const stream = new ModelStreamDecoder();
    const wire = (": heartbeat\n\n" + frame({ content: "你好" }) + frame({}, "stop") + done).replaceAll("\n", "\r\n");
    let visible = "";
    for (const char of wire) visible += stream.push(char);
    expect(visible).toBe("你好"); expect(stream.result().content).toBe("你好");
    for (const suffix of ["", frame({}, "stop"), done]) {
      const broken = new ModelStreamDecoder(); broken.push(frame({ content: "partial" }) + suffix);
      expect(() => broken.result()).toThrow("不完整");
    }
    for (const reason of ["length", "content_filter", "aborted", "insufficient_system_resource"]) {
      const stream = new ModelStreamDecoder();
      expect(() => stream.push(frame({}, reason))).toThrow("不完整");
      try { stream.push(frame({}, reason)); } catch (error) { expect(error).toMatchObject({ diagnostic: `AI_INVALID_RESPONSE_FINISH_${reason.toUpperCase()}` }); }
    }
  });
  it("rejects oversized text/tools, unknown tool types and upstream errors", () => {
    for (const delta of [{ content: "a".repeat(12001) }, { tool_calls: [{ index: 6 }] }, { tool_calls: [{ index: 0, type: "custom" }] }, { tool_calls: [{ index: 0, function: { arguments: "a".repeat(6001) } }] }]) {
      expect(() => new ModelStreamDecoder().push(frame(delta))).toThrow("不完整");
    }
    expect(() => new ModelStreamDecoder().push('data: {"error":{"message":"private-provider-error"}}\n\n')).toThrow("报告异常");
  });
});

function fakeProvider() {
  const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/event-stream" } });
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(() => { response.destroy(); }), end: vi.fn<(body?: string) => void>() });
  vi.mocked(request).mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    req.end.mockImplementation(() => callback(response));
    return req;
  }) as never);
  const input: ModelInput = { baseUrl: "https://model.example/v1", apiKey: "synthetic-private-key", model: "test", messages: [{ role: "user", content: "test" }], tools: [], onDelta: vi.fn(async () => {}) };
  return { input, response, req };
}
it("streams text before EOF, decodes split UTF-8, and sends one pinned HTTPS request", async () => {
  const { input, response, req } = fakeProvider();
  const result = callModel(input);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  const bytes = Buffer.from(frame({ content: "你好" }));
  for (const byte of bytes) response.write(Buffer.from([byte]));
  await vi.waitFor(() => expect(input.onDelta).toHaveBeenCalled());
  expect(vi.mocked(input.onDelta!).mock.calls.map(c => c[0]).join("")).toBe("你好");
  response.write(frame({}, "stop") + done); // provider deliberately keeps the socket open
  expect(await result).toEqual({ content: "你好", finishReason: "stop" });
  expect(response.destroyed).toBe(true);
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(req.end.mock.calls[0]![0] as unknown as string)).toMatchObject({ stream: true, max_tokens: 2048 });
  expect(vi.mocked(request).mock.calls[0]?.[1]).toMatchObject({ family: 4, lookup: expect.any(Function) });
});
it("collects the provider stream for a legacy caller without a text callback", async () => {
  const { input, response, req } = fakeProvider();
  delete input.onDelta;
  const result = callModel(input);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.write(frame({ reasoning_content: "内部推理", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "open_entry", arguments: "{}" } }] }, "tool_calls") + done);
  expect(await result).toEqual({ content: null, reasoning_content: "内部推理", tool_calls: [{ id: "call-1", type: "function", function: { name: "open_entry", arguments: "{}" } }], finishReason: "tool_calls" });
  expect(JSON.parse(req.end.mock.calls[0]![0] as unknown as string)).toMatchObject({ stream: true, max_tokens: 2048 });
});
it("cancels the HTTPS request and never retries", async () => {
  const { input, req } = fakeProvider();
  const controller = new AbortController(); input.signal = controller.signal;
  const result = callModel(input); const rejected = expect(result).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  controller.abort(new AssistantFailure("AI_CANCELLED", "cancelled"));
  await rejected;
  expect(req.destroy).toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
});
it("waits up to sixty seconds for the first effective response even after headers", async () => {
  vi.useFakeTimers();
  const { input, req } = fakeProvider();
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_MODEL_FIRST_RESPONSE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(req.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  await rejected; expect(req.destroy).toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds the request even if no response headers arrive", async () => {
  vi.useFakeTimers();
  const { input, req } = fakeProvider();
  vi.mocked(request).mockImplementation((() => { req.end.mockImplementation(() => {}); return req; }) as never);
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_MODEL_FIRST_RESPONSE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(60_001);
  await rejected; expect(req.destroy).toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
});

it("keeps an actively generating answer beyond the former model and browser deadlines", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  input.onProgress = vi.fn();
  const result = callModel(input);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(50_000);
    response.write(frame({ content: String(i) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(req.destroy).not.toHaveBeenCalled();
  }
  response.write(frame({}, "stop") + done);
  expect(await result).toEqual({ content: "012345", finishReason: "stop" });
  expect(input.onProgress).toHaveBeenCalledTimes(6);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("counts reasoning and tool fragments as progress without exposing them as text", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  input.onProgress = vi.fn();
  const result = callModel(input);
  await vi.advanceTimersByTimeAsync(0);
  for (const delta of [
    { reasoning_content: "internal thought" },
    { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "open_" } }] },
    { tool_calls: [{ index: 0, function: { name: "entry", arguments: '{"page":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"orders"}' } }] }
  ]) {
    await vi.advanceTimersByTimeAsync(50_000);
    response.write(frame(delta));
    await vi.advanceTimersByTimeAsync(0);
    expect(req.destroy).not.toHaveBeenCalled();
  }
  response.write(frame({}, "tool_calls") + done);
  expect(await result).toMatchObject({ content: null, reasoning_content: "internal thought", tool_calls: [{ id: "call-1", function: { name: "open_entry", arguments: '{"page":"orders"}' } }] });
  expect(input.onDelta).not.toHaveBeenCalled();
  expect(input.onProgress).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

const emptyFrames = ": heartbeat\n\n" + frame({ role: "assistant", content: "", reasoning_content: "", tool_calls: [{ index: 0, function: { name: "", arguments: "" } }] })
  + 'data: {"choices":[],"usage":{"total_tokens":42}}\n\n';
it("does not let heartbeats, usage or empty deltas extend the first-response deadline", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  input.onProgress = vi.fn();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_MODEL_FIRST_RESPONSE_TIMEOUT" });
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    response.write(emptyFrames);
    await vi.advanceTimersByTimeAsync(0);
  }
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  expect(input.onProgress).not.toHaveBeenCalled();
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("times out sixty seconds after the last effective delta despite continued heartbeat traffic", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_MODEL_IDLE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(40_000);
  response.write(frame({ content: "answer started" }));
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    response.write(emptyFrames);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(req.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not treat a finish-reason-only frame as the first effective model response", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  input.onProgress = vi.fn();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_MODEL_FIRST_RESPONSE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(59_000);
  response.write(frame({}, "stop"));
  await vi.advanceTimersByTimeAsync(500);
  response.write(": heartbeat\n\n");
  await vi.advanceTimersByTimeAsync(501);
  await rejected;
  expect(input.onProgress).not.toHaveBeenCalled();
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("still requires the protocol terminator and rejects a duplicate finish frame", async () => {
  vi.useFakeTimers();
  const { input, response } = fakeProvider();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_MODEL_IDLE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(0);
  response.write(frame({ content: "complete text" }, "stop"));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_001);
  await rejected;
  const stream = new ModelStreamDecoder();
  stream.push(frame({ content: "complete text" }, "stop"));
  expect(() => stream.push(frame({}, "stop"))).toThrow("不完整");
});

it("cleans up after manual cancellation during a long active response", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  const controller = new AbortController(); input.signal = controller.signal;
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_CANCELLED" });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(50_000);
    response.write(frame({ content: "still working" }));
    await vi.advanceTimersByTimeAsync(0);
  }
  controller.abort(new AssistantFailure("AI_CANCELLED", "cancelled"));
  await rejected;
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("awaits asynchronous progress checks and never emits text after access is denied", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider();
  input.onProgress = async () => { await Promise.resolve(); throw new AssistantFailure("AI_CANCELLED", "cancelled"); };
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_CANCELLED" });
  await vi.advanceTimersByTimeAsync(0);
  response.write(frame({ content: "text" }));
  await rejected;
  expect(req.destroy).toHaveBeenCalledOnce();
  expect(input.onDelta).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects a provider disconnect before the terminator without retrying", async () => {
  const { input, response, req } = fakeProvider();
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_STREAM_INCOMPLETE" });
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.end(frame({ content: "unfinished" }));
  await rejected; expect(request).toHaveBeenCalledOnce();
});

it.each(["onProgress", "onDelta"] as const)("does not attribute a failed %s application callback to the provider", async callback => {
  const { input, response, req } = fakeProvider();
  input[callback] = async () => { throw new Error("synthetic-private-database-or-client-detail"); };
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: callback === "onProgress" ? "AI_PROGRESS_FAILED" : "AI_DELIVERY_FAILED" });
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.write(frame({ content: "answer" }));
  await rejected; expect(req.destroy).toHaveBeenCalled();
});

it("classifies certificate rejection separately from retryable connection failures", async () => {
  const { input, req } = fakeProvider();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_TLS_FAILED" });
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  req.emit("error", Object.assign(new Error("synthetic-private-certificate-detail"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
  await rejected; expect(req.destroy).toHaveBeenCalled();
});

it("reports a stream error separately and stops without accepting trailing text as success", async () => {
  const { input, response, req } = fakeProvider();
  const upstreamId = "req_abcdef0123456789abcdef0123456789";
  Object.assign(response.headers, { "x-request-id": upstreamId });
  const result = callModel(input).catch(error => error as AssistantFailure);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.write(frame({ role: "assistant" }) + 'data: {"error":{"type":"upstream_error","message":"synthetic-private-key"}}\n\n'
    + frame({ content: "must not be treated as successful" }, "stop") + done);
  const error = await result as AssistantFailure;
  expect(error.diagnostic).toBe("AI_UPSTREAM_STREAM_ERROR");
  expect(modelFailureDiagnostic(error)).toMatchObject({ category: "upstream", requestId: upstreamId });
  expect(JSON.stringify([error, modelFailureDiagnostic(error)])).not.toContain(input.apiKey);
  expect(input.onDelta).not.toHaveBeenCalled();
  expect(req.destroy).toHaveBeenCalledOnce();
});

it("classifies bounded non-200 JSON errors without exposing their body or request echo", async () => {
  const { input, response, req } = fakeProvider();
  response.statusCode = 429;
  response.headers["content-type"] = "application/json";
  const result = callModel(input).catch(error => error as AssistantFailure);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.end(JSON.stringify({ error: { code: "insufficient_quota", message: input.apiKey } }));
  const error = await result as AssistantFailure;
  expect(error.diagnostic).toBe("AI_HTTP_429");
  expect(modelFailureDiagnostic(error)).toMatchObject({ category: "quota", httpStatus: 429, upstreamCode: "insufficient_quota" });
  expect(JSON.stringify([error, modelFailureDiagnostic(error)])).not.toContain(input.apiKey);
  expect(req.destroy).toHaveBeenCalledOnce();
});

it("does not wait for a stalled HTTP error body beyond two seconds", async () => {
  vi.useFakeTimers();
  const { input, response, req } = fakeProvider(); response.statusCode = 503;
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_HTTP_503" });
  await vi.advanceTimersByTimeAsync(1999); expect(req.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(req.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it("bounds HTTP error bodies and classifies non-JSON bodies without retaining them", async () => {
  const { input, response, req } = fakeProvider(); response.statusCode = 502;
  const result = callModel(input).catch(error => error as AssistantFailure);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.write("private-error-body".repeat(2000));
  const error = await result as AssistantFailure;
  expect(error.diagnostic).toBe("AI_HTTP_502");
  expect(modelFailureDiagnostic(error)).toEqual({ category: "upstream", reason: expect.any(String), httpStatus: 502 });
  expect(req.destroy).toHaveBeenCalledOnce();
});

it.each([
  ["data: {invalid}\n\n", "AI_INVALID_RESPONSE_JSON"],
  ['data: {"choices":{}}\n\n', "AI_INVALID_RESPONSE_CHOICES"],
  [frame({ tool_calls: [{ index: 7 }] }), "AI_INVALID_RESPONSE_TOOL_CALLS"],
  ["data: " + "a".repeat(256_001), "AI_INVALID_RESPONSE_SSE"],
  [frame({}, "private-unknown-finish-value"), "AI_INVALID_RESPONSE_FINISH_OTHER"]
])("classifies malformed stream metadata without logging payload (%s)", (wire, code) => {
  try { new ModelStreamDecoder().push(wire); throw new Error("expected rejection"); }
  catch (error) {
    expect(error).toMatchObject({ diagnostic: code });
    expect(modelFailureDiagnostic(error)?.category).toBe("protocol");
    expect(JSON.stringify([error, modelFailureDiagnostic(error)])).not.toContain("private-unknown-finish-value");
  }
});

it("classifies invalid UTF-8 as a protocol failure rather than a network failure", async () => {
  const { input, response, req } = fakeProvider();
  const rejected = expect(callModel(input)).rejects.toMatchObject({ diagnostic: "AI_INVALID_RESPONSE_UTF8" });
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce()); response.end(Buffer.from([0xff]));
  await rejected; expect(req.destroy).toHaveBeenCalledOnce();
});
