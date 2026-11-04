import type { AssistantChatReply, AssistantStreamEvent } from "../../../../packages/contracts/src/assistant.ts";
import { SseDecoder } from "../../../../packages/contracts/src/sse.ts";

interface ResponseActivity {
  onActivity?: () => void;
  signal?: AbortSignal;
}

async function* responseChunks(response: Response, { onActivity, signal }: ResponseActivity) {
  if (!response.body) throw new Error("回答连接未建立，请重试。");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return;
      if (value.byteLength === 0) continue;
      onActivity?.();
      size += value.byteLength;
      if (size > 1_000_000) throw new Error("回答过长，请缩小问题范围后重试。");
      yield value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readAssistantResponseText(response: Response, activity: ResponseActivity): Promise<string> {
  if (!response.body) { activity.signal?.throwIfAborted(); return ""; }
  const decoder = new TextDecoder();
  let text = "";
  for await (const value of responseChunks(response, activity)) text += decoder.decode(value, { stream: true });
  return text + decoder.decode();
}

export async function readAssistantStream(response: Response, onEvent: (event: AssistantStreamEvent) => void, activity: ResponseActivity = {}): Promise<AssistantChatReply> {
  const decoder = new TextDecoder("utf-8", { fatal: true }), frames = new SseDecoder();
  for await (const value of responseChunks(response, activity)) {
    for (const data of frames.push(decoder.decode(value, { stream: true }))) {
      const event = JSON.parse(data) as AssistantStreamEvent;
      if (event.type === "delta" && typeof event.text === "string" && event.text.length <= 12000
        || event.type === "status" && ["thinking", "tool"].includes(event.phase)) {
        if (!Number.isInteger(event.round) || event.round < 1 || event.round > 4) throw new Error("回答格式异常，请重试。");
        onEvent(event);
      } else if (event.type === "error" && typeof event.message === "string" && typeof event.code === "string" && typeof event.status === "number") {
        onEvent(event);
        throw new Error(event.message);
      } else if (event.type === "done" && typeof event.result?.text === "string" && event.result.text.length <= 12000
        && typeof event.result.conversationId === "string" && Array.isArray(event.result.entries)) {
        return event.result;
      } else throw new Error("回答格式异常，请重试。");
    }
  }
  throw new Error("回答连接已中断，本次内容尚未完成，请重试。");
}
