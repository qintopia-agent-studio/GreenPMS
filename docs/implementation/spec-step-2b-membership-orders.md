---
title: '第 2 步检查点 2B：会员订单、企微收款与显式生效'
type: 'feature'
created: '2026-07-24'
status: 'accepted'
checkpoint: '2B'
---

# 第 2 步检查点 2B：会员订单、企微收款与显式生效

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 2A 只有独立会员档案；工作人员还不能出售三种固定会员产品、记录多笔企微收款、保留收款更正历史或显式生效一年期 30 夜权益。

**Approach:** 新增独立会员订单聚合与版本化会员产品 catalog。订单创建时锁定产品、标价、成交价和调价原因；企微收款与更正使用追加事实；显式生效时在同一 PostgreSQL 事务中创建一年期会员合同和单个 30 夜权益 Lot。

## Boundaries & Constraints

**Always:** 三种产品固定为公卫单人间 `¥1,620 / 30 ROOM_NIGHT`、独卫单人间 `¥2,160 / 30 ROOM_NIGHT`、公卫四人间 `¥936 / 30 BED_NIGHT`。成交价偏离标价时原因必填。每笔企微收款保存独立交易单号；交易号不施加未经确认的全局唯一约束。收款合计与成交价不同只显示差额，不阻止明确生效。生效日期使用门店时区，截止日期为生效日期一年后。

**Ask First:** 若必须改变三个产品、默认价、30 夜、一年有效期、允许零笔收款生效，或需要引入支付平台到账/结清推断，立即停止并确认。

**Never:** 不原地编辑或删除收款事实，不把订单来源当支付方式，不实现退费；不进入 2C 的余额更正、房型匹配、住宿覆盖、冻结或核销；不读取旧 PMS/FewohBee 项目。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 创建会员订单 | 会员、产品、成交价 | 保存待生效订单与价格快照 | 偏离默认价但无原因时零写入 |
| 多笔企微收款 | 正整数分金额、独立交易号 | 每笔追加不可变 COLLECTION | 非正金额或空交易号拒绝 |
| 更正收款 | 原有效收款、新金额、新交易号 | 原收款追加 REVERSAL，再追加 replacement COLLECTION | 已更正/非本订单事实拒绝且零部分写入 |
| 无收款生效 | 待生效订单、有效收款为 0 | 不生效、不发权益 | 中文明确拒绝 |
| 差额生效 | 有至少一笔收款，合计不等于成交价 | 显示差额但允许明确生效 | 不自动改价、不推断结清 |
| 重复生效 | 已生效订单或幂等重放 | 原请求返回原结果；新请求明确拒绝 | 不重复创建合同、Lot 或 30 夜 |

## Data and Command Model

- `membership_products`：门店范围内的版本化已发布产品，保存产品 code、名称、价格、权益类型、30 夜、允许房型与销售单位。
- `membership_orders`：保存不可变产品/价格快照、待生效/已生效状态、版本、生效时间、有效日期及生成的合同/Lot 引用。
- `membership_payment_facts`：追加 `COLLECTION` / `REVERSAL`；replacement COLLECTION 引用被更正事实，REVERSAL 以唯一 `reverses_fact_id` 防止重复冲销。
- Commands：`CREATE_MEMBERSHIP_ORDER`、`RECORD_MEMBERSHIP_PAYMENT`、`CORRECT_MEMBERSHIP_PAYMENT`、`ACTIVATE_MEMBERSHIP_ORDER`。
- 生效事务：锁会员订单和收款事实，重算有效收款净额，写入 `member_contracts`、`entitlement_lots(total_units=30)`，再将订单切换为 `ACTIVE`；任一步失败全部回滚。

## Tasks & Acceptance

- [x] 新增 2B migration、产品种子、所有权/追加事实/单次生效约束。
- [x] 新增四类 Command 的 Preview/Confirm、并发锁、幂等、陈旧预览和原子回滚。
- [x] 扩展会员详情 Query，返回会员订单、有效收款、差额和完整更正历史。
- [x] 实现中文会员订单创建、收款、更正、生效及成功/失败恢复界面。
- [x] 完成 unit、PostgreSQL integration、OpenAPI contract、桌面/移动 E2E 和人工验收数据。

**Acceptance Criteria:**

- Given 三种产品，when 创建订单，then 默认价和 30 夜类型正确；改价时原因必填且标价、成交价、差额和原因可见。
- Given 一张待生效订单，when 追加两笔企微收款，then 两个交易单号和金额独立可见，差额不阻止生效。
- Given 一笔有效收款，when 更正，then 原收款、冲销和 replacement 均可见，净收款只计算当前有效事实。
- Given 零笔收款，when 生效，then 零合同/零 Lot；given 至少一笔收款，when 生效，then 一次性创建一年期合同和 30 夜 Lot。
- Given 幂等重放、并发生效或任一步失败，when 服务端处理，then 最多一张合同和一个 Lot，历史与审计完整。

</frozen-after-approval>

## Spec Change Log

- 2026-07-24：2A 人工验收通过后创建 2B 实施规格；2C 保持未开始。
- 2026-07-24：2B 实现与自动化验证完成，状态转为等待人工验收；未进入 2C。
- 2026-07-24：用户完成 2B 人工验收，三产品、调价、收款、更正与生效旅程符合预期；状态转为 accepted，允许开始 2C。
- 2026-09-02：第 9 步重新确认一个更窄的管理员例外。普通实时办卡仍按本规格以物业当天显式生效；`BACKFILL_HISTORICAL_MEMBERSHIP` 可在证据完整且会员链截至物业营业日仍有效时，以真实付款业务日期补录，系统记录时间仍为当前。`CORRECT_MEMBERSHIP_EFFECTIVE_DATE` 可追加式纠正当前有效链日期，但不得改变生命周期状态、资金、产品、权益数量或余额；该例外不开放普通订单编辑。
- 2026-09-03：进一步冻结永久历史补录的价格边界：`BACKFILL_HISTORICAL_MEMBERSHIP` 不接受管理员输入成交价，订单标价与成交价均取已发布产品标价，调价为零；真实正数 COLLECTION 作为独立事实可少付或多付，沿用本规格“仅显示差额、不阻止明确生效、不自动改价”的既有规则。历史折扣或特批成交价仅由版本化一次性过渡程序处理。

## Dev Agent Record

### Completion Notes

- 完成三种固定产品、会员订单价格快照、多笔企微收款、更正事实与显式生效的一体化 Web/API/PostgreSQL 旅程。
- 生效在同一事务中创建一年期合同和单个 30 夜 Lot；幂等重放、陈旧预览及并发生效均验证最多一次写入。
- 中文界面直接进入核对页，成功、拒绝和恢复路径均不展示内部 ID；桌面与移动布局通过截图及横向溢出检查。

### Validation

- TypeScript：通过。
- Unit：`213/213` 通过。
- PostgreSQL integration：2B `4/4` 通过；全套 `145/146`，唯一失败为第 1 步既有的已入住订单换房后缩短用例，不属于 2B。
- Contract / production build：`56/56` 通过。
- Playwright 2B desktop + mobile：`2/2` 通过。
- Pricing facts：`7/7` 通过；`git diff --check` 通过。
