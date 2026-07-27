---
title: 'QinTopia PMS 第 4 步 U1 共享命令外壳'
type: 'feature'
created: '2026-07-27'
status: 'awaiting_user_acceptance'
review_loop_iteration: 1
baseline_commit: '0c1aed475a5abe33e136b8390005f6b4382c4505'
context:
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - 'docs/architecture/invariants-and-decisions.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 当前命令弹窗只有部分业务自动核对，其他业务仍暴露技术预检；成功后还要关闭独立回执页。返回修改可能丢草稿，提交中、结果未知和未执行也缺少一致反馈。

**Approach:** 为已验收业务命令建立显式共享状态机：自动服务端核对、一次业务确认、成功自动关闭并刷新权威投影；底层 Preview/Confirm/Receipt、幂等、版本锁和恢复合同不变。

## Boundaries & Constraints

**Always:** 白名单为 `CREATE_ORDER`（普通/免费/会员）、`CREATE_MEMBER`、`CREATE_MEMBERSHIP_ORDER`、`RECORD_MEMBERSHIP_PAYMENT`、`CORRECT_MEMBERSHIP_PAYMENT`、`ACTIVATE_MEMBERSHIP_ORDER`、`CORRECT_MEMBER_ENTITLEMENT_BALANCE`、`LOCK_MAINTENANCE`、`RELEASE_MAINTENANCE`、`CORRECT_ORDER_OCCUPANT`、`REPRICE_ORDER`、`CHECK_IN`、`CHECK_OUT`。全部自动核对，只显示中文业务摘要并只确认一次；除经 2026-07-27 人工验收重新协商的 `CHECK_IN`、`CHECK_OUT` 单层核对例外外，返回修改保留草稿并废弃旧预检。入住、退房在同一核对页填写可选备注，只开放取消和正式确认。Confirm 前先持久化原幂等身份；结果未知只查询原键，终态明确前不重发。成功后自动关闭、刷新、清除对应恢复记录、恢复焦点并显示非模态结果；明确未执行说明零写入并解锁。关闭、路由变化或新尝试后的迟到响应不得覆盖当前状态。

**Ask First:** 若需改 contracts/OpenAPI、服务端、领域、数据库或任一命令的业务输入、允许动作、计价、库存、权益、审计、事务语义，立即暂停；若安全恢复必须保留独立成功页，也暂停确认。

**Never:** 不改 `CREATE_QUOTE` 外壳、清洁、Token、无 Web 入口命令及阶段 9-13 命令；不进入 U2 或正式 4.2。不以清存储、换新键重试、乐观成功、隐藏失败或删除断言简化流程。

## I/O & Edge-Case Matrix

| State | Expected behavior | Failure handling |
|---|---|---|
| 自动核对中 | 打开白名单命令即载入绑定草稿的核对信息 | 可取消请求；迟到结果忽略 |
| 可确认 | 显示业务摘要并聚焦标题；一般命令开放返回修改/确认，入住、退房只开放取消/确认 | 缺失依据不开放确认 |
| 返回修改 | 非入住、退房命令恢复全部草稿，旧预检失效 | 零写入 |
| 核对过期 | 隐藏确认，聚焦中文错误并可重新核对 | 陈旧确认零写入 |
| 提交中 | 可见进度；禁关闭、Escape、重复确认 | 身份持久化失败则不发 Confirm |
| 结果未知 | 关闭/刷新后仍查询原键 | 禁止盲重试 |
| 明确未执行 | 中文说明未执行，保留草稿并解锁 | 页面和服务端零写入 |
| 执行成功 | 自动关闭、刷新、非模态反馈、恢复焦点 | 清恢复记录失败则继续阻断写入并给恢复入口 |

</frozen-after-approval>

## Code Map

- `apps/web/src/command-shell/commandShellState.ts` -- 白名单、八态转换和迟到响应门禁。
- `apps/web/src/ui.tsx`、`apps/web/src/api.ts` -- 共享弹窗、业务摘要、恢复/结果反馈、焦点与请求取消。
- `apps/web/src/pages/{InventoryPage,MembersPage,TodayPage,OrderDetailPage}.tsx` -- 草稿、投影刷新、结果反馈和统一写阻断。
- `apps/web/src/components/OrderOccupantCorrectionDialog.tsx`、`apps/web/src/styles.css` -- 更正草稿及可访问样式。
- `apps/web/src/**/*.test.ts`、`tests/e2e/*.spec.ts` -- 状态、页面和浏览器回归。

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/command-shell/commandShellState.ts`、`apps/web/src/ui.tsx`、`apps/web/src/api.ts` -- 实现白名单状态机、自动核对、请求租约、中文反馈及安全终态。
- [x] 四个宿主页与 `OrderOccupantCorrectionDialog.tsx`、`styles.css` -- 保留草稿；成功后刷新、提示、恢复焦点；排除命令保持原行为。
- [x] Web 单测与 `tests/e2e/command-shell-u1.spec.ts` -- 覆盖全部白名单、八态、非法转换、迟到响应、存储失败、零写入、刷新恢复、键盘和移动端；同步强化所有依赖手动预检/回执/完成的既有 E2E。
- [x] `tests/e2e/setup-u1-acceptance.ts`、两份分步计划与本规格 -- 准备独立验收数据；实施时记 `in_progress`，门禁通过后记 `awaiting_user_acceptance` 并附结果，不启动 U2。

**Acceptance Criteria:**
- Given 任一白名单入口，when 核对、返回修改（入住、退房除外）或确认，then 无技术协议词、草稿不丢且正式确认恰好一次。
- Given 过期、确定失败、存储失败、网络中断或刷新，when 状态变化，then 只开放安全动作，未知不重复写，明确未执行零写入。
- Given 成功，when 投影刷新，then 弹窗自动关闭、最新事实和非模态中文结果可见、焦点恢复且无残留恢复锁。
- Given U1 完成，when 交付，then 独立实例、账号、代表性验收数据和八态人工步骤可用；U2、正式 4.2 和排除命令未改变。

## Spec Change Log

- 2026-07-27：三项人工验收问题及盲审竞态已修复，状态转为 `awaiting_user_acceptance`。入住、退房使用单层核对与可选备注，房态桌面/手机均在当前页办理，调价默认当前金额；自然 freshness 过期不打断已开始核对，但 revision、查询范围、门店、账号、订单、Stay、权限或投影状态变化继续失败关闭。未知结果恢复会保留原订单目标或关闭无关订单上下文。U2 与正式 4.2 未开始。
- 2026-07-27：U1 人工验收发现三项交互问题，状态退回 `in_progress`：入住/退房核对页与“返回修改”页面重复，且正常履约不应强制填写原因；调整金额输入框必须默认为当前订单金额；从房态办理退房应留在当前窗口，不跳转完整订单页。本轮只修复 U1 Web 交互与回归，不改 contracts、API、领域、数据库或履约/计价规则，不启动 U2 或正式 4.2。

## Human Acceptance Fixes

- [x] `apps/web/src/ui.tsx`、`OrderDetailPage.tsx` -- 入住/退房只保留一页核对；改为“办理备注（选填）”，空白时使用稳定系统审计备注满足既有服务端合同。
- [x] `InventoryPage.tsx`、`RoomStatusOrderContext.tsx` -- 房态中的入住/退房动作直接打开当前页共享履约弹窗，绑定选中的精确物业和订单范围，成功后刷新房态与订单上下文。
- [x] Web 单测与 U1/Stage 8 E2E -- 固定空备注可确认、无重复返回步骤、调价输入默认当前金额，以及房态内联退房不跳转并刷新投影。

## Design Notes

状态转换必须是纯数据；宿主页只保留草稿、刷新投影和放置提示。终态 Receipt 仍作内部证据，但不再是工作人员必须关闭的页面。

## Verification

- 2026-07-27 人工验收返修：TypeScript、production build、`git diff --check` 与 Unit `330/330` 通过；U1 专属 E2E `3 passed / 3 expected skipped`，Stage 8 桌面/手机 E2E `5 passed / 5 expected skipped`，调价当前值与会员备注持久化 E2E `2/2`。Stage 8 真实竞态同时证明只读投影立即禁用确认、自然 freshness 过期不误杀已开始核对、内联按钮可真实点击且 URL 保持房态根页。
- 2026-07-27：TypeScript、production build、`git diff --check` 通过；Unit `316/316`、Integration `182/182`、Contract/OpenAPI `57/57`、pricing facts `7/7` 通过。
- U1 专属桌面/手机 E2E `3 passed / 3 expected skipped`；调价与维修释放真实旅程 `2/2`；Stage 8 独立履约 `5 passed / 5 expected skipped`；修正后的手机今日入住 `1/1`。
- 完整 E2E 首轮为 `61 passed / 56 skipped / 8 did not run / 17 failed`。其中两条 Stage 8 失败由共享数据库前序占用污染造成，独立复跑全绿；一条手机用例违反已验收的提前退房门禁，修正为合法入住旅程后通过。其余为 U1 排除范围内的既有 Token 与房态性能、拖选、恢复、响应式断言；U1 相关套件无剩余失败，不在本切片跨阶段修复。
- 评审补丁已闭合：所有关闭路径保留草稿、迟到键门禁、未知结果原键查询、Receipt 语义一致性、权威投影刷新、焦点回退、恢复存储仅保留身份；调价核对严格覆盖原金额、连续住宿时间线、完整 pricing 证据、币种/整元/差额一致性及原订单目标，维修释放严格绑定原锁房目标并显示可识别房号，任一损坏证据均不开放确认。

## Suggested Review Order

**单层履约核对**

- 入住、退房改为可选备注并在空值时生成稳定审计文字。
  [`ui.tsx:376`](../apps/web/src/ui.tsx#L376)

- 共享弹窗只为入住、退房移除重复返回修改步骤。
  [`ui.tsx:1632`](../apps/web/src/ui.tsx#L1632)

**房态内联与失败关闭**

- 新命令与活动命令分别处理 freshness 和权威投影失效。
  [`InventoryPage.tsx:1340`](../apps/web/src/pages/InventoryPage.tsx#L1340)

- 房态内联履约绑定门店、账号、订单和 Stay。
  [`InventoryPage.tsx:2448`](../apps/web/src/pages/InventoryPage.tsx#L2448)

- 未知结果恢复不会刷新当前无关订单上下文。
  [`InventoryPage.tsx:2639`](../apps/web/src/pages/InventoryPage.tsx#L2639)

- 订单上下文仅把入住、退房留在当前房态页。
  [`RoomStatusOrderContext.tsx:134`](../apps/web/src/room-status/RoomStatusOrderContext.tsx#L134)

**调价与验证**

- 调价默认当前金额并拒绝非整元草稿及提交。
  [`OrderDetailPage.tsx:62`](../apps/web/src/pages/OrderDetailPage.tsx#L62)

- 浏览器覆盖只读竞态、自然过期、桌面/手机内联和备注持久化。
  [`room-status-stage8-fulfillment.spec.ts:217`](../tests/e2e/room-status-stage8-fulfillment.spec.ts#L217)
