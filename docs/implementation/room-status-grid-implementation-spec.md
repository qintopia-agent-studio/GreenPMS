---
title: 'QinTopia PMS RoomStatusGrid Implementation'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: '4b287c79cee640202716f0d21eb6062427604ba4'
context:
  - 'docs/implementation/room-status-ui-development-goal.md'
  - 'docs/implementation/spec-qintopia-pms-core-operations-mvp.md'
  - 'design-system/qintopia-pms/MASTER.md'
---

> 2026-10-16 已确认修订：房态显示快照的5秒提示不再作为整页办理门禁。前台默认15秒读取轻量revision、营业日和授权摘要，变化时刷新；具体写入仍需Preview/Confirm。日期切换失败保留导航，确定性数据错误不自动无限重试；历史已释放但资料待核对的住宿可非阻断、不可写只读展示，不新增Claim。当前/未来未知库存、权限、未决命令保护不变。详细验收以 `spec-room-status-reliability-and-dorm-stats.md` 为准，以下早期实施记录保留，不作为新刷新频率要求。


<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 当前房态页只提供逐日“可售/占用”，无法说明订单、Stay、维修、内部占用与清洁来源，也缺少安全区间选择、新鲜度、恢复和移动任务体验，不能作为日常运营工作面。

**Approach:** 新增 PostgreSQL 驱动的只读复合房态投影及最小 Operations/Block 事实，通过同一授权和 Preview/Confirm/Receipt 协议执行写入；React 以该投影实现父子房源、连续条带、上下文、响应式与无障碍交互。

## Boundaries & Constraints

**Always:** 服务端计算整房/床位互斥、冲突、typed sources、allowed actions、revision 与 freshness；日期使用半开区间。正常订单、FREE_STAY、INTERNAL_USE、维修和清洁保持不同来源。READ 只见读动作；所有高风险写入重验权限、版本和冲突并返回持久 Receipt。`stale`、`unknown`、DTO 缺失或 blocking conflict 均阻断写入。

**Ask First:** 只有需要改变既有计价、会员、资金、Token 权限或清洁是否阻断夜间可售等未确认经营边界时暂停。清洁在本目标中作为不改变夜间 Claim 的履约任务显示。

**Never:** 客户端推断可售/冲突/金额；创建可编辑 `roomStatus` 字段；用 fixture、颜色或 CSS 伪造来源；改变旧 availability 或外围智能体命令语义；建设旧 PMS 兼容；在移动端缩小完整二维矩阵。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 房态查询 | 物业与最多 90 夜区间 | 父房行、床位子行、连续 typed intervals、稳定引用、revision/asOf/freshUntil | 来源无法解析为 `unknown`，不当作可售 |
| 区间选择 | 鼠标、触控、键盘或日期输入 | 仅产生本地 `[arrival, departure)` 选区与服务端已有冲突详情 | 冲突/陈旧时隐藏或禁用写动作 |
| 内部占用 | WRITE + 空闲区间 + reason | Preview 后原子创建 Block/Claim/Receipt | Confirm 重验失败零业务写入 |
| Block 释放 | 精确匹配完整有效 Block | Preview 后释放全部 Claim 并保留历史 | 部分选区只读，不能释放 |
| 清洁 | CHECK_OUT / 待清洁任务 | 退房追加任务；完成命令可追溯 Receipt | 不改变已确认库存 Claim 规则 |
| 返回恢复 | 从 Order/Block/Receipt 返回 | 恢复范围、筛选、展开、滚动、选区和焦点 | revision 变化先刷新并重新校验 |
| 移动房态 | 小于 576px | 到店、在住、离店、异常任务流 | 不渲染缩小桌面矩阵 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/index.ts` -- RoomStatus DTO、稳定状态/动作和新命令类型。
- `packages/db/src/migrations/013_room_status_operations.sql` -- INTERNAL_USE 与清洁事实及约束。
- `packages/db/src/room-status.ts` -- 有界高效复合投影与 revision。
- `packages/db/src/commands/` -- Operations/Block effect、Confirm 和 Receipt。
- `apps/api/src/{schemas,server}.ts` -- Query、命令/OpenAPI 合同。
- `apps/web/src/pages/InventoryPage.tsx`、`apps/web/src/room-status/`、`apps/web/src/styles.css` -- 房态工作面、恢复、移动替代路径。
- `tests/` -- PostgreSQL、OpenAPI、性能、E2E、Axe 与多视口证据。

## Tasks & Acceptance

**Execution:**
- [x] 固化 DTO、迁移、投影和 Operations/Block 命令，保持旧 API additive。
- [x] 实现父子网格、连续条带、筛选、区间、详情、动作分流与完整释放。
- [x] 实现 4 秒 revision 刷新、5 秒 stale 阈值、命令恢复和返回状态恢复。
- [x] 实现小屏任务流、键盘网格、屏读名称、320px/200% zoom 与 reduced motion。
- [x] 补齐 RS-UI-001..014 的 integration、contract、unit、E2E 和性能证据。

Required Verification 五项全量命令、7 项真实计价事实、最终实例、真实认证投影和最终截图汇总均已取得本次工作树的 post-review 证据。

**Acceptance Criteria:**
- Given 整房或子床 Claim，when 查询同房日期，then 双向互斥、兄弟床并存和精确来源由服务端 DTO 表达。
- Given WRITE/READ 主体，when 打开空白区间，then WRITE 看到四类正确入口，READ 不看到业务写动作。
- Given stale、unknown、冲突或过期 Preview，when 尝试确认，then 禁用或服务端拒绝且零业务写入。
- Given 200 单元和 90 夜，when 查询并打开页面，then Query P95 不超过 500ms、首屏两秒内可交互且 DOM 有界。
- Given 桌面、平板、375px、320px 与 200% zoom，when 完成筛选、选区、详情及一个高风险动作，then 无溢出、遮挡或不可见焦点并通过 Axe。

## Design Notes

`room-status` 返回稳定 revision 与 `freshUntil=asOf+5s`。Claim 条带按来源、显示单元和连续服务日合并；父行继承子床阻断，子行继承整房阻断，但保留实际 Claim 单元。清洁任务是 Operations overlay，不自行改变夜间库存可售。网格按房间分页并对日期窗口化，替代删除层级或来源语义。Operations 任务使用 500 条硬上限、SQL `limit+1` 和确定性截断；一旦截断，投影返回 `PARTIAL` 并 fail closed，而不是把不完整任务集声明为 `READY`。

## RS-UI Traceability

| Requirement | Authoritative implementation | Automated evidence |
|---|---|---|
| RS-UI-001 Entry / filters | `InventoryPage.tsx`, `RoomStatusToolbar.tsx`, `RoomStatusBoardQueryDto`, `/api/v1/properties/:id/room-status` | `room-status.contract.test.ts` full-property filters/facets; `room-status.spec.ts` range, filtered-empty and range-loading |
| RS-UI-002 Room / bed hierarchy | `packages/db/src/room-status.ts`, `RoomStatusGrid.tsx`, fail-closed DTO validation | `room-status-projection.integration.test.ts` inherited conflicts; `roomStatusState.test.ts` parent/child filtering; desktop matrix E2E |
| RS-UI-003 Composite projection | RoomStatus DTOs, `packages/db/src/room-status.ts`, `RoomStatusContext.tsx` | projection integration suite; strict contract test; typed Block browser journey |
| RS-UI-004 Status vocabulary | `roomStatusPresentation.tsx`, `RoomStatusGrid.tsx`, `RoomStatusMobileTasks.tsx` | `roomStatusValidation.test.ts` UNKNOWN/fail-closed cases; stale/unknown browser E2E |
| RS-UI-005 Source separation | typed source builders in `packages/db/src/room-status.ts`; source labels and action routing in Web | FREE_STAY/inactive-source integration; typed source and mobile task browser journeys |
| RS-UI-006 Range selection | `roomStatusState.ts`, `RoomStatusGrid.tsx`, equivalent unit/date editor in `RoomStatusContext.tsx` | selection/keyboard unit tests; range-selection E2E; cross-interval pointer E2E |
| RS-UI-007 Context detail | `RoomStatusContext.tsx`; server references, history, conflicts and redaction | stable-reference contract; amendment/Receipt projection integration; desktop context E2E |
| RS-UI-008 Action routing | service-owned `allowedActions`; `InventoryPage.tsx` command/quote routing | READ/WRITE contract; desktop WRITE and READ-principal E2E; mobile task-action unit tests |
| RS-UI-009 Conflict safety | `roomStatusValidation.ts`, precise conflict DTOs, `CommandDialog` write blocking | fail-closed validation tests; stale Preview zero-write integration; Preview/access downgrade E2E |
| RS-UI-010 Command / Receipt | shared Preview/Confirm/Receipt services, `CommandDialog`, persistent recovery in `ui.tsx` | command-state E2E covers expiry, recovery and original Receipt; typed Block commit/refresh E2E |
| RS-UI-011 Release rules | complete `sourceStartDate/sourceEndDate`, `intervalActions`; Query 窗口最多 90 夜，Block 沿用 366 夜领域边界 | cross-window view-only integration; complete-release validation and mobile task unit tests; create/release E2E |
| RS-UI-012 Return restoration | versioned restoration and fact fingerprint in `roomStatusState.ts`; focus/scroll restoration in Grid/Page | restoration unit suite; Order return E2E; mobile-first to desktop edge E2E |
| RS-UI-013 Query / command states | `InventoryPage.tsx` query phases; `CommandDialog` and recovery state UI | range/stale/unknown/403 browser E2E; command-state E2E including `duplicate-returned-original-receipt` |
| RS-UI-014 Operational copy | `roomStatusPresentation.tsx`, `RoomStatusContext.tsx`, explicit error/recovery copy in Page/Dialog | browser assertions for object/date/reason/state copy; final human visual/copy review passed across 28 retained screenshots |

## Current Evidence Status

Current worktree full-gate evidence:

- `npm run verify`: post-review TypeScript rerun passed; 16 unit/domain/Web files and 198 tests passed.
- `npm run test:integration`: clean PostgreSQL rerun passed 15 files and 133 tests.
- `npm run test:contract`: post-review production Web build plus OpenAPI/security/agent/script contracts passed 8 files and 52 tests.
- `npm run build`: post-review production Web build passed with 1,701 transformed modules and no warnings.
- `npm run test:pricing-facts`: all 7 user-confirmed pricing facts passed through the production pricing executor.
- `npm run test:e2e`: 41 browser tests passed, 33 tests were intentionally skipped by desktop/mobile project scope, and 0 failed against migrated PostgreSQL.
- The 200-unit by 90-night browser performance journey became keyboard-interactive in approximately 1.8 seconds; the PostgreSQL projection P95 remained inside its 500 ms acceptance threshold.
- Playwright produced 28 PNGs under `test-results/`, covering 1440x900, 1024x768, 768x1024, 375x812, 320 CSS px, dedicated 200% zoom, sticky grid edges, focus restoration, typed sources, blocking conflict, stale draft, server Preview, Receipt, desktop/mobile interval drag and `room-status-mobile-pagination-200-rooms.png`.
- Automated geometry/hit-test assertions and human screenshot inspection found the matrix non-empty, sticky axes opaque, focus visible, Chinese text readable and mobile task flow free of a compressed desktop matrix. The 200-room mobile screenshot visibly reaches page 2 of 4 without blank rendering, overlap or inaccessible paging controls. The in-app browser integration was unavailable in this environment, so this evidence was collected with the repository's real Playwright Chromium setup rather than claimed as an in-app-browser run.
- The final projection distinguishes `CLAIM`, `LODGING_ORDER`, `OVERDUE_IN_HOUSE` and `UNIT_UNSELLABLE` blockers. Departure-day availability uses the same active lodging-order facts as quote availability, while missing Claims and unresolved source facts fail closed without fabricating references.
- Long operational reasons remain readable, and keyboard focus plus the selection anchor survive date-window changes when the target remains visible; otherwise the UI provides an explicit restoration notice.
- Final E2E verification exposed and corrected a membership-domain defect: naturally expired Lots are excluded from new coverage allocation as of the property business date, while already-held or consumed coverage remains preserved. PostgreSQL regression coverage now protects both boundaries.
- A reusable production instance is running at `http://127.0.0.1:4100`. `/`, `/docs/`, `/health/live`, `/health/ready` and `/api/v1/openapi.json` return 200; the health payloads are `{"status":"ok"}` and `{"status":"ready"}`, and OpenAPI reports version 3.1.0 for QinTopia PMS Core Operations API 1.0.0.
- A real `operator` session queried `/api/v1/properties/prop_qintopia_demo/room-status` and returned `projectionState=READY`, 44 unique parent-room rows and 46 unique bed child rows.

The RoomStatusGrid execution, independent review, post-review evidence and Quick Dev presentation gates are complete. Frontmatter is `done`.

## Independent Review Closure

Two adversarial review passes were resolved with executable regressions. The final implementation preserves the 90-night Query window while retaining the 366-night Block domain boundary and migrating historical long maintenance locks; bounds Operations tasks at 500 with deterministic fail-closed truncation; bumps revision for projection-visible repricing and member-coverage refresh; derives checkout cleaning from the property business date and keeps pending cleaning visible across midnight; prevents releasing a Block while active Claims remain; restores the legacy `/availability` wire DTO; prevents Block dialogs from Previewing dates outside the server-validated selection; rejects corrupt restoration snapshots; and adds mobile paging for properties larger than 50 rooms.

The review also accepted two explicit safety conclusions: overdue in-house stays continue blocking resale as an inventory-safety correction, and actor/command/correlation audit fields remain visible only to property-authorized principals.

## Remaining Non-Blocking Risks

- The validating host runs Node `v24.14.0` while the project declares Node 22.x; the full gate passes, but release automation should continue using the declared LTS version.
- Four-second polling has narrow latency headroom against the five-second freshness threshold.
- Scale beyond the accepted 200 rooms by 90 nights may eventually require database-first pagination.
- A disposable local database that executed a temporary pre-review migration 013 may retain obsolete 90-night Block constraints; fresh installs and automated databases are correct, and affected demo databases should be rebuilt rather than patched with invented business facts.

## Verification

**Commands:**
- `npm run verify`
- `npm run test:integration`
- `npm run test:contract`
- `npm run build`
- `npm run test:pricing-facts`
- `npm run test:e2e`

**Manual checks:**
- Playwright 检查 1440x900、1024x768、768x1024、375x812、320px、200% zoom、键盘、Axe、sticky、stale/unknown/conflict/recovery 和 Receipt。

**Verification evidence:** all five required commands plus the pricing-facts gate passed on the current worktree. Browser evidence comprises 41 passed scenarios, 33 intentional project-scope skips, 0 failures and 28 retained PNGs. Axe, keyboard-only flows, focus clipping, responsive geometry, 200% zoom, stale/unknown/conflict/recovery, Preview/Confirm/Receipt, mobile pagination and 200-by-90 performance are covered by executable assertions.

**Final gate status:** implementation, independent review, post-review verification, browser inspection, reusable runtime and Quick Dev status transition are complete.

## Suggested Review Order

**运营入口与交互**

- 先看页面编排如何统一查询、选区、命令恢复与响应式分流。
  [`InventoryPage.tsx:986`](../../apps/web/src/pages/InventoryPage.tsx#L986)

- 二维网格保留父子库存、连续条带和完整键盘语义。
  [`RoomStatusGrid.tsx:144`](../../apps/web/src/room-status/RoomStatusGrid.tsx#L144)

- 上下文面板只呈现服务端事实、引用、冲突和允许动作。
  [`RoomStatusContext.tsx:125`](../../apps/web/src/room-status/RoomStatusContext.tsx#L125)

- 移动端改用任务流并支持超大物业分页。
  [`RoomStatusMobileTasks.tsx:102`](../../apps/web/src/room-status/RoomStatusMobileTasks.tsx#L102)

- 恢复快照严格校验范围、焦点和选区后才复用。
  [`roomStatusState.ts:658`](../../apps/web/src/room-status/roomStatusState.ts#L658)

**权威投影与安全写入**

- 稳定 DTO 固化状态、来源、冲突、动作、上限和新鲜度。
  [`index.ts:293`](../../packages/contracts/src/index.ts#L293)

- PostgreSQL 只读事务生成有界、可追溯且 fail-closed 的复合投影。
  [`room-status.ts:578`](../../packages/db/src/room-status.ts#L578)

- 迁移建立 typed Block、清洁任务、revision 与跨表约束。
  [`013_room_status_operations.sql:11`](../../packages/db/src/migrations/013_room_status_operations.sql#L11)

- Confirm 原子创建或释放 Block、Claim、任务与持久 Receipt。
  [`apply.ts:431`](../../packages/db/src/commands/apply.ts#L431)

- 共享命令服务统一 Preview 重验、幂等和投影 revision。
  [`service.ts:641`](../../packages/db/src/commands/service.ts#L641)

- 版本化 Query API 复用同一授权与权威投影。
  [`server.ts:228`](../../apps/api/src/server.ts#L228)

**响应式与失败关闭**

- 严格运行时验证拒绝缺失、未知或自相矛盾的投影 DTO。
  [`roomStatusValidation.ts:541`](../../apps/web/src/room-status/roomStatusValidation.ts#L541)

- 移动断点、sticky 轴、焦点和 200% zoom 使用同一设计语言。
  [`room-status.css:1036`](../../apps/web/src/room-status/room-status.css#L1036)

**可执行证据**

- PostgreSQL 集成覆盖互斥、任务上限、回滚、长 Block 和并发。
  [`room-status-projection.integration.test.ts:163`](../../tests/integration/room-status-projection.integration.test.ts#L163)

- OpenAPI 契约锁定稳定词汇、授权动作与旧 API 形状。
  [`room-status.contract.test.ts:127`](../../tests/contract/room-status.contract.test.ts#L127)

- 桌面旅程验证 typed Block、恢复和 Receipt 全链路。
  [`room-status.spec.ts:314`](../../tests/e2e/room-status.spec.ts#L314)

- 边界旅程证明选区外零 Preview、sticky 和缩放安全。
  [`room-status-ui-edge.spec.ts:268`](../../tests/e2e/room-status-ui-edge.spec.ts#L268)

- 真实 200×90 性能及 200 房移动分页保持有界。
  [`room-status-performance.spec.ts:176`](../../tests/e2e/room-status-performance.spec.ts#L176)
