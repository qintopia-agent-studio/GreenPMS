---
title: '修复迁移逾期在住房态投影被前端拒绝'
type: 'bugfix'
created: '2026-08-10'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'b3544a9'
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/QinTopia-PMS-2026历史订单导入-实施规格.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** V6 历史订单导入后，后端按已批准规则把周慧玲的 active migration overdue hold 投影为 306 房间的 `OVERDUE_IN_HOUSE` 阻断区间；前端校验器仍无条件拒绝所有这类区间，导致整张房态日历失败关闭。

**Approach:** 前端只接受由专用迁移锁稳定证据完整支撑的 `OVERDUE_IN_HOUSE` 区间，同时继续拒绝普通逾期订单状态推断、缺证据或不一致的阻断；不改变后端投影、库存、订单或金额事实。

## Boundaries & Constraints

**Always:** 允许条件必须同时绑定 `ORDER/FREE_STAY` 住宿来源、`IN_HOUSE`、不可售阻断、零 Claim/CLAIM 引用、各自恰好一个稳定 `ORDER + STAY + BLOCK` 引用，以及恰好一条 `SYSTEM / MIGRATED_OVERDUE_HOLD` 历史；该历史不得带 actor、command、Receipt 或 correlation。日级、区间级和单元级冲突仍需精确互相对应。普通已过计划退房日但没有 migration hold 的订单继续遵守 4.1：不能自动延长当前或未来房态。任何缺失、伪造或不一致数据继续失败关闭。

**Ask First:** 若修复需要改变数据库记录、迁移锁生命周期、后端 DTO/Schema、普通入住/退房规则、房态可售算法或周慧玲的真实离店/续住事实，停止并重新确认范围。

**Never:** 不删除或绕过房态 DTO 校验；不把所有 `OVERDUE_IN_HOUSE` 全局放行；不将订单 `CHECKED_IN` 状态本身当作未来库存依据；不自动解除 migration hold、补写 Claim、推断真实离店日或重算历史金额。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 已批准迁移锁 | `IN_HOUSE` 阻断区间，`OVERDUE_IN_HOUSE`，零 Claim，含匹配 ORDER/STAY/BLOCK 和迁移历史 | DTO 校验通过；306 在查询窗口内显示在住且不可售，其他房态正常显示 | N/A |
| 普通逾期订单 | 只有订单状态或普通逾期异常，没有专用 BLOCK/迁移历史 | 不得延长当前或未来房态 | DTO 若伪造阻断则失败关闭 |
| 迁移证据不完整 | 缺 BLOCK、缺迁移历史、错误状态、携带 Claim 或引用不匹配 | 不接受该 DTO | 明确指出迁移逾期证据不完整 |
| 迁移锁已处理 | 后端解除 hold 并改为真实 Claim 支撑的续住区间 | 继续按现有 Claim 规则校验和展示 | 不保留旧迁移锁例外 |

</frozen-after-approval>

## Code Map

- `apps/web/src/room-status/roomStatusValidation.ts` -- 房态 DTO 的客户端失败关闭边界；当前无条件拒绝 `OVERDUE_IN_HOUSE`。
- `apps/web/src/room-status/roomStatusValidation.test.ts` -- 前端 DTO 合法/伪造房态矩阵。
- `packages/db/src/room-status.ts` -- 生成专用 migration overdue hold 的 BLOCK、ORDER、STAY、SYSTEM history 和冲突事实。
- `tests/integration/historical-order-import.integration.test.ts` -- 已证明 active hold 阻塞 availability、投影房态并在处理后转为 Claim。

## Tasks & Acceptance

**Execution:**
- [x] `apps/web/src/room-status/roomStatusValidation.ts` -- 增加窄范围的迁移逾期证据校验，替代无条件拒绝；保留普通逾期和畸形 DTO 的失败关闭。
- [x] `apps/web/src/room-status/roomStatusValidation.test.ts` -- 增加有效迁移锁、缺 BLOCK、缺迁移历史、错误状态/Claim 形状及普通逾期回归。
- [x] `tests/integration/historical-order-import.integration.test.ts` -- 把 Resolve 前后的真实后端房态送入前端 DTO 校验，锁定迁移锁与 Claim 两种跨层契约。
- [x] `待开发项/QinTopia-PMS-2026历史订单导入-实施规格.md` -- 追加 Web validator 仅凭专用 BLOCK 与迁移 SYSTEM history 放行的契约说明。
- [x] `待开发项/QinTopia-PMS-分步开发与人工验收计划.md` -- 完成后追加线上故障、修复边界和验证记录。

**Acceptance Criteria:**
- Given 线上 V6 数据仍含周慧玲 306 active hold，when 查询包含 `2026-08-10` 的房态，then 整张日历成功载入且 306 显示在住、不可售。
- Given 没有 migration hold 的普通逾期在住订单，when 查询当前或未来房态，then 不得凭生命周期状态自动制造阻断区间。
- Given migration overdue DTO 缺少任一稳定证据或内部聚合不一致，when 前端校验，then 房态继续失败关闭且不开放写入。
- Given migration hold 后续由专用操作处理，when 房态重新查询，then 仅显示真实 Claim 支撑的新安排，不依赖迁移例外。

## Spec Change Log

## Design Notes

这是兼容已批准后端契约的客户端窄例外，不是放宽库存规则。`OVERDUE_IN_HOUSE` 只有在区间自身包含唯一专用 `BLOCK` 引用和无行为主体/命令证据的唯一 `SYSTEM / MIGRATED_OVERDUE_HOLD` 历史时才可通过；marker 与 conflict 必须同时存在，且 active hold 必须覆盖锁开始日与查询窗口的完整交集。已有 `assertIntervalConflict`、逐日冲突和单元汇总一致性检查继续执行。普通逾期 `EXCEPTION` task 的既有非阻断规则不变。

客户端校验器消费同一服务端生成的 DTO，不把展示层引用当作关系数据库的第二套身份系统。`ORDER`、`STAY`、hold、房间与日期的实体绑定继续由 `migration_overdue_holds_source_match` 数据库约束及后端单 hold 投影负责；客户端只接受该权威投影公开的完整稳定引用、专用 history、匹配库存与一致冲突聚合。若未来允许外部系统构造该 DTO，必须另行增加专用 `holdId`/discriminator 后再扩展信任边界。

## Verification

**Commands:**
- `npx vitest run apps/web/src/room-status/roomStatusValidation.test.ts` -- 有效迁移锁通过，缺证据和普通逾期继续拒绝。
- `npx vitest run tests/integration/historical-order-import.integration.test.ts` -- active hold 与处理后 Claim 投影不回归。
- `npm run typecheck` -- TypeScript 通过。
- `npm run build` -- 生产构建通过。
- `git diff --check` -- 补丁格式通过。

**Manual checks (if no CLI):**
- 部署后使用正式 operator 登录，确认房态日历载入、306 为周慧玲在住且不可售，其余房间和写入门禁正常。

## Suggested Review Order

**校验边界**

- 迁移 marker、完整证据与查询覆盖交集在单一入口失败关闭。
  [`roomStatusValidation.ts:222`](../apps/web/src/room-status/roomStatusValidation.ts#L222)

- 普通运营逾期任务继续显式拒绝迁移例外。
  [`roomStatusValidation.ts:398`](../apps/web/src/room-status/roomStatusValidation.ts#L398)

**跨层回归**

- 表驱动矩阵覆盖缺证据、伪造聚合和漏占日期。
  [`roomStatusValidation.test.ts:483`](../apps/web/src/room-status/roomStatusValidation.test.ts#L483)

- PostgreSQL 验证完整板、截断窗口和 Resolve 后清理。
  [`historical-order-import.integration.test.ts:894`](../tests/integration/historical-order-import.integration.test.ts#L894)

**契约记录**

- 历史导入规格冻结 Web 投影信任边界。
  [`QinTopia-PMS-2026历史订单导入-实施规格.md:229`](./QinTopia-PMS-2026历史订单导入-实施规格.md#L229)

- 人工验收计划记录线上故障、范围和验证证据。
  [`QinTopia-PMS-分步开发与人工验收计划.md:395`](./QinTopia-PMS-分步开发与人工验收计划.md#L395)
