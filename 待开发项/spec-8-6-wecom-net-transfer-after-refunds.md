---
title: '8.6 企业微信退款后按净额升级会员'
type: 'bugfix'
created: '2026-08-28'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'b8c2141'
context:
  - '待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 在住订单只要出现退款事实，升级会员入口就永久失败关闭；即使退款后重新收到有效企业微信款，当前实际留存净额也无法转入会员订单。

**Approach:** 将资格与转入金额改为同一住宿订单有效企业微信收款减有效企业微信退款后的净额。退款不永久关闭升级；确认时只转入每笔收款尚未退款的正额余额，并保持住宿、会员资金及权益原子提交。

## Boundaries & Constraints

**Always:** 仅处理企微来源的普通住宿订单；退款减少原收款可转余额；全额退款只保留审计，不建零元事实；部分退款只转剩余额，后续企微收款正常参与；全部正额余额一次转入且总额等于订单企微净额；会员成交价不得低于转入额；Preview/Confirm 核对同一资金图，并发变化失败关闭；完成后住宿资金净额为零。

**Ask First:** 将新增迁移应用到真实 `qintopia` 数据库；扩大到现金、银行转账、其他支付方式；改变已人工确认的退款或冲销事实。

**Never:** 部分选择、虚假零元事实或重复转入；接受负净额、未知方式、跨币种、普通冲销或损坏引用；绕过数据库守恒与命令终态约束；开始 8.7。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 退款后重新收款 | 企微收款 33、退款 33、再收 33 和 300 | 可转入 333；入口启用；确认后住宿净额 0 | 任一事实并发变化则 Preview 失效 |
| 部分退款 | 企微收款 100、有效退款 40 | 仅转入 60；原收退款均可追溯 | 不允许按 100 或任意金额转入 |
| 全额退款净零 | 企微收款 100、有效退款 100 | 允许以零转入继续购买会员；不建零元转入事实 | 会员成交价仍须正额并登记真实企微差额收款 |
| 不合法资金图 | 非企微、负净额、冲销、已转移或损坏引用 | 不可升级 | 明确失败且零写入 |

</frozen-after-approval>

## Code Map

- `packages/db/src/orders.ts` -- 订单详情中的升级入口资格。
- `packages/db/src/commands/effects.ts` -- Preview 资金图校验、净额计算及并发 basis。
- `packages/db/src/commands/apply.ts` -- 原子生成住宿转出、会员转入及关联事实。
- `packages/db/src/migrations/045_stay_membership_net_wecom_transfer.sql` -- 允许按剩余额转移并验证资金守恒。
- `apps/web/src/pages/OrderDetailPage.tsx` -- 显示可转余额、总转入额和正确禁用原因。
- `tests/integration/stay-collection-membership-conversion.integration.test.ts` -- 资金、并发、回滚及可追溯性门禁。

## Tasks & Acceptance

**Execution:**
- [x] 更新实施规格、前后端净额算法与提示，确保资格和金额一致。
- [x] 新增 045 迁移，约束部分余额、净零历史资金图和最终守恒。
- [x] 将原“出现退款必须拒绝”测试改为退款后净额转换，并补齐失败与并发回归。

**Acceptance Criteria:**
- Given 104-A 的纯企微收退款历史，when 确认升级，then 原子转入 333 元且全部事实可追溯。
- Given Preview 后资金变化，when Confirm，then 返回冲突，会员订单、转入、权益和重价均无写入。
- Given 全额退款形成零净额，when 升级，then 只登记正额会员企微收款，不产生零元资金事实。
- Given 非企微、负净额、普通冲销、已转移或损坏资金，when Preview，then 失败关闭且不写入业务事实。

## Spec Change Log

- 2026-08-28：确认仅企业微信资金参与。有效企业微信收款减有效原路退款后的净额全量转入；原路退款可无独立交易单号并沿用原收款凭据。全额退款不创建零元资金事实，正式会员成交价仍须由真实正额企业微信收款完成。普通冲销、混合或损坏资金图继续失败关闭。

## Design Notes

退款不被改写。余额为零的来源不建转入桥；正额来源创建等额住宿转出、会员收款和转入桥。来源余额总和必须等于订单企微净额。

## Verification

**Commands:**
- `npm run test:integration` -- 隔离测试库中的转换、回滚、迁移和并发测试全部通过。
- `npm run test:contract` -- 命令与 API 合约通过。
- `npm test`、`npm run typecheck`、`npm run build`、`git diff --check` -- 前端计算、类型、构建与格式全部通过。

2026-08-28 自动验证完成：Unit `888/888`、TypeScript、production build、Integration `362/362`、Contract `76/76`、补丁格式均通过；新增数据库 readiness 篡改门禁 `7/7` 与历史企微退款交易号的转换失败关闭回归 `1/1` 通过。所有数据库写入测试仅使用隔离的 `qintopia_*` 测试库，未写入真实 `qintopia` 演示库。

2026-08-29 真实验收收口：真实 `qintopia` 已从 migration 044 升级到 045 且 readiness 通过。用户确认 104-A 按 `33 - 33 + 33 + 300 = 333` 的企微净额升级至“公卫四人间会员”，会员成交价 `¥936.00`、新增企微差额 `¥603.00`、住宿金额归零、30 夜核销 5 夜后剩余 25 夜，原收退款完整可追溯且无虚假 0 元事实；随后确认权益不足续住失败关闭、合法续住与缩短按 24/25 夜增减、适用床位换房保持权益、不适用房型失败关闭及普通重价/撤销入住禁用；并确认 201 的逾期在住异常在今日页和订单详情中使用统一告警语义，核对入口只导航而不自动写入。用户明确回复 `8.6 通过`；本规格完成，不开始 8.7。

## Suggested Review Order

**资金规则与 Preview 绑定**

- 从完整收退款图计算每笔剩余额，并全量绑定 Preview。
  [`effects.ts:1483`](../packages/db/src/commands/effects.ts#L1483)

- 入口使用同一净额语义，异常资金图直接失败关闭。
  [`orders.ts:1328`](../packages/db/src/orders.ts#L1328)

**原子提交与数据库守恒**

- 同一事务写入住宿转出、会员收款、合同与权益。
  [`apply.ts:1041`](../packages/db/src/commands/apply.ts#L1041)

- 仅允许类型化升级命令按退款后剩余额生成转出。
  [`045_stay_membership_net_wecom_transfer.sql:1`](../packages/db/src/migrations/045_stay_membership_net_wecom_transfer.sql#L1)

- 延迟校验完整资金图、零转入与会员实收守恒。
  [`045_stay_membership_net_wecom_transfer.sql:530`](../packages/db/src/migrations/045_stay_membership_net_wecom_transfer.sql#L530)

**操作界面**

- 界面按每笔剩余额展示转入合计和明确的禁用原因。
  [`OrderDetailPage.tsx:750`](../apps/web/src/pages/OrderDetailPage.tsx#L750)

- 升级窗口分开展示住宿转入和本次差额企微收款。
  [`OrderDetailPage.tsx:1077`](../apps/web/src/pages/OrderDetailPage.tsx#L1077)

**回归门禁**

- 全额退款净零不创建虚假零元资金事实。
  [`stay-collection-membership-conversion.integration.test.ts:2290`](../tests/integration/stay-collection-membership-conversion.integration.test.ts#L2290)

- `33-33+33+300=333` 验证退款后再收款恢复升级资格。
  [`stay-collection-membership-conversion.integration.test.ts:2360`](../tests/integration/stay-collection-membership-conversion.integration.test.ts#L2360)
