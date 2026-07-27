---
title: 'QinTopia PMS 第 4 步阶段 7R 换房后 Stay 选择回归'
type: 'bugfix'
created: '2026-07-27'
status: 'awaiting_user_acceptance'
review_loop_iteration: 0
baseline_commit: 'bf1f37d'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
---

<frozen-after-approval reason="用户确认已完成范围讨论并同意继续；本文件固化阶段 7R 的独立回归边界">

## Intent

**Problem:** 阶段 7 已验收的稳定 Stay 选择必须在换房后继续成立，但现有回归只验证从原房源点击，且测试夹具会对未来订单提前入住，已被 4.1 日期门禁正确拒绝，导致真实浏览器金标无法运行。

**Approach:** 保持 `orderId/stayId`、换房命令和房态投影业务语义不变，恢复合法可运行的 Stage 7 验收数据，并补齐从换房前后任一分段进入都共同高亮同一 Stay 的双向回归。

## Boundaries & Constraints

**Always:** 点击换房前或换房后的可见住宿格，都必须打开同一权威订单上下文，并高亮当前窗口内属于同一稳定 Stay 的全部有效分段；相邻独立订单、相同昵称的其他订单和有日期间隔的新住宿不得合并；右侧继续使用服务端订单 DTO 与 `allowedActions`。

**Ask First:** 若修复必须改变 MOVE_UNIT 的领域规则、价格、库存 Claim、会员权益、订单/Stay 身份或服务端投影语义，立即停止并请求确认。

**Never:** 不实现新的换房业务，不调整换房金额；不进入 U1、U2、正式 4.2、改期、续住、缩短、取消、未到或资金规则；不读取旧 PMS/FewohBee；不覆盖或提交既有未跟踪文件。

## I/O & Edge-Case Matrix

| 场景 | 输入 / 状态 | 预期行为 | 失败处理 |
|---|---|---|---|
| 从原房源选择 | 同一 Stay 已从 B01 换至 B02 | 打开同一订单，并共同高亮 B01 与 B02 的有效日期 | 不把换房日后的 B01 误选 |
| 从新房源选择 | 点击 B02 的换房后日期 | 仍打开同一订单，并反向高亮 B01 的换房前日期 | 不丢失原分段 |
| 窗口裁剪 | 首日或末日位于当前可见范围外 | 仅高亮可见部分，订单上下文仍显示完整安排 | 不扩展查询范围或伪造格子 |
| 隔离负例 | 相邻订单或相同昵称订单 | 只选择稳定引用匹配的订单/Stay | 引用不唯一时失败关闭 |

</frozen-after-approval>

## Code Map

- `apps/web/src/room-status/roomStatusState.ts` -- 从房态 interval 解析稳定订单/Stay 身份，并判断格子是否属于已选 Stay。
- `apps/web/src/room-status/RoomStatusGrid.tsx` -- 使用 `selectedStayId` 为跨房源日期格应用共同高亮。
- `apps/web/src/pages/InventoryPage.tsx` -- 保持所选 `orderId/stayId`、加载权威订单上下文并在 revision 变化后恢复选择。
- `tests/e2e/setup-stage7-acceptance.ts` -- 创建真实 PostgreSQL 延长后换房验收数据。
- `tests/e2e/room-status-stage7-order-context.spec.ts` -- 验证双向选择、窗口裁剪和负例隔离。

## Tasks & Acceptance

**Execution:**
- [x] `tests/e2e/setup-stage7-acceptance.ts` -- 让 Stage 7 夹具遵守 4.1 未来入住门禁，使换房回归可独立重复运行。
- [x] `apps/web/src/room-status/roomStatusState.test.ts` -- 增加跨两个房源的同 Stay 与同昵称独立 Stay 隔离单元金标。
- [x] `tests/e2e/room-status-stage7-order-context.spec.ts` -- 分别从换房前、换房后分段进入，验证共同高亮、同一订单上下文和负例不合并。
- [x] 产品选择文件（仅在新增金标失败时）-- 做最小修复，不触碰换房业务规则。
- [x] 两份权威计划与本规格 -- 完成回归后转为 `awaiting_user_acceptance`，记录实例与测试结果并停止在 7R。

**Acceptance Criteria:**
- Given 同一 Stay 具有连续的换房前后分段，when 点击任一分段的任一天，then 当前窗口内两边分段共同高亮且右侧始终是同一订单。
- Given 两个订单昵称相同或日期相邻，when 选择其中一个，then 另一个不高亮、不进入当前订单上下文。
- Given 4.1 已禁止未来订单提前入住，when 准备 7R 未来预订夹具，then 不绕过日期门禁且换房选择回归仍可运行。

## Spec Change Log

- 2026-07-27：首个失败金标确认“在完整订单执行换房后返回房态会丢失原订单上下文”。修复以物业隔离的 `orderId + stayId + triggerDate` 路由身份重新解析最新住宿位置，并在当前筛选确实隐藏已移动住宿时清除失效筛选后继续恢复；一般详情返回仍保留原筛选。
- 2026-07-27：盲审与边界路径审阅补齐全分页统一 revision/营业日/权限/投影/分页元数据核对、查询超时、父房展示副本与具体床位 canonical interval 去重，以及多个 direct interval、`PARTIAL` 投影、损坏或跨物业路由状态的失败关闭。基线既有的“订单上下文保持打开时由后台 revision 迁移位置”逻辑未在 7R 跨层重构，留待独立检查点处理。
- 2026-07-27：状态转为 `awaiting_user_acceptance`。未修改 MOVE_UNIT、计价、库存 Claim、会员权益或服务端投影语义；U1/U2 与正式 4.2 均未开始。

## Verification

**Commands:**
- `npm test -- --run apps/web/src/room-status/roomStatusState.test.ts` -- 跨房源稳定 Stay 与负例隔离通过。
- `npm run test:integration -- --run tests/integration/room-status-projection.integration.test.ts` -- 真实 PostgreSQL 换房分段投影无回归。
- `npm run test:e2e -- tests/e2e/room-status-stage7-order-context.spec.ts` -- 桌面与手机真实浏览器回归通过。
- `npm run typecheck && npm run build && git diff --check` -- 类型、生产构建和补丁格式通过。

**Results (2026-07-27):**
- 房态状态单元测试 `27/27` 通过。
- PostgreSQL Integration 全量 `182/182` 通过，其中房态投影文件 `21/21` 通过。
- Stage 7 桌面/手机真实浏览器矩阵 `13 passed / 13 expected skipped / 0 failed`。
- TypeScript、production build 与 `git diff --check` 通过。
- Blind Hunter 与 Edge Case Hunter 已完成；属于 7R 的 `PARTIAL`、direct interval 歧义、跨物业/损坏 envelope、失败提示和全分页提前返回问题已修复并回归。

## Suggested Review Order

**返回恢复主流程**

- 以稳定路由身份扫描完整分页，并在事实不完整时失败关闭。
  [`InventoryPage.tsx:1862`](../apps/web/src/pages/InventoryPage.tsx#L1862)

- 从房态进入订单详情时携带物业隔离的返回身份。
  [`InventoryPage.tsx:2347`](../apps/web/src/pages/InventoryPage.tsx#L2347)

**稳定身份与歧义**

- 严格解析 envelope，并区分 canonical interval 与父房展示副本。
  [`roomStatusState.ts:146`](../apps/web/src/room-status/roomStatusState.ts#L146)

- 全局 resolver 对重复 direct interval 和多位置命中失败关闭。
  [`roomStatusState.ts:195`](../apps/web/src/room-status/roomStatusState.ts#L195)

**真实回归证据**

- 双向点击和换房后返回共同验证同一 Stay。
  [`room-status-stage7-order-context.spec.ts:228`](../tests/e2e/room-status-stage7-order-context.spec.ts#L228)

- PostgreSQL 投影证明换房前后分段保留同一 Stay 引用。
  [`room-status-projection.integration.test.ts:943`](../tests/integration/room-status-projection.integration.test.ts#L943)
