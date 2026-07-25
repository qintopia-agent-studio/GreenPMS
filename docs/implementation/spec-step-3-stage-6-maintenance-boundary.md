---
title: 'Step 3 Stage 6 Maintenance Boundary'
type: 'feature'
created: '2026-07-24'
status: 'accepted'
baseline_commit: 'ce0091c0d27b7cff2d5df0c7f6d142ce6546dc9d'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 维修锁房是已确认能力；内部占用与免费入住的经营边界尚未确认，但旧实现已把内部占用暴露为可写 Command、房态动作和 Web 表单。

**Approach:** 保留并验证维修锁房全链路；撤销内部占用的新写入口，在数据库层拒绝新 Block/Claim。历史表和旧记录只作兼容保留，不删除、不改写、不自动释放。

## Boundaries & Constraints

**Always:** 维修锁房只接收房源、日期和原因，经 Preview/Confirm 创建 MAINTENANCE Block/Claim；释放完整区间并保留历史和审计。维修不产生住宿人、Order、Stay、报价、会员或资金事实，也不增加多人间入住比例。

**Ask First:** 定义内部占用与免费入住的经营边界、恢复内部占用写入口，或决定如何处置既有内部占用历史记录。

**Never:** 不删除或自动释放既有内部占用事实；不把免费入住改名为内部占用；不在阶段 6 实施阶段 7 的订单上下文；不进入阶段 7。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 创建维修 | 空闲房源、合法半开日期、非空原因 | 创建 MAINTENANCE 与 Claims；无订单/资金/住宿人事实 | 冲突、陈旧 Preview、越权均零业务写入 |
| 床位维修 | 分床房的具体床位 | 父房不可整售，但入住比例分子不增加 | 房间与床位双向互斥 |
| 完整释放 | 当前有效维修 Block | 精确释放全部对应 Claim；历史、Receipt、审计保留 | 部分区间或陈旧版本失败关闭 |
| 内部占用新写 | API、服务端或直接数据库尝试 | 无公开命令/动作/UI；数据库拒绝新 Block/Claim | 零内部占用业务写入 |
| 历史内部占用 | 升级前已存在记录 | 不删除、不改写、不自动释放；公共房态失败关闭 | 不提供新写或普通 UI 操作 |

</frozen-after-approval>

## Tasks & Acceptance

**Execution:**
- [x] 移除内部占用的公开 Command/OpenAPI、房态动作和 Web 入口。
- [x] 新增数据库迁移，拒绝新的 INTERNAL_USE Block/Claim，同时保留历史记录。
- [x] 保持维修锁房创建、互斥、释放、恢复、权限、幂等和审计。
- [x] 增加静态、数据库、Contract 与 E2E 回归和专用验收数据。

**Acceptance Criteria:**
- Given WRITE 工作人员选择空闲房源，when 创建维修锁房，then 页面只要求房源、日期和原因，确认后显示精简维修横条。
- Given 多人间床位维修，when 查看父房，then 入住比例不增加且整房销售仍被阻止。
- Given 完整维修区间，when 释放，then 房态恢复可售且历史仍可查。
- Given 任一公开客户端，when 查找或提交内部占用，then OpenAPI、动作和 UI 均无入口，数据库守卫拒绝绕过写入。

## Design Notes

迁移 013 的历史表和约束不回写，避免删除审计或擅自改变库存。新迁移只封闭 INSERT；旧记录的兼容读取不得重新变成可创建能力。阶段 7 已随第 3 步通过，内部占用仍保持待决。

## Verification

**Commands:**
- 阶段 6 功能已纳入阶段 7 最终全量门禁：TypeScript、Unit 262/262、Integration 169/169、Contract 57/57、Pricing facts 7/7、E2E 65 passed/0 failures、production build 与 `git diff --check` 全部通过。

**Manual checks:**
- 2026-07-25 用户明确免除阶段 6 单独人工检测；创建/释放维修、父房比例、内部占用无入口及免费入住语义保持项并入阶段 6+7 一次性人工验收。
- 2026-07-25 用户明确回复“第三步通过”；阶段 6 随合并验收标记为 accepted，内部占用继续保持 `deferred_decision`。
