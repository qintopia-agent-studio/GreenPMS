---
title: 'QinTopia PMS 第 4 步 U2 当前页面信息减负'
type: 'feature'
created: '2026-07-28'
status: 'awaiting_user_acceptance'
baseline_commit: 'e4e777a'
rework_baseline_commit: '2b2b9d3'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
  - 'docs/architecture/invariants-and-decisions.md'
---

<frozen-after-approval reason="user approved U2 interaction and naming decisions on 2026-07-27">

## Intent

**Problem:** 订单详情把不可变事实表直接当成工作人员页面，混入英文键、内部 ID、版本号和 raw payload；房态点击后长期挤出右侧信息栏，简单入口难找，桌面导航过宽。

**Approach:** 服务端增加严格、只读、失败关闭的住宿生命周期投影；工作人员页面只显示原始安排、当前或最后安排、入住/退房结果和中文变更历史。房态点击格先出现就近快捷浮层，复杂查看和写操作进入不压缩主表的覆盖式抽屉。桌面导航收窄并可持久收起。

## Boundaries & Constraints

**Always:** 底层 `stay_segments`、`amendments`、pricing revisions、collection facts 和内部引用继续保留并可供 API/审计使用；工作人员页面统一使用中文业务名称。住宿安排只能来自服务端 typed projection，前端不得拼接 raw segment 或猜测最大 sequence。抽屉关闭后恢复触发格、选区、纵向位置、横向位置和焦点。

**Ask First:** 若只读投影无法在不改变既有命令、数据库结构或业务规则的前提下形成，立即暂停；若浮层或抽屉需要改变房态动作可用性，也暂停确认。

**Never:** 不新增或提前实现改期、续住、缩短、换房、取消、未到和资金命令；不修改这些命令的计价、库存、权益或事务规则；不重新启用清洁；不进入正式检查点 4.2、阶段 9-13、Token 或阶段 14。

## 页面机器信息清单

| 页面/区域 | 当前工作人员可见内容 | U2 处理 | 保留位置 |
|---|---|---|---|
| 订单头部 | 缺少名称时回退内部库存 ID | 失败关闭为“房源名称暂不可用”，不展示内部 ID | API 原字段 |
| 订单金额条 | `currentContractAmount`、`netRecordedCollection`、`collectionDifference` | 改为“订单金额”“已登记净收款”“待收 / 多收” | typed amount DTO |
| 住宿分段 | `INITIAL`、Segment ID、原始 segment 顺序 | 替换为服务端投影的“原始预订安排”“当前/最后/取消前/未到订单安排” | raw `segments` 仍留 API |
| 入住与退房 | 办理营业日、记录时间、操作人 | 保留；明确记录时间不是住客实际到店/离店时间 | typed fulfillment DTO |
| 变更历史 | `Amendments`、英文类型、reason code、版本号、raw payload | 替换为逐条中文安排变更；显示前后日期/房源、原因、操作人、记录时间和相关金额摘要 | raw `amendments` 仍留 API |
| 住宿人更正 | occupant/correction/subject/Amendment/Command ID | 只显示住宿人、前后资料、中文原因、操作人和记录时间 | raw correction refs 仍留 API |
| 计价记录 | revision ID、政策 ID、`CHANNEL_CONTRACT`、“渠道合同价/差” | 显示“第 N 次计价”、锁定政策业务名称或“已锁定政策”、统一“本单渠道应结金额”“与政策基础金额差额” | pricing revision 原字段 |
| 收退款表 | Fact ID、引用/冲销 ID、英文 method/status | 显示中文类型、金额、净影响、外部交易单号、方式、备注和记录时间；内部关联不直接展示 | collection fact 原字段 |
| 创建核对/结果 | “渠道合同价”“渠道合同价差”及部分英文金额键 | 统一“本单渠道应结金额”“与政策基础金额差额” | 内部 `CHANNEL_CONTRACT` 不变 |
| 房态工具栏 | `revision` | 工作人员只见数据时点、有效期和完整/不完整状态 | DTO revision 继续用于并发门禁 |
| 房态上下文 | “来源事实”“逐日事实”、interval ID、固定长右栏 | 由快捷浮层和覆盖式抽屉替代；错误仅用中文业务说明 | DTO IDs 继续用于精确路由 |
| 房态技术错误 | DTO 路径和技术协议词 | 本轮只收敛正常工作人员页面；损坏 DTO 仍失败关闭，技术错误文案的全局映射不做跨层重构 | 错误日志/后续专门收敛 |

## Frozen Interaction

1. 点击空房态格，在该格附近显示房源、日期、状态及当前允许的“创建住宿”“维修锁房”“查看房态记录”；停用清洁时不显示“房务”或清洁。
2. 点击单笔住宿格，浮层显示住客、住宿周期、状态和“查看订单”；多人间父房聚合格先显示简洁订单列表，不猜测单笔写操作。
3. 浮层不承载完整表单。查看抽屉为非模态覆盖，写抽屉阻止误触其他房态；桌面宽 `420-480px`，移动端全屏，标题和底部动作固定。
4. 桌面导航展开约 `176px`、收起约 `60px`；图标按钮带可访问名称和 Tooltip，状态跨页面持久化；手机继续使用底部导航。
5. 房态保持唯一主视图，不新增单日或渠道视图。

## Read Projection

- `originalArrangement`：CREATE_ORDER 的不可变日期和房源。
- `effectiveArrangement`：服务端沿 supersession 与有效 claim 形成的不重叠时间线；终态按订单状态命名为“最后住宿安排”“取消前安排”或“未到订单安排”。
- `fulfillment`：未入住、在住、已退房、已取消或未到；CHECK_IN/CHECK_OUT 只显示办理营业日、记录时间和操作人。
- `arrangementHistory`：初始预订、改期、续住、缩短、换房和提前退房逐条显示 before/after、原因、操作人、记录时间与可用的计价/资金摘要。
- 任一断链、重复事实、日期重叠、房源缺失或类型不认识均使订单 Query 失败关闭；Web 不回退 raw payload 猜测。

## Tasks & Acceptance

- [x] contracts/OpenAPI、PostgreSQL Query、API 和 Web 类型：增加住宿生命周期只读投影及损坏事实门禁。
- [x] 订单详情与房态订单抽屉：改用四层业务投影，移除工作人员可见机器信息并统一渠道金额文案。
- [x] 房态格快捷浮层、覆盖式查看/写抽屉：实现准确单笔、多笔父房、键盘、焦点和双轴位置恢复。
- [x] AppShell：实现 `176px/60px` 桌面导航和跨页面持久化，手机导航不变。
- [x] Unit、Integration、Contract/OpenAPI、桌面/手机 E2E：覆盖失败关闭、文案清单、典型笔记本、200% zoom、键盘和移动全屏。
- [x] 独立 U2 验收库与实例：提供真实订单、整房、分床和父房多订单样例；完成后转 `awaiting_user_acceptance` 并停止。

## Automated Gate

- PostgreSQL/contract 证明原始安排不可变、当前安排不重叠、终态标签正确、履约结果来自 typed facts，损坏链或事实零猜测并失败关闭。
- Web 与 E2E 不出现 `INITIAL`、Segment ID、Amendments、raw payload、内部版本号、“渠道合同价”或“渠道合同价差”。
- `1280x720`、`1366x768`、`1440x800` 下抽屉不改变房态主表宽度；浮层不越界；关闭后格子、选区、页面纵向位置、时间轴横向位置和焦点恢复。
- 键盘可用 Enter 打开浮层、进入抽屉，Escape 逐层关闭；200% zoom 和移动全屏无重叠或不可达动作。

## Stop Point

U2 门禁通过后启动独立实例并等待用户明确回复 `U2 通过`。未收到该口令前不进入正式检查点 4.2。

## Automated Gate Results

- TypeScript、production build 与 `git diff --check` 通过。
- Unit `408/408`、PostgreSQL Integration `183/183`、Contract/OpenAPI `58/58` 通过。
- U2、阶段 7 与阶段 8 联合桌面/手机 E2E：`27 passed / 27 expected skipped / 0 failed`。
- 独立数据库 `qintopia_u2_acceptance` 已准备；样例日期为 `2026-08-04` 至 `2026-08-09`。
- 验收实例为 `http://127.0.0.1:4231/`；账号 `operator / demo-pass-2026`。实际内置浏览器已登录验证，无跨域会话错误。

</frozen-after-approval>

## Acceptance Rework

- [x] 点击新的普通房态格时清除旧拖选区间，只保留新格快捷浮层的当前上下文。
- [x] 从单笔住宿格或父房订单列表选择准确订单时清除旧拖选区间，只高亮该订单在当前窗口内的完整 Stay。
- [x] 真实浏览器回归覆盖空格、单笔住宿格和父房多订单格，证明旧选区不会残留或在关闭上下文后恢复。
- [x] 四人间换二人间且价格产品不同却未在当前页面清楚呈现重价的问题只登记到阶段 11；U2 不修改 `MOVE_UNIT`、计价、库存或会员权益规则。

2026-07-28 人工验收发现：拖选多日区间后点击其他普通格或订单格，旧选区仍与新上下文同时高亮。U2 退回 `in_progress`，只返修选择状态互斥及其回归；其他已通过验收项保持有效。

2026-07-28 返工完成：新格单选、唯一订单完整 Stay、父房多订单后准确 Stay 三种上下文已互斥；失效锚点、物业/账号切换、投影删除住宿和抽屉重开不会恢复过期选区。双重只读审查完成，真实补丁问题均已修复；换房重价可见性只登记到阶段 11。

## Rework Gate Results

- TypeScript、production build 与 `git diff --check` 通过；Unit `410/410` 通过。
- U2 桌面/手机完整 E2E：`10 passed / 10 expected skipped / 0 failed`。
- 阶段 7 选区与抽屉回归：`4/4` 通过；整房、父房多订单、跨房 Stay 和完整订单返回均保持原语义。
- 原 U2 PostgreSQL Integration `183/183`、Contract/OpenAPI `58/58` 不受本次纯前端状态返工影响。
- 独立验收库 `qintopia_u2_acceptance` 未重置；验收实例继续使用 `http://127.0.0.1:4231/`。

## Suggested Review Order

**返工入口与状态互斥**

- 新格替换旧区间，唯一订单与抽屉上下文只保留一个高亮来源。
  [`InventoryPage.tsx:2393`](../apps/web/src/pages/InventoryPage.tsx#L2393)

- 唯一、空白、多订单和损坏引用保持严格分流。
  [`roomStatusState.ts:159`](../apps/web/src/room-status/roomStatusState.ts#L159)

- 真实浏览器覆盖空格、单笔订单、父房多订单及关闭恢复。
  [`current-page-u2.spec.ts:277`](../tests/e2e/current-page-u2.spec.ts#L277)

**权威投影与失败关闭**

- 从不可变事实形成四层住宿生命周期投影。
  [`orders.ts:676`](../packages/db/src/orders.ts#L676)

- 在共享合同中固定四层业务 DTO。
  [`index.ts:679`](../packages/contracts/src/index.ts#L679)

- 让 OpenAPI 严格描述新增只读投影。
  [`schemas.ts:1317`](../apps/api/src/schemas.ts#L1317)

- 前端拒绝断链、重叠或时间倒序 DTO。
  [`orderViewValidation.ts:390`](../apps/web/src/orderViewValidation.ts#L390)

**工作人员页面与交互**

- 订单详情只呈现中文业务层和业务金额。
  [`OrderDetailPage.tsx:282`](../apps/web/src/pages/OrderDetailPage.tsx#L282)

- 房态保存并恢复触发格、双轴和焦点。
  [`InventoryPage.tsx:2385`](../apps/web/src/pages/InventoryPage.tsx#L2385)

- 快捷浮层在触发格附近处理单笔与多笔订单。
  [`RoomStatusQuickPopover.tsx:44`](../apps/web/src/room-status/RoomStatusQuickPopover.tsx#L44)

- 共用抽屉支持查看非模态和写操作模态。
  [`ui.tsx:200`](../apps/web/src/ui.tsx#L200)

- 导航状态按账号持久化为 176px/60px。
  [`session.tsx:258`](../apps/web/src/session.tsx#L258)

**回归证据**

- 领域测试覆盖投影链和损坏事实失败关闭。
  [`orders.test.ts:201`](../packages/db/src/orders.test.ts#L201)

- 浏览器测试覆盖双轴、抽屉、移动端和缩放。
  [`current-page-u2.spec.ts:106`](../tests/e2e/current-page-u2.spec.ts#L106)
