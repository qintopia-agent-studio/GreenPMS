---
title: 'QinTopia PMS 当前版本暂停清洁任务流程'
type: 'feature'
created: '2026-07-26'
status: 'awaiting-user-acceptance'
review_loop_iteration: 1
baseline_commit: '33dc6075b0db9e7d084acc8764c49e2d355581bb'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - '待开发项/QinTopia-PMS-第4步-4.1-实施规格.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 当前版本退房生成待清洁任务；任务跨营业日后与前端当日异常任务校验冲突，整份房态 DTO 被拒绝并显示“状态未知”。

**Approach:** 用服务端单点开关暂停清洁流程。退房只更新住宿状态并释放库存；房态和订单查询不投影清洁任务；完成清洁命令失败关闭。数据库结构和既有记录原样保留，重新启用列入后续版本。

## Boundaries & Constraints

**Always:** 普通、会员、免费住宿继续遵守“已预订 → 在住 → 已退房”；退房保持原子库存释放且不重复核销权益；开关关闭时不新增、投影、展示或完成清洁任务；其他损坏 DTO 继续失败关闭。

**Ask First:** 如需改表、删除或改写历史记录、改变库存互斥/可售规则，或影响 4.2 及后续住宿命令，停止并确认。

**Never:** 不放宽历史清洁 DTO 校验；不删除清洁表、命令契约或审计；不进入 4.2；不读取旧 PMS/FewohBee；不覆盖工作树既有改动。

## I/O & Edge-Case Matrix

| 场景 | 输入/状态 | 预期 | 失败处理 |
|---|---|---|---|
| 当前版本退房 | 在住订单 | 已退房、释放库存、无清洁写入 | 非法/重复退房仍零部分写入 |
| 遗留任务 | 已有当日或历史 PENDING 记录 | 房态与订单正常且不展示任务 | 不删除或改写记录 |
| 完成清洁 | 直接调用命令 | 返回当前版本未启用 | 无 Receipt 和业务写入 |
| 跨营业日 | 前日存在遗留任务 | 次日房态正常并按库存事实可售 | 其他损坏 DTO 仍拒绝 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/index.ts` -- 当前版本清洁能力共享开关。
- `packages/db/src/commands/{effects,apply}.ts` -- 退房和完成清洁写入边界。
- `packages/db/src/{room-status,orders}.ts` -- 遗留任务查询与投影边界。
- `apps/web/src/{ui.tsx,pages/TodayPage.tsx,pages/OrderDetailPage.tsx}` -- 当前退房文案与工作人员入口。
- `tests/integration/room-status-projection.integration.test.ts`、`tests/e2e/room-status-stage8-fulfillment.spec.ts` -- 数据库和浏览器回归。
- `待开发项/*.md` -- 当前验收决策和未来版本计划。

## Tasks & Acceptance

**Execution:**
- [x] 数据库服务层 -- 让退房、查询和完成清洁一致遵守默认关闭的开关。
- [x] Web -- 清除当前旅程中的清洁入口和承诺文案，保留未来可复用类型。
- [x] 自动化 -- 验证零清洁写入、遗留任务隔离、命令拒绝和真实跨营业日页面。
- [x] 计划 -- 从 4.1 验收移出清洁任务，新增后续版本重新启用计划。

**Acceptance Criteria:**
- Given 开关关闭，when 三类住宿退房并跨到下一营业日，then 订单已退房、库存可售、房态正常且无清洁入口或状态。
- Given 遗留待清洁记录，when 查询房态或调用完成清洁，then 查询不受阻断、命令拒绝且记录不变。

## Spec Change Log

## Design Notes

单点开关避免删除模型。未来重新启用仍须重新确认清洁日期、逾期呈现、可售关系和权限，不能直接翻转开关发布。

## Verification

**Commands:**
- `npm test -- --run apps/web/src/ui.test.ts apps/web/src/pages/OrderDetailPage.test.ts apps/web/src/pages/InventoryPage.test.ts`
- `npm run test:integration -- --run tests/integration/room-status-projection.integration.test.ts`
- `npm run test:contract`
- `npm run test:e2e -- --grep "阶段 8|4.1"`
- `npm run typecheck && npm run build && git diff --check`

**Results (2026-07-26):** Unit `274/274`、Integration `174/174`、Contract `57/57`、Stage 8 E2E `4 passed / 4 expected skipped / 0 failures`、真实计价金标 `7/7`、TypeScript、production build 与 `git diff --check` 全部通过。

## Review Outcome

- Blind Review 与 Edge Case Hunter 均已完成；当前 4.1 边界内无遗留阻断项。
- 已补强旧 `COMPLETE_CLEANING` Preview 的统一拒绝和零写入保证，并覆盖当日/历史遗留任务、普通/会员/免费退房及新幂等键重试。
- 已补强免费住宿类型不可变和非企微普通订单渠道单号的数据库门禁。
- 混合版本能力协商及应用/数据库时钟统一属于后续架构工作，不扩入当前单实例 4.1 验收。

## Human Acceptance

等待用户按当前范围验收。未收到“4.1 通过”或最终“第 4 步通过”前，不标记完成、不提交 Git、不进入 4.2。

## Suggested Review Order

**发布边界**

- 单点能力开关统一定义当前版本行为。
  [`index.ts:17`](../../packages/contracts/src/index.ts#L17)

**命令与写入**

- 预检阶段拒绝清洁命令，退房 effect 不再携带清洁任务。
  [`effects.ts:686`](../../packages/db/src/commands/effects.ts#L686)

- 确认阶段先失败关闭，旧 Preview 不生成命令工件。
  [`service.ts:725`](../../packages/db/src/commands/service.ts#L725)

- 退房仍原子释放库存，仅跳过清洁任务写入。
  [`apply.ts:1047`](../../packages/db/src/commands/apply.ts#L1047)

**查询与界面**

- 房态投影从源头隔离全部遗留清洁任务。
  [`room-status.ts:1541`](../../packages/db/src/room-status.ts#L1541)

- 订单查询与页面双重隐藏遗留清洁记录。
  [`orders.ts:209`](../../packages/db/src/orders.ts#L209)

- 房态操作入口同时受共享能力开关约束。
  [`InventoryPage.tsx:2236`](../../apps/web/src/pages/InventoryPage.tsx#L2236)

**回归与计划**

- 集成金标覆盖零写入、历史保留和旧 Preview 拒绝。
  [`room-status-projection.integration.test.ts:1769`](../../tests/integration/room-status-projection.integration.test.ts#L1769)

- 真实浏览器验证跨营业日正常可售且无清洁入口。
  [`room-status-stage8-fulfillment.spec.ts:169`](../../tests/e2e/room-status-stage8-fulfillment.spec.ts#L169)

- 当前验收范围与未来重新启用计划均已固化。
  [`QinTopia-PMS-分步开发与人工验收计划.md:192`](../../待开发项/QinTopia-PMS-分步开发与人工验收计划.md#L192)
