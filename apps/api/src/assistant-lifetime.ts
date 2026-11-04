import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "@qintopia/contracts";
import type { AssistantStreamEvent } from "../../../packages/contracts/src/assistant.ts";

export class AssistantFailure extends DomainError {
  constructor(readonly diagnostic: string, message: string, details?: Record<string, unknown>) { super("VALIDATION_ERROR", message, 400, false, details); }
}
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export function assistantLifetime(request: FastifyRequest, reply: FastifyReply, idleTimeoutMs = 120_000) {
  const controller = new AbortController();
  const { signal } = controller;
  let streaming = false, terminal = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(new AssistantFailure("AI_CANCELLED", "本次回答已停止。")); };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", disconnect);
  const check = () => { if (signal.aborted) throw signal.reason; };
  // Bound stalled dependencies, not the age of an actively progressing answer.
  // Our own browser keepalive must never refresh this timer.
  function progress() {
    if (disposed) return;
    check();
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new AssistantFailure("AI_REQUEST_IDLE_TIMEOUT", "助手查询长时间没有进展，已停止本次请求，请稍后重试。")), idleTimeoutMs);
  }
  progress();
  function start() {
    check();
    if (!request.headers.accept?.includes("text/event-stream")) return;
    streaming = true;
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
    reply.raw.flushHeaders();
    reply.raw.write(": connected\n\n");
    heartbeat = setInterval(() => {
      if (!terminal && !signal.aborted && !reply.raw.destroyed && reply.raw.writableLength < 16_384) reply.raw.write(": heartbeat\n\n");
    }, 10_000);
  }
  async function emit(event: AssistantStreamEvent) {
    check();
    if (!streaming || terminal) return;
    if (!reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { reply.raw.off("drain", drained); signal.removeEventListener("abort", aborted); };
        const drained = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        reply.raw.once("drain", drained); signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
    check();
    if (event.type === "done") { terminal = true; reply.raw.end(); }
  }
  function fail(error: unknown) {
    if (!streaming) return false;
    if (!terminal && !reply.raw.destroyed) {
      const safe = error instanceof DomainError ? error : new AssistantFailure("AI_REQUEST_FAILED", "助手暂时无法完成回答，请稍后重试。");
      terminal = true;
      reply.raw.end(`data: ${JSON.stringify({ type: "error", code: safe.code, status: safe.statusCode, message: safe.message,
        ...(safe.details?.backupRetryAvailable === true ? { backupRetryAvailable: true } : {}) })}\n\n`);
      controller.abort(safe);
    }
    return true;
  }
  function dispose() {
    disposed = true;
    clearTimeout(idle); clearInterval(heartbeat);
    if (!signal.aborted) controller.abort(new AssistantFailure("AI_CANCELLED", "本次回答已结束。"));
    request.raw.off("aborted", disconnect); reply.raw.off("close", disconnect);
  }
  const cancel = (reason = new AssistantFailure("AI_CONFIG_CHANGED", "模型配置已变化，请新建对话后重试。")) => controller.abort(reason);
  return { signal, check, progress, start, emit, fail, dispose, cancel, get streaming() { return streaming; } };
}
