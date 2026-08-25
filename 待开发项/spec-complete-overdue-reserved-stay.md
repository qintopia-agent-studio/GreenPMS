---
title: '已有逾期预订完成住宿'
type: 'feature'
created: '2026-08-15'
status: 'accepted'
baseline_commit: '7d13ec08f5cc42292fd02b2f47e3c136100703b8'
review_loop_iteration: 0
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 已有订单若仍为“已预订”，计划离店日已到或已过，而客人实际住过并已离店，当前只能取消或标记未到，无法如实闭环；2 栋 202 即为此例。历史待处理订单的右上角角标目前又只覆盖父房床位汇总，1 栋 105、106 这类房间订单会漏标。

**Approach:** 在原订单新增“完成住宿”，一次确认补记入住和退房，并按真实收款直接显示“已结单”或“欠款”；同时统一今天以前所有订单格的“欠款/逾期”右上角角标规则。

## Boundaries & Constraints

**Always:** 仅允许 WRITE 用户处理 `RESERVED + PLANNED + businessDate >= departureDate`，且不得已有入住/退房事实；必须确认“实际入住且已经离店”并填写说明，原因随 Preview 锁定。事务内追加迟录入住/退房：生效日分别为原到店/离店日，办理日为当前营业日；将 Order/Stay 置为 `CHECKED_OUT/COMPLETED`，按完整有效时间线核验区段和逐日 `HELD` 权益、释放全部活动 Claim，不生成清洁任务。原订单、住客、日期、合同额和计价不变。门店直收可不补收或补记不超过余额的真实收款；0 元不写事实，免费、会员、渠道不写住宿收款。直收不足显示“欠款”，足额、免费和资料完整渠道订单显示“已结单”。并发、重试和未知结果复用现有核对/恢复协议。所有 `serviceDate < businessDate` 的订单格，无论整房订单、床位订单或父房汇总，均从同一来源事实生成右上角短标签：`ARREARS -> 欠款`、逾期 `RESERVED -> 逾期`；同类去重、混合异常可并列。已结单、正常在住及已完成免费住宿不加标签；免费/会员/渠道订单若仍为逾期 `RESERVED`，同样显示“逾期”；今天及未来不套用历史角标。

**Ask First:** 实际日期不同、客人仍在住、权益/库存损坏、特殊结算订单已有住宿收款、需要改价或退款时停止并确认。

**Never:** 不创建新订单或恢复旧 `BACKFILL_COMPLETED_STAY`；不再逐步点入住/退房；不处理未来、在住或终态纠正；不伪造收款、改价或静默修数据。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 2 栋 202 | 逾期预订，¥1,232 已收足 | 原订单成为已退房、已结单 | 失败全部回滚 |
| 未收清直收 | 0/部分已收，可选补收 | 按净收款显示欠款或已结单 | 超余额/缺凭据则拒绝 |
| 免费/会员/渠道 | 合法资料或 HELD 权益 | 完成且不新增住宿收款 | 夹带收款或资料不全则拒绝 |
| 非法/并发 | 日期、状态或核对后事实不符 | 不下发动作或 Preview 失效 | 零写入；未知结果只查询 |
| 历史角标 | 105 欠款、106 欠款/逾期 | 对应历史订单格右上角显示短标签 | 不遮挡订单文字，不按房间号特判 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/index.ts`, `apps/api/src/schemas.ts` -- 命令契约。
- `packages/db/src/commands/effects.ts`, `apply.ts` -- 事务写入。
- `apps/web/src/pages/OrderDetailPage.tsx`, `apps/web/src/room-status/RoomStatusGrid.tsx` -- 操作入口与统一角标。

## Tasks & Acceptance

**Execution:**
- [x] `packages/contracts/src/index.ts`, `apps/api/src/schemas.ts`, `apps/web/src/types.ts` -- 新增 `COMPLETE_STAY`、`actualStayCompletedConfirmed`、可选收款及 OpenAPI/运行时契约。
- [x] `packages/db/src/commands/{effects,apply,service}.ts`, `packages/db/src/migrations/042_complete_overdue_reserved_stay.sql`, `packages/db/src/database.ts` -- 实现双履约、收款、时间线、权益/库存、持久证据和数据库约束；注册严格恢复与房态刷新。
- [x] `packages/db/src/{orders,room-status}.ts`, `apps/web/src/pages/OrderDetailPage.tsx`, `apps/web/src/room-status/{RoomStatusQuickPopover,RoomStatusOrderContext,RoomStatusGrid}.tsx`, `apps/web/src/room-status/room-status.css`, `apps/web/src/ui.tsx` -- 服务端下发资格；房态与详情按唯一订单展示入口；统一整房、床位、父房历史角标且不遮挡内容。
- [x] `packages/db/src/orders.test.ts`, `apps/web/src/room-status/RoomStatusGrid.test.ts`, `tests/{integration,contract,e2e}` -- 覆盖矩阵、回滚、并发、幂等恢复、投影、105/106 角标和 2 栋 202 浏览器旅程。

**Acceptance Criteria:**
- Given 2 栋 202 仍为逾期预订且已有足额收款，when 确认“完成住宿”，then 原订单直接显示已退房/已结单且没有重复收款。
- Given 1 栋 105/106 的日期早于营业日，when 房态显示欠款或逾期订单，then 对应格右上角显示“欠款/逾期”，整房与床位规则一致且不遮挡订单。
- Given 资格、并发或持久化校验失败，when 确认，then 状态、资金、权益和库存均零部分写入。

## Spec Change Log

- 2026-08-25：经人工确认，逾期是整张订单的待处理状态。只要订单开始日期早于当前营业日且仍为 `RESERVED`，右上角“逾期”角标和细红框覆盖整张订单的完整日期区间，包括跨越今天的今天及未来部分；处理完成后整段同时消失。
- 2026-08-25：完成住宿恢复查询必须保留并恢复原 `orderId`，按原命令效果哈希核对持久结果；恢复只查询已经执行的结果，不得再次补记入住、退房或收款。
- 2026-08-25：逆向审查补齐跨房源首末履约、完整生命周期、Claim 指针、特殊结算资金、渠道计价基础、非会员权益、数据库双履约链和持久回执引用保护；异常数据一律停止办理，不静默修正或结单。
- 2026-08-25：新增前向迁移 043，为已经登记旧版 042 的数据库重新部署加固函数、唯一索引和双延迟约束触发器；升级前只读核验已有 COMPLETE_STAY 事实，发现损坏则整体拒绝迁移，不自动修数据。

## Verification

**Commands:**
- `npm run typecheck && npm test` -- 类型检查通过；37 个文件、815 个单测通过。
- `npm run test:integration && npm run test:contract` -- 29 个文件、334 个集成测试及 8 个文件、75 个契约测试通过。
- `npm run build` -- 生产构建通过。
- `E2E_API_PORT=4110 E2E_WEB_PORT=4174 npm run test:e2e -- tests/e2e/complete-overdue-reserved-stay.spec.ts --project=desktop` -- 真实浏览器旅程通过。
- 演示库已从已登记旧版 042 安全升级至 `043_complete_stay_guard_hardening.sql`，`db:ready`、API `/health/ready` 及 Web 首页均通过；2 栋 202 只读核验为 1 次 COMPLETE_STAY、1 次入住、1 次退房、1 笔 ¥1,232 收款。

## Human Acceptance

- 2026-08-25：用户确认 2 栋 202 订单详情显示“已退房”、历史日历显示“已结单”，且不存在重复履约或重复收款。
- 2026-08-25：用户确认跨越今天的逾期预订在今天及未来部分继续显示右上角“逾期”和细红框。
- 2026-08-25：用户确认“无法安全保存本次操作的恢复状态”及“查询完成住宿结果”阻塞提示均已消失，本规格人工验收通过。

## Suggested Review Order

**业务资格与核对**

- 从完整生命周期、资金、权益和库存事实生成唯一可确认结果。
  [`effects.ts:2428`](../packages/db/src/commands/effects.ts#L2428)

- 资格投影与 Preview 使用相同的订单、Stay 和履约门槛。
  [`orders.ts:191`](../packages/db/src/orders.ts#L191)

**事务与持久证据**

- 一次事务写入入住、退房、结算、权益和库存释放。
  [`apply.ts:1870`](../packages/db/src/commands/apply.ts#L1870)

- 数据库延迟约束拒绝不完整或重复的双履约链。
  [`042_complete_overdue_reserved_stay.sql:134`](../packages/db/src/migrations/042_complete_overdue_reserved_stay.sql#L134)

- 已登记旧版 042 的现有数据库通过前向迁移补齐同一组保护，并在升级前拒绝损坏的历史事实。
  [`043_complete_stay_guard_hardening.sql:1`](../packages/db/src/migrations/043_complete_stay_guard_hardening.sql#L1)

- 持久事实必须与核对页完整效果摘要一致。
  [`service.ts:169`](../packages/db/src/commands/service.ts#L169)

- 库存指针损坏时回滚，不静默释放 Claim。
  [`inventory.ts:404`](../packages/db/src/inventory.ts#L404)

**恢复查询**

- 成功回执绑定订单、Stay、双履约、收款和效果哈希。
  [`ui.tsx:3804`](../apps/web/src/ui.tsx#L3804)

- 本地恢复记录必须保留唯一订单目标后才允许查询。
  [`ui.tsx:4165`](../apps/web/src/ui.tsx#L4165)

- API 结果严格要求持久资源引用和 64 位效果哈希。
  [`schemas.ts:1404`](../apps/api/src/schemas.ts#L1404)

**整单逾期提示**

- 房态投影为每个换房区段保留整单原始到店日。
  [`room-status.ts:1708`](../packages/db/src/room-status.ts#L1708)

- UI 按整单到店日判断逾期，旧载荷保持兼容回退。
  [`roomStatusPresentation.tsx:107`](../apps/web/src/room-status/roomStatusPresentation.tsx#L107)

**回归门禁**

- 事务测试覆盖跨房源、异常资金、权益、Claim 和幂等。
  [`complete-overdue-reserved-stay.integration.test.ts:283`](../tests/integration/complete-overdue-reserved-stay.integration.test.ts#L283)

- 房态测试覆盖预排换房后续区段和父房角标。
  [`room-status-projection.integration.test.ts:1213`](../tests/integration/room-status-projection.integration.test.ts#L1213)

- 浏览器旅程验证完成、刷新和唯一收款。
  [`complete-overdue-reserved-stay.spec.ts:166`](../tests/e2e/complete-overdue-reserved-stay.spec.ts#L166)
