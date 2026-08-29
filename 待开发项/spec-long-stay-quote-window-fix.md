---
title: '房态长周期报价窗口修复'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
baseline_commit: '8ee580b0d3dee7e053945eaf96f1cc87b0dcdc21'
review_loop_iteration: 0
context:
  - '待开发项/房态30天连续时间轴与超长住宿开发规格.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 房态页面只加载 30 夜，但前端把完整报价日期误要求为全部存在于这 30 夜数据中，导致所有房间和床位的 31-366 夜报价在请求服务端前就失去办理动作。

**Approach:** 将“当前窗口内的逐日可售判断”和“窗口外长住的房源级动作授权”分开；窗口外完整日期继续交由现有 Quote API 权威核价与查库存。

## Boundaries & Constraints

**Always:** 所有房间和床位接受 1-366 夜报价；窗口内已占日期继续前端失败关闭；窗口外冲突由服务端返回精确日期；长住草稿刷新后保留；动作必须启用、类型正确并精确绑定当前房源；窗口外仅放行住宿报价动作，不扩大维修锁房等其他操作范围。

**Ask First:** 若实现需要改变 366 夜上限、计价规则、库存/订单事务、数据库结构或服务端动作契约，必须先与用户确认。

**Never:** 不实现 367 夜以上报价；不扩大到无限期住宿；不增加 D01/B01 切换专项；不修改生产环境、不提交、不部署，直到人工验收通过。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 窗口外长住 | 任一房间或床位，31/117/335/356/365/366 夜 | 保留办理动作并请求服务端报价 | Quote 失败时保留草稿 |
| 超限 | 367 夜 | 不请求 Quote | 中文提示最长 366 夜 |
| 窗口内冲突 | 1-30 夜内已有占用 | 不提供报价动作 | 前端失败关闭 |
| 窗口外冲突 | 第 31 夜后已有占用 | Quote API 拒绝并指出日期 | 不创建订单、不清空草稿 |
| 恢复 | 合法 31-366 夜草稿刷新/恢复 | 选定房源和完整日期保留 | 窗口外日期不伪装为格子焦点 |

</frozen-after-approval>

## Code Map

- `../apps/web/src/pages/InventoryPage.tsx` -- 报价动作授权、日期编辑和提交前复验。
- `../apps/web/src/pages/InventoryPage.test.ts` -- 窗口内外动作授权边界单测。
- `../apps/web/src/room-status/roomStatusState.ts` -- 房态选区恢复与窗口外焦点处理。
- `../apps/web/src/room-status/roomStatusState.test.ts` -- 长草稿序列化与恢复回归。
- `../tests/e2e/room-status.spec.ts` -- 真实 UI 长周期报价及远端冲突旅程。
- `../tests/integration/long-stay-booking.integration.test.ts` -- 现有 117、366/367 与完整区间库存金标。

## Tasks & Acceptance

**Execution:**
- [x] `InventoryPage.test.ts`、`roomStatusState.test.ts` -- 先补 31-366 夜、367 夜、窗口内冲突和恢复失败测试。
- [x] `InventoryPage.tsx` -- 对窗口内选区逐日核验，对窗口外选区使用精确房源级动作授权。
- [x] `roomStatusState.ts` -- 保存并恢复合法的窗口外长住草稿，避免窗口外 grid focus。
- [x] `room-status.spec.ts` -- 固化侧边直接输入长周期、367 夜和窗口外冲突旅程。
- [x] 自动检查并启动本地 `4110/4174`，等待人工验收。

**Acceptance Criteria:**
- 任一房间或床位从侧边输入 31-366 夜后，会调用现有 Quote API 并显示完整报价。
- 367 夜继续在客户端和服务端拒绝。
- 完整区间冲突、动作撤销、权限收窄和精确房源不匹配均不产生部分写入。
- 30 夜房态窗口、计价、库存、订单确认和既有人工验收行为不变。

## Spec Change Log

- 2026-08-29: 独立复审后将 30 夜外回退严格限定为住宿报价，避免意外放开长周期维修锁房。
- 2026-08-29: 受控 E2E 发现并固化无效日期保持抽屉、无效草稿不恢复旧报价、远端冲突保留房源、日期、住客和渠道草稿。
- 2026-08-29: 用户完成人工验收并授权提交、推送与部署；本规格转为完成。

## Design Notes

`selectionActions` 对已加载窗口仍做逐日核验；当完整选区超出窗口时，仅对住宿报价动作回退到当前房源的服务端授权。它不声称窗口外可售，Quote/Confirm 仍负责完整区间与并发复验；维修锁房等非报价动作仍要求完整区间位于已加载窗口。

## Verification

**Commands:**
- `npx vitest run apps/web/src/pages/InventoryPage.test.ts apps/web/src/room-status/roomStatusState.test.ts apps/web/src/room-status/RoomStatusContext.test.tsx` -- 新旧前端边界全通过。
- `npm run test:integration -- --run tests/integration/long-stay-booking.integration.test.ts` -- 完整区间及 366/367 金标通过。
- `npm run test:contract`、`npm run typecheck`、`npm run build` -- 契约、类型和生产构建通过。
- 房态桌面 E2E -- 侧边直接输入长周期、恢复及远端冲突通过。

**Results:**
- Unit: `897/897` 通过。
- Integration: `362/362` 通过；长住专项 `4/4` 通过。
- Contract/OpenAPI: `76/76` 通过。
- TypeScript、生产构建、`git diff --check` 通过。
- 房态桌面长住 E2E: `1/1` 通过，仅重置 `qintopia_e2e`。

## Suggested Review Order

**报价授权**

- 先看窗口内逐日核验与窗口外 Quote 回退的分界。
  [`InventoryPage.tsx:2490`](../apps/web/src/pages/InventoryPage.tsx#L2490)

- 确认动作码、房源引用和 366 夜上限同时失败关闭。
  [`InventoryPage.tsx:2219`](../apps/web/src/pages/InventoryPage.tsx#L2219)

**草稿与恢复**

- 日期改动强制旧 Quote 失效，保留住客与渠道草稿。
  [`InventoryPage.tsx:1336`](../apps/web/src/pages/InventoryPage.tsx#L1336)

- 无效日期保持抽屉可修改，但不恢复旧报价授权。
  [`InventoryPage.tsx:4341`](../apps/web/src/pages/InventoryPage.tsx#L4341)

- 长住选区可恢复，窗口外日期不冒充网格焦点。
  [`roomStatusState.ts:649`](../apps/web/src/room-status/roomStatusState.ts#L649)

**回归证据**

- 单测覆盖 31–366 夜、房间/床位、冲突与动作错绑。
  [`InventoryPage.test.ts:1525`](../apps/web/src/pages/InventoryPage.test.ts#L1525)

- 恢复测试固化 366 夜与窗口外焦点语义。
  [`roomStatusState.test.ts:1057`](../apps/web/src/room-status/roomStatusState.test.ts#L1057)

- 桌面 E2E 贯穿 117/366/367 夜、远端冲突与草稿保留。
  [`room-status.spec.ts:1267`](../tests/e2e/room-status.spec.ts#L1267)
