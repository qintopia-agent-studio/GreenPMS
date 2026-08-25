---
title: '历史补录入口写入门禁回归修复'
type: 'bugfix'
created: '2026-08-15'
status: 'done'
review_loop_iteration: 1
baseline_commit: '7d13ec08f5cc42292fd02b2f47e3c136100703b8'
context:
  - '待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md'
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 操作员拉选 1 栋 104-C 的 2026-08-11 至 2026-08-14，以及其他历史空白房位时，快捷框中没有“补录住宿”，侧边上下文误显示“服务端未为当前对象下发可执行动作”。强制刷新不能解决。

**Approach:** 保留投影新鲜度、权限和命令恢复的失败关闭边界；不再从展示投影删除服务端已授权的动作。快捷框和侧边上下文保留“补录住宿”入口；写入暂停时禁用该入口，明确显示是房态刷新、权限、恢复记录还是真正无服务端动作，并在可恢复时提供直接处理入口。

## Boundaries & Constraints

**Always:** 历史空白选区仍须由服务端 `BACKFILL_ORDER`、WRITE 权限、READY 投影、无占用和无冲突共同授权；命令恢复未收口时不得发起新写入；房态短暂过期时主动刷新。

**Never:** 不清除或绕过未收口恢复记录；不将已占用历史日期放宽为可补录；不改动 8.3 已验收的补录提交与结算规则。

</frozen-after-approval>

## Code Map

- `apps/web/src/pages/InventoryPage.tsx` -- 投影新鲜度、命令恢复门禁、快捷框与侧边上下文动作组装。
- `apps/web/src/room-status/RoomStatusQuickPopover.tsx` -- 历史选区快捷入口及暂停原因。
- `apps/web/src/room-status/RoomStatusContext.tsx` -- 侧边上下文动作与失败关闭提示。

## Tasks & Acceptance

**Execution:**
- [x] 保留服务端原始授权动作，将“是否可执行”与“是否应展示”分开。
- [x] 为恢复待查、投影过期/刷新失败、只读权限和真正无授权动作提供准确中文表达。
- [x] 快捷框、侧边上下文和 104-C 历史选区都有自动回归覆盖。
- [x] 通过类型检查、全部 Unit、关键用户旅程和 production build。

**Acceptance Criteria:**
- Given 104-C 的历史区间为空白且服务端已授权，when 拉选 2026-08-11 至 2026-08-14，then 快捷框和侧边上下文均显示“补录住宿”。
- Given 房态短暂过期，when 打开历史选区，then 页面立即刷新，刷新前不发起写入且不误称“服务端未下发”。
- Given 上一笔命令恢复未收口，when 打开历史选区，then “补录住宿”可见但禁用，且可从当前上下文进入原结果查询。
- Given 历史选区已占用或服务端未授权 `BACKFILL_ORDER`，when 打开快捷框，then 不伪造补录入口，且不发起任何写入。

## Verification

**Commands:**
- `npm run typecheck`
- `npm run test`
- `npm run build`
- 定向真实浏览器旅程：104-C 历史选区的正常、过期刷新和恢复阻断三种状态。

**Results (2026-08-15):**
- TypeScript 通过。
- Unit 通过：36 个测试文件，784/784。
- Production build 通过；仅保留既有的 Vite chunk-size 提示。
- `git diff --check` 通过。
- 真实浏览器通过：104-C 2026-08-11 至 2026-08-14 显示并进入“补录住宿”；104-D 另一历史空白格同样显示；104-B 已占用日期不显示补录入口。
- 终审加固：入口、日期编辑和最终提交均重新核对同一服务端动作；权限降级、投影撤权、新增占用及 8.3 跨营业日区间均失败关闭。

## Suggested Review Order

**授权生命周期**

- 以服务端动作绑定补录目标，并在日期变化后重新核对。
  [`InventoryPage.tsx:1888`](../apps/web/src/pages/InventoryPage.tsx#L1888)

- 最终确认前再次验证权限、占用和动作意图。
  [`InventoryPage.tsx:4146`](../apps/web/src/pages/InventoryPage.tsx#L4146)

- 权限、刷新和恢复状态分别给出准确门禁原因。
  [`InventoryPage.tsx:2093`](../apps/web/src/pages/InventoryPage.tsx#L2093)

**操作界面**

- 历史日期只替换创建动作，保留维修和订单操作。
  [`RoomStatusQuickPopover.tsx:62`](../apps/web/src/room-status/RoomStatusQuickPopover.tsx#L62)

- 侧栏同时表达暂停原因与服务端未授权。
  [`RoomStatusContext.tsx:374`](../apps/web/src/room-status/RoomStatusContext.tsx#L374)

**回归测试**

- 覆盖撤权、占用、权限降级、恢复意图及跨营业日。
  [`InventoryPage.test.ts:1150`](../apps/web/src/pages/InventoryPage.test.ts#L1150)

- 覆盖历史动作保留与禁用动作不触发写入。
  [`RoomStatusQuickPopover.test.ts:82`](../apps/web/src/room-status/RoomStatusQuickPopover.test.ts#L82)

- 覆盖侧栏门禁表达与无效日期清除旧目标。
  [`RoomStatusContext.test.tsx:54`](../apps/web/src/room-status/RoomStatusContext.test.tsx#L54)
