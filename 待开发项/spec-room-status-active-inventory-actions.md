---
title: '房态表有效库存与可售选区操作修复'
type: 'bugfix'
created: '2026-08-08'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f4757bce0a703df96594fa105d716e724bc1f32a'
context:
  - '待开发项/QinTopia-PMS-上线前房间目录更正-实施规格.md'
  - '待开发项/QinTopia-PMS-第4步-4.1-实施规格.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 房间目录更正后，105、108、206 已是两人间，但各自的 C、D 两个已下线床位仍作为“不可售”行出现在逐日房态表。后端又把每间房的 2 人容量与包含 inactive C/D 在内的 4 个 children 比较，误判整个房态投影不完整，导致顶部显示“投影不完整”提示，并撤掉所有房间和床位快捷菜单、右侧抽屉里的执行操作。

**Approach:** 房态投影继续保留下线库存的历史引用与异常审计能力，但用于目录闭合校验、当前矩阵、分页、筛选选项和可售汇总的展示树只使用 active 房间与 active 床位。目录闭合恢复后，投影应重新成为 READY，顶部错误提示自然消失，所有符合既有权限、可售和冲突规则的快捷菜单及右侧抽屉操作随之恢复。

## Boundaries & Constraints

**Always:** 不删除或改写已下线库存的数据库身份、历史 Claim、订单、住宿或审计事实；105、108、206 的当前展示树各自只能包含 A、B 两个 active 床位，父房间的 children、childUnitIds、capacity 和 occupancyCapacity 必须闭合一致；后端不得把任何 inactive 房间或床位放入当前矩阵；任一晚不可售、存在冲突、投影真实不完整、无 WRITE 权限或写恢复被阻断时仍须 fail closed；创建流程继续复用现有报价、幂等、权限和库存校验。

**Ask First:** 若修复需要改变投影安全规则、订单/住宿领域命令语义，或需要迁移/删除现有数据，必须先征得用户确认。

**Never:** 不重新处理已经完成的页头冻结；不把 inactive 库存仅在前端隐藏后仍留在 API 展示树；不为了显示按钮绕过服务端投影、冲突或权限保护；不把 CREATE_ORDER 与 CREATE_FREE_STAY 拆成新的领域流程。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 有效双人间 | 105、108、206 active，各自 A/B active、C/D inactive | 每间房只显示 A/B；C/D 不出现在矩阵、筛选计数或可售汇总；目录闭合校验按两个 active children 通过 | 下线单元仍可被历史/异常审计引用 |
| 正常投影 | 当前有效目录闭合且不存在其他真实投影异常 | projectionState 为 READY；顶部不显示“投影不完整”；所有符合既有规则的快捷菜单和右侧抽屉恢复执行操作 | 不隐藏或降级真实投影异常 |
| 可售床位选区 | 任意 active 床位连续多晚均 available、无冲突、WRITE 且投影新鲜 | 快捷菜单显示“创建住宿”，点击后日期和床位完整带入既有住宿创建流程 | 不因其他房间的 inactive 历史库存丢失动作 |
| 受阻选区 | 任一晚不可售/有冲突，或投影/权限/恢复状态不可写 | 不显示创建入口 | 保留查看房态记录并继续 fail closed |
| 下线父房间 | ROOM active=false | 房间及其床位不进入当前矩阵或分页 | 审计异常任务可继续引用稳定库存 ID |

</frozen-after-approval>

## Code Map

- `packages/db/src/room-status.ts` -- 构建房态展示树、筛选、分页、汇总及允许动作。
- `apps/web/src/pages/InventoryPage.tsx` -- 根据投影状态执行全局写闸门；本次用于确认 READY 后既有动作自动恢复。
- `apps/web/src/room-status/RoomStatusGrid.tsx` -- 显示 PARTIAL 提示并消费后端展示树；本次用于端到端验收，不隐藏真实警告。
- `tests/integration/room-status-projection.integration.test.ts` -- 覆盖 inactive 库存的投影、审计与汇总边界。
- `tests/e2e/room-status-stage-1.spec.ts` -- 覆盖床位连续拖选到创建住宿的用户流程。

## Tasks & Acceptance

**Execution:**
- [x] `packages/db/src/room-status.ts` -- 将内部全量库存索引与 active 展示树分离；用 active children 完成床位目录闭合校验，保证下线单元不出现在矩阵、分页、筛选选项和可售汇总中，同时保留历史/异常引用。
- [x] `tests/integration/room-status-projection.integration.test.ts` -- 新增 inactive 房间/床位隐藏、双人间目录闭合、READY 投影、审计保留和真实异常继续 PARTIAL 的回归测试。
- [x] `tests/e2e/room-status-stage-1.spec.ts` -- 新增正常页面无错误提示、任意可售房间/床位快捷入口和右侧抽屉执行操作恢复的回归测试。

**Acceptance Criteria:**
- Given 105、108、206 已按目录更正为两人间，when 打开并展开任一房间，then 只显示 A、B 两个床位，各自的 C、D 在任何当前房态列表和筛选结果中均不可见。
- Given 当前有效库存目录闭合且不存在其他真实投影异常，when 打开房态页，then 投影为 READY、顶部不出现“投影不完整”提示，快捷入口和右侧抽屉按既有权限正常显示执行操作。
- Given 任意 active 床位的连续选区均为可售且操作者具有写权限，when 横向拖选该区间，then 快捷菜单显示“创建住宿”，并可进入既有创建订单/免费住宿办理流程。
- Given 选区任一晚受阻或投影不满足安全写入条件，when 打开快捷菜单，then 不显示创建入口且不会产生写命令。
- Given 下线库存存在历史业务引用，when 查询房态审计/异常事实，then 仍能通过原稳定 ID 追溯，且不污染当前矩阵。

## Spec Change Log

- 2026-08-08：方案 A 完成。当前展示树仅包含 active 房间与床位；隐藏库存仍保留审计引用，存在真实当前占用时继续 fail closed。

## Design Notes

展示集合与审计集合必须分离：`unitsById` 可继续保留完整库存身份供历史投影和异常任务使用；床位目录闭合、桌面和移动端共同消费的 `rooms` 展示树则只允许 active ROOM 和 active BED。本次不单独恢复或强制显示按钮，而是修正导致全局 PARTIAL 的错误目录输入，让既有 READY/WRITE 安全闸门恢复正常。

## Verification

**Commands:**
- `npm run test -- tests/integration/room-status-projection.integration.test.ts` -- inactive 展示/审计边界通过。
- `npx playwright test tests/e2e/room-status-stage-1.spec.ts` -- 页面 READY、快捷入口、右侧抽屉和连续床位选区验收通过。
- `npm run typecheck` -- TypeScript 类型检查通过。
- `npm run build` -- 生产构建通过。
- `git diff --check` -- 无空白错误。

**Gate Results:**
- 房态投影 Integration：`24/24` 通过；覆盖 inactive C/D 不进入展示、投影恢复 READY、审计引用保留、隐藏库存存在 active 事实和有效目录不闭合时继续 PARTIAL。
- 默认 Vitest：`34 files / 710 tests` 通过。
- Stage 1 桌面 E2E：`5/5` 通过（移动端 5 项按测试范围跳过）；新增用例覆盖 102B 四晚拖选、无 PARTIAL 提示及住宿办理抽屉操作恢复。
- TypeScript、production build 与 `git diff --check` 通过。
- 本地 `qintopia` 数据库实测：投影 READY、44 间房不变；105/108/206 各自只返回 A/B，inactive 展示数为 0；可售床位快捷菜单与住宿办理抽屉执行操作恢复。

## Suggested Review Order

**有效库存展示树**

- 从全量审计索引派生 active 展示树，统一销售模式、容量和子床集合。
  [`room-status.ts:1097`](../packages/db/src/room-status.ts#L1097)

- 矩阵、汇总、筛选和分页共同消费同一 active 展示树。
  [`room-status.ts:1736`](../packages/db/src/room-status.ts#L1736)

**安全降级边界**

- 隐藏库存的真实当前事实继续触发 PARTIAL，并保留可追溯引用。
  [`room-status.ts:1701`](../packages/db/src/room-status.ts#L1701)

- 容量仅在父房与 active 子床完全一致时闭合。
  [`room-status.ts:551`](../packages/db/src/room-status.ts#L551)

**回归证据**

- 集成测试覆盖隐藏、审计保留、真实异常及容量不一致边界。
  [`room-status-projection.integration.test.ts:1361`](../tests/integration/room-status-projection.integration.test.ts#L1361)

- E2E 复现 102B 四晚拖选并验证抽屉操作可执行。
  [`room-status-stage-1.spec.ts:130`](../tests/e2e/room-status-stage-1.spec.ts#L130)
