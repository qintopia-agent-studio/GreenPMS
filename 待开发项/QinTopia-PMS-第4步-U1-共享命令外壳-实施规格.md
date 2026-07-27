---
title: 'QinTopia PMS 第 4 步 U1 共享命令外壳'
type: 'feature'
created: '2026-07-27'
status: 'awaiting_user_acceptance'
review_loop_iteration: 0
baseline_commit: 'd5b26891c67163e49f2a0bd208d2b4f46371edc2'
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

**Always:** 白名单为 `CREATE_ORDER`（普通/免费/会员）、`CREATE_MEMBER`、`CREATE_MEMBERSHIP_ORDER`、`RECORD_MEMBERSHIP_PAYMENT`、`CORRECT_MEMBERSHIP_PAYMENT`、`ACTIVATE_MEMBERSHIP_ORDER`、`CORRECT_MEMBER_ENTITLEMENT_BALANCE`、`LOCK_MAINTENANCE`、`RELEASE_MAINTENANCE`、`CORRECT_ORDER_OCCUPANT`、`REPRICE_ORDER`、`CHECK_IN`、`CHECK_OUT`。全部自动核对，只显示中文业务摘要并只确认一次；返回修改保留草稿并废弃旧预检。Confirm 前先持久化原幂等身份；结果未知只查询原键，终态明确前不重发。成功后自动关闭、刷新、清除对应恢复记录、恢复焦点并显示非模态结果；明确未执行说明零写入并解锁。关闭、路由变化或新尝试后的迟到响应不得覆盖当前状态。

**Ask First:** 若需改 contracts/OpenAPI、服务端、领域、数据库或任一命令的业务输入、允许动作、计价、库存、权益、审计、事务语义，立即暂停；若安全恢复必须保留独立成功页，也暂停确认。

**Never:** 不改 `CREATE_QUOTE` 外壳、清洁、Token、无 Web 入口命令及阶段 9-13 命令；不进入 U2 或正式 4.2。不以清存储、换新键重试、乐观成功、隐藏失败或删除断言简化流程。

## I/O & Edge-Case Matrix

| State | Expected behavior | Failure handling |
|---|---|---|
| 自动核对中 | 打开白名单命令即载入绑定草稿的核对信息 | 可取消请求；迟到结果忽略 |
| 可确认 | 显示业务摘要，聚焦标题，只开放返回修改/确认 | 缺失依据不开放确认 |
| 返回修改 | 恢复全部草稿，旧预检失效 | 零写入 |
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
- Given 任一白名单入口，when 核对、返回修改或确认，then 无技术协议词、草稿不丢且正式确认恰好一次。
- Given 过期、确定失败、存储失败、网络中断或刷新，when 状态变化，then 只开放安全动作，未知不重复写，明确未执行零写入。
- Given 成功，when 投影刷新，then 弹窗自动关闭、最新事实和非模态中文结果可见、焦点恢复且无残留恢复锁。
- Given U1 完成，when 交付，then 独立实例、账号、代表性验收数据和八态人工步骤可用；U2、正式 4.2 和排除命令未改变。

## Spec Change Log

## Design Notes

状态转换必须是纯数据；宿主页只保留草稿、刷新投影和放置提示。终态 Receipt 仍作内部证据，但不再是工作人员必须关闭的页面。

## Verification

- 2026-07-27：TypeScript、production build、`git diff --check` 通过；Unit `316/316`、Integration `182/182`、Contract/OpenAPI `57/57`、pricing facts `7/7` 通过。
- U1 专属桌面/手机 E2E `3 passed / 3 expected skipped`；调价与维修释放真实旅程 `2/2`；Stage 8 独立履约 `5 passed / 5 expected skipped`；修正后的手机今日入住 `1/1`。
- 完整 E2E 首轮为 `61 passed / 56 skipped / 8 did not run / 17 failed`。其中两条 Stage 8 失败由共享数据库前序占用污染造成，独立复跑全绿；一条手机用例违反已验收的提前退房门禁，修正为合法入住旅程后通过。其余为 U1 排除范围内的既有 Token 与房态性能、拖选、恢复、响应式断言；U1 相关套件无剩余失败，不在本切片跨阶段修复。
- 评审补丁已闭合：所有关闭路径保留草稿、迟到键门禁、未知结果原键查询、Receipt 语义一致性、权威投影刷新、焦点回退、恢复存储仅保留身份，以及调价/维修释放 effect 与原输入的一致性失败关闭。

## Suggested Review Order

**状态机与确认边界**

- 从精确 13 命令白名单和八态转换理解 U1 边界。
  [`commandShellState.ts:3`](../apps/web/src/command-shell/commandShellState.ts#L3)

- 核对迟到响应、旧幂等键和终态不可回退门禁。
  [`commandShellState.ts:87`](../apps/web/src/command-shell/commandShellState.ts#L87)

- 检查调价、维修释放和履约摘要的权威证据一致性。
  [`ui.tsx:477`](../apps/web/src/ui.tsx#L477)

- 共享弹窗统一自动核对、返回修改、提交和成功收口。
  [`ui.tsx:1529`](../apps/web/src/ui.tsx#L1529)

**恢复与隐私**

- 恢复记录只保留主体、范围、原键和稳定目标身份。
  [`ui.tsx:1142`](../apps/web/src/ui.tsx#L1142)

- 终态转换不持久化 Receipt、金额或住客资料。
  [`ui.tsx:1290`](../apps/web/src/ui.tsx#L1290)

- 浏览器恢复锁在保存、清除失败时继续失败关闭。
  [`ui.tsx:1366`](../apps/web/src/ui.tsx#L1366)

**宿主页绑定**

- 房态动作刷新权威投影并恢复原选区与焦点。
  [`InventoryPage.tsx:2555`](../apps/web/src/pages/InventoryPage.tsx#L2555)

- 订单资料更正草稿绑定精确订单和住宿人。
  [`OrderOccupantCorrectionDialog.tsx:32`](../apps/web/src/components/OrderOccupantCorrectionDialog.tsx#L32)

- 会员操作返回修改后重开对应业务表单。
  [`MembersPage.tsx:608`](../apps/web/src/pages/MembersPage.tsx#L608)

- 今日履约成功后等待真实订单投影刷新。
  [`TodayPage.tsx:101`](../apps/web/src/pages/TodayPage.tsx#L101)

**验证证据**

- 单测证明恢复存储无 Receipt 和业务敏感字段。
  [`OrderDetailPage.test.ts:321`](../apps/web/src/pages/OrderDetailPage.test.ts#L321)

- 单测覆盖损坏 effect 与原输入串线失败关闭。
  [`ui.test.ts:155`](../apps/web/src/ui.test.ts#L155)

- 浏览器覆盖草稿返回、未知恢复和移动端自动关闭。
  [`command-shell-u1.spec.ts:79`](../tests/e2e/command-shell-u1.spec.ts#L79)
