import { expect, it } from "vitest";
import { readAssistantStream } from "./stream";
import type { AssistantStreamEvent } from "../../../../packages/contracts/src/assistant.ts";
const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
const result = { conversationId: "test", text: "你好", entries: [] };
it("delivers fragmented Unicode increments before the final result, ignoring heartbeats", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const received: AssistantStreamEvent[] = [];
  const finished = readAssistantStream(response, value => received.push(value));
  for (const byte of new TextEncoder().encode(": heartbeat\r\n\r\n" + event({ type: "delta", text: "你好", round: 1 }))) source.enqueue(new Uint8Array([byte]));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(received).toEqual([{ type: "delta", text: "你好", round: 1 }]);
  source.enqueue(new TextEncoder().encode(event({ type: "done", result })));
  expect(await finished).toEqual(result);
});
it("requires a final success and propagates a safe streamed failure", async () => {
  await expect(readAssistantStream(new Response(event({ type: "delta", text: "unfinished", round: 1 })), () => {})).rejects.toThrow("中断");
  const seen: AssistantStreamEvent[] = [];
  await expect(readAssistantStream(new Response(event({ type: "error", code: "VALIDATION_ERROR", status: 400, message: "模型超时" })), value => seen.push(value))).rejects.toThrow("模型超时");
  expect(seen).toHaveLength(1);
});
