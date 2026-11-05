import { describe, expect, it } from "vitest";
import { assistantKnowledgeTopics } from "../../../packages/contracts/src/assistant-knowledge.ts";
import { buildAssistantSystemPrompt } from "./assistant-prompt.ts";

describe("历史住宿统计的既有员工知识", () => {
  it.each([
    {
      question: "历史人数和入住率能把尚未入住的预订算进去吗？",
      ids: ["dashboard", "check-in-out"],
      facts: ["正常应收费已履约住宿", "预订不等于已入住", "不含离店日"]
    },
    {
      question: "实际住过但忘记录了，能为了对齐人数直接再建一单吗？",
      ids: ["historical-corrections"],
      facts: ["补录用于补进真实漏记业务", "不是改写已有订单", "录入真实历史日期",
        "错误预订的完成住宿需填写真实依据、核对完整履约与权益影响", "不能对所有历史订单普遍补办入住/退房"]
    }
  ])("为员工问题提供已确认依据：$question", ({ ids, facts }) => {
    const knowledge = assistantKnowledgeTopics.filter(topic => ids.includes(topic.id)).map(topic => topic.content).join("\n");
    for (const page of ["房态", "经营概览"]) {
      const prompt = buildAssistantSystemPrompt({ today: "2026-11-05", page, paymentAllocationEnabled: false });
      for (const fact of facts) {
        expect(knowledge).toContain(fact);
        expect(prompt).toContain(fact);
      }
      expect(prompt).toContain("最多20条订单不是全店统计");
      expect(prompt).toContain("不是当前用户权限、当前订单状态或实时余额");
    }
  });
});
