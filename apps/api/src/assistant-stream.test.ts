import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { callModel, ModelStreamDecoder, type ModelInput } from "./assistant-model.ts";
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
    expect(() => new ModelStreamDecoder().push('data: {"error":{"message":"private-provider-error"}}\n\n')).toThrow("不完整");
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
function fakeJsonProvider() {
  const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "application/json" } });
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(() => { response.destroy(); }), end: vi.fn<(body?: string) => void>() });
  vi.mocked(request).mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    req.end.mockImplementation(() => callback(response));
    return req;
  }) as never);
  const input: ModelInput = { baseUrl: "https://model.example/v1", apiKey: "synthetic-private-key", model: "test", messages: [{ role: "user", content: "test" }], tools: [] };
  return { input, response, req };
}
it("preserves reasoning content in the legacy non-stream response path", async () => {
  const { input, response, req } = fakeJsonProvider();
  const result = callModel(input);
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.end(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "内部推理", tool_calls: [{ id: "call-1", type: "function", function: { name: "open_entry", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  expect(await result).toEqual({ content: null, reasoning_content: "内部推理", tool_calls: [{ id: "call-1", type: "function", function: { name: "open_entry", arguments: "{}" } }], finishReason: "tool_calls" });
  expect(JSON.parse(req.end.mock.calls[0]![0] as unknown as string)).toMatchObject({ stream: false, max_tokens: 2048 });
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
it("stops a silent provider after headers and preserves a classified timeout", async () => {
  vi.useFakeTimers();
  const { input, req } = fakeProvider();
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_MODEL_IDLE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(25_001);
  await rejected; expect(req.destroy).toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
});
it("bounds the request even if no response headers arrive", async () => {
  vi.useFakeTimers();
  const { input, req } = fakeProvider();
  vi.mocked(request).mockImplementation((() => { req.end.mockImplementation(() => {}); return req; }) as never);
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_MODEL_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(60_001);
  await rejected; expect(req.destroy).toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
});
it("rejects a provider disconnect before the terminator without retrying", async () => {
  const { input, response, req } = fakeProvider();
  const result = callModel(input);
  const rejected = expect(result).rejects.toMatchObject({ diagnostic: "AI_INVALID_RESPONSE" });
  await vi.waitFor(() => expect(req.end).toHaveBeenCalledOnce());
  response.end(frame({ content: "unfinished" }));
  await rejected; expect(request).toHaveBeenCalledOnce();
});
