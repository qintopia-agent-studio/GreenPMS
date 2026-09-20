import type { AssistantChatReply, AssistantStreamEvent } from "../../../../packages/contracts/src/assistant.ts";
import { SseDecoder } from "../../../../packages/contracts/src/sse.ts";

export async function readAssistantStream(response: Response, onEvent: (event: AssistantStreamEvent) => void): Promise<AssistantChatReply> {
  if (!response.body) throw new Error("回答连接未建立，请重试。");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }), frames = new SseDecoder();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("回答连接已中断，本次内容尚未完成，请重试。");
      size += value.byteLength;
      if (size > 1_000_000) throw new Error("回答过长，请缩小问题范围后重试。");
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
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
