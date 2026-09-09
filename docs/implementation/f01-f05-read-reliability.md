# F01–F05 读取可靠性修复

2026-09-08，依据用户本次明确要求及 2026-09-06 用户旅程审计实施。工程与自动验证状态在交付时记录；人工验收另行记录，不由自动测试代替。

- F01：同一订单/门店/身份只安排一个轮询请求，完成后四秒再读；显式刷新合并，离开或切换作用域取消旧读，二十秒超时。迟到读不能覆盖提交后已取得的更高订单版本。
- F03：当前有效会话的后台普通读失败保留已显示内容、表单与焦点，暂时阻断新的编辑提交。恢复为同一权威数据时保持草稿；权威数据变化沿用既有关闭旧编辑、重新核对规则。401/403/404（包括防枚举的范围拒绝）和订单/门店/身份/授权切换隔离旧编辑。命令确认继续由原协议复核版本。
- F05：统一业务请求 401 使工作区卸载并展示重新登录；403 权限不足与普通读失败分别展示。旧会话迟到响应不能污染新登录；已发送而结果不确定的命令保留主体/门店作用域的原恢复身份，新登录按当前授权查询原结果，不能新建幂等键重复确认。
- F04：订单列表与详情新增 `current_primary_guest`，使用与 `occupants` 相同的最新更正投影，列表搜索和今日任务消费该字段。原始 `primary_guest_snapshot`、住宿人行、更正历史和会员主档保持原样。列表在同一 repeatable-read 快照读取订单与当前住客。无需数据库迁移。
- F02：服务端五秒 `asOf/freshUntil`、客户端时钟保守换算、原三秒安装余量/四秒恢复余量/750ms 写入余量保持不变。这些余量约束的是**开放新写入**，不再作为丢弃已验证、同授权作用域读取内容的条件。慢成功响应允许展示，标明服务端数据时间及写入暂停原因；未取得安全余量不能新开写入。慢响应续期继续去重、退避，连续三次不足后显示人工重试入口，已有内容继续可查看。普通刷新失败保留原显示，权限拒绝清除显示。提交后慢读同样可安装为只读，不把业务已提交误认为失败。原 Preview/Confirm 的新鲜度、权限、版本、库存锁、会员权益、资金与事务复核不变。

以上是对既有房态稳定性实施规格 §2.1 的展示行为补充，不延长 TTL，不放宽写入或未知结果恢复门禁。没有授权生产操作、推送或部署。

自动验证结果见下方交付记录；人工验收仍为待验收。

## 文件与验证范围

| 项目 | 实现文件（项目相对路径） | 行为证据 |
| --- | --- | --- |
| F01 | `apps/web/src/readPoller.ts`、`apps/web/src/pages/OrderDetailPage.tsx`、`apps/web/src/api.ts` | `readPoller.test.ts` 验证单请求、刷新合并、取消、迟到结果与超时；`read-resilience.spec.ts` 验证 2/4.5/8 秒成功详情及无重叠轮询。 |
| F03 | `apps/web/src/pages/OrderDetailPage.tsx`、`apps/web/src/components/{MoveUnitDrawer,StayDateChangeDrawer}.tsx`、`apps/web/src/ui.tsx` | `read-resilience.spec.ts` 验证 503/超时/恢复/版本变化/403/404、草稿与键盘焦点；`stage15-complete-journeys.spec.ts` 在真实退款、日期调整和换房旅程注入 503，验证保留字段及焦点、暂停提交、恢复后正常确认。 |
| F05 | `apps/web/src/api.ts`、`apps/web/src/App.tsx`、`apps/web/src/session.tsx`、`apps/web/src/ui.tsx` | `api.session.test.ts` 验证全局 401、迟到会话响应、403/503 区分；`read-resilience.spec.ts` 验证重新登录、当前权限和原幂等键未知结果恢复。 |
| F04 | `packages/db/src/current-order-guests.ts`、`packages/db/src/orders.ts`、`packages/db/src/index.ts`、`apps/api/src/server.ts`、`apps/api/src/schemas.ts`、`apps/web/src/types.ts`、`apps/web/src/orderViewValidation.ts`、`apps/web/src/pages/{OrderDetailPage,OrdersPage,TodayPage}.tsx` | 更正集成测试验证两次更正、原始行/快照、当前投影、审计和会员主档；跨入口浏览器测试验证昵称/姓名/手机号搜索及今日任务。今日任务用已更正订单的只读在住展示样例，不改变住宿生命周期事实。 |
| F02 | `apps/web/src/pages/InventoryPage.tsx` | `InventoryPage.test.ts` 验证原新鲜度边界；`read-resilience.spec.ts` 覆盖 2.1/8 秒、三次后停止、失败/恢复及权限拒绝；既有房态 E2E 覆盖时钟偏差、三个新鲜度窗口、旧范围重试取消、真实 403 和 WRITE→READ；服务端集成覆盖过期 Preview 零写入、并发占房与权限。 |

配套测试修改还包括 `apps/api/src/schemas.test.ts`、`apps/web/src/ui.test.ts`、`apps/web/src/pages/InventoryPage.test.ts`、`tests/e2e/room-status.spec.ts`、`tests/integration/order-occupant-corrections.integration.test.ts`。新增测试为 `readPoller.test.ts`、`api.session.test.ts` 和 `tests/e2e/read-resilience.spec.ts`。

## 接口、数据与安全边界

- 无新增数据库迁移，不修改服务端房态 TTL、写命令处理器或库存/资金/权益计算。
- 订单列表行与详情 `order` 对象增加只读 `current_primary_guest`；原 `primary_guest_snapshot` 字段保持不可变，客户端兼容缺少新增字段的旧投影。当前字段与主要住宿人不一致时详情契约校验拒绝安装。
- 房态慢成功只获得查看资格；原新写入门禁、当前命令确认校验、版本/权限/库存事务锁和未知结果恢复机制保留。持续慢网络下写入会继续暂停，这是本切片保留的安全行为。
- 普通读失败不会持久化草稿到其他身份；当前会话草稿保留在原表单中。版本变化关闭旧编辑并要求重开核对；身份、门店、订单和授权变化隔离旧编辑。
- 既有工作区改动保留；未运行 `runtime-audit.mjs`，未提交、推送或部署，测试仅使用独立合成数据库。

## 人工验收

状态：待验收，未标记通过。操作步骤以 [分步开发与人工验收计划：追加 F01–F05](../../待开发项/QinTopia-PMS-分步开发与人工验收计划.md#追加f01f05-读取可靠性与会话恢复2026-09-08) 为准。自动验证只证明工程行为；仍需前台人员确认桌面/手机提示可理解、编辑恢复符合操作习惯，以及重新登录和原结果查询路径可用。

## 自动验证交付记录（2026-09-08）

| 检查 | 结果 |
| --- | --- |
| `npm run verify`（TypeScript + 单元测试） | 50 个测试文件、1,116 项全部通过。包含轮询、会话、房态、订单、表单、命令恢复及接口 schema 验证。 |
| OpenAPI、房态、安全、命令效果契约 | 4 个文件、57 项通过。 |
| 命令协议、权限矩阵、数据库不变量、房态投影集成 | 4 个文件、100 项通过；覆盖并发占房、过期 Preview、权限与事务保护。 |
| `order-occupant-corrections.integration.test.ts` | 4 项通过；确认最新更正投影、不可变原始资料、审计历史和会员主档。 |
| `stage15-complete-journeys.spec.ts` + `current-page-u2.spec.ts` + `read-resilience.spec.ts` | 41 项通过，15 项按设备限定跳过；含桌面/手机、键盘焦点、弹层/滚动、200% 桌面缩放、收退款/日期/换房和会员升级旅程。 |
| 最后提示修正后的 `stage15-complete-journeys.spec.ts` 专项复测 | 2 项通过，2 项按桌面限定跳过；退款、日期调整和换房遇 503 后保留草稿与焦点，恢复后继续确认，且不再提示关闭草稿。 |
| `room-status.spec.ts` 定向回归 | 8 项通过，8 项仅适用桌面而跳过。包括三个新鲜度窗口、时钟偏差及回拨、慢响应停止重试、范围替换取消旧重试、连续失败、真实 403 和 WRITE→READ。 |

验证使用独立合成测试库；没有运行会改动原审计样例的 `runtime-audit.mjs`。房态范围替换用例曾发现“慢响应”文案遮住“刷新失败”原因，已修复提示优先级并复测通过。最后复查还修正了收退款提交按钮的禁用状态及日期/换房暂时读失败的提示，避免要求用户关闭仍可恢复的草稿。

原始日志保留在本机 `/tmp/green-pms-f01-f05-final-verify.log`、`/tmp/green-pms-f01-f05-contract.log`、`/tmp/green-pms-f01-f05-safety.log`、`/tmp/green-pms-f01-f05-final-e2e.log`、`/tmp/green-pms-f02-final-e2e.log`；最终提示专项复测日志为 `/tmp/green-pms-f03-final-journeys.log`。

最终状态：**F01–F05 工程实现完成，适用自动验证通过；人工验收待验收。** `git diff --check` 通过。未发现本次范围内尚未解决的工程问题；持续慢网络下写入暂停是保留的安全边界。原工作区已有改动及未跟踪资料保持保留。
