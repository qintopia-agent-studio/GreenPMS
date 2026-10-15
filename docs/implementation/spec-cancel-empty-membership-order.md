---
title: 取消误建的空白会员订单
type: feature
created: 2026-10-15
status: done
route: dispatch
baseline_commit: e599a4be3b75b4039800712b82348817fbe54efd
---

<frozen-after-approval>
## Intent
用户已确认：取消重复办理的空白会员订单，保留正常订单及其收款、权益和核销记录。沿用核对、确认、审计流程。

## Boundaries & Constraints
仅 DRAFT、从未有任何收款事实、未关联合同或权益的订单可以取消；收款净额为零但存在历史事实也不允许。取消原因必填，保留订单及审计，取消后无差额提示、收款或生效操作。不修改生产数据、CI 或已有有效会员链。
权限沿用普通办卡人员的日常命令授权机制，服务端检查门店、人员命令授权与 token ceiling；不扩大已有 token ceiling。

## I/O & Edge-Case Matrix
| 场景 | 输入 | 结果 |
|---|---|---|
| 误建空白订单 | DRAFT，无收款/合同/权益，原因非空 | 仅目标单作废，显示已取消及原因，正常单不变 |
| 非空白订单 | 有任意收款事实或已生效/关联合同权益 | 拒绝且零写入 |
| 重复与并发 | 幂等重放、重复取消、与收款/生效竞争 | 同请求返回原结果；新请求拒绝或失效；不会收款后取消 |
| 非法请求 | 空白原因、跨店、无权限 | 拒绝 |
| 取消后 | 查询、再收款/生效 | 保留审计，终态不可继续操作 |
</frozen-after-approval>

## Code Map
- `packages/db/src/commands/effects.ts`、`apply.ts`：复用命令预览/确认、订单行锁、会员锁和版本重验。
- `packages/db/src/migrations/074_cancel_empty_membership_order.sql`：新增追加式取消记录；沿用 VOIDED 终态，通过记录区分已取消与既有已作废。加强同事务命令证据及空白状态约束，不改变原纠错路径。
- `packages/contracts/src/index.ts`、`packages/domain/src/command-permissions.ts`、`apps/api/src/schemas.ts`：命令、权限和严格 API 契约。
- `packages/db/src/members.ts`、`apps/web/src/types.ts`、`apps/web/src/pages/MembersPage.tsx`、`apps/web/src/ui.tsx`：取消记录、原因表单、核对和终态显示。
- `packages/contracts/src/assistant-knowledge.ts`：员工知识与依据同步。

## Tasks & Acceptance
- [x] 新增取消命令、迁移、审计和并发约束。
- [x] 实现页面取消、原因输入、确认及已取消显示；无差额、收款和生效操作。
- [x] 更新助手知识与主验收计划。
- [x] 覆盖矩阵边界，执行相关单元、数据库集成、类型与构建检查。

**Acceptance Criteria:**
- Given 同一会员有正常单及空白重复单，when 取消重复单，then 正常单的金额、日期、权益及核销记录完全保持。
- Given 已取消订单，when 查看会员详情，then 显示已取消、原因、操作者和时间，不提示欠款且没有写操作入口。

## Implementation Notes
- 需求已在本对话逐项确认，直接实施；主模型执行，不委派子代理。
- 采用 VOIDED 加独立取消审计记录，兼容现有对终态订单的业务排除规则。

## Verification
类型检查、相关单元测试、专用集成测试（包含 runtime 角色）、前端构建及页面截图。人工验收与上线另行记录。

## Review Triage Log
- 主模型复核：取消的 API 输入与输出原因长度统一为 1000，避免长原因成功写入后回执序列化失败。
- 主模型复核：补齐取消回执严格契约、Token 权限选项及数据库 readiness；以浏览器及 runtime 集成验证完整链路。未运行独立子代理审阅。
- 验证中发现既有 REPRICE_ORDER 契约测试遗漏已发布的 bookingChannelCode 字段，已补充严格字段断言（不放宽测试）。

## 验证与验收记录
- 全量单元测试 104 文件、1659 项通过。
- 会员订单原回归 5 项通过；新增取消集成 8 项通过，含 runtime、幂等、并发、跨店/只读权限、回滚及 readiness 守卫。
- OpenAPI 契约 21 项通过；命令效果 HTTP 契约 6 项通过。
- 桌面及手机端完整取消流程各 1 项通过，截图保存在忽略目录 `.local-workspace/cancel-membership-validation/`。
- 人工验收及真实助手问答待执行；生产山风的订单未修改。迁移与代码须同版本发布，已有 token ceiling 不自动扩大。

- 补充共享守卫回归：runtime 数据库角色 21 项、账号与误建会员删除契约 22 项均通过；Token ceiling 缺少取消权限时明确拒绝。
- 浏览器再次验证核对页“返回修改”保留取消原因，桌面/手机共 2 项通过。
- 工程完成；本状态不代表人工验收、真实模型问答或生产发布完成。
