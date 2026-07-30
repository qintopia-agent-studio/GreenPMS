---
title: 'QinTopia PMS 第 4 步 4.2 未入住改期与在住续住'
type: 'feature'
status: 'accepted'
created: 2026-07-29
review_loop_iteration: 1
baseline_commit: '9a625ac'
checkpoint: 4.2
technical_stage: 9
human_acceptance_command: 4.2 通过
context:
  - '待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md'
  - '待开发项/QinTopia-PMS-分步开发与人工验收计划.md'
  - '待开发项/房态与订单运营流程分步开发计划.md'
  - 'docs/implementation/spec-qintopia-pms-core-operations-mvp.md'
  - 'docs/architecture/invariants-and-decisions.md'
---

# QinTopia PMS 第 4 步 4.2 实施规格

## 1. 权威来源与当前状态

本规格只实施正式检查点 4.2 / 工程阶段 9“未入住改期与在住续住”。用户已于 2026-07-29 明确回复 `U2 通过，开始 4.2`，并在完成六组人工验收及当前检查点缺陷修复后明确回复 `4.2 通过`；4.2 / 阶段 9 已接受，4.3 及以后未开始。

权威来源按以下顺序共同约束本切片：

1. [渠道订单计价、住宿生命周期与 4.2 范围纠偏提案](./sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md)
2. [房态与订单运营流程分步开发计划](./房态与订单运营流程分步开发计划.md)阶段 9
3. [QinTopia PMS 分步开发与人工验收计划](./QinTopia-PMS-分步开发与人工验收计划.md)检查点 4.2
4. [核心运营规格](../docs/implementation/spec-qintopia-pms-core-operations-mvp.md)
5. [核心不变量](../docs/architecture/invariants-and-decisions.md)
6. [4.1 实施规格](./QinTopia-PMS-第4步-4.1-实施规格.md)的“2026-07-26 后续开发覆盖声明”

若实现与上述来源冲突，先停止相应分支并修正规格，不由代码自行选择解释。

## 2. 目标与成功信号

### 2.1 目标

- 已预订订单可调整入住日、退房日或两者，保留同一 `orderId/stayId`。
- 已入住订单只可延长退房日；计划退房日后仍真实继续住宿时由工作人员主动续住。
- 每次操作在一次 Preview/Confirm 和一个 PostgreSQL 事务内追加不可变住宿安排、amendment、完整 pricing revision、库存与会员权益变化、审计和 Receipt。
- 日期变化后使用成交时锁定的价格政策版本对完整连续住宿重新计价，旧渠道金额和旧人工偏价不继承。
- 成功后当前房态和订单上下文即时刷新：改期删除的旧日期恢复可售且不再显示/高亮订单，只在原始安排和变更历史中保留；续住的原日期与新增日期仍属于同一个完整 Stay，并保留本次变更边界。

### 2.2 成功信号

检查点只有在 Contract/OpenAPI、领域、真实 PostgreSQL、API、Web、桌面/手机 E2E、类型检查和生产构建全部通过，并启动独立验收实例后，才能转为 `awaiting_user_acceptance`。收到用户明确的 `4.2 通过` 前不得开始 4.3。

## 3. 明确非目标

- 不实现已入住缩短、提前退房或退款参考计算；归 4.3 / 阶段 10。入住当天不提供提前退房，未实际使用房间的“撤销入住”按 2026-07-29 最终确认归 4.5 / 阶段 12。
- 不修改换房、跨产品换房计价或未来换房生效；归 4.4 / 阶段 11。
- 不实现取消、标记未到、20:00 队列或逾期补办入住；归 4.5 / 阶段 12。
- 不登记实际收款、退款、支付方式或住宿转会员；归 4.6/4.7。
- 不重新启用清洁工作流，不修改清洁 schema 或历史记录。
- 不扩大房态日期窗口，不进入阶段 14 的连续 30 天时间轴。
- 不新增平台打款、银行流水、跨订单分摊、待结算或预计/实际实得金额。
- 不借本切片重做 U2 页面、住客资料、会员主档或订单详情信息架构。

## 4. 状态与日期矩阵

所有日期使用物业时区的半开区间 `[arrivalDate, departureDate)`，完整住宿保持既有最长 366 夜限制。

| 当前状态 | 营业日期 | 4.2 允许动作 | 约束与成功后状态 |
|---|---|---|---|
| `RESERVED` | 早于计划到店日 | 调整入住日、退房日或两者 | `newArrivalDate >= businessDate`；`newDepartureDate > newArrivalDate`；至少一个日期变化；仍为 `RESERVED` |
| `RESERVED` | 等于计划到店日、尚未入住 | 同上 | 可改期或走 4.1 普通入住；改期后仍为 `RESERVED` |
| `RESERVED` | 晚于计划到店日 | 人工改期 | 新入住日不得早于营业日；不得自动未到、取消或补办入住；仍为 `RESERVED` |
| `CHECKED_IN` | 早于或等于计划退房日 | 延长住宿 | `newDepartureDate > oldDepartureDate`；仍为 `CHECKED_IN` |
| `CHECKED_IN` | 晚于计划退房日 | 工作人员主动延长住宿 | `newDepartureDate > businessDate`；冲突和完整重价照常执行；否则继续走 4.1 迟录退房 |
| `CHECKED_OUT/CANCELLED/NO_SHOW` | 任意 | 无 | 所有日期变化失败关闭且零业务写入 |

`RESERVED` 的离店日提前或延后都统一属于“调整预订日期”，不能再分别串联 `SHORTEN_STAY` 和 `EXTEND_STAY`。`CHECKED_IN` 的缩短继续失败关闭。

## 5. Command、DTO 与 OpenAPI 合同

### 5.1 新命令 `RESCHEDULE_STAY`

只用于 `RESERVED`：

```ts
interface RescheduleStayInput {
  propertyId: string;
  orderId: string;
  newArrivalDate: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}
```

### 5.2 收紧 `EXTEND_STAY`

只用于 `CHECKED_IN`：

```ts
interface ExtendStayInput {
  propertyId: string;
  orderId: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}
```

### 5.3 原因边界

- 住宿变更原因通过既有 Confirm `reason` 提交，`note` 必填且去除首尾空白后仍非空。
- 渠道价格差异说明只解释本次外部渠道金额相对政策基础金额的差异。
- 人工调价原因只解释 WECOM 主动偏离本次政策重算金额。
- 三类原因不能互相替代；免费和会员住宿也必须填写住宿变更原因。
- Preview effect、Receipt 和订单 Query 返回中文业务所需的前后日期、晚数、原合同金额、政策基础金额、订单新金额、已登记净收款和差额。外围智能体恢复所需的稳定 Command/Receipt 引用继续保留，但 Web 不向工作人员展示内部 ID。

### 5.4 严格合同

- contracts、OpenAPI 与 API schema 必须共同列出新命令和字段，并保持 `additionalProperties: false`。
- `OrderActionCode` 增加 `RESCHEDULE_STAY`；在日期变更动作中，`RESERVED` 只开放 `RESCHEDULE_STAY`，`CHECKED_IN` 只开放 `EXTEND_STAY`，不影响入住、资料更正、收款等其他既有动作。
- 历史 amendment type 保留，新的改期 amendment/segment 使用稳定 `RESCHEDULE_STAY`；只读投影继续显示中文“调整预订日期”。
- command effect schema 必须区分 `before`、`after`、计价决策、库存差集、权益差集和资金只读摘要；损坏数据继续失败关闭。
- `targetCurrentContractAmountMinor` 若出现，必须是 JavaScript safe integer、PostgreSQL `integer` 可存储范围内的非负整元 minor units：`0..2_147_483_600` 且 `multipleOf: 100`。contracts、OpenAPI、API 与领域共同拒绝角分和溢出值。

## 6. 完整重价规则

每次改期或续住先使用原订单锁定的 `pricingPolicyVersionId` 计算完整新安排的政策基础金额，再按订单类型形成唯一目标合同金额。

| 订单类型 | 本次价格输入与校验 | 新 revision |
|---|---|---|
| `YOUMUDAO/CTRIP/MEITUAN` | 必须重新填写“本单渠道应结金额”；不得继承旧目标金额。`abs(target - policyBase) * 100 > policyBase * 15` 时渠道价格差异说明必填 | `CHANNEL_CONTRACT`，`manualAdjustmentMinor=0` |
| `WECOM` | 默认本次政策基础金额；主动偏离时人工调价原因必填 | 默认 `POLICY`，偏价为 `MANUAL_ADJUSTMENT` |
| 会员住宿 | 禁止渠道/人工目标金额；重新计算权益覆盖与现金余量 | `MEMBER_ENTITLEMENT` |
| 免费住宿 | 禁止任何金额输入，始终为 0 | `FREE` |

- 政策按完整连续住宿重选 1/7/14/30 夜档；跨月不拆，允许 6→7、13→14、29→30 的倒挂，只在最终总金额舍入一次。
- `policyBaseAmountMinor`、`currentContractAmountMinor`、`pricingBasis`、差额及适用说明必须写入同一个完整 revision。
- 已登记收退款事实及其原 revision 关联完全不变。
- `collectionDifference = newCurrentContractAmount - netRecordedCollection`。正数只表示待补收参考，负数只表示多收/退款参考，零只表示当前记录无差额；不得宣称已到账、已结清或已核销。
- 本命令不得写入 COLLECTION、REFUND、REVERSAL 或任何外部财务事实。

## 7. 住宿安排与库存迁移

### 7.1 不可变安排

- 原订单、Stay、原 segment、原 amendment 和旧 revision 不变。
- 成功时追加一个 amendment、一份不可变安排版本和一个完整 pricing revision。
- 订单的当前入住/退房日期与当前 revision 指向新安排；同一 `orderId/stayId` 保持不变。
- 用户已选择方案 A：当前有效安排包含多个房源区间的未入住订单在 4.2 严格失败关闭，并显示“该订单已有换房安排，当前版本暂不能调整预订日期”；组合改期留待 4.4 / 阶段 11 与换房规则共同实现。不得由代码自行平移、裁剪或猜测内部换房边界。

### 7.2 Claim 差集

以服务日期和库存单元构成稳定身份：

- 交集 Claim 保持原 ID 和来源，不释放后重建。
- `old - new` 精确释放。
- `new - old` 精确创建并指向新安排版本。
- 新旧范围涉及的全部 `roomId + serviceDate` 先去重、稳定排序并 `FOR UPDATE`，再做冲突重验。
- 整房与子床双向互斥继续由同一库存主干保证；任一新日期冲突时，旧 Claim 不得被提前释放。

## 8. 会员权益迁移

### 8.1 未入住改期

- 交集 HELD coverage 保持原 coverage 身份，不重复写 HOLD。
- 删除日期的 HELD 在同一事务追加 RELEASE 并转为 RELEASED。
- 新增日期使用本次可用余额重新形成 coverage，未覆盖部分按既有 P1 现金余量规则处理。
- 计算新日期可用余额时，必须把本命令即将释放的 HELD 作为同一事务内可重分配额度；零可用余额的等晚数平移不得错误变成现金。
- 数据库继续以部分唯一索引保证同一订单、同一住宿日只能存在一条 `HELD` 或 `CONSUMED` coverage；不得因房源 ID 不同而允许重复有效覆盖。`RELEASED` coverage 与既有 RELEASE 账本继续不可变；订单从 A 改到 B 再改回 A 时新建 coverage，保证只存在一条当前有效 coverage 且余额守恒。

### 8.2 已入住续住

- 既有 CONSUMED coverage 原样保留，永不恢复或重写。
- 原区间已经按现金结算的日期也保持原 revision 构成；续住时后来新增或恢复的权益只能覆盖新增日期，不得追溯覆盖原现金日期。
- 新增日期先形成本次 coverage，再在同一事务立即 CONSUMED，不依赖第二次 CHECK_IN。
- 权益不足时未覆盖日期继续形成现金余量。

### 8.3 多 Lot 失败关闭

同一新增日期若存在多份同类型、同房型且都可覆盖的有效 Lot，当前没有获准的消耗顺序。该日期必须失败关闭；不得自行采用最早到期、创建时间或数据库顺序。已保留的原 coverage 不受此门禁影响。

事务必须锁定会员身份下相关合同/Lot，而不是只锁一条历史 `memberContractId`，防止并发新增或消耗权益绕过 Preview basis。

## 9. PostgreSQL 原子事务顺序

Confirm 使用既有单事务主干，按以下顺序完成：

1. 重验主体、物业 WRITE 权限、精确命令类型、Preview 未使用且未过期、幂等范围和输入 hash。
2. 锁定订单并重读状态、版本、当前 revision、原始/当前安排和营业日。
3. 锁定会员身份下相关合同与 Lot；锁定新旧日期并集的 room-day。
4. 重新构建 effect，重验政策版本/basis、库存、权益、资金摘要和业务日期；effect hash 必须与 Preview 一致。
5. 追加 amendment 和新住宿安排版本。
6. 插入完整 pricing revision，使新增 coverage 可以稳定引用本次 revision。
7. 迁移 Claim 差集和 HELD/CONSUMED coverage，且只核销本次续住新增的 coverage。
8. 更新订单当前日期、当前 revision 和版本。
9. 写入审计、命令 `APPLIED` 状态、`EXECUTED` Receipt 和房态 revision。
10. 一次提交。

任何冲突、陈旧数据、权限变化、营业日跨界、政策/权益变化、故障注入或 Receipt 写入失败都必须回滚全部业务事实。不得出现“先释放旧库存、再发现新库存冲突”的半完成状态。“零业务写入”不删除既有恢复协议：业务事务回滚后仍可另行保存命令 `REJECTED`、`NOT_EXECUTED` Receipt 与拒绝审计。

同主体、物业、命令类型和幂等键的同载荷重放返回原 Receipt；异载荷拒绝。恢复查询只读取原结果，不创建新命令。

## 10. Query 与工作人员流程

- 房态快捷操作和订单详情对 `RESERVED` 显示“调整预订日期”，对 `CHECKED_IN` 显示“延长住宿”。
- 点击动作后进入已通过的覆盖式表单抽屉，填写日期、住宿变更原因及当前订单类型所需的金额说明。
- Web 自动获取服务端预检，只显示一层中文业务核对；正式确认只有一次。
- 核对内容至少显示原日期、新日期、增减晚数、完整新晚数、原合同金额、政策基础金额、订单新金额、已登记净收款和差额。
- 外部渠道显示并要求填写“本单渠道应结金额”。WECOM 默认采用并显示本次政策重算金额，只有工作人员选择主动调整时才显示金额输入和人工调价原因；免费不显示金额编辑；会员显示覆盖晚数、未覆盖晚数和未覆盖金额。
- 预检过期或任何 basis 变化时保留草稿并要求重新核对，不能继续使用旧确认。
- 成功后关闭写抽屉并刷新房态、订单当前安排、变更历史、计价和金额摘要。若 Stay 仍有效，保留完整 Stay 选择、页面滚动位置和合理键盘焦点。
- 改期删除的旧日期恢复可售且不再显示或高亮该订单，只在原始安排和变更历史中可查；改期后当前日期按同一 `orderId/stayId` 选中当前 Stay。
- 续住原日期和新增日期都按稳定 `orderId/stayId` 选中同一连续 Stay；本次续住边界仍可定位。
- 页面不得显示 Preview、Confirm、Receipt、Command、内部 ID、raw payload 或内部枚举。

## 11. 失败关闭与兼容边界

- 无日期变化、非法区间、过去的新入住日、续住日不晚于原退房日、逾期续住日不晚于营业日：拒绝且零写入。
- `RESCHEDULE_STAY` 用于非 `RESERVED`、`EXTEND_STAY` 用于非 `CHECKED_IN`：拒绝且零写入。
- 已入住缩短继续由前后端隐藏并由服务端失败关闭。
- 终态订单、损坏当前安排、多 Lot 未决选择：拒绝且不猜测。多房源未入住安排按第 7.1 节使用稳定中文原因失败关闭。
- 旧 `SHORTEN_STAY` / `EXTEND_STAY` 的未入住测试和夹具必须迁移到新命令；不得删除相关业务覆盖。
- 现有外部智能体 Preview/Confirm/Receipt、权限、恢复和 OpenAPI 路径保持兼容；新增合同为 additive，收紧非法状态是本阶段批准的行为变更。

## 12. 自动化测试矩阵

### 12.1 Unit / Domain

- 状态/日期矩阵、无变化和最长住宿边界。
- 6→7、13→14、29→30、跨月和倒挂。
- 外部渠道 15% 两侧、WECOM 默认/偏价、免费、会员全额/部分/零覆盖。
- 资金差额正、零、负的纯算术与中文呈现。

### 12.2 Contract / OpenAPI

- `RESCHEDULE_STAY` 和收紧后的 `EXTEND_STAY` required/properties/additionalProperties。
- 金额字段覆盖 safe integer、`0..2_147_483_600`、`multipleOf: 100`，角分和溢出输入失败关闭。
- Preview effect、Receipt、Order action 和 Query DTO。
- Preview effect/Receipt 的 `before` 明确包含原合同金额，Web 可据此显示而不反推。
- 损坏 arrangement、pricing、coverage、fulfillment DTO 继续失败关闭。

### 12.3 真实 PostgreSQL Integration

- 未入住：提前/延后入住、提前/延后退房、整体平移、无变化、过去入住日、终态拒绝。
- 已有多个房源区间的未入住订单失败关闭，返回稳定中文原因且业务事实零变化。
- 在住：计划退房日前、当天及逾期主动续住；新退房日必须满足边界。
- 同一 `orderId/stayId`、旧事实不变、新事实追加；交集 Claim/coverage ID 保留，差集精确变化。
- 会员改期 A→B→A：旧 RELEASED coverage/账本保留，只存在一条当前有效 coverage，余额守恒且无唯一键冲突。
- 房床互斥、双连接竞争、订单状态变化、权益变化、政策 basis 变化、陈旧确认。
- pricing revision、Claim、coverage/ledger 与最终 Receipt 各写入阶段的故障注入或等价约束失败前后，业务表逐表快照相同；允许另行保留 `REJECTED` 命令、`NOT_EXECUTED` Receipt 与拒绝审计。幂等重放不重复 revision/Claim/Ledger。
- 外部渠道旧目标不继承，WECOM 旧偏价不继承，收款 facts 和原 revision 关联不变。
- RESERVED 会员 HELD 迁移；CHECKED_IN 新覆盖同事务 HOLD+CONSUME；既有 CONSUMED 不变；多 Lot 失败关闭。
- 免费改期/续住为 0，且无权益或资金写入。

### 12.4 Web / E2E

- 房态内打开表单、自动预检、一次确认、返回修改保留草稿、结果未知恢复。
- 成功留在房态，订单上下文、金额、原始/当前安排和变更历史刷新。
- 改期删除的旧日期恢复可售、不再显示/高亮订单；当前新区间仍按同一 `orderId/stayId` 选择。
- 续住原日期与新增日期选择同一连续 Stay 并显示续住边界。
- 桌面完整旅程、移动端规则烟测、键盘/Escape/焦点和滚动位置保持。
- 不出现内部协议词、ID 或错误资金语义。

## 13. 专用验收数据与人工验收

使用独立数据库 `qintopia_stage9_acceptance`，所有日期相对营业日生成并放在当前 21 天窗口内。夹具全部通过正式命令建立，在住样例必须真实执行 CHECK_IN，不直接修改业务表。

至少准备：

- 五张独立未入住普通订单：提前入住日、延后入住日、缩短预订（计划退房日提前）、延长预订（计划退房日延后）、整体平移。不得把未入住订单的计划日期调整称为“提前离店”；真实入住后的提前离店属于 4.3。
- 一张已有收款订单：验证收款不变和新差额。
- 一张携程订单：验证重新填写本单渠道应结金额及 15% 说明。
- 一张曾主动偏价的 WECOM 订单：验证本次默认政策重算金额且旧偏价不继承。
- 一张未入住会员订单：验证 HELD 差集迁移。
- 一张已入住会员订单：验证续住新增权益立即核销。
- 一张已超过原计划退房日但仍在住的订单：验证必须由工作人员主动续住，并保持原计划日期和办理营业日语义。
- 一张免费订单：验证改期/续住 0 元且无会员事实。
- 一张新范围库存冲突订单：验证失败关闭和零部分写入。
- 一张已有换房安排的未入住订单：验证日期动作失败关闭并明确留待换房组合规则处理。

交付时提供 URL、账号、每张样例的房号/住客名和逐步操作。人工验收逐项确认：

1. 未入住五种日期变更都保留同一订单、原安排和原因，新库存与新金额一次生效；删除的旧日期恢复可售且不再高亮订单。
2. 已有收款保持不变，页面只显示补收或退款参考差额，不自动产生资金事实。
3. 外部渠道重新填写本单渠道应结金额；WECOM 不继承旧偏价；免费保持 0。
4. 未入住会员只迁移 HELD；已入住会员续住新增覆盖立即核销，既有核销不变。
5. 冲突样例明确拒绝且旧日期、库存、金额、权益均不变化。
6. 计划内续住和逾期主动续住后，点击原日期或新增日期都选中同一个完整 Stay，并能看见续住边界。

## 14. 实施清单与停点

- [x] 六份权威文档完整复核。
- [x] 需求、事务和测试夹具只读审计。
- [x] 独立规格审查第一轮完成并修正合同、恢复协议、coverage 重入与验收矩阵。
- [x] 用户选择多房源方案 A：4.2 失败关闭，留待 4.4。
- [x] U2 状态同步为已通过，4.2 / 阶段 9 进入实施。
- [x] contracts/OpenAPI 与领域规则。
- [x] PostgreSQL 原子事务、Query/API 与数据库守卫。
- [x] Web 房态内改期/续住流程。
- [x] Unit、Integration、Contract、E2E、TypeScript 与 build。
- [x] 独立验收数据库和可试用实例。
- [x] 用户人工验收 `4.2 通过`。
- [x] 验收后独立审计、阻断修复、完整回归与 Git 收尾。

用户已明确回复 `4.2 通过`，本规格更新为 `accepted`。本次收尾只固定 4.2 行为并完成测试、计划同步和 Git 提交；4.3 / 阶段 10 仍为 `pending`，不得在本次收尾中提前实施。

## Spec Change Log

- 2026-07-29：4.2 验收后独立审计关闭两个提交阻断。日期变更 Direct Preview 与 Confirm 现在都会在任何业务写入前复用完整生命周期投影，四类 Stay/amendment/revision/segment 损坏事实新增 PostgreSQL 零写入测试；已入住会员原权益已经 CONSUMED、合同随后失效时，续住保留原覆盖并只对新增夜形成现金余量，新预订和未入住会员仍拒绝失效权益。独立复核无阻断，最终门禁为 TypeScript、Unit `430/430`、Integration `202/202`、Contract/OpenAPI `59/59`、pricing facts `7/7`、Stage 9 E2E `8 passed / 8 expected skipped`、production build 与 `git diff --check`；4.3 / 阶段 10 未开始。
- 2026-07-29：用户明确回复 `4.2 通过`。六组人工验收全部完成；验收期间修复了第一层重价不可见、企业微信金额控件与文案、日期抽屉缺少住客/房号/中文状态/当前周期及误称“原预订日期”，并把“今天”改为轻量底色提示。上述修复未扩张 4.2 业务边界；真实提前退房仍归 4.3，多房源未入住组合改期仍归 4.4。4.2 转为 `accepted`，4.3 及以后未开始。
- 2026-07-29：4.2 第六大条人工验收发现房态横向滚动后左侧房号离开视口，而日期调整/续住抽屉只显示日期并把当前有效周期误称为“原预订日期”，导致操作员把已连续续住两次的 202 误认为尚未续住的 D02。数据库和真实页面核对确认两张订单没有串联：202 当前为 `2026-07-28` 至 `2026-07-31`，D02 仍为 `2026-07-26` 至 `2026-07-28`。本轮只修 Web 操作上下文：抽屉固定显示当前预订/住宿日期、中文状态、住客、房号和当前周期，并增加计划退房日与逾期续住 E2E 断言；不修改订单、计价、库存和续住规则。Unit `430/430`、TypeScript、production build、Stage 9 E2E `8 passed / 8 expected skipped` 与真实验收实例视觉核对通过。用户随后明确要求当前版本就用美观底色表示今天；本轮仅把日期头和整列改为轻量品牌色底色并移除贯穿全表的粗竖线，保留“今天”文字作为非颜色提示，不提前实现第 5 步时间轴结构。
- 2026-07-29：4.2 第一轮人工验收发现日期输入层只显示原金额，操作员必须进入下一层才知道重价结果；企业微信说明使用“政策重算、人工偏价、继承”等技术化表达，且未受控的全局输入框样式把复选框放大为蓝色方块。同时确认验收样例“提前离店”命名错误：该样例仍未入住，只是缩短预订安排。4.2 只修当前缺陷：日期或金额输入有效后调用既有服务端 Preview，在第一层明确显示原金额、调整后金额和变化；库存冲突停留在第一层失败关闭；企业微信改为“另行调整金额”及业务语言；样例改名为“缩短预订/延长预订”。真实提前离店仍严格留在 4.3。
- 2026-07-29：4.2 / 阶段 9 完成并转为 `awaiting_user_acceptance`。新增 `RESCHEDULE_STAY`，收紧 `EXTEND_STAY`，完成完整重价、库存 Claim 与会员 HELD/CONSUMED 差集迁移、渠道/WECOM/免费规则、Preview 陈旧与故障回滚、中文 Web 核对和房态选择恢复。最终门禁为 TypeScript、Unit `430/430`、Integration `197/197`、Contract/OpenAPI `59/59`、pricing facts `7/7`、Stage 9 E2E `7 passed / 7 expected skipped`、production build 与 `git diff --check`；长时联合回归暴露的既有 UI 五秒时序项均已聚焦复跑通过，Stage 9 房态新鲜度竞态测试改为显式刷新后再执行写动作。独立验收库 `qintopia_stage9_acceptance` 与实例 `http://127.0.0.1:4321/` 保留，用户人工验收和 Git 提交尚未完成，4.3 未开始。
- 2026-07-29：用户对两处多房源改期询问均明确选择 `A`。4.2 只允许当前有效安排为单房源区间的未入住订单改期；已有换房安排的未入住订单以稳定中文原因失败关闭并纳入 PostgreSQL、Web 与人工验收，组合规则留待 4.4 / 阶段 11。
- 2026-07-29：独立规格审查第一轮完成。补充 coverage A→B→A 所需部分唯一索引、成功/拒绝恢复状态、改期与续住不同的房态选择语义、原合同金额、金额精度范围、分阶段故障注入及完整验收数据；多房源未入住改期边界等待用户明确选择。
- 2026-07-29：用户明确回复 `U2 通过，开始 4.2`。完成六份权威文档复核及需求、事务、测试三路只读审计，冻结 4.2 的状态日期矩阵、原子命令、完整重价、Claim/权益迁移、失败关闭、测试与独立人工验收边界；产品代码尚未修改，4.3 及以后保持未开始。
