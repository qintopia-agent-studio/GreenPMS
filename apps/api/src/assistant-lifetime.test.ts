import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { abortable, assistantLifetime } from "./assistant-lifetime.ts";
afterEach(() => vi.useRealTimers());
it("enforces a total budget even while a dependency is pending, and removes request listeners", async () => {
  vi.useFakeTimers();
  const incoming = new EventEmitter(), outgoing = Object.assign(new EventEmitter(), { writableFinished: false });
  const lifetime = assistantLifetime({ raw: incoming, headers: {} } as FastifyRequest, { raw: outgoing } as unknown as FastifyReply, 120_000);
  const waiting = abortable(new Promise(() => {}), lifetime.signal);
  const rejected = expect(waiting).rejects.toMatchObject({ diagnostic: "AI_TOTAL_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(120_000); await rejected;
  expect(() => lifetime.check()).toThrow("超时");
  lifetime.dispose();
  expect(incoming.listenerCount("aborted")).toBe(0); expect(outgoing.listenerCount("close")).toBe(0);
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
