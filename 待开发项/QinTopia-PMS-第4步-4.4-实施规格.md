---
title: 'QinTopia PMS 第 4 步 4.4 换房、连续分段与完整重价'
type: 'feature'
status: 'accepted'
created: 2026-07-30
review_loop_iteration: 3
baseline_commit: 'c15c9c4'
checkpoint: 4.4
technical_stage: 11
human_acceptance_command: 4.4 通过
context:
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
  - '待开发项/QinTopia-PMS-第4步-4.2-实施规格.md'
  - '待开发项/QinTopia-PMS-第4步-4.3-实施规格.md'
  - 'docs/implementation/spec-qintopia-pms-core-operations-mvp.md'
  - 'docs/architecture/invariants-and-decisions.md'
  - 'design-system/qintopia-pms/MASTER.md'
---

# QinTopia PMS 第 4 步 4.4 实施规格

## 1. 权威来源与当前状态

用户已于 2026-07-30 明确回复 `4.3 通过`，4.3 已以提交 `c15c9c4` 收尾。本规格只实施正式检查点 4.4 / 工程阶段 11“换房、连续分段和最终一次舍入”；4.5 及以后不得提前实现。

4.4 属于 A 级切片，必须按实施规格、开发、系统自动检查、独立实例和逐步人工验收闭环。现有 `MOVE_UNIT` 只是早期纵向链路，不能作为阶段 11 已完成的证据。

规格审计确认的一项实施前 Gate 已于 2026-07-30 关闭：用户明确批准第 15 节方案 B。已有多房源安排的未入住订单改变住宿日期时，按变更类型迁移计划换房生效日，不再保留未决算法。

## 2. Why

现有换房已经能追加基础分段并迁移库存，但工作人员看不到跨产品换房的原金额、新金额和差额；外部渠道、WECOM、会员权益、未来换房位置和多房源后续日期动作也没有完整阶段规则。此前真实验收已经出现四人间换到二人间后页面无法感知金额变化的情况，容易让操作员误判换房没有重价。

## 3. Capabilities 与成功信号

- **CAP-1 明确选择目标房源**
  - **intent:** 工作人员按生效日期选择准确的整房或具体床位，并在提交前看清销售产品、容量、当前安排和目标安排。
  - **success:** 候选项不混淆整房与床位；容量不足、换房后完整时间线未变和完整目标区间冲突在 Preview/Confirm 均失败关闭。
- **CAP-2 同一 Stay 的连续换房**
  - **intent:** 换房保留同一 `orderId/stayId`，只追加不可变安排历史。
  - **success:** 生效日前使用原房源，生效日起使用目标房源；时间线连续、无重叠、无空夜，原 segment 与旧 revision 不被覆盖。
- **CAP-3 完整时间线重价**
  - **intent:** 同价和跨价换房都按整个连续 Stay 的统一晚数档位重新计价。
  - **success:** 每个房源分段使用统一档位对应产品的精确金额，全部分段求和后只对最终总价 half-up 一次；核对和成功后的当前页面都显示权威新金额。
- **CAP-4 当前与计划位置可区分**
  - **intent:** 工作人员不会把尚未生效的未来换房误认为住客已经搬房。
  - **success:** 已入住订单按营业日显示“当前住宿位置”，未来转换显示“计划换至”；到达生效日后位置自然切换，历史办理时间仍可追溯。
- **CAP-5 严格失败关闭**
  - **intent:** 陈旧预检、权限变化、并发库存、损坏时间线、非法会员转换和事务故障不能留下半笔换房。
  - **success:** 订单、分段、计价、Claim、权益、资金、Command 和 Receipt 的自动化快照证明成功时完整提交、拒绝时业务事实零变化。

## 4. Constraints

- 日期继续使用物业时区半开区间 `[arrivalDate, departureDate)`；换房生效日必须覆盖至少一个服务日。
- 同一订单和 Stay 保持不变；变更只追加 amendment、安排版本、完整 pricing revision、审计和 Receipt。
- 换房原因通过 Confirm `reason.note` 提交，去除首尾空白后必须非空；金额原因不能代替住宿变更原因。
- 使用成交时锁定的政策版本对完整当前时间线重价；旧渠道金额、旧人工偏价和旧说明不继承。
- 既有 COLLECTION/REFUND/REVERSAL 及其 revision 关联完全不变；4.4 不新增资金事实，不宣称到账、结清或退款完成。
- 当前版本继续停用清洁流程。
- 不扩大 21 天房态窗口，不进入第 5 步的连续 30 天时间轴。
- 不借本切片实现取消、未到、撤销入住、真实收退款或住宿转会员。

## 5. 状态与日期矩阵

| 订单状态 | 换房生效日 | 结果 |
|---|---|---|
| `RESERVED` 且 `businessDate <= arrivalDate` | `arrivalDate <= effectiveDate < departureDate` | 调整计划住宿房源；不表示实际搬房 |
| `RESERVED` 且 `businessDate > arrivalDate` | 任意 | 拒绝；先使用 4.2 调整预订日期处理逾期安排 |
| `CHECKED_IN` | `effectiveDate = businessDate` | 当日实际换房；当前住宿位置立即切换 |
| `CHECKED_IN` | `businessDate < effectiveDate < departureDate` | 建立未来计划换房；当前住宿位置保持不变 |
| `CHECKED_IN` | `effectiveDate < businessDate` | 拒绝追溯换房，零业务写入 |
| `CHECKED_IN` 且 `businessDate >= departureDate` | 任意 | 拒绝；先使用既有续住或迟录退房流程 |
| `CHECKED_OUT/CANCELLED/NO_SHOW` | 任意 | 拒绝，零业务写入 |

工作人员再次选择同一 Stay 的某个生效日和目标房源时，明确以本次选择替换 `[effectiveDate, departureDate)` 的计划后缀；生效日前的有效安排保持不变，不能静默修改已经履行的历史位置。只有换房后的完整时间线与变更前完全相同时才拒绝；若目标房源虽等于生效日原计划房源，但本次操作撤销了后续计划换房，则完整时间线已发生变化，应允许继续核对。

## 6. Command、DTO 与 OpenAPI

继续使用 `MOVE_UNIT`，但把输入和 Effect 升级为阶段 11 完整合同：

```ts
interface MoveUnitInput {
  propertyId: string;
  orderId: string;
  newInventoryUnitId: string;
  effectiveDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}
```

Effect、Preview 和 Receipt 至少提供：

- `before`：`stayTimeline` 表达当前完整有效安排，`currentContractAmount` 表达原合同金额，`effectiveDateInventoryUnit` 表达换房生效日原计划房源，`actualCurrentInventoryUnit` 表达已入住订单按营业日计算的实际当前位置；`RESERVED` 的实际当前位置必须为 `null`，不得把未来计划房源称为当前位置；
- `after`：`stayTimeline` 表达换房后的连续时间线，并明确目标房源和生效日期；
- `pricingDecision`：本次政策基础金额、目标合同金额、计价类型和适用说明；
- `inventoryChange`：保留、释放和新增的服务日/房源摘要；
- `entitlementSummary`：会员权益保留或迁移摘要及账本写入数；
- `fundsSummary`：已登记净收款和换房后差额，只读且不写资金事实。

contracts、OpenAPI、API schema 和 Web 必须共同执行严格字段规则，并保持 `additionalProperties: false`。目标金额继续限制为 `0..2_147_483_600`、整元 minor units。

## 7. 完整重价

1. 用当前有效连续安排的入住日至当前退房日的总服务夜数只选择一次 `1/7/14/30` 档位；原始预订日期只保留为历史，不重复计价。
2. 对每个连续房源区间使用该统一档位下对应销售产品的精确分数金额。
3. 先精确相加全部分段，再只对最终订单总价执行一次人民币元 positive half-up；不得逐段舍入。
4. 同价产品可能保持原金额；跨产品换房必须形成可见的新完整 revision。

| 订单类型 | 本次价格输入 | 新 revision |
|---|---|---|
| `YOUMUDAO/CTRIP/MEITUAN` | 必须重新填写“本单渠道应结金额”；超过政策基础金额绝对差异 15% 时“渠道价格差异说明”必填 | `CHANNEL_CONTRACT`，`manualAdjustmentMinor = 0` |
| `WECOM` | 默认本次政策基础金额；主动偏离时必须填写新的人工调价原因 | `POLICY` 或 `MANUAL_ADJUSTMENT` |
| 会员住宿 | 禁止渠道/人工目标金额；仅使用符合第 9 节的既有会员产品 | `MEMBER_ENTITLEMENT` |
| 免费住宿 | 禁止金额输入，始终为 0 | `FREE` |

页面统一使用“本单渠道应结金额”和“与政策基础金额差额”，不得显示“渠道合同价”或逐单平台待收款语义。

## 8. 住宿安排与库存

- 新时间线由服务日到房源的唯一映射构成，必须覆盖完整 `[arrivalDate, departureDate)`，无空洞、无重叠。
- 生效日前的服务日与 Claim 身份保持不变；从生效日起精确计算旧/新 `(serviceDate, inventoryUnitId)` 差集。
- 交集 Claim 保持原 ID；旧后缀精确释放；目标后缀精确创建并指向本次新安排版本。
- 新旧时间线涉及的全部 `roomId + serviceDate` 去重并稳定排序后 `FOR UPDATE`，再做整房/子床双向冲突校验。
- 候选项只能作为便利展示，Confirm 必须重新校验目标容量、产品和完整后缀库存；不得因为候选列表曾显示可用而跳过事务重验。
- 同一命令不得通过换房静默缩短退房日或制造不连续 Stay。

## 9. 会员权益

- 会员目标房源必须与合同权益 kind 一致，并且目标销售产品可由当前会员合同覆盖；不满足时返回稳定中文原因并零写入。
- `BED_NIGHT` 与 `ROOM_NIGHT` 不得静默转换；当前未批准跨 kind 补差价或权益折算。
- 未入住会员换房：生效日起仍为 `HELD` 的 coverage 按服务日精确迁移到目标房源，释放与重新冻结同事务完成，余额不重复扣减。
- 已入住会员换房：既有 `CONSUMED` coverage 和 ledger 永不恢复、删除或改写，并继续保留核销发生时的历史房源身份；它可以与换房后的当前 Claim 房源不同。同一已覆盖产品内换房不得重复核销或产生新的权益扣减。
- 跨会员产品、多个可用 Lot 无确定选择、残留非法 HELD/CONSUMED 状态，或 `CONSUMED` coverage 无法与换房前的有效时间线及同 kind 会员产品对应时失败关闭；不得仅因合法换房后当前 Claim 已迁移就把历史 coverage 判为损坏。4.4 不顺手修复历史损坏事实。
- 现金和免费订单不得写会员账本。

## 10. PostgreSQL 原子事务

Confirm 必须在一个事务中：

1. 重验主体、物业 WRITE 权限、命令类型、Preview、幂等范围和输入 hash。
2. 锁定订单并重读 Order/Stay 状态、版本、当前 revision、完整安排、履约和营业日。
3. 复用生命周期投影验证 amendment sequence、segment supersession、revision 指针和状态一致性。
4. 锁定会员相关合同/Lot，以及新旧时间线涉及的全部 room-day。
5. 重建 Effect，重验日期分支、目标容量、库存、政策、价格输入、权益和资金 basis；比较 effect hash。
6. 追加一条 `MOVE_UNIT` amendment、一个不可变安排版本和一个完整 pricing revision。
7. 原子迁移 Claim 和获准的 HELD coverage；不得改写 CONSUMED coverage 或资金事实。
8. 更新订单当前 revision、版本和房态 revision；Order/Stay 生命周期状态保持原值。
9. 写入审计、Command `APPLIED` 状态和 `EXECUTED` Receipt。
10. 一次提交。

新增 migration 028 必须在数据库层验证 `MOVE_UNIT` 的 amendment、segment、revision、订单版本、完整时间线、同订单关系、价格 basis、状态与 active Claim 组合；并阻止该命令改写 CONSUMED coverage、跨 kind 权益或写入资金事实。readiness、备份恢复和冷启动检查同步推进到 028。

## 11. 当前位置、计划位置与历史

- `RESERVED` 没有实际住宿位置，只显示“计划住宿安排”。
- `CHECKED_IN` 使用营业日对应的时间线房源显示“当前住宿位置”；生效日在营业日之后的转换显示“计划换至”。
- 生效日在营业日前的转换属于历史换房，不再显示为未来计划。
- 订单详情继续分为原始预订安排、当前住宿安排、入住与退房结果、住宿安排变更历史；不得把 segment 列表当实际入住流水。
- 房态点击任一可见分段仍以稳定 `orderId/stayId` 选中同一完整 Stay，并共同高亮可见窗口内全部有效分段。

## 12. Web 工作流

- 从房态快捷框或订单上下文选择“换房”后进入覆盖式写抽屉，不跳完整订单页。
- 抽屉固定显示住客、当前房号、状态、当前周期和动作名称。
- 目标选择项显示“整房”或“具体床位”、房号、销售产品、可登记人数和目标区间状态；不显示内部 kind、ID 或 Claim。
- 第一层填写生效日期、目标房源、换房原因以及当前订单类型所需金额字段；有效输入自动 Preview。
- 第一层即显示原房源、目标房源、各分段日期、原金额、政策基础金额、本单新金额和差额；现金/WECOM 订单可显示已登记净收款及仅供后续人工处理的差额。外部渠道只显示政策基础金额、本单渠道应结金额、与政策基础金额差额及说明，不显示逐单已收、待补收或建议退款语义；库存冲突停留在第一层。
- 第二层只做一次中文正式核对。陈旧 Preview 保留草稿并要求重新核对。
- 成功后关闭抽屉并刷新订单、金额、房态和完整 Stay 选择；跨价换房不能只在数据库更新 revision 而页面仍显示旧金额。
- 桌面抽屉覆盖房态且不挤窄主表，移动端全屏；关闭后恢复房态滚动和焦点。

## 13. 日期动作与既有换房时间线

在同一 Stage 11 中补齐此前明确移交的组合边界：

- 已完成历史换房后续住：新增日期沿用当前最后房源，并按完整时间线重价。
- 存在未来换房时续住：新增日期沿用计划时间线最后房源，保留未来转换。
- 存在未来换房时缩短或提前退房：按新退房日裁剪时间线；生效日在新退房日或之后的计划转换不进入新安排，相应 Claim 同事务释放。
- 多房源未入住订单只调整退房日时，可按相同的尾部扩展/裁剪规则处理。
- 多房源未入住订单改变入住日时，执行第 15 节已批准的方案 B，并在 Preview 中展示系统计算后的完整分段供操作员核对。

所有组合日期动作继续使用原命令 `RESCHEDULE_STAY`、`EXTEND_STAY`、`SHORTEN_STAY`，不新增同义命令。它们只扩展到获准的多房源时间线算法，不改变 4.2/4.3 的日期、原因、渠道、会员和提前退房规则。

## 14. 失败关闭与自动化门禁

必须覆盖：

- Unit/Domain：同价、跨价、多段统一档位、最终一次舍入、先改期后换房仍只计算当前有效安排、目标容量、状态日期矩阵、会员 kind，以及方案 B 的等量平移、单端修改、非等量修改、节点落边界和全部旧节点裁出。
- Contract/OpenAPI：新增价格字段、严格 Effect/Receipt、错误 DTO 和 `additionalProperties: false`。
- PostgreSQL Integration：同房源、容量不足、整房/子床冲突、并发目标冲突、陈旧 Preview、权限变化、重复请求、故障注入、损坏时间线、渠道/WECOM/免费/会员、已核销 coverage 历史房源身份保留、未来换房裁剪、方案 B 的完整时间线迁移、完全早于/晚于旧安排时的首房/末房承接、Preview 与最终持久化安排一致，以及冲突时逐表零写入。
- Query/API：当前位置与“计划换至”、完整安排、历史、当前金额和 revision 指针一致；损坏 DTO 继续失败关闭。
- E2E：桌面/手机完成同价、跨价、外部渠道、WECOM、免费、会员拒绝、即时刷新和完整 Stay 高亮。
- 系统门禁：TypeScript、Unit、Integration、Contract/OpenAPI、pricing facts、E2E、production build、`git diff --check`、真实 027 -> 028 恢复、readiness 与冷启动。

## 15. 已关闭 Gate：多房源未入住订单改变入住日

示例：计划为 A 房 `08-01 至 08-03`、B 房 `08-03 至 08-05`，现把订单改为 `08-02 至 08-06`。权威文档尚未决定 B 房应从 `08-03` 还是 `08-04` 生效。可选方案：

- **A 保持绝对日期：** B 房仍从 `08-03` 生效；日期裁剪/扩展只影响首尾。实现最简单，但会改变各房源住宿晚数比例。
- **B 按变更类型迁移（推荐）：** 入住日和退房日等量平移时，全部换房节点随订单平移并保持每段晚数；只改一端或两端移动量不同时，仍落在新区间内的换房日保持绝对日期，首尾只裁剪或延长。该规则覆盖常见操作，且不要求工作人员重复填写每个分段。
- **C 明确编辑最终分段：** 多房源订单改变入住日时，工作人员必须在同一表单明确选择最终换房生效日；系统展示并提交完整结果时间线，不自动猜测。业务意图最明确，但操作和实现都更复杂。

用户于 2026-07-30 明确批准 **方案 B**：

- 入住日与退房日等量平移时，全部内部换房节点按相同天数平移，保持各房源分段晚数。
- 只修改一端或两端移动量不同时，仍落在新区间内的内部换房节点保持绝对日期；首尾分段只裁剪或延长。
- 落在新区间之外或等于新边界、因而不再覆盖任何服务日的分段自动消失；结果仍必须覆盖完整新区间且无空洞、无重叠。
- 新区间与旧区间相交时，以原时间线裁剪交集；向旧入住日前延长的日期使用原首房，向旧退房日后延长的日期使用原末房。
- 新区间完全早于旧安排时，全部服务日使用原首房；完全晚于旧安排时，全部服务日使用原末房；最后合并相邻且房源相同的分段。
- 操作员只填写新入住日和退房日，不重复填写内部换房日；第一层 Preview 必须只读展示系统计算后的每个房源分段和换房边界。若业务意图是另行改变换房日，使用 `MOVE_UNIT` 换房流程处理。

该 Gate 已关闭，允许进入 T1 产品开发。

## 16. 专用验收数据与人工验收

至少准备相互独立的样例：同价换房、跨价换房、先改期后换房、外部渠道、WECOM 旧偏价、免费、未入住未来换房、已入住当日换房、会员同产品、会员跨 kind 拒绝、目标库存冲突、已有历史/未来换房后的续住与缩短，以及方案 B 的等量整体平移、单端或非等量改期、完全早于旧安排和完全晚于旧安排。

人工验收最终分组：

1. 同价与跨价换房：核对目标房源、连续分段、原金额、新金额、差额和成功后即时刷新。
2. 渠道/WECOM/免费：确认旧目标金额不继承，外部渠道使用本单渠道应结金额，免费保持 0，不产生资金事实。
3. 当前/计划位置与组合日期动作：未来换房显示“计划换至”；已完成历史换房可续住，未来换房可安全裁剪。
4. 床位/整房与会员：现金/免费允许经容量和库存校验换房；会员跨 kind 明确拒绝且权益零变化。
5. 房态追溯：从任一分段进入都选中同一 Stay，原安排、旧 revision 和原因仍可查。
6. 多房源改期：一笔订单整体等量平移后各分段晚数保持不变；另一笔只改一端或非等量改期后，区间内换房日保持不变，首尾正确裁剪或延长；再核对完全早于/晚于旧安排时分别使用原首房/末房。核对层展示的完整分段必须与完成后的订单安排完全一致。

## 17. Tasks / Subtasks

- [x] **T0 规格 Gate**
  - [x] 完整复核权威范围、现有 `MOVE_UNIT`、计价、事务、Query、Web 和测试缺口。
  - [x] 用户确认第 15 节多房源入住日迁移方案 B。
  - [x] 独立规格审查完成，无未决阻断。
- [x] **T1 Contracts、领域与 OpenAPI**
- [x] **T2 PostgreSQL 原子事务与 migration 028**
- [x] **T3 Query/API 与当前/计划位置投影**
- [x] **T4 Web 换房抽屉与即时刷新**
- [x] **T5 多房源组合日期动作**
- [x] **T6 Unit、Integration、Contract、pricing facts 与 E2E**
- [x] **T7 独立审查、恢复、全量门禁与验收实例**
- [x] **T8 人工验收纠偏：目标房源选择、抽屉稳定性与库存冲突文案**
  - [x] 目标房源选择器去除内部英文产品代码和重复房号，增加中文房号/房型搜索与紧凑候选文案；床位同时显示父房间房型和具体床位。
  - [x] 相同订单轮询和核对结果刷新不得重建结果区域或让抽屉回弹顶部；真实事实变化仍关闭表单。
  - [x] 已知库存占用在第一层显示准确中文原因并禁止继续，服务端权威冲突校验与零写入规则保持不变。
  - [x] 完成定点 Unit、Integration、E2E、TypeScript、build 与补丁检查后重新进入人工验收。

### Review Findings

- [x] [Review][Protocol] 历史 `SHORTEN_STAY` 只在日期、库存差集、完成模式、营业日和退房引用全部符合 Stage 10 形状时允许读取；Stage 11 epoch 后的不完整形状继续失败关闭。
- [x] [Review][Pricing] 付费 `MOVE_UNIT` Preview 必须提供覆盖完整时间线、与政策基础金额一致的现金计价证据。
- [x] [Review][Membership] 会员 Preview 拒绝 ROOM/BED 跨 kind 或混合 kind，同时保留合法历史已核销 coverage 的原房源身份。
- [x] [Review][Polling] 轮询响应按到达时的最新编辑状态判断是否关闭表单，覆盖“请求先发出、随后打开抽屉”的竞态；相同 DTO 不替换页面状态。
- [x] [Review][Selector] 床位候选从父房间取得中文房型，真实目录中的“202 · 床位 A”可按“四人间（公卫）”搜索并显示为清晰的房型与床位组合。
- [x] [Review][Operator copy] 换房抽屉不再显示 `Preview` 或内部产品代码，工作人员可见文案统一为中文业务语言。

## 18. Dev Agent Record

### Implementation Plan

- 先关闭唯一产品 Gate，再按 T1 -> T7 的 red-green-refactor 顺序实施。
- T1 由单一 owner 负责 `packages/contracts`、API schema、领域计价及对应 contract/unit 测试；合同冻结前不启动依赖其 DTO 的写入实现。
- T2 与 T5 后端由同一 owner 串行负责 `effects.ts`、`apply.ts`、migration 028、恢复脚本及对应 PostgreSQL 测试，避免两个 worker 同时改写日期与库存事务主干。
- T3 独立负责 Query/API、当前位置/计划位置和损坏投影失败关闭；发现合同缺口退回 T1，不直接修改 contracts。
- T4 与 T5 Web 由同一 owner 串行负责换房抽屉、日期组合动作、订单 DTO 校验和房态即时刷新，避免两个 worker 同时修改日期抽屉与动作入口。
- T6 的 Unit/Integration/Contract 测试跟随各生产文件 owner；独立 E2E owner 只修改 Stage 11 夹具和跨阶段回归用例，不修改产品代码。
- T1 合同冻结后，T2、T3、T4 才可按上述不重叠所有权并行；T2-T5 稳定后启动 E2E，最后由主任务执行 T7 合并验证和两轮只读审查。

### Debug Log

- 2026-07-31：T8 纠偏与复审完成。独立审查补获并修复轮询请求先发出后才打开抽屉的竞态、真实床位目录缺少父房型搜索上下文及一个残留的可见 `Preview` 文案。最终门禁为 Unit `625/625`、Integration `261/261`、Contract/OpenAPI `70/70`、pricing facts `7/7`、4.4 桌面 E2E `6/6`、手机 E2E `3/3`、TypeScript、production build 与 `git diff --check`；独立验收库已按最终代码重建。
- 2026-07-31：人工验收发现目标房源下拉框暴露内部英文产品代码且难以检索，跨价换房抽屉随订单轮询重复 Preview 并回弹，已占用目标被错误折叠为通用“业务状态变化”。4.4 退回 `in_progress`，只实施 T8 纠偏；阶段 12 未开始。
- 2026-07-30：独立审查收紧历史 `SHORTEN_STAY` 协议、付费换房完整计价证据和会员同 kind 时间线证据；合法 Stage 10 历史形状继续可读，Stage 11 epoch 后的不完整形状仍失败关闭。复审无剩余阻断。
- 2026-07-30：全量门禁通过：Unit `622/622`、Integration `260/260`、Contract/OpenAPI `70/70`、pricing facts `7/7`、E2E `122 passed / 102 expected desktop/mobile skips / 0 failed`、TypeScript、production build 和 `git diff --check`。
- 2026-07-30：真实 populated 027 备份恢复至 028、readiness 和冷启动检查通过；独立验收库 `qintopia_stage11_acceptance` 已按最终代码重建。
- 2026-07-30：只读审计确认现有 `MOVE_UNIT` 已有基础 Preview/Confirm、库存锁、append-only segment/revision 和完整时间线计价主干，但缺少阶段 11 的价格决策、渠道/WECOM、当前/计划位置、会员写入边界、Web 核对和 028 数据库组合守卫。
- 2026-07-30：发现多房源未入住订单改变入住日的转换日期映射未决；按 4.2 “不得猜测内部换房边界”要求暂停产品编码并提交用户选择。
- 2026-07-30：用户批准方案 B；等量整体平移同步迁移内部换房节点，非等量或单端修改保留新区间内节点并只裁剪/延长首尾。操作员不重复填写节点，Preview 必须展示完整计算结果。
- 2026-07-30：独立 T0 审查收紧完整重价起点、方案 B 完全不相交区间算法、当前位置/计划房源语义及对应自动化和人工验收矩阵。

### Completion Notes

- `MOVE_UNIT` 已端到端覆盖严格 contracts/OpenAPI、完整时间线重价、PostgreSQL 原子写入、Query/API 投影、Web 换房抽屉和成功后即时刷新。
- 同价、跨价、外部渠道、WECOM、免费和会员订单都使用本次完整计价决策；换房不新增资金事实，会员跨 kind 和损坏权益失败关闭。
- 已实施方案 B：等量改期同步平移内部换房节点；单端或非等量改期保留新区间内节点并只裁剪/延长首尾，完全提前/延后分别由原首房/末房承接。Preview 与最终持久化安排一致。
- migration 028 对换房命令、安排、计价、Claim、权益、资金与成功 Receipt 的组合关系增加数据库守卫；真实 027 -> 028 恢复、readiness 和冷启动已通过。
- T8 已完成纯中文可搜索目标房源选择、相同事实轮询与核对刷新下的抽屉稳定、准确的容量/库存拒绝和服务端冲突零写入；独立复审发现的轮询竞态与真实床位房型搜索边界已一并关闭。
- 2026-07-31：用户明确回复 `4.4 通过`。4.4 已验收通过并提交收尾；阶段 12 / 4.5 仅开始规格审计，尚未开始产品代码。

## 19. File List

- `apps/api/src/schemas.ts`
- `apps/api/src/server.ts`
- `apps/web/src/api.ts`
- `apps/web/src/availabilityValidation.test.ts`
- `apps/web/src/availabilityValidation.ts`
- `apps/web/src/command-shell/commandShellState.test.ts`
- `apps/web/src/command-shell/commandShellState.ts`
- `apps/web/src/components/AccommodationPositionSummary.test.tsx`
- `apps/web/src/components/AccommodationPositionSummary.tsx`
- `apps/web/src/components/MoveUnitDrawer.test.ts`
- `apps/web/src/components/MoveUnitDrawer.tsx`
- `apps/web/src/components/StayDateChangeDrawer.test.ts`
- `apps/web/src/components/StayDateChangeDrawer.tsx`
- `apps/web/src/orderViewValidation.test.ts`
- `apps/web/src/orderViewValidation.ts`
- `apps/web/src/pages/InventoryPage.test.ts`
- `apps/web/src/pages/InventoryPage.tsx`
- `apps/web/src/pages/OrderDetailPage.test.ts`
- `apps/web/src/pages/OrderDetailPage.tsx`
- `apps/web/src/room-status/RoomStatusGrid.test.ts`
- `apps/web/src/room-status/RoomStatusGrid.tsx`
- `apps/web/src/room-status/RoomStatusOrderContext.test.tsx`
- `apps/web/src/room-status/RoomStatusOrderContext.tsx`
- `apps/web/src/room-status/RoomStatusQuickPopover.test.ts`
- `apps/web/src/room-status/RoomStatusQuickPopover.tsx`
- `apps/web/src/room-status/room-status.css`
- `apps/web/src/styles.css`
- `apps/web/src/types.ts`
- `apps/web/src/ui.move-pricing-evidence.test.ts`
- `apps/web/src/ui.test.ts`
- `apps/web/src/ui.tsx`
- `packages/contracts/src/index.ts`
- `packages/db/src/commands/apply.ts`
- `packages/db/src/commands/effects.ts`
- `packages/db/src/commands/service.ts`
- `packages/db/src/database.ts`
- `packages/db/src/historical-command-protocol.test.ts`
- `packages/db/src/historical-command-protocol.ts`
- `packages/db/src/inventory.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/migrations/028_stage11_move_unit_guards.sql`
- `packages/db/src/orders.test.ts`
- `packages/db/src/orders.ts`
- `packages/db/src/stay-timeline-plan.test.ts`
- `packages/db/src/stay-timeline-plan.ts`
- `packages/domain/src/operational-facts.test.ts`
- `packages/domain/src/operational-facts.ts`
- `scripts/restore.sh`
- `scripts/verify-backup-restore.sh`
- `scripts/verify-compose-cold-start.sh`
- `tests/contract/agent-core-journey.contract.test.ts`
- `tests/contract/command-effects.contract.test.ts`
- `tests/contract/openapi.contract.test.ts`
- `tests/contract/restore-script.contract.test.ts`
- `tests/contract/security.contract.test.ts`
- `tests/e2e/channel-order-pricing.spec.ts`
- `tests/e2e/command-shell-u1.spec.ts`
- `tests/e2e/core-journey.spec.ts`
- `tests/e2e/current-page-u2.spec.ts`
- `tests/e2e/member-order-trace-stage10.spec.ts`
- `tests/e2e/member-stays-step2c.spec.ts`
- `tests/e2e/move-unit-stage11.spec.ts`
- `tests/e2e/reset-database.ts`
- `tests/e2e/room-status-command-states.spec.ts`
- `tests/e2e/room-status-performance.spec.ts`
- `tests/e2e/room-status-stage-1.spec.ts`
- `tests/e2e/room-status-stage7-order-context.spec.ts`
- `tests/e2e/room-status-stage8-fulfillment.spec.ts`
- `tests/e2e/room-status-ui-edge.spec.ts`
- `tests/e2e/room-status.spec.ts`
- `tests/e2e/setup-database.ts`
- `tests/e2e/setup-stage10-acceptance.ts`
- `tests/e2e/setup-stage11-acceptance.ts`
- `tests/e2e/setup-stage7-acceptance.ts`
- `tests/e2e/setup-stage8-acceptance.ts`
- `tests/e2e/setup-stage9-acceptance.ts`
- `tests/e2e/stay-date-changes-stage9.spec.ts`
- `tests/e2e/stay-shortening-stage10.spec.ts`
- `tests/helpers/database.ts`
- `tests/integration/command-protocol.integration.test.ts`
- `tests/integration/core-operations.integration.test.ts`
- `tests/integration/database-invariants.integration.test.ts`
- `tests/integration/member-profile-lifecycle.integration.test.ts`
- `tests/integration/migration-concurrency.integration.test.ts`
- `tests/integration/move-unit-stage11.integration.test.ts`
- `tests/integration/operational-references.integration.test.ts`
- `tests/integration/real-pricing-policy.integration.test.ts`
- `tests/integration/room-status-projection.integration.test.ts`
- `tests/integration/stay-date-change-lifecycle-corruption.integration.test.ts`
- `tests/integration/stay-date-changes.integration.test.ts`
- `tests/integration/whole-room-occupants.integration.test.ts`
- `待开发项/QinTopia-PMS-分步开发与人工验收计划.md`
- `待开发项/QinTopia-PMS-第4步-4.4-实施规格.md`
- `待开发项/房态与订单运营流程分步开发计划.md`

## 20. Change Log

- 2026-07-30：4.3 提交后启动 4.4 A 级规格；完成权威范围与现有实现审计，登记一个必须由用户确认的多房源改期 Gate，产品代码尚未修改。
- 2026-07-30：用户明确批准多房源未入住订单改期方案 B，关闭实施前业务 Gate并启动 T1。
- 2026-07-30：T1–T7 实施完成；换房完整重价、migration 028、当前/计划位置、Web 抽屉、会员同 kind 迁移、方案 B 组合改期、全量自动门禁、恢复与独立复审通过，状态转为 `awaiting_user_acceptance`；尚未提交，阶段 12 未开始。

## 21. Preservation Review

- **Coherence:** 已覆盖换房状态日期矩阵、完整重价、库存、会员、渠道、未来位置、事务、Web、组合日期动作和验收。
- **Preservation:** 阶段 11 与 4.2/4.3 明确移交的全部换房规则均已落入；唯一未决映射没有被代码或规格静默猜测。
- **Wrapper-only content:** 未复制与 4.4 无关的清洁、取消、未到、真实收退款、时间轴或发布流程。
- **Open questions:** 无。
