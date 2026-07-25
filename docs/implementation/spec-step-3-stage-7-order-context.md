---
title: 'Step 3 Stage 7 Order Context'
type: 'feature'
created: '2026-07-25'
status: 'accepted'
review_loop_iteration: 4
baseline_commit: 'ce0091c0d27b7cff2d5df0c7f6d142ce6546dc9d'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 已占房态目前仍按单格选区显示通用上下文，工作人员不能从任一住宿日稳定选中完整 Stay、查看权威订单概述或更正录错的居住人资料；窄屏固定侧栏还会挤压主表。

**Approach:** 用服务端 ORDER/STAY 稳定引用驱动跨日期、跨房源选择，加载权威订单上下文和服务端允许动作；资料更正通过追加式命令与审计事实投影，不覆盖初始快照。空间不足时把订单上下文放入可关闭并恢复焦点的抽屉。

## Boundaries & Constraints

**Always:** 父房分床聚合格不猜订单；具体床位和整房格只进入唯一稳定订单。完整 Stay 超出窗口时只高亮可见交集，但上下文展示完整日期和全部分段。更正要求原因并记录修改前后值、操作者、时间；会员主档不联动。

**Ask First:** 改变会员主档同步规则、允许删除住宿人、改变订单动作状态机，或扩大时间轴范围。

**Never:** 不按昵称、颜色或视觉相邻合并订单；不在房态或高亮条显示订单号；不直接 UPDATE/DELETE 初始住宿人事实；不提前实现阶段 8-13 的业务动作结果；不进入第 4 步。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 整房或床位住宿 | 点击任一已占日/昵称 | 高亮同一 Stay 可见分段并显示唯一订单上下文 | 稳定引用缺失或歧义时不猜测，保持失败关闭 |
| 分床父房聚合 | 同日存在一笔或多笔床位订单 | 只显示昵称和比例，不提供单笔订单入口 | 展开后逐床精确进入 |
| 续住或换房 | 同一 Stay 有多个 segment | 同一订单选择身份，分段边界仍可定位 | 不与相邻订单、间隔住宿或同昵称订单合并 |
| 资料更正 | 获权人员提交四字段完整快照与原因 | 追加 correction，订单与房态立即投影最新值 | 无原因、越权、陈旧基线或直接覆盖均零写入 |
| 窄桌面/短屏 | 主表与上下文无法同时满足最小宽度 | 使用焦点受控抽屉，关闭后恢复选区、滚动与触发焦点 | Escape 与关闭按钮行为一致 |

</frozen-after-approval>

## Code Map

- `packages/db/src/orders.ts` -- 权威订单、Stay、分段、住宿人和允许动作查询。
- `packages/db/src/commands/effects.ts` -- 更正 Preview、版本基线和权限事实。
- `packages/db/src/commands/apply.ts` -- 事务内追加更正记录并刷新房态 revision。
- `packages/db/src/room-status.ts` -- ORDER/STAY 稳定引用及最新昵称投影。
- `packages/contracts/src/index.ts` -- 更正命令与订单上下文合同。
- `apps/api/src/schemas.ts` -- OpenAPI 严格输入输出 schema。
- `apps/web/src/pages/InventoryPage.tsx` -- Stay 选择、上下文模式和返回恢复编排。
- `apps/web/src/room-status/RoomStatusGrid.tsx` -- 可见分段高亮与父房歧义边界。
- `apps/web/src/room-status/RoomStatusContext.tsx` -- 空白、Block、订单三种上下文。
- `apps/web/src/pages/OrderDetailPage.tsx` -- 同一权威详情、动作路由和更正审计展示。

## Tasks & Acceptance

**Execution:**
- [x] 新增 append-only 住宿人更正迁移、命令、合同、投影与数据库守卫。
- [x] 扩展订单详情为工作人员订单上下文，返回完整 Stay 分段、更正历史及服务端允许动作。
- [x] 以 ORDER/STAY 引用实现点击整段/跨房高亮，隐藏住宿文字横条并保留 Block 横条。
- [x] 实现订单上下文、资料更正和典型笔记本抽屉及焦点恢复。
- [x] 固定 94px 日期列，按主表实际宽度提供 7 至 21 天自动窗口及 `7 / 14 / 21` 手动档位；普通与订单上下文均可收起重开且不触发列宽变化。
- [x] 增加 Unit、PostgreSQL、Contract、E2E、响应式、键盘和隐私回归。

**Acceptance Criteria:**
- Given 整房、分床、续住、换房、相邻订单和同昵称订单夹具，when 点击已占格，then 只按稳定 Stay 引用选择正确可见分段并显示权威订单。
- Given WRITE 或 READ 主体，when 打开订单上下文，then 仅显示服务端允许动作，READ 不出现写入口，选择订单不发 Quote。
- Given 合法更正，when Confirm，then 原始住宿人行不变、追加审计可查且房态/上下文/详情一致刷新。
- Given 1280x720、1366x768、1440x800、375/320px 和 200% 缩放，when 打开关闭上下文，then 主表可用且无溢出、重叠或焦点丢失。
- Given 1440px 或 1920px 桌面，when 使用自动窗口、点击订单或切换上下文，then 日期列保持 94px，典型笔记本约显示 10 天，大屏显示更多且不超过 21 天；手动 `7 / 14 / 21` 可恢复为自动。

## Spec Change Log

- 2026-07-25：阶段 7 实施完成并通过全部自动化门禁；状态转为等待第 3 步阶段 6+7 合并人工验收。阶段 8 未开始。
- 2026-07-25：最终可视检查发现桌面非模态抽屉落在主表下方及 320px 原生滚动条造成横向溢出；已改为固定右侧抽屉并在手机全屏上下文打开时锁定页面滚动，只修复阶段 7 响应式边界。
- 2026-07-25：人工验收夹具默认平移到未来 7 天，避免“今天到店未入住”触发逾期保护而隐藏写入口；专用验收房态已核对为 `READY`，住宿人更正动作为 enabled。
- 2026-07-25：人工验收发现订单抽屉在 4 秒房态轮询时闪动并回跳顶部；修复为同一订单、同一权限范围后台刷新期间保留已授权上下文 DOM，只在新订单、权限变化或请求失败时关闭旧数据，并新增抽屉滚动位置回归。
- 2026-07-25：人工验收发现分床父房展开后，具体床位格只显示状态而未显示住客昵称；已让床位使用自身稳定住宿区间渲染准确住宿人，A 床逐日显示“山峰”、B 床逐日显示“小满”，仍分别进入各自订单。
- 2026-07-25：人工验收要求点击订单前后保持单日格尺寸，并按不同分辨率利用可用空间；日期列固定为 94px，自动窗口按房态表实际宽度适配 7 至 21 天，增加 `自动 / 7 / 14 / 21`，普通与订单上下文均可收起重开。阶段 8 未开始。
- 2026-07-25：人工验收发现 14 夜查询范围会截断 `21` 档位；新会话默认查询改为 21 夜，现有较短范围选择更长档位时自动补足结束日期，仍不扩大到阶段 14 的 90 天时间轴。
- 2026-07-25：用户明确回复“第三步通过”；阶段 7 转为 accepted，最终门禁全部通过，阶段 8 未开始。

## Design Notes

`order_occupants` 保留创建时不可变快照；每次更正保存完整 prior/corrected snapshot。查询按每位住宿人最新 correction 投影，审计仍能重建全部版本。订单动作 DTO 由服务端按订单状态和访问级别生成，前端只渲染或路由，不自行扩权。

## Verification

**Commands:**
- `npm run typecheck` -- 通过。
- `npm test` -- 19 个文件，264/264 通过。
- `npm run test:integration` -- 19 个文件，169/169 通过。
- `npm run test:contract` -- 8 个文件，57/57 通过。
- `npm run test:pricing-facts` -- 7/7 通过。
- `E2E_API_PORT=4133 E2E_WEB_PORT=4193 ROOM_STATUS_E2E_BASE_URL=http://127.0.0.1:4193 npm run test:e2e` -- 65 passed、51 configured skips、0 failures。
- `npm run build` -- production build 通过。
- `git diff --check` -- 通过。
- 抽屉修复后聚焦 E2E -- desktop 8/8、mobile 3/3 通过；几何断言覆盖抽屉视口贴合与 320px 根页面无横向溢出。
- 本机可视复查 -- 1440x900、375x812、320x700 均无内容遮挡；桌面抽屉固定右侧，手机上下文全屏可滚动且无横向滚动条。
- 独立验收实例 -- `qintopia_stage7_acceptance` 房态投影为 `READY`，WRITE 订单上下文返回已启用的 `CORRECT_ORDER_OCCUPANT`。
- 抽屉后台刷新回归 -- 聚焦 desktop E2E 1/1 通过；本机浏览器将 `1栋 104` 订单抽屉滚至 `scrollTop=950` 后连续观察 13 秒，三个轮询周期内位置保持不变、未出现加载态且订单入口持续可见。
- 分床昵称回归 -- 聚焦 desktop E2E 1/1 通过；五个住宿日逐格断言 A 床仅显示“山峰”、B 床仅显示“小满”，本机验收实例同步完成可视复查。
- 自适应日期窗口回归 -- 阶段 7 专用 E2E desktop 9/9、mobile 3/3 通过；覆盖 1280/1366/1440、1920、固定 94px 日期列、14 夜查询选择 `21` 后补足范围、普通/订单上下文收起重开、Escape 焦点恢复、`7 / 14 / 21 / 自动` 切换及详情返回恢复。

## Suggested Review Order

**选择与订单上下文**

- 稳定 Order/Stay 身份统一驱动可见区间选择、抽屉与返回恢复。
  [`InventoryPage.tsx:1899`](../../apps/web/src/pages/InventoryPage.tsx#L1899)

- 工作人员上下文只呈现权威住宿、允许动作与资料更正入口。
  [`RoomStatusOrderContext.tsx:116`](../../apps/web/src/room-status/RoomStatusOrderContext.tsx#L116)

- 服务端聚合完整 Stay、住宿人、更正历史与权限动作。
  [`orders.ts:169`](../../packages/db/src/orders.ts#L169)

**追加式资料更正**

- Preview 冻结旧快照并拒绝陈旧、无变化或非法输入。
  [`effects.ts:877`](../../packages/db/src/commands/effects.ts#L877)

- Confirm 只追加更正和审计事实，不覆盖初始住宿人。
  [`apply.ts:783`](../../packages/db/src/commands/apply.ts#L783)

- 房态投影读取每位住宿人的最新更正昵称。
  [`room-status.ts:130`](../../packages/db/src/room-status.ts#L130)

**回归门禁**

- 浏览器旅程覆盖整房、分床、换房、权限、更正和响应式布局。
  [`room-status-stage7-order-context.spec.ts:142`](../../tests/e2e/room-status-stage7-order-context.spec.ts#L142)

- PostgreSQL 测试锁定不可变快照、并发与会员主档隔离。
  [`order-occupant-corrections.integration.test.ts:85`](../../tests/integration/order-occupant-corrections.integration.test.ts#L85)
