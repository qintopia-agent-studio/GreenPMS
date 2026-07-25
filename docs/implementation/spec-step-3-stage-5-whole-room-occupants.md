---
title: 'Step 3 Stage 5 Whole-Room Occupants'
type: 'feature'
created: '2026-07-24'
status: 'accepted'
review_loop_iteration: 2
baseline_commit: 'ce0091c0d27b7cff2d5df0c7f6d142ce6546dc9d'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 整房订单目前只保存主要居住人，大床房、双人间和多人间整房实际入住多人时无法登记同行人，房态因此只能显示一个昵称。

**Approach:** 保留现有主要居住人合同，新增有序同行人、独立住宿容量和稳定住宿人 ID；整房房态显示全部昵称与人数，完整资料仅在订单视图展示，并为阶段 7 的逐人更正保留目标。

## Boundaries & Constraints

**Always:** `CREATE_ORDER` 保留一位不可删除的主要居住人，并可按权威住宿容量增加同行人；每人姓名、昵称必填，电话、证件号可选。顺序稳定且同名不去重。床位容量为 1；房间使用独立住宿容量，大床房和双人房可为 2。会员只预填和关联主要居住人。历史订单原样回填一位主要住宿人，不补造同行人。房态只投影住宿人 ID、昵称和人数；完整资料仅在获权订单视图显示。

**Ask First:** 改变已确认容量、允许超容量、替换主要居住人、关联同行人与会员，或在房态展示个人资料。

**Never:** 不以实体床数推测容量或虚构人数；不以姓名冒充历史昵称；不覆盖历史快照；不向房态 DTO、Tooltip、移动摘要或无障碍名称泄露个人资料；不进入阶段 6。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 整房多人 | 容量 2 的房间提交两人 | Preview、Receipt、详情和房态保持顺序；房态显示全部昵称与 `2人` | N/A |
| 床位或超容量 | 床位提交两人，或人数超容量 | Preview 前拒绝，零业务写入 | 返回容量错误 |
| 会员同行人 | 会员主要居住人加同行人 | 仅首人预填和关联；同行人不被覆盖 | 不修改会员主档 |
| 历史订单 | 只有旧主要快照 | 得到一位住宿人；空昵称显示“历史未记录” | 不补造数据 |
| 隐私 | 住宿人含电话、证件号 | 房态只返回 ID、昵称、人数 | 泄露即失败 |

</frozen-after-approval>

## Code Map

- `packages/db/src/migrations/020_whole_room_occupants.sql`、`schema.ts` -- 住宿容量、append-only 住宿人及历史回填。
- `packages/contracts/src/index.ts`、`apps/api/src/schemas.ts`、`packages/db/src/commands/*` -- additive 输入、容量校验、Preview/Confirm/Receipt 与幂等。
- `packages/db/src/{orders,room-status,inventory}.ts` -- 有序查询、隐私房态投影和容量。
- `apps/web/src/pages/InventoryPage.tsx`、`room-status/*`、订单页面 -- 动态表单、全昵称、人数和详情。

## Tasks & Acceptance

**Execution:**
- [x] 更新两份计划；增加迁移、schema、合同、数据库门禁和历史回填。
- [x] 扩展 Preview/Confirm/Receipt、订单查询和房态批量投影。
- [x] 实现动态表单、订单详情、桌面/手机全昵称和人数。
- [x] 增加单元、集成、合同、E2E 与专用验收数据。

**Acceptance Criteria:**
- Given 容量 2 的房间，when 创建两人整房订单，then 房态显示两个昵称和 `2人`，详情显示两份快照。
- Given 床位订单或超容量名单，when 请求 Preview，then 命令失败且所有业务表零写入。
- Given 同名、历史空昵称或长昵称，when 查看桌面和手机房态，then 顺序、人数及昵称正确，无 `+N`、截断、隐私泄露或溢出。
- Given 会员订单添加同行人，when 报价刷新并创建，then 只预填首人，同行资料与会员主档不变。

## Spec Change Log

- 2026-07-24：人工验收确认默认房态不重复显示住宿文字横条；整房与父房聚合格仅显示逐日昵称、人数/比例和业务状态，维修/锁房等 Block 横条保留。点击后的整段连续高亮和右侧订单入口仍由阶段 7 实施。
- 2026-07-24：用户完成复验并回复“检查完了，继续”，阶段 5 状态转为 `accepted`，允许进入阶段 6；阶段 7 仍未开始。

## Design Notes

保留 `orders.primary_guest_snapshot` 兼容旧客户端；`order_occupants` 是新订单权威名单，历史订单迁为 ordinal 1。阶段 7 通过稳定 occupant ID 追加 correction，不更新初始快照。

## Verification

**Commands:**
- `npm run typecheck && npm test && npm run test:integration && npm run test:contract` -- 全部通过。
- `npm run test:e2e && npm run test:pricing-facts && npm run build && git diff --check` -- 全部通过。

**Manual checks (if no CLI):**
- 在大床房和整间双人房登记两人，确认房态横排全部昵称与 `2人`，订单详情资料完整；床位添加第二人明确被拒绝。

## Suggested Review Order

1. 从房态查看 `101` 四人间的 `2/4`、`3/4`、`4/4`、同名、历史空昵称与维修排除，确认昵称横排且无 `+N`。
2. 查看 `A03` 大床房和 `104` 双人间，确认各自显示两个昵称与 `2人`、默认没有重复的住宿文字横条，订单详情包含两位住宿人完整资料。
3. 创建一笔两人整房订单，核对同行人动态表单、成功回执与订单详情；再用床位尝试添加第二人，确认容量失败关闭。
4. 用桌面宽度检查房态页面无横向溢出；手机人工验收按用户决定留待后续集中进行，自动化手机门禁已通过。
