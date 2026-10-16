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
    { question: "F栋宿舍象征性收费还计入经营入住率吗？", ids: ["dashboard", "catalog"], facts: ["计入经营住宿统计", "跨房住宿按实际房间和日期分段", "房态、订单与真实收退款仍保留", "现有经营销售额不随住宿统计开关删减"] },
    { question: "房态慢、翻上个月一直刷新怎么办？", ids: ["room-status"], facts: ["后台约15秒", "不会无限自动重试", "可以返回今天", "办理仍需服务端重新核对", "结果未知应查询原回执"] },
    { question: "企微补录本单387.5能填吗，实收能选为什么本单不行？", ids: ["booking", "pricing"], facts: ["包括企微直订及住宿补录", "387.50元", "本单金额与实际收款是两个字段", "不要取整或改渠道绕过", "政策基础价仍按原规则计算"] },
    { question: "企微已收到1000元，只匹配300元，算哪天多少收入？", ids: ["operating-sales"], facts: ["本次实际匹配份额", "匹配完成的PMS日期", "只收到钱不计住宿销售额", "不能重复认定历史已计收入"] },
    { question: "售卡收款后用会员入住，原住宿款转会员还会再算吗？", ids: ["operating-sales"], facts: ["会员真实收款成功登记到会员订单时", "不等待入住核销或权益生效", "权益入住和住宿收款转会员不再加一次", "只新增真实补款"] },
    { question: "渠道订单取消为0元了，平台退款在哪登记？", ids: ["refunds"], facts: ["原订单的退款入口", "本次应结减少金额", "即使订单取消后合同为0", "仍可登记退款", "不发起平台退款", "已封账月份不能重复补登记"] },
    { question: "游牧岛应结277.20元能录角分吗，已退房录错了怎么办？", ids: ["booking", "pricing"], facts: ["277.20", "最多两位小数", "已退房", "保留原值", "不改变退房与库存", "不等于办理收款或退款"] },
    { question: "逐日人数和统计依据在哪里，需要点开吗？", ids: ["dashboard"], facts: ["逐日人数与统计依据", "始终展开显示", "长表保留滚动查看", "免费分类的展开/收起切换仍保留"] },
    { question: "当前在住和所选期间全部是什么意思，怎么返回？", ids: ["dashboard"], facts: ["当前在住", "所选期间全部", "按人", "按人次", "不随顶部历史日期变化", "所选期间实际住过的全部连续住宿", "仍在住或已离店", "完整夜数", "同一人离店后再来分别计次", "返回居住概览"] },
    { question: "所选日期不包含今天怎么办，后来才离店的是否纳入？", ids: ["dashboard"], facts: ["统计截止日取所选结束日与今天中较早的一天", "不把截止日之后的实际住宿倒灌历史", "期间首日已离店的不纳入", "截止日当天入住计0晚", "纯未来区间没有已发生住宿", "不含仅预订未入住", "历史期间全部不一定包含今天才入住的人"] },
    { question: "回头客能用昵称匹配吗，卡片里的2条是2个人吗？", ids: ["dashboard"], facts: ["昵称优先、姓名辅助做模糊匹配", "无需补证件或逐条人工核对", "不是去重后的回头客人数", "同一人回来两次计两条", "人数见详情", "再次入住日期落在所选期间才纳入", "仅预订未入住不算回访"] },
    { question: "不填证件号就不统计时长、还要员工逐条核对吗？", ids: ["dashboard"], facts: ["已有住客登记ID和完整有效住宿时间线自动计算", "不要求补录证件号", "不增加逐条人工核对步骤", "原单续住和换房", "昵称优先、姓名辅助做模糊匹配", "昵称姓名近似统计"] },
    { question: "住宿时长怎么分档，40晚属于哪一档，两种口径是否一致？", ids: ["dashboard"], facts: ["两者统一为六档", "不足1周（≤6晚）", "1–2周（7–13晚）", "2–3周（14–20晚）", "3周至1个月（21–30晚）", "1–2个月（31–60晚）", "超过2个月（≥61晚）", "月按固定30晚划分", "不改变实际夜数", "不计未来预订夜"] },
    { question: "当前欠款和留存在哪里，历史日期会改变它们吗，资金页签排在哪里？", ids: ["dashboard"], facts: ["当前现场", "住宿欠款余额及客户留存待用", "均不随历史日期变化", "不在历史概览重复显示", "资金与欠款（默认）、未来已订、楼栋与房型", "查看免费占用明细"] },
    { question: "共居看板怎么查看续住和天数，分类有冲突是不是总人数也未知？", ids: ["dashboard"], facts: ["共居经营看板", "当前在住", "所选期间全部", "“返回居住概览”按钮", "分类冲突不抹掉已知总人数", "撤销登记不等于真实离店", "只排除该天未知住宿量", "记录计数不等同去重人数", "不把提前晚数当损失收入"] },
    { question: "在哪里看经营，收款是不是收入，能直接告诉我实时入住率吗？", ids: ["dashboard"], facts: ["/dashboard", "门店READ权限", "最多366天", "不筛门店资金", "按PMS登记时间", "非银行到账", "旧错误会员收款冲销计更正", "没有经营概览实时统计查询工具", "未知来源进入待核对", "不含离店日"] },
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


it("当前人数与今日经营指标提供正确的范围和金额口径", () => {
 const topic=assistantKnowledgeTopics.find(topic=>topic.id==="dashboard")!;
 for(const text of ["今日入住", "今日新增订单", "今日登记收款", "含补录", "未扣退款", "不将渠道应结金额当作已收款", "组成明细"]) expect(topic.content).toContain(text);
});

it("explains cancellation of an empty duplicate membership without deleting the active membership", () => {
  const topic = assistantKnowledgeTopics.find(topic => topic.id === "membership-sale")!;
  expect(topic.commands).toContain("CANCEL_MEMBERSHIP_ORDER");
  for (const rule of ["从未有任何收款记录", "收款已冲销为零也不属于空白订单", "不影响其他正常订单及核销", "不能用删除会员"]) expect(topic.content).toContain(rule);
  expect(buildAssistantSystemPrompt(context)).toContain("取消订单");
});
