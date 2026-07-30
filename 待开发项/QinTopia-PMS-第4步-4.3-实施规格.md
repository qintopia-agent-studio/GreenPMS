---
title: 'QinTopia PMS 第 4 步 4.3 在住缩短与提前退房'
type: 'feature'
status: 'accepted'
created: 2026-07-29
review_loop_iteration: 1
baseline_commit: '4c24a87'
checkpoint: 4.3
technical_stage: 10
human_acceptance_command: 4.3 通过
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
  - '待开发项/QinTopia-PMS-第4步-4.1-实施规格.md'
  - '待开发项/QinTopia-PMS-第4步-4.2-实施规格.md'
  - 'docs/implementation/spec-qintopia-pms-core-operations-mvp.md'
  - 'docs/architecture/invariants-and-decisions.md'
---

# QinTopia PMS 第 4 步 4.3 实施规格

## 1. 权威来源与当前状态

本规格只实施正式检查点 4.3 / 工程阶段 10“在住缩短、提前退房与退款参考”。用户已于 2026-07-29 明确回复 `4.2 通过`，并确认本规格的两个最终边界：

1. 入住当天不提供提前退房或钟点房模型。未实际使用房间的“撤销入住”归 4.5 / 阶段 12；确认实际使用后的当天离店当前版本失败关闭。
2. 已完成的历史换房不阻断缩短；营业日当日或以后尚未生效的未来换房安排由 4.4 / 阶段 11 处理，4.3 不裁剪或猜测该时间线。

4.3 是 A 级切片，必须完成实施规格、开发、系统自动检查、独立实例和逐步人工验收。4.4 及以后不得提前实现。

## 2. Why

4.1 人工验收已经证明，普通退房若在计划退房日前只释放库存而不缩短安排、不重价，会形成“订单日期和金额未变，但库存已释放”的半完成状态。工作人员需要一个原子操作，把在住缩短、真实离店原因、完整重价、库存释放、提前退房状态和退款参考同时提交；失败时任何业务事实都不能部分生效。

## 3. Capabilities 与成功信号

- **CAP-1 在住缩短后继续住宿**
  - **intent:** 工作人员可把在住订单退房日缩到营业日之后，并保留同一订单和 Stay。
  - **success:** 新安排、完整重价、库存差集、历史和页面刷新同事务完成，状态仍为“在住”。
- **CAP-2 原子提前退房**
  - **intent:** 至少已履行一晚的住客可在计划退房日前按当前营业日提前退房。
  - **success:** 真实原因、新安排、新计价、营业日及以后库存释放、已退房状态和履约结果一次成功或全部失败。
- **CAP-3 退款参考**
  - **intent:** 工作人员能看到缩短后是否存在建议退款金额，而不会误认为系统已经退款。
  - **success:** 仅当净收款高于新订单金额时显示正数退款参考；4.3 不新增任何资金事实。
- **CAP-4 严格失败关闭**
  - **intent:** 非法日期、入住当天、未来换房、损坏生命周期、陈旧确认、权限变化和并发冲突均不能产生半笔变更。
  - **success:** 自动化逐表证明业务事实零变化；既有恢复协议只可保存 `REJECTED/NOT_EXECUTED` 命令结果。

## 4. Constraints

- 所有日期使用物业时区的半开区间 `[arrivalDate, departureDate)`，并保持 `departureDate > arrivalDate`。
- 只允许状态为 `CHECKED_IN` 的订单使用 `SHORTEN_STAY`。
- 保留同一 `orderId/stayId`，不得删除、取消后重下或覆盖旧 segment、amendment、revision、履约和权益事实。
- 成功使用原锁定 `pricingPolicyVersionId` 对缩短后的完整有效时间线重价，不能按减少晚数简单相减。
- 普通 `CHECK_OUT` 继续只处理计划日/迟录退房，不能成为提前退房旁路。
- 已 `CONSUMED` 的会员权益不恢复、不改写，4.3 不追加 RELEASE 或补偿权益事实。
- 清洁工作流继续停用，不生成、投影或完成清洁任务。
- 任何工作人员可见页面不得展示内部 Command、Preview、Receipt、revision、segment 或 raw payload 标识。

## 5. Non-goals

- 不实现入住当天的提前退房、零夜住宿或钟点房。
- 不实现“撤销入住”；归 4.5 / 阶段 12。
- 不新增或裁剪尚未生效的未来换房安排；归 4.4 / 阶段 11。
- 不登记真实退款、收款、冲销或支付交易号；归 4.6 / 阶段 13。
- 不实现取消、未到、20:00 门禁或普通取消退款参考；归 4.5。
- 不重新启用清洁，不修改清洁 schema 或历史记录。
- 不扩大房态日期窗口，不进入第 5 步连续 30 天时间轴。
- 不借本切片重做 U2 信息架构、会员主档或外部财务对账。

## 6. 状态与日期矩阵

设旧安排为 `[arrivalDate, oldDepartureDate)`，新退房日为 `newDepartureDate`，当前物业营业日为 `businessDate`。

| 当前状态/条件 | 新退房日 | 结果 |
|---|---|---|
| `CHECKED_IN` 且 `arrivalDate < businessDate < oldDepartureDate` | `businessDate < newDepartureDate < oldDepartureDate` | 缩短后继续在住 |
| 同上 | `newDepartureDate = businessDate` | 原子提前退房，立即释放 `[businessDate, oldDepartureDate)` 库存 |
| 同上 | `newDepartureDate < businessDate` | 拒绝追溯改写，零业务写入 |
| 同上 | `newDepartureDate = oldDepartureDate` | 拒绝无变化 |
| 同上 | `newDepartureDate > oldDepartureDate` | 不属 4.3，使用 4.2 延长住宿 |
| `CHECKED_IN` 且 `arrivalDate = businessDate` | 任意 `<= businessDate` | 拒绝；未实际使用房间时等待 4.5 撤销入住 |
| `CHECKED_IN` 且 `businessDate = oldDepartureDate` | `newDepartureDate = oldDepartureDate` | 使用 4.1 普通退房，不是缩短 |
| `CHECKED_IN` 且 `businessDate > oldDepartureDate` | 任意 `<= businessDate` | 拒绝缩短；使用 4.1 迟录退房 |
| `RESERVED` | 任意 | 拒绝；使用 4.2 调整预订日期 |
| `CHECKED_OUT/CANCELLED/NO_SHOW` | 任意 | 拒绝，零业务写入 |

`newDepartureDate` 还必须严格早于 `oldDepartureDate`。Preview 与 Confirm 都必须使用服务端营业日重新判断，Web 不得自行放宽。

## 7. 未来换房边界

- 从不可变安排重建营业日时的有效时间线，不以最新 segment 猜测实际房间。
- 未来换房使用明确算法判定：按 `serviceDate` 排序后，对每个 `i > 0` 比较相邻日期的 `inventoryUnitId`；发生变化时，以 `timeline[i].serviceDate` 作为房源转换生效日。只要任一转换生效日 `>= businessDate` 即拒绝。
- 房源转换的生效服务日期 `< businessDate` 时视为已完成历史换房，可保留历史并缩短当前最后一段。
- 只要存在生效服务日期 `>= businessDate` 的房源转换，本阶段拒绝并显示“该订单已有尚未生效的换房安排，请在换房流程中处理后再缩短住宿”。
- 拒绝时不得释放未来换房 Claim、不得新增 revision 或改变当前状态。
- 阶段 11 将负责同时裁剪未来换房安排和释放相应库存；4.3 不提前实现。

## 8. Command、DTO 与 OpenAPI

继续使用历史协议中的 `SHORTEN_STAY`，但把它从失败关闭占位升级为本规格的唯一写命令：

```ts
interface ShortenStayInput {
  propertyId: string;
  orderId: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}
```

- 住宿变更/离店原因通过 Confirm `reason` 提交，`note` 去除首尾空白后必须非空。Preview 不接收该 Confirm 字段；Web 第一层先校验，Confirm/API/service 再权威拒绝空原因。
- Web 使用稳定原因码，工作人员只填写真实说明；不得自动填“办理退房”或“按计划退房”。
- `targetCurrentContractAmountMinor` 必须是非负整元 minor units：`0..2_147_483_600` 且 `multipleOf: 100`。
- contracts、OpenAPI、API schema 与领域共同保持 `additionalProperties: false`，拒绝角分、溢出和不适用字段。
- Effect 明确返回 `completionMode: SHORTEN_IN_HOUSE | EARLY_CHECK_OUT`、before/after、完整计价、库存差集、专用 `entitlementSummary`、资金摘要和独立非负 `refundReferenceAmount`。
- `refundReferenceAmount = max(0, netRecordedCollection - newCurrentContractAmount)`，不能由 Web 反转 `collectionDifference` 后自行猜测。
- `refundReferenceAmount` 使用专用 `NonNegativeMoney`：`currency` 与新 revision 一致，`minorUnits` 是 `0..2_147_483_647` 的安全整数；Effect 与 Receipt 均始终返回，Web 只在大于 0 时显示。
- Receipt 的业务结果固定返回 `orderId`、`stayId`、`arrangementAmendmentId`、`checkoutAmendmentId: Id | null`、`staySegmentId`、`pricingRevisionId`、`completionMode`、`fulfillmentTiming: object | null`、资金摘要和退款参考；Web 不展示内部引用。
- Order Query 的当前金额摘要和每条住宿安排变更资金摘要也返回服务端计算的非负 `refundReferenceAmount`，使刷新后的订单页仍可追溯当时建议退款；前端不得从负 `collectionDifference` 反推退款。

## 9. 完整重价规则

使用订单成交时锁定的政策版本，对缩短后的完整连续住宿时间线重新选择 1/7/14/30 夜档；跨月不拆，最终总额只舍入一次。

| 订单类型 | 本次价格输入 | 新 revision |
|---|---|---|
| `YOUMUDAO/CTRIP/MEITUAN` | 必须重新填写“本单渠道应结金额”；旧渠道目标金额不继承。`abs(target - policyBase) * 100 > policyBase * 15` 时渠道价格差异说明必填 | `CHANNEL_CONTRACT`，`manualAdjustmentMinor = 0` |
| `WECOM` | 默认本次政策基础金额；主动偏离时必须填写新的人工调价原因 | 默认 `POLICY`，偏价为 `MANUAL_ADJUSTMENT` |
| 会员住宿 | 禁止渠道/人工目标金额；保留已核销事实并重新形成当前安排的覆盖/现金摘要 | `MEMBER_ENTITLEMENT` |
| 免费住宿 | 禁止金额输入，始终为 0 | `FREE` |

- 新 revision 不继承旧渠道金额、旧人工偏价或旧价格说明。
- `policyBaseAmountMinor`、`currentContractAmountMinor`、`pricingBasis`、差额和说明写入同一个完整 revision。
- `collectionDifference = newCurrentContractAmount - netRecordedCollection` 保持原语义：正数为待补收参考，负数为多收，零为当前记录无差额。
- 退款参考使用独立非负字段，只有大于 0 时才在页面显示“建议退款”。

## 10. 住宿安排、履约与库存

### 10.1 缩短后继续在住

- 追加一个 `SHORTEN_STAY` amendment、一个不可变住宿安排版本和一个完整 pricing revision。
- 更新订单当前退房日、当前 revision 和版本；Order/Stay 状态保持 `CHECKED_IN/IN_HOUSE`。
- 交集 Claim 保持原 ID；精确释放 `[newDepartureDate, oldDepartureDate)`，不得先全量释放再重建。

### 10.2 原子提前退房

- 设命令前订单版本为 `V`。同一 `SHORTEN_STAY` command 中先追加 `SHORTEN_STAY` 安排/计价 amendment：`sequence/new_version = V + 1`、`prior_version = V`；再追加 typed `CHECK_OUT` 履约 amendment：`sequence/new_version = V + 2`、`prior_version = V + 1`。最终 `order.version = V + 2`。
- 两条 amendment 必须属于同一订单、引用同一 `command_id`、保存同一工作人员真实原因；只新增一个 `SHORTEN_STAY` segment 和一个关联首条 amendment 的 pricing revision，第二条 amendment 不新增 segment 或 revision。
- pricing revision 关联 `SHORTEN_STAY` amendment；`CHECK_OUT` 履约记录 `effectiveDate = businessDate`、`businessDate` 和系统记录时间。
- 第二条 `CHECK_OUT` payload 是独立 typed 状态 effect：`fromStatus = CHECKED_IN`、`toStatus = CHECKED_OUT`、`effectiveDate = businessDate`、`businessDate`、`recordingMode = ON_SCHEDULE`，且不含清洁任务；不得把完整 `SHORTEN_STAY` effect 原样复用为履约 payload。
- Order/Stay 原子转为 `CHECKED_OUT/COMPLETED`，当前退房日更新为 `businessDate`。
- 对操作员与可售库存，立即恢复 `[businessDate, oldDepartureDate)`，包括营业日当天。数据库同时关闭该订单全部仍为 active 的 `ORDER_SEGMENT` Claim：营业日前的 Claim 关闭只是结束终态订单的 Claim 生命周期，不计入可售释放量，也不改变历史住宿安排。
- Receipt 同时引用两个 amendment；工作人员页面把它呈现为一次“提前退房”，订单变更历史与履约结果分别可追溯，不显示成两次人工操作。

### 10.3 缩短后继续在住的版本

- 设命令前订单版本为 `V`，只追加一条 `SHORTEN_STAY` amendment：`sequence/new_version = V + 1`、`prior_version = V`，最终 `order.version = V + 1`。
- 只新增一个 segment 和一个关联该 amendment 的 pricing revision，不追加 `CHECK_OUT`。

### 10.4 锁顺序

- 对旧/新时间线涉及的 `roomId + serviceDate` 去重并稳定排序后 `FOR UPDATE`。
- 交集 Claim 身份保持不变，删除差集精确释放。
- 任一冲突、陈旧 basis 或写入失败时，旧 Claim 不得提前释放。

## 11. 会员权益

- CHECK_IN 时形成的全部 `CONSUMED` coverage 和 CONSUME ledger 永不恢复、删除或改写，即使其服务日期落在被缩短掉的未来区间。
- 4.3 不写 HOLD、RELEASE、CONSUME 或补偿权益事实，不再次核销。
- Stage 10 独立 apply 分支禁止调用 `releaseCoverage`、`reconcileCoverage`、`holdCoverage`、`consumeCoverage` 或 `bumpMembershipForCoverage`；`coverage_items` 全行、`member_contracts.version`、`entitlement_lots.version` 和 `entitlement_ledger` 必须保持不变。
- 会员重价只能复用新区间内原有的 `CONSUMED` coverage；Effect 与新 revision 的 coverage 集合必须严格等于原 `CONSUMED` 集合对新区间的日期子集。不得调用会员权益重新分配逻辑，也不得把后来新增或重新可用的权益分配给原先现金覆盖的住宿日。
- 新 revision 的覆盖/现金摘要只表达上述既有权益子集和缩短后当前合同金额；被缩短日期上的历史已核销 coverage 继续可查询，但不进入新 revision 的当前 coverage 集合。
- `entitlementSummary` 固定包含 `currentConsumedCoverageDates`、`retainedHistoricalConsumedCoverageDates` 和字面值 `ledgerWriteCount: 0`；不得复用 Stage 9 的 released/added diff 造成“已恢复权益”的错误含义。
- 在住订单若残留本应已核销的 `HELD` coverage、coverage 与订单/Stay/房型不一致，Preview 前失败关闭，不能在缩短中顺手修复。
- 免费和现金订单不得产生会员账本写入。

## 12. PostgreSQL 原子事务

Confirm 复用阶段 9 的单事务主干，顺序冻结为：

1. 重验主体、物业 WRITE 权限、命令类型、Preview、幂等范围和输入 hash。
2. 锁定订单，重读 Order/Stay 状态、版本、当前 revision、不可变安排、履约和营业日。
3. 复用完整生命周期投影验证 amendment sequence、segment supersession、revision 指针和状态一致性。
4. 识别并拒绝营业日当日或以后的未来换房；锁定会员相关合同/Lot和旧/新日期并集的 room-day。
5. 使用锁定政策版本重新形成完整 effect，重验渠道/WECOM/免费/会员输入、库存、权益和资金 basis。
6. 比较 effect hash；营业日、权限、订单版本、政策、库存、权益或任一资金事实变化均使旧 Preview 失效。basis 必须包含 collection fact 的稳定 ID、类型、净影响、引用/冲销关系及顺序 hash，不能只包含净收款合计；即使新增 COLLECTION 与 REFUND 后净额恰好不变，旧 Preview 仍须失效。
7. 追加安排 amendment、住宿安排版本和完整 pricing revision；提前退房再追加 typed CHECK_OUT 履约 amendment。
8. 继续在住时精确释放 Claim 差集；提前退房时关闭订单全部 active Claim，同时只把营业日及以后的日期报告为恢复可售；不写会员或资金事实。
9. 更新 Order/Stay 当前日期、revision、状态和版本，写审计、房态 revision、Command 与 Receipt。
10. 一次提交。

新增 migration 必须在 PostgreSQL 层守住：

- `SHORTEN_STAY` revision 只能属于同一订单、`CHECKED_IN` 状态和严格缩短日期。
- 新退房日不得早于或等于到店日；入住当天提前退房不能写入。
- pricing basis、整元范围、免费 0 元、会员和渠道规则与阶段 9 等价。
- 提前退房的安排、计价、履约和最终状态必须形成完整组合，不能只插入其中一部分。
- 使用 `DEFERRABLE INITIALLY DEFERRED` 的组合约束在事务提交前检查 `amendments`、`stay_segments`、`pricing_revisions`、`orders`、`stays` 和 active Claim 形状。继续在住必须形成一条 SHORTEN amendment、一个 segment、一个 revision、`order.version = V + 1` 且状态仍在住；提前退房必须形成同 command 的连续 SHORTEN + CHECK_OUT、一个 segment、一个 revision、`order.version = V + 2`、Order/Stay 终态且 active Claim 为零。
- 同一提前退房组合的两条 amendment 必须同订单、同 `command_id`、同 reason；CHECK_OUT typed payload 必须使用本规格的状态与日期字段。
- 普通 `CHECK_OUT` command 的 typed `businessDate` 不得早于当时有效退房日；只有 `command_type = SHORTEN_STAY` 且同 command 形成上述完整组合时才允许计划日前结束住宿。
- PostgreSQL 拒绝任何 `command_type = SHORTEN_STAY` 的命令写入 `entitlement_ledger`；集成测试还必须证明 coverage 全行和会员合同/Lot version 不变。

拒绝命令可以按既有恢复协议在业务事务回滚后保存 `REJECTED/NOT_EXECUTED` Receipt 和拒绝审计，但订单、安排、计价、库存、权益、履约和资金事实必须零变化。

## 13. Web 工作流

- 在住且可合法缩短的订单显示“缩短住宿”；计划退房日前点击“退房”时进入同一 4.3 表单，并明确标题为“提前退房”。
- 入住当天不显示提前退房入口，在操作区显示“入住当天暂不办理提前退房；未实际使用房间时请使用后续的撤销入住流程”。
- 已存在未来换房安排时隐藏写入口并显示服务端中文原因。Query/AllowedActions 必须传入按第 7 节算法计算的 `hasFutureMove`，不得复用“包含多个房源区间”来误伤已完成历史换房。
- 覆盖式抽屉顶部固定显示住客、房号、状态、当前住宿日期和动作名称；不压缩房态表。
- 第一层填写新退房日、真实原因和本订单类型所需金额字段；自动 Preview 后直接显示原日期、新日期、减少晚数、完整新晚数、原金额、政策基础金额、新金额、已登记净收款、差额和建议退款。
- “建议退款”下固定显示“该金额仅供工作人员办理退款参考，目前尚未登记退款”。无正退款参考时不显示可退款措辞。
- 第二层只做一次中文正式核对；陈旧 Preview 保留草稿并要求重新核对。
- 成功后关闭抽屉，刷新房态、订单当前/最后安排、变更历史、计价、金额和履约结果；缩短后继续在住则保持完整 Stay 选择，提前退房则移除已释放日期的占用。
- 今日履约页不得对所有 `IN_HOUSE` 订单直接发送普通 `CHECK_OUT`：计划日前必须进入 4.3 提前退房抽屉；按非当前浏览日期查看时不得把展示日期当成实际营业日发起履约。
- 页面不得要求用户随后发起退款，也不得出现“已退款、已结清、已到账”。

## 14. 失败关闭

- 非 `CHECKED_IN`、无日期变化、延长、追溯日期、入住当天、普通退房旁路、未来换房或非法金额：Preview/Confirm 均拒绝且零业务写入。空住宿变更原因因不属于 Preview input，由 Web 第一层与 Confirm/API/service 拒绝且零业务写入。
- 损坏 Order/Stay 状态、amendment sequence、segment supersession、revision 链、coverage 或 fulfillment：Preview 前失败关闭。
- Confirm 时营业日跨界必须变成 `PREVIEW_STALE`，不能沿用旧分支结果。
- Command service 将 `SHORTEN_STAY` 的 `VALIDATION_ERROR` 纳入陈旧 Preview 映射；营业日跨界造成“继续在住/提前退房/非法”分支变化时必须返回 `PREVIEW_STALE`。
- 权限从 WRITE 降级、订单并发变化、收款变化、库存变化、幂等异载荷和故障注入全部失败关闭。
- 同载荷幂等重放返回原 Receipt，不新增 amendment、revision、履约或审计业务事实。
- 普通 `CHECK_OUT` 在 `businessDate < departureDate` 时继续拒绝；不能先用 `SHORTEN_STAY` 改到当天后再调用普通退房。

## 15. 自动化门禁

### 15.1 Unit / Domain

- 日期矩阵、未来换房判定、完整重价、15% 整数公式、正退款参考和中文展示。
- Query/Effect DTO 对缺字段、额外字段、符号错误、错误状态和损坏历史失败关闭。
- 入住当天和追溯日期严格拒绝。
- `SHORTEN_STAY` 历史类型只在 typed payload 的 `completionMode = EARLY_CHECK_OUT` 时投影为“提前退房”；`SHORTEN_IN_HOUSE` 投影为“缩短住宿”，缺失或损坏 mode 失败关闭。

### 15.2 Contract / OpenAPI

- `SHORTEN_STAY` 新输入字段、整元范围、`additionalProperties: false` 和 Effect/Receipt 完整形状。
- `refundReferenceAmount` 为独立非负 Money，不能与 `collectionDifference` 混用。
- AllowedActions 与中文原因在 API/Web 一致。

### 15.3 PostgreSQL Integration

- 继续在住、原子提前退房、追溯拒绝、入住当天拒绝、未来换房拒绝。
- 现金、外部渠道、WECOM、免费、会员和合同失效后的会员订单。
- 已 CONSUMED 身份、余额和 ledger 完全不变。
- `coverage_items` 全行、会员合同版本和权益批次版本也完全不变；PostgreSQL 直接尝试为 SHORTEN 写 ledger 必须失败。
- 净收款高于、等于、低于新金额；任何情况均不新增 COLLECTION、REFUND 或 REVERSAL。
- 陈旧 Preview、营业日切换、权限变化、并发、幂等重放、生命周期损坏和逐步故障注入。
- 逐表快照证明拒绝/回滚时订单、Stay、segment、amendment、revision、Claim、coverage、ledger、fulfillment 和 collection facts 无部分变化。

### 15.4 真实 E2E

- 至少一笔缩短后继续在住和一笔原子提前退房，验证房态与订单立即刷新。
- 外部渠道重新填写“本单渠道应结金额”并执行 15% 说明规则；WECOM 政策价/主动偏价；免费 0 元；会员不恢复权益。
- 入住当天、追溯日期和未来换房显示中文原因，不能继续确认。
- 页面停留、滚动和轮询后不回弹，不出现内部枚举、ID 或技术错误。
- 桌面和移动端至少各覆盖一条工作人员路径。

## 16. 人工验收准备

独立验收库必须提供不可重复使用的样例，并在每轮返工后按当前检查点需要重建：

1. 继续在住：新退房日 `> businessDate`，验证完整重价和只释放减少的未来库存。
2. 原子提前退房：`arrivalDate < businessDate = newDepartureDate < oldDepartureDate`，填写真实原因；验证营业日及以后库存立即可售、状态已退房和建议退款。
3. 追溯拒绝：`newDepartureDate < businessDate`，验证零变化。
4. 入住当天拒绝：`arrivalDate = businessDate`，验证没有提前退房入口及中文原因。
5. 资金三态：净收款分别高于、等于、低于新金额，只有高于时显示正数建议退款；均没有真实退款事实。
6. 订单类型：外部渠道、WECOM、免费和会员各一笔，验证金额/原因规则、免费 0 元和会员 CONSUMED 不恢复。
7. 换房边界：已完成历史换房可缩短；尚未生效未来换房明确拒绝。

交付时必须提供运行 URL、账号、每张样例的房号/住客名、测试结果和逐步点击顺序。4.3 验收只核对建议退款和“尚未登记退款”，不得要求用户在本阶段发起真实退款。

## 17. 完成与停点

只有 Contract/OpenAPI、领域、真实 PostgreSQL、API、Web、桌面/手机 E2E、TypeScript、生产构建、补丁格式和独立只读审查全部通过，且独立验收实例可访问时，才能把 4.3 转为 `awaiting_user_acceptance`。

收到用户明确回复 `4.3 通过` 后，才更新计划为 `accepted`、创建本检查点 Git 提交并进入 4.4。第 4 步 Goal 在等待验收期间保持未完成；只有用户最终明确回复 `第 4 步通过` 才能 complete。

## 18. Tasks / Subtasks

- [x] **T1 契约与失败测试**
  - [x] 为 `SHORTEN_STAY` 输入、Effect、Receipt、OpenAPI、非负退款参考和额外字段拒绝先加入失败测试。
  - [x] 扩展严格 schema，并证明工作人员页面不依赖内部引用。
- [x] **T2 领域 Preview 与查询动作**
  - [x] 为日期三分支、入住当天、未来换房算法、完整重价、会员事实保护、资金三态和生命周期损坏先加入失败测试。
  - [x] 实现专用 SHORTEN effect、`EARLY_CHECK_OUT` 投影、AllowedActions 中文原因和 Confirm 陈旧映射。
- [x] **T3 PostgreSQL 原子写入与不变量**
  - [x] 为继续在住、双 amendment 提前退房、Claim 关闭、会员/资金零写入、幂等、回滚、权限/营业日变化和故障注入先加入失败测试。
  - [x] 替换旧 SHORTEN apply 分支，增加 stage 10 migration 和延迟组合约束。
- [x] **T4 Web 工作流**
  - [x] 为订单页、房态、今日任务、桌面/移动端的缩短/提前退房入口、第一层金额与建议退款展示先加入失败测试。
  - [x] 扩展覆盖式日期变更抽屉、中文核对和成功刷新，保持入住当天/未来换房失败关闭。
- [x] **T5 真实 E2E 与独立验收数据**
  - [x] 建立不可重复使用的 stage 10 数据，覆盖继续在住、提前退房、三类资金、四类订单和两类换房边界。
  - [x] 完成桌面/手机 E2E、跨营业日/陈旧预检和可售库存证据。
- [x] **T6 全量门禁、独立审查与交付**
  - [x] 通过 Unit、Integration、Contract/OpenAPI、pricing facts、E2E、TypeScript、生产构建和 `git diff --check`。
  - [x] 完成独立只读代码审查，修复本阶段发现后启动独立验收实例并转为 `awaiting_user_acceptance`。
- [x] **T7 4.3 人工验收纠偏**
  - [x] 修复新房态选择与旧订单抽屉并存的错单操作风险；保留“房态格 → 快捷操作框 → 准确订单抽屉”流程，父房多单不猜测。
  - [x] 允许住宿安排未变、后续独立 `REPRICE_ORDER` 的合法 DTO；继续严格校验当前 revision 指针、金额、币种和资金合计。
  - [x] 将在住“延长住宿 / 缩短住宿 / 提前退房”收敛为一个“调整退房日期”工作人员入口；只由 Web 根据新日期路由到既有 `EXTEND_STAY` / `SHORTEN_STAY` 命令，不改领域、API 或数据库语义。
  - [x] 纠正金额可见语义：明确调整前/调整后差额；外部渠道只展示政策基础金额、本单渠道应结金额、差额与说明，不把渠道合同额显示为逐单待补收。
  - [x] 补齐已批准 U2 的会员住宿双向追溯：订单抽屉显示关联会员、使用的会员产品、冻结/核销数量和会员档案入口；不改权益账本与核销规则。
  - [x] 纠正追溯日期人工验收说明，将“过去日期不可选”作为 Web 证据，绕过页面的拒绝与零写入由自动化证明；入住当天继续失败关闭并明确撤销入住尚未开放。
  - [x] 完成 4.2 延长、4.3 缩短/提前退房、U2 抽屉、外部渠道、会员链接、损坏 DTO 失败关闭的聚焦与全量回归，重建独立验收库后再转回 `awaiting_user_acceptance`。

### Review Findings

- [x] [Review][Patch] 允许 `REPRICE_ORDER` 将订单合法调回政策价的 `POLICY` revision [apps/web/src/orderViewValidation.ts:578]
- [x] [Review][Patch] 外部渠道的订单页、房态抽屉、核对层与成功回执始终使用渠道应结语义，不显示逐单收退款 [apps/web/src/ui.tsx:55]
- [x] [Review][Patch] 会员住宿在当前 coverage 为空时仍按 `member_contract_id` 追溯已生效会员产品 [apps/web/src/room-status/RoomStatusOrderContext.tsx:232]
- [x] [Review][Patch] Stage 10 桌面和移动验收夹具避免与共享 E2E 库中的 Stage 8 有效房源区间冲突 [tests/e2e/setup-stage10-acceptance.ts:304]
- [x] [Review][Patch] 延迟旧订单响应竞态用例显式等待旧请求完成或取消，避免固定定时导致假绿 [tests/e2e/current-page-u2.spec.ts:426]

## 19. Dev Agent Record

### Implementation Plan

- 复用阶段 9 的完整生命周期投影和重价主干，但为 `SHORTEN_STAY` 建立独立 Effect 与 apply 分支。
- 按 T1 → T6 执行 red-green-refactor；每个任务通过聚焦测试后再进入下一项。

### Debug Log

- 2026-07-30：T7 五项审查修复完成。联合浏览器回归进一步消除跨阶段房源和幂等键冲突、旧请求 200/取消双终态、入住恢复入口时序以及刷新后房态快捷框定位竞争；所有调整均只收紧当前 U2/4.1/4.2/4.3 回归，不改变 4.4/4.5 业务规则。
- 2026-07-30：4.3 人工验收发现新房态选择与旧订单抽屉并存、合法独立调价 DTO 被拒绝、外部渠道资金语义易误解、在住日期入口边界不清及 U2 会员双向追溯遗漏。用户已批准作为 T7 验收纠偏；状态退回 `in_progress`，4.4 及以后仍未开始。
- 2026-07-29：独立规格审查发现终态 Claim 生命周期、双 amendment 序列、Receipt 形状和 PostgreSQL 组合约束需要在编码前定死，已纳入本规格。
- 2026-07-29：首次完整 Integration 为 `214/215`，唯一失败来自测试夹具把人工历史 `CHECK_IN` 时间写成前一 amendment 的 `+1ms`，可能晚于随后事务的 `now()`；改为复用前一时间并增加序列时间非递减、原子双 amendment 同事务时间断言后，全量 `215/215` 通过，未放宽生产投影。
- 2026-07-29：Stage 10 首次桌面 E2E trace 证明快捷操作框和整段高亮已经出现，随后被房态首次挂载的滚动恢复关闭；仅在 E2E 交互前等待双绘制帧并增加焦点、操作框、`aria-expanded` 和完整区间高亮断言，产品关闭语义保持不变。
- 2026-07-29：完整 Integration 两次出现测试库重建阶段的 PostgreSQL `57P01` 连接终止噪声；测试夹具改为在 PostgreSQL 内复用精确 amendment 时间，数据库重建先等待正常关闭中的连接、仍存活时再终止。最终全量 `224/224` 无未处理错误。
- 2026-07-29：独立审查发现完整伪造缩短可裁掉未来换房、历史退款参考可能超过 DTO 上限、非 `APPLIED` 命令可挂载完整业务组合，以及 readiness/恢复漏查三个即时触发器及其函数绑定。全部补充 PostgreSQL/Query/恢复失败关闭测试并修复后，第二轮只读复审无新增阻断。

### Completion Notes

- `SHORTEN_STAY` 已端到端覆盖 contracts/OpenAPI、领域 Preview、PostgreSQL 原子 apply、Query/Receipt、Web 与恢复协议。新退房日晚于营业日时继续在住；等于营业日时同事务追加缩短与退房记录、重价、释放库存并结束住宿；早于营业日、入住当天和未来换房均失败关闭。
- 完整新时间线使用原锁定政策重价；外部渠道重新填写本单渠道应结金额并执行 15% 说明门槛，WECOM 默认政策价、主动偏价需原因，免费保持 0，会员已核销权益不恢复且不追加账本事实。
- 退款参考由服务端固定计算为 `max(0, 已登记净收款 - 新订单金额)`，只作为提示返回；Stage 10 不新增退款事实。数据库 migration 027 对命令、amendment、segment、revision、Claim、状态、权益零写入和普通提前退房旁路增加组合守卫。
- migration 027 进一步绑定未来换房时间线、房源/Claim、会员 coverage、资金事实和成功命令状态；readiness 与恢复脚本严格核对 3 个核心函数、2 个延迟触发器、3 个即时触发器及其绑定函数。真实 populated 026 备份恢复到完整 027 已通过。
- T7 最终门禁：TypeScript 通过；Unit `498/498`；Integration `224/224`；Contract/OpenAPI `62/62`；pricing facts `7/7`；U2/Stage 8/Stage 9/Stage 10 联合关键 E2E `37 passed / 37 expected skipped`；production build 与 `git diff --check` 通过。
- 独立验收库 `qintopia_stage10_acceptance` 按最终代码重建后使用 Web `http://127.0.0.1:4240/`、API `4241`。用户于 2026-07-30 逐项确认六项人工验收并明确回复 `4.3 通过`；4.3 已转为 `accepted`，验收时尚未进入 4.4/4.5。

## 20. File List

- `apps/api/src/schemas.ts`
- `apps/web/src/command-shell/commandShellState.test.ts`
- `apps/web/src/command-shell/commandShellState.ts`
- `apps/web/src/components/StayDateChangeDrawer.test.ts`
- `apps/web/src/components/StayDateChangeDrawer.tsx`
- `apps/web/src/orderViewValidation.test.ts`
- `apps/web/src/orderViewValidation.ts`
- `apps/web/src/pages/InventoryPage.test.ts`
- `apps/web/src/pages/InventoryPage.tsx`
- `apps/web/src/pages/MembersPage.test.ts`
- `apps/web/src/pages/MembersPage.tsx`
- `apps/web/src/pages/OrderDetailPage.test.ts`
- `apps/web/src/pages/OrderDetailPage.tsx`
- `apps/web/src/pages/TodayPage.tsx`
- `apps/web/src/room-status/RoomStatusOrderContext.test.tsx`
- `apps/web/src/room-status/RoomStatusOrderContext.tsx`
- `apps/web/src/ui.test.ts`
- `apps/web/src/ui.tsx`
- `docs/implementation/spec-qintopia-pms-core-operations-mvp.md`
- `packages/contracts/src/index.ts`
- `packages/db/src/commands/apply.ts`
- `packages/db/src/commands/effects.ts`
- `packages/db/src/commands/service.ts`
- `packages/db/src/database.ts`
- `packages/db/src/migrations/027_stage10_stay_shortening_guards.sql`
- `packages/db/src/orders.test.ts`
- `packages/db/src/orders.ts`
- `packages/domain/src/operational-facts.test.ts`
- `packages/domain/src/operational-facts.ts`
- `packages/domain/src/pricing.test.ts`
- `packages/domain/src/pricing.ts`
- `scripts/restore.sh`
- `scripts/verify-backup-restore.sh`
- `scripts/verify-compose-cold-start.sh`
- `tests/contract/agent-core-journey.contract.test.ts`
- `tests/contract/command-effects.contract.test.ts`
- `tests/contract/openapi.contract.test.ts`
- `tests/contract/restore-script.contract.test.ts`
- `tests/e2e/current-page-u2.spec.ts`
- `tests/e2e/member-order-trace-stage10.spec.ts`
- `tests/e2e/room-status-stage8-fulfillment.spec.ts`
- `tests/e2e/setup-stage10-acceptance.ts`
- `tests/e2e/stay-date-changes-stage9.spec.ts`
- `tests/e2e/stay-shortening-stage10.spec.ts`
- `tests/helpers/create-restore-fixture.ts`
- `tests/helpers/database.ts`
- `tests/integration/core-operations.integration.test.ts`
- `tests/integration/database-invariants.integration.test.ts`
- `tests/integration/member-profile-lifecycle.integration.test.ts`
- `tests/integration/migration-concurrency.integration.test.ts`
- `tests/integration/operational-references.integration.test.ts`
- `tests/integration/room-status-projection.integration.test.ts`
- `tests/integration/stay-date-changes.integration.test.ts`
- `待开发项/QinTopia-PMS-分步开发与人工验收计划.md`
- `待开发项/QinTopia-PMS-第4步-4.1-实施规格.md`
- `待开发项/QinTopia-PMS-第4步-4.2-实施规格.md`
- `待开发项/QinTopia-PMS-第4步-4.3-实施规格.md`
- `待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md`
- `待开发项/房态与订单运营流程分步开发计划.md`

## 21. Change Log

- 2026-07-30：用户逐项确认抽屉防误操作、统一退房日期入口、提前退房、外部渠道金额语义、WECOM 合法调回政策价和会员产品追溯均通过，并明确回复 `4.3 通过`；4.3 转为 `accepted`，允许在本阶段提交后开始 4.4。
- 2026-07-30：T7 五项审查修复与联合回归完成，4.3 重新转为 `awaiting_user_acceptance`；4.4/4.5 未开始，等待用户明确回复 `4.3 通过`。
- 2026-07-30：根据 4.3 人工验收批准 T7 纠偏，状态退回 `in_progress`；严格不进入 4.4/4.5。
- 2026-07-29：根据用户确认和独立规格审查冻结 4.3 业务、事务、契约、测试与阶段边界。
- 2026-07-29：完成 T1-T5 和 T6 自动门禁，建立独立验收数据与运行实例；等待独立代码审查收口后转为人工验收。
- 2026-07-29：完成两轮独立审查与阻断修复、真实 026→027 恢复、最终全量回归和独立实例准备；4.3 转为 `awaiting_user_acceptance`，4.4 未开始。

## 22. Preservation review

- **Coherence:** 已覆盖状态/日期矩阵、计价、库存、会员、资金、事务、恢复、Web、自动化和人工验收；同日撤销与未来换房均有唯一后续归属。
- **Preservation:** 六份权威来源中的全部 4.3 load-bearing 规则已落入本规格；更早“入住当天至少一晚”的口径已被用户 2026-07-29 最终确认覆盖，不再保留为活规则。
- **Wrapper-only content:** 未复制与 4.3 无关的阶段说明、历史讨论过程或其他步骤验收细节。
- **Open questions:** 无。后续阶段问题不阻断 4.3。
