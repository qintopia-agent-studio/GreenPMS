import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountManagementActions } from "../../../packages/contracts/src/account-management.ts";
import { humanGrantableCommandTypes } from "../../../packages/domain/src/command-permissions.ts";
import { assistantOrderActions } from "../../../packages/contracts/src/assistant.ts";
import { assistantKnowledgeTopics, renderAssistantKnowledge } from "../../../packages/contracts/src/assistant-knowledge.ts";
import { assistantTools } from "./assistant.ts";
import { buildAssistantSystemPrompt } from "./assistant-prompt.ts";

const context = { today: "2026-10-06", page: "订单", paymentAllocationEnabled: true };

describe("versioned employee operating knowledge", () => {
  it("covers every human-grantable business capability, including disabled capabilities with limitations", () => {
    const covered = new Set(assistantKnowledgeTopics.flatMap(topic => topic.commands));
    expect(humanGrantableCommandTypes.filter(command => !covered.has(command))).toEqual([]);
    expect([...covered].filter(command => !(humanGrantableCommandTypes as readonly string[]).includes(command))).toEqual([]);
    expect(new Set(assistantKnowledgeTopics.flatMap(topic => topic.accountActions ?? []))).toEqual(new Set(accountManagementActions));
    expect(new Set(assistantKnowledgeTopics.map(topic => topic.id)).size).toBe(assistantKnowledgeTopics.length);
    for (const topic of assistantKnowledgeTopics) {
      expect(topic.content.trim().length, topic.id).toBeGreaterThan(80);
      expect(topic.sources.length, topic.id).toBeGreaterThan(0);
      for (const source of topic.sources) {
        expect(existsSync(fileURLToPath(new URL(`../../../${source}`, import.meta.url))), `${topic.id}: ${source}`).toBe(true);
      }
    }
  });

  // These are required evidence supplied to the model, not proof of a live model's answer quality.
  const scenarios = [
    { question: "客人付1000元，怎么分到两张或更多预订？", ids: ["payment-allocation"], facts: ["A订单分400元", "B订单选择同一流水分600元", "三个或更多订单", "逐单预览确认", "会员订单收款仍整笔独占"] },
    { question: "取消B以后是不是自动退款并能把600给C？", ids: ["cancel-no-show", "refunds"], facts: ["不会自动退款", "不会自动释放", "现金净额400元", "不能再拿600元"] },
    { question: "取消的600留到下次怎么操作？", ids: ["retained-create"], facts: ["来源订单", "登记客户留存", "联系方式/核验依据", "不是充值钱包", "不会自动转成公共余额"] },
    { question: "客户让我用留存给朋友付400，还剩多少？", ids: ["retained-use"], facts: ["目标住宿订单", "授权", "剩余200元", "不新增现金收入", "不能直接查询留存清单或实时余额"] },
    { question: "剩下200退款，误标留存如何解除？", ids: ["retained-refund-release"], facts: ["来源订单", "已成功", "不发起实际退款", "不成为公共可分配余额", "已使用部分不能直接抹掉"] },
    { question: "今天能预订为什么不能入住？", ids: ["room-status"], facts: ["不含离店日", "不代表后客现在可以入住", "先让前客正式办理退房", "不是系统预订上限"] },
    { question: "冲销后是不是就可以重新分配？", ids: ["reverse-facts"], facts: ["普通冲销不会自动释放", "不能直接撤销", "不改变实际收退款"] },
    { question: "怎么把这笔拆分资金升级成会员？", ids: ["membership-conversion"], facts: ["拆分收款或内部划转来源禁止转会员", "不是再次收款"] },
    { question: "撤销入住会恢复预订吗？", ids: ["revoke-fulfillment"], facts: ["未被实际使用", "不是恢复为原预订", "管理员受控纠错"] },
    { question: "跨房型升级会员后还能换房续住吗？", ids: ["membership-conversion"], facts: ["保留实际房间", "不是要求先换房", "跨房型升级后延长、换房和历史房间安排纠错被阻止"] },
    { question: "清洁按钮怎么用？", ids: ["maintenance"], facts: ["清洁工作流关闭", "内部占用也不是当前可办理能力"] },
    { question: "如何改房型价格、工作人员权限和外部密钥？", ids: ["catalog", "accounts-tokens"], facts: ["设置→房型与价格", "设置→账号管理", "设置→智能体与外部访问", "不能因新增功能自动给旧Token增加能力"] }
  ];
  it.each(scenarios)("supplies required evidence for: $question", ({ ids, facts }) => {
    const evidence = assistantKnowledgeTopics.filter(topic => ids.includes(topic.id)).map(topic => topic.content).join("\n");
    const prompt = buildAssistantSystemPrompt(context);
    for (const fact of facts) { expect(evidence).toContain(fact); expect(prompt).toContain(fact); }
  });

  it("includes the complete knowledge, not a keyword subset, for initial and unrelated-page questions", () => {
    for (const page of ["房态", "会员", "未知页面"]) {
      const prompt = buildAssistantSystemPrompt({ ...context, page });
      expect(prompt).toContain(renderAssistantKnowledge());
      expect(prompt).toContain("不是生产部署状态证明");
      expect(prompt).toContain("知识没有覆盖的问题明确说明不确定");
      expect(prompt).toContain("settings仅是AI助手设置");
      for (const action of assistantOrderActions) expect(prompt).toContain(action);
    }
  });

  it("uses the actual write feature flag without mistaking it for permission or deleting historical guidance", () => {
    const disabled = buildAssistantSystemPrompt({ ...context, paymentAllocationEnabled: false });
    expect(disabled).toContain("未开启；不能指导当前用户执行拆分分配或留存写入");
    expect(disabled).toContain("历史记录按页面查询");
    expect(disabled).toContain("包含已处理历史");
    expect(disabled).not.toContain("本实例收款分配与客户留存写入开关：已开启");
    expect(buildAssistantSystemPrompt(context)).toContain("已开启，但仍需核对当前门店流水来源、权限、订单资格");
  });

  it("keeps live data separate from operating instructions and does not add write or private-data tools", () => {
    const prompt = buildAssistantSystemPrompt({ ...context, orderId: "synthetic-order" });
    expect(prompt).toContain('"orderId":"synthetic-order"');
    expect(prompt).toContain("示例只解释流程，不是实际交易数据");
    expect(prompt).toContain("不能提交业务或调用不存在的工具");
    expect(assistantTools.map(tool => tool.function.name)).toEqual(["search_orders", "search_members", "availability", "order_details", "open_entry"]);
    // Explicit budget: force review before silent prompt growth or accidental source-code inclusion.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(45_000);
    expect(prompt.length).toBeLessThan(18_000);
    expect(prompt).not.toContain("docs/implementation/");
  });
});
