import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { abortable, AssistantFailure, assistantLifetime } from "./assistant-lifetime.ts";
afterEach(() => vi.useRealTimers());
it("bounds a stalled dependency and removes request listeners", async () => {
  vi.useFakeTimers();
  const incoming = new EventEmitter(), outgoing = Object.assign(new EventEmitter(), { writableFinished: false });
  const lifetime = assistantLifetime({ raw: incoming, headers: {} } as FastifyRequest, { raw: outgoing } as unknown as FastifyReply, 120_000);
  const waiting = abortable(new Promise(() => {}), lifetime.signal);
  const rejected = expect(waiting).rejects.toMatchObject({ diagnostic: "AI_REQUEST_IDLE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(120_000); await rejected;
  expect(() => lifetime.check()).toThrow("没有进展");
  lifetime.dispose();
  expect(incoming.listenerCount("aborted")).toBe(0); expect(outgoing.listenerCount("close")).toBe(0);
});
it("allows progress beyond every former total deadline, then releases timers on disposal", async () => {
  vi.useFakeTimers();
  const incoming = new EventEmitter(), outgoing = Object.assign(new EventEmitter(), { writableFinished: false });
  const lifetime = assistantLifetime({ raw: incoming, headers: {} } as FastifyRequest, { raw: outgoing } as unknown as FastifyReply);
  for (let i = 0; i < 24; i++) {
    await vi.advanceTimersByTimeAsync(59_000);
    lifetime.progress();
    expect(lifetime.signal.aborted).toBe(false);
  }
  lifetime.dispose();
  lifetime.progress();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not mistake outgoing keepalives for model or dependency progress", async () => {
  vi.useFakeTimers();
  const incoming = new EventEmitter();
  const outgoing = Object.assign(new EventEmitter(), { writableFinished: false, writableLength: 0, destroyed: false,
    setHeader: vi.fn(), writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(() => true) });
  const lifetime = assistantLifetime({ raw: incoming, headers: { accept: "text/event-stream" } } as unknown as FastifyRequest,
    { raw: outgoing, getHeaders: () => ({}), hijack: vi.fn() } as unknown as FastifyReply);
  lifetime.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(outgoing.write).toHaveBeenCalledWith(": heartbeat\n\n");
  expect(lifetime.signal.reason).toMatchObject({ diagnostic: "AI_REQUEST_IDLE_TIMEOUT" });
  lifetime.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("distinguishes a completed HTTP response from a disconnected client", () => {
  const outgoing = Object.assign(new EventEmitter(), { writableFinished: true });
  const lifetime = assistantLifetime({ raw: new EventEmitter(), headers: {} } as FastifyRequest, { raw: outgoing } as unknown as FastifyReply);
  outgoing.emit("close"); expect(lifetime.signal.aborted).toBe(false);
  outgoing.writableFinished = false; outgoing.emit("close"); // once listener was consumed by the completed response
  lifetime.dispose();
  const active = assistantLifetime({ raw: new EventEmitter(), headers: {} } as FastifyRequest, { raw: outgoing } as unknown as FastifyReply);
  outgoing.emit("close"); expect(active.signal.reason.diagnostic).toBe("AI_CANCELLED"); active.dispose();
});
it("releases a backpressured output when the model fails without a socket close", async () => {
  const incoming = new EventEmitter();
  const outgoing = Object.assign(new EventEmitter(), { writableFinished: false, writableLength: 0, destroyed: false,
    setHeader: vi.fn(), writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(() => false), end: vi.fn() });
  const lifetime = assistantLifetime({ raw: incoming, headers: { accept: "text/event-stream" } } as unknown as FastifyRequest,
    { raw: outgoing, getHeaders: () => ({}), hijack: vi.fn() } as unknown as FastifyReply);
  lifetime.start();
  const output = lifetime.emit({ type: "delta", text: "片段", round: 1 });
  const rejected = expect(output).rejects.toMatchObject({ diagnostic: "AI_MODEL_IDLE_TIMEOUT" });
  expect(outgoing.listenerCount("drain")).toBe(1);
  lifetime.fail(new AssistantFailure("AI_MODEL_IDLE_TIMEOUT", "模型响应中断"));
  lifetime.dispose();
  await rejected;
  expect(outgoing.listenerCount("drain")).toBe(0);
  expect(outgoing.listenerCount("close")).toBe(0);
  expect(incoming.listenerCount("aborted")).toBe(0);
});
