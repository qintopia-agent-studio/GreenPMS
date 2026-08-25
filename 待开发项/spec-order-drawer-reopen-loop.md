---
title: '房态建单抽屉反复弹出修复'
type: 'bugfix'
created: '2026-08-15'
status: 'done'
baseline_commit: '7d13ec08f5cc42292fd02b2f47e3c136100703b8'
review_loop_iteration: 0
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 操作员在房态中拉选日期段后，历史补录和未来预订的抽屉都会在自动报价产生“未收口恢复记录”时反复抢占界面；此时关闭动作又被恢复门禁直接拒绝，导致抽屉无法稳定关闭。

**Approach:** 将“禁止新写入”与“抽屉是否展开”拆成独立状态：恢复记录继续保留并阻断新写入，同一恢复 identity 只自动展示一次；同一 `SENDING` 恢复也只自动查询一次，失败后转为 `UNKNOWN` 并等待显式核对。

## Boundaries & Constraints

**Always:** 历史补录与未来预订使用同一抽屉生命周期；关闭抽屉只记录当前 identity 已展示并恢复原选区和焦点；恢复未收口时仍阻止报价、建单和补录写入；自动查询失败不清除恢复记录；新 idempotency key 可再自动提示一次；显式点击“打开处理入口”可重新打开。

**Ask First:** 若修复必须改变恢复记录的持久化格式、清理时机、幂等键语义或放宽写入门禁，必须暂停并与用户重新确认。

**Never:** 不通过清空 localStorage/sessionStorage、忽略恢复记录、自动重发命令或禁用安全门禁来消除 UI 现象；不改动 8.3 已通过的补录数据、计价、资金和订单生命周期规则。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 同标签报价中 | 选区抽屉已打开，当前报价写入 `SENDING` 恢复记录 | 抽屉保持单一实例；点击关闭后立即收起 | 恢复条仍可见，新写入仍被阻止 |
| 同 identity 刷新 | `UNKNOWN` 或 `SENDING` 状态经历房态轮询、storage/sync 事件和重渲染 | 已关闭抽屉不再自动打开 | 仅显式入口可再次打开 |
| 自动查询失败 | 同标签 `SENDING` 的首次结果查询抛错 | 同 identity 不再每 500ms 自动查询 | 保留幂等键并转 `UNKNOWN`，等待操作员核对 |
| 新恢复事件 | idempotency key 改变 | 新 identity 首次可自动打开一次 | 关闭后同样不重开 |
| 恢复已收口 | 恢复记录变为 `ABSENT` | 正常报价结果继续在当前选区展示，不闪烁、不产生第二个抽屉 | 只有权威收口结果才解除写入门禁 |

</frozen-after-approval>

## Code Map

- `apps/web/src/pages/InventoryPage.tsx` -- 报价恢复 identity、自动打开 effect、抽屉关闭/显式重开与 QuoteWorkbench 回调。
- `apps/web/src/pages/InventoryPage.test.ts` -- 恢复 identity 和自动展示决策的单元回归。
- `tests/e2e/room-status-stage-1.spec.ts` -- 持有慢速报价的真实抽屉生命周期回归。

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/pages/InventoryPage.tsx` -- 按 identity 一次性自动展示，统一选区/恢复抽屉关闭，停止 `SENDING` 查询失败循环，并避免等价 recovery target 反复写回 state。
- [x] `apps/web/src/pages/InventoryPage.test.ts` -- 覆盖同 identity 展示/自动查询各一次、dismiss 持续有效、新 identity 可重新提示和 owner 边界。
- [x] `tests/e2e/room-status-stage-1.spec.ts` -- 在历史补录与未来预订中验证：慢速报价期间关闭抽屉后，轮询/同步不重开，恢复门禁和处理入口仍存在。

**Acceptance Criteria:**
- Given 操作员已拉选历史或未来日期并进入建单抽屉，when 报价处于 `SENDING/UNKNOWN` 且操作员关闭抽屉，then 抽屉立即关闭且同 identity 不再自动打开。
- Given 未收口恢复记录仍存在，when 抽屉已被关闭，then 页面仍显示可到达的恢复入口且所有新写入继续失败关闭。
- Given 当前恢复 identity 已被 dismiss，when 操作员显式点击恢复入口，then 同一抽屉可重新打开一次，不重发报价或建单。
- Given 同标签 `SENDING` 的自动查询失败，when 页面继续渲染或房态轮询，then 不再循环查询，恢复记录变为 `UNKNOWN` 并继续阻断新写入。

## Verification

**Commands:**
- `npm run typecheck` -- TypeScript 通过。
- `npx vitest run apps/web/src/pages/InventoryPage.test.ts` -- 抽屉与恢复决策回归通过。
- `npm run test` -- 全部单元测试通过。
- `npm run build` -- 生产构建通过。
- `npm run test:e2e -- --grep "抽屉.*恢复|恢复.*抽屉"` -- 桌面端历史/未来抽屉回归通过。

## Suggested Review Order

**抽屉生命周期**

- 统一当前选区与恢复抽屉，保留稳定单实例。
  [`InventoryPage.tsx:3738`](../apps/web/src/pages/InventoryPage.tsx#L3738)

- 关闭只记录已展示 identity，不清除恢复记录。
  [`InventoryPage.tsx:4231`](../apps/web/src/pages/InventoryPage.tsx#L4231)

**恢复与门禁**

- 用稳定 identity 分离自动打开、自动核对和人工核对。
  [`InventoryPage.tsx:427`](../apps/web/src/pages/InventoryPage.tsx#L427)

- 自动核对每个 identity 只执行一次，失败后转为 UNKNOWN。
  [`InventoryPage.tsx:1457`](../apps/web/src/pages/InventoryPage.tsx#L1457)

- 跨重挂与门店切换保留 dismiss 和自动核对记忆。
  [`InventoryPage.tsx:2573`](../apps/web/src/pages/InventoryPage.tsx#L2573)

**回归覆盖**

- 单测覆盖新 identity、dismiss、UNKNOWN 和所有者边界。
  [`InventoryPage.test.ts:813`](../apps/web/src/pages/InventoryPage.test.ts#L813)

- 真实浏览器覆盖历史补录、未来预订与轮询刷新。
  [`room-status-stage-1.spec.ts:468`](../tests/e2e/room-status-stage-1.spec.ts#L468)
