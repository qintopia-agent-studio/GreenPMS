import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantChatRequest } from "../../../packages/contracts/src/assistant.ts";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

const body: AssistantChatRequest = { propertyId: "property-test", page: "today", message: "如何办理续住？" };
const result = { conversationId: "conversation-test", text: "请打开续住表单。", entries: [] };
const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`;

function streamingResponse(contentType = "text/event-stream") {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; }, cancel: cancelled
  }), { headers: { "Content-Type": contentType } });
  return { response, cancelled, write: (text: string) => source.enqueue(new TextEncoder().encode(text)), close: () => source.close() };
}

describe("assistant connection inactivity", () => {
  it("continues beyond the former total deadline while receiving heartbeat bytes", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse();
    const fetch = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    const reply = api.assistantChat(body, new AbortController().signal, onEvent);
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(100_000);
      stream.write(": heartbeat\n\n");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(onEvent).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(false);
    stream.write(frame({ type: "delta", text: result.text, round: 1 }) + frame({ type: "done", result }));
    expect(await reply).toEqual(result);
    expect(onEvent).toHaveBeenCalledWith({ type: "delta", text: result.text, round: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out while waiting for response headers without retrying", async () => {
    const { api } = await import("./api");
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const reply = api.assistantChat(body, new AbortController().signal, () => {});
    const rejected = expect(reply).rejects.toThrow("长时间未收到数据");
    await vi.advanceTimersByTimeAsync(150_000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a new inactivity window when headers arrive and cancels a stalled body", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse();
    let headers!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { headers = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const reply = api.assistantChat(body, new AbortController().signal, () => {});
    const rejected = expect(reply).rejects.toThrow("长时间未收到数据");
    await vi.advanceTimersByTimeAsync(100_000);
    headers(stream.response);
    await vi.advanceTimersByTimeAsync(149_999);
    expect(stream.cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("measures silence from the last nonempty chunk and does not count empty chunks", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const reply = api.assistantChat(body, new AbortController().signal, () => {});
    const rejected = expect(reply).rejects.toThrow("长时间未收到数据");
    await vi.advanceTimersByTimeAsync(100_000);
    stream.write(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(100_000);
    stream.write("");
    await vi.advanceTimersByTimeAsync(49_999);
    expect(stream.cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues reading a legacy JSON response while body bytes arrive", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse("application/json");
    const fetch = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    const reply = api.assistantChat(body, new AbortController().signal, onEvent);
    const json = JSON.stringify(result);
    for (const fragment of [json.slice(0, 15), json.slice(15, 30), json.slice(30)]) {
      await vi.advanceTimersByTimeAsync(100_000);
      stream.write(fragment);
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.close();
    expect(await reply).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also cancels a stalled legacy JSON body", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse("application/json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const reply = api.assistantChat(body, new AbortController().signal, () => {});
    const rejected = expect(reply).rejects.toThrow("长时间未收到数据");
    await vi.advanceTimersByTimeAsync(0);
    stream.write("{");
    await vi.advanceTimersByTimeAsync(150_000);
    await rejected;
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors manual stop immediately and removes the inactivity timer", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse();
    const fetch = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const reply = api.assistantChat(body, controller.signal, () => {});
    const rejected = expect(reply).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(stream.response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains session invalidation for a streamed 401 and cleans up the connection", async () => {
    const { api, onSessionExpired } = await import("./api");
    const stream = streamingResponse();
    const fetch = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetch);
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    const reply = api.assistantChat(body, new AbortController().signal, () => {});
    const rejected = expect(reply).rejects.toMatchObject({ status: 401, code: "SESSION_EXPIRED" });
    await vi.advanceTimersByTimeAsync(0);
    stream.write(frame({ type: "error", status: 401, code: "SESSION_EXPIRED", message: "登录已过期" }));
    await rejected;
    await expect(api.assistantChat(body, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("preserves the HTTP 401 payload even after notifying session invalidation", async () => {
    const { api, onSessionExpired } = await import("./api");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "AUTHENTICATION_REQUIRED", message: "请登录" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetch);
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    await expect(api.assistantChat(body, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 401, code: "AUTHENTICATION_REQUIRED", message: "请登录" });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("preserves an HTTP error without a response body", async () => {
    const { api } = await import("./api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(api.assistantChat(body, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 503, code: "REQUEST_FAILED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the old account's stream even when it only receives a heartbeat", async () => {
    const { api } = await import("./api");
    const stream = streamingResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "Content-Type": "application/json" } })));
    const onEvent = vi.fn();
    const reply = api.assistantChat(body, new AbortController().signal, onEvent);
    const rejected = expect(reply).rejects.toMatchObject({ status: 401, code: "SESSION_EXPIRED" });
    await vi.advanceTimersByTimeAsync(0);
    await api.login("new-account", "password");
    stream.write(": heartbeat\n\n");
    await rejected;
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("assistant provider controls", () => {
  it("keeps a streamed backup retry hint on the error and never retries automatically in the browser", async () => {
    const { api } = await import("./api");
    const fetch = vi.fn().mockResolvedValue(new Response(frame({ type: "status", phase: "fallback", round: 1 })
      + frame({ type: "error", code: "VALIDATION_ERROR", status: 400, message: "模型连接中断", backupRetryAvailable: true }), { headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    await expect(api.assistantChat(body, new AbortController().signal, onEvent)).rejects.toMatchObject({
      code: "VALIDATION_ERROR", details: { backupRetryAvailable: true }
    });
    expect(onEvent).toHaveBeenCalledWith({ type: "status", phase: "fallback", round: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves JSON retry hints and sends an explicit backup selection only when requested", async () => {
    const { api } = await import("./api");
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: "VALIDATION_ERROR", message: "主模型失败", details: { backupRetryAvailable: true } }), {
      status: 400, headers: { "Content-Type": "application/json" }
    })).mockResolvedValueOnce(new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(api.assistantChat(body, new AbortController().signal, () => {})).rejects.toMatchObject({ details: { backupRetryAvailable: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api.assistantChat({ ...body, useBackup: true }, new AbortController().signal, () => {})).resolves.toEqual(result);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("useBackup");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({ ...body, useBackup: true });
  });
  it("sends promotion and recovery as explicit versioned administrator actions", async () => {
    const { api } = await import("./api");
    const fetch = vi.fn().mockImplementation(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const action = { propertyId: "property-test", expectedVersion: 8 };
    await api.assistantPromoteBackup(action); await api.assistantRecoverPrimary(action);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/v1/assistant/promote-backup", "/api/v1/assistant/recover-primary"]);
    for (const [, init] of fetch.mock.calls) {
      expect(init.method).toBe("POST"); expect(init.credentials).toBe("include"); expect(JSON.parse(init.body)).toEqual(action);
    }
  });
});
