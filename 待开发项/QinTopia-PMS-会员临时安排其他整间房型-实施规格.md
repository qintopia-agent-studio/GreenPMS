# QinTopia PMS 会员临时安排其他整间房型实施规格

状态：已冻结并实现，自动检查、失败项修正复验、本地人工验收和视觉复核均已通过  
冻结日期：2026-09-05  
风险等级：A 级（会员权益、库存占用、事务、并发和审计）

## 1. 权威决定与目标

本规格落实 `deferred-work.md` 中 2026-09-04 已确认的业务决定，以及用户于 2026-09-05 对冻结方案的明确确认。

目标是在不增加新入口和审批流程的前提下，让工作人员从正常房态表选择空的整间房、创建订单、选择会员并使用其原有整房权益，将会员本次临时安排到另一个整间房型。

本次安排必须同时满足：

- 原会员权益是有效的 `ROOM_NIGHT` 整房权益。
- 实际目标库存是 `inventory_units.kind = ROOM` 的整房销售单位。
- 所有住宿服务日都由同一份可唯一确定的原合同和原权益 Lot 完整覆盖。
- 每晚仍从原 Lot 扣除 1 个 `ROOM_NIGHT`。
- 只占用实际目标房间，不占用原适用房型。
- 不增加房型差价、现金行、收款、退款或人工调价。
- 不改变会员产品、合同、有效期和以后适用房型。
- 普通员工与管理员均通过既有 `CREATE_ORDER` 权限执行；管理员继续是普通员工权限的严格超集。

## 2. 非目标

- 不新增“换房”“升级”或管理员专属入口。
- 不新增业务命令，不复用 `FREE_STAY`，不创建额外权益。
- 不支持 `BED_NIGHT -> ROOM`、`ROOM_NIGHT -> BED` 或任何床位参与的临时安排。
- 不新增会员产品选择、Lot 选择、补差价、退款或审批流程。
- 不修改普通匹配房型会员订单的现有部分覆盖和现金余款规则。
- 不在首版自动扩张临时安排的日期或迁移到另一房源。
- 不通过覆盖或删除既有订单、库存、权益和审计事实纠错。

## 3. 精确定义

### 3.1 整房

目标“整间房”以现有库存模型为准：`inventory_units.kind = ROOM`。这包括系统中以整房形式出售的多人房；其床位销售单位仍属于 `BED`，不能参与本功能。

来源权益必须同时满足：

- `membership_orders.allowed_inventory_kind = ROOM`
- `membership_orders.entitlement_unit_kind = ROOM_NIGHT`
- `entitlement_lots.unit_kind = ROOM_NIGHT`

### 3.2 完整覆盖

住宿日期使用物业时区和现有 `[arrivalDate, departureDate)` 半开区间。临时安排的 `coverageSet` 数量必须等于服务日数量，每个服务日恰有一条来自同一原 Lot 的覆盖。

少一晚余额、部分日期无效、会员订单未生效、合同未生效、合同已失效、Lot 已过期或已过期入账时，整单失败；不得回退为现金住宿。

### 3.3 唯一权益来源

客户端只选择会员，不选择产品、合同或 Lot。服务端必须从当前门店中解析唯一可覆盖完整住宿区间的活动整房会员来源。

如果同时存在两份或多份可覆盖来源，或需要组合多个 Lot 才能完整覆盖，保持现有“消耗顺序未确认”失败关闭，不新增一线选择流程。

如果会员同时存在可精确匹配实际目标房型的有效权益，必须优先按普通匹配会员订单处理，不得选择或生成临时安排。

## 4. 用户旅程

### 4.1 普通匹配房型

房型精确匹配时，现有页面、自动报价、会员覆盖摘要、建单和确认流程完全不变，不显示临时安排选项。

客户端即使直接提交临时安排标识，服务端也必须拒绝，防止为普通订单制造错误审计。

### 4.2 房型不匹配

1. 工作人员从房态选择空的整房并点击“创建订单”。
2. 勾选“本次住宿使用会员权益”并选择会员。
3. 正常报价发现房型不匹配时，由服务端返回结构化 `ENTITLEMENT_CONFLICT`；前端不得匹配中文错误文案。
4. 只有服务端确认来源为整房权益、目标为整房、全晚有效、余额充足且来源唯一时，错误详情才返回 `temporaryOtherRoomAvailable: true`。
5. 页面显示“本次临时安排其他房型”复选项。勾选后显示必填的简短原因，去除首尾空白后长度为 1 至 200 个字符。
6. 勾选会触发一次带 `temporaryOtherRoom: true` 的重新报价；原因输入不触发连续自动报价。
7. 页面显示原适用房型、实际房间/房型、覆盖晚数和零补差结果。
8. 创建订单后进入既有 Preview/Confirm；核对页显示临时安排摘要和锁定原因，只确认一次。

### 4.3 原房型仍可能有空

“原房型仍有空”定义为：报价快照时，原适用房型至少存在一个活动 `ROOM` 库存单位，在整个住宿区间均可用。

满足时页面额外提示：“系统显示原会员房型仍可能有空房，请确认现场安排原因。”

该结果只用于运营提醒：

- 原房型无论是否有空，所有临时安排都必须填写原因。
- 不锁原房型 room-day，不占用原房型库存。
- Preview 到 Confirm 之间原房型可用性变化不造成陈旧或阻断。
- 实际目标房间和会员权益仍必须在 Confirm 锁后重验。

### 4.4 响应式要求

- 桌面 440px 写入抽屉中的临时安排区固定为单栏。
- 移动端沿用房态选择器返回页面内联报价区的现有旅程。
- 标签和值容器使用稳定布局、`min-width: 0` 和必要的长词换行。
- 帮助说明放在可悬停、可键盘聚焦的 `InfoHint` tooltip 中。
- 必须验证 1280x720、412x839、375px 和 320px 宽度无重叠、截断或横向滚动。
- 用户可见文案不得出现 Lot、projection、override、数据库字段或协议名称。

## 5. 契约

### 5.1 Quote 请求与响应

`CreateQuoteCommandInputDto` 和 `QuoteRequestSchema` 增加：

```ts
temporaryOtherRoom?: true;
```

仅会员报价允许该字段。精确匹配、免费入住、非会员报价和目标床位提交该字段时必须拒绝。

成功的临时安排 Quote 增加服务端生成的 `temporaryOtherRoomArrangement`；初次未确认的结构化 409 只返回展示资格所需的安全字段，不接受客户端提供的合同、Lot 或房型事实。

### 5.2 CREATE_ORDER 输入

`CreateOrderInputDto` 和严格 API Schema 增加：

```ts
temporaryOtherRoomReason?: string;
```

临时安排 Quote 必须提供有效原因；普通 Quote 不得提供该字段。

### 5.3 不可变安排快照

Quote 结果、`CREATE_ORDER` Effect、Receipt 和首个 amendment 使用同一个类型化结构：

```ts
interface TemporaryOtherRoomArrangementDto {
  kind: "TEMPORARY_OTHER_ROOM";
  membershipOrderId: string;
  memberContractId: string;
  entitlementLotId: string;
  originalRoomTypeCode: string;
  originalInventoryKind: "ROOM";
  entitlementUnitKind: "ROOM_NIGHT";
  actualInventoryUnitId: string;
  actualRoomTypeCode: string;
  actualInventoryKind: "ROOM";
  arrivalDate: string;
  departureDate: string;
}
```

这些字段全部由服务端生成。原因不在该对象中重复保存，而是锁定为 amendment/audit 的 reason。

### 5.4 Confirm reason

临时安排的确认原因固定为：

```ts
{ code: "TEMPORARY_OTHER_ROOM", note: temporaryOtherRoomReason }
```

Confirm 必须验证 code、非空 note 及 note 与 Preview 锁定值完全一致。普通创建订单仍只允许 `CREATE_STANDARD_ORDER` 空备注，补录仍只允许 `BACKFILL_STAY`。

## 6. 数据模型与持久化

不新增业务表。

- `coverage_items.contract_id/lot_id` 继续指向原合同和原 Lot。
- `coverage_items.inventory_unit_id` 保存实际安排房间。
- `entitlement_ledger` 继续对原 Lot 写 `HOLD/CONSUME/RELEASE/RESTORE`。
- `stay_segments` 和 `inventory_claims` 继续保存并占用实际目标房间。
- `pricing_revisions` 保存全晚 coverage、空现金行、零合同金额和零人工调价。
- 首个 `CREATE_ORDER` amendment 保存 `temporaryOtherRoomArrangement`，`reason_code = TEMPORARY_OTHER_ROOM`，`reason_note` 保存现场原因。
- `amendments.command_id -> command_executions.subject_id -> subjects` 提供操作人；amendment 和 command 时间提供操作时间。
- `audit_entries.reason` 保存同一 code 和 note。

订单详情增加只读中文记录：“本次临时安排其他房型”，展示原适用房型、实际房型/房间、住宿日期、原因、操作人和操作时间。

## 7. 领域不变量

临时安排必须同时满足：

1. Quote、Preview、Confirm 和持久化 amendment 均明确标识同一临时安排。
2. 原会员订单、合同、Lot、会员和物业归属一致且状态有效。
3. 原房型与实际房型不同；相同时拒绝临时安排标识。
4. 来源和目标均为整房，权益单位为 `ROOM_NIGHT`。
5. 每个服务日恰好覆盖一次，全部来自快照中的同一 Lot。
6. `cashLines` 为空，`cashRemainder = 0`，`currentContractAmount = 0`，`manualAdjustmentMinor = 0`。
7. 不接受订单来源渠道、渠道订单号、人工价格原因、收款或退款输入。
8. Claim 只写实际目标房间及日期。
9. 原会员产品、合同、Lot 总量和有效期不发生修改。
10. 任何未携带完整证据的房型不匹配继续由应用和数据库拒绝。

## 8. 事务、锁与并发

Confirm 继续在一个 PostgreSQL 事务中执行，保持现有顺序：

1. 锁命令协议版本并重验主体、物业 WRITE、exact `CREATE_ORDER` grant、Token ceiling 和既有命令发布门禁；首版不新增独立的临时安排运行期开关。
2. 锁 Preview 和幂等命令执行槽。
3. 获取 `qintopia:member-entitlements:{memberId}` advisory transaction lock。
4. 锁会员、原合同、原 Lot；同一会员的权益更正、作废重建和并发住宿由相同 advisory lock 串行化。
5. 按稳定的 room/date 顺序锁实际目标 room-day。
6. 锁后重建 Effect，重验来源唯一性、状态、有效期、余额、全晚覆盖、实际库存及零资金结果。
7. Effect hash 与 Preview 不同则返回 `PREVIEW_STALE`，不得部分应用。
8. 写入订单、Stay、amendment、segment、pricing revision、实际 Claim、coverage、ledger、Receipt 和 Audit。

原适用房型的可用性不属于业务门禁，因此不加锁、不参与 Effect hash，也不产生 TOCTOU 业务风险。

实际目标房间并发继续由 room-day 行锁、锁后 `assertUnitAvailable()` 和房床互斥指针保证只有一笔成功。权益并发继续由会员 advisory lock、合同/Lot 行锁、锁后余额重算和账本守恒保证不超扣。

## 9. 数据库迁移与 readiness

新增版本化 migration `052_temporary_other_room_member_stays.sql`，不得修改旧 migration。

迁移必须：

- 保留 `qintopia_validate_coverage_ownership()` 的默认会员产品精确匹配规则。
- 仅在同一订单首个 `CREATE_ORDER` amendment 具有完整 `TEMPORARY_OTHER_ROOM` 证据时，允许 `ROOM_NIGHT` 对另一 `ROOM` 房型建立 coverage。
- 对每条例外 coverage 校验会员订单、合同、Lot、物业、会员、日期、实际 inventory 和类型化快照一致。
- 增加 deferred 整单断言，在事务结束前验证服务日完整覆盖、同一原 Lot、零现金、零人工调价、实际 Claim 和命令/审计关联。
- 缺失 reason、缺少任一服务日、错误 Lot、床位参与、快照篡改或普通错配时失败。
- 将新 migration、函数、触发器、body marker、精确绑定和 SHA-256 函数指纹纳入 `databaseReady()`。
- 为受限 runtime 身份只增加执行本命令所需的最小权限，不授予 DDL、DELETE、触发器管理或宽泛 UPDATE。

## 10. 幂等、恢复与回滚

- Quote 和 CREATE_ORDER 继续使用现有主体/物业/命令/幂等键命名空间。
- 同键同请求返回原 Receipt；同键不同原因或不同安排返回 `IDEMPOTENCY_KEY_REUSED`。
- Preview 使用一次；Quote 过期、权益变化、合同失效、实际房间被占或 Effect 改变时返回陈旧并要求重新核对。
- 网络中断后使用现有 command result/Receipt 恢复，不创建第二张订单或重复权益事实。
- Confirm 事务任一步失败时，订单、Claim、coverage、ledger、amendment、Receipt 和 ALLOWED audit 均不得部分存在；拒绝记录沿用现有独立拒绝审计。
- 已提交订单不得删除或直接覆盖。取消、未到、撤销入住和日期减少继续使用现有追加式补偿事实；`RESERVED/PLANNED` 删除日期释放实际 Claim 和对应 `HELD` 权益，入住后的普通缩短沿用已验收规则，只释放被裁日期的实际 Claim，不返还已经核销的权益。
- 发布后如需停止新建，通过前向兼容版本停止临时安排资格提示和新 Quote，并同时拒绝带临时安排标识的 Preview/Confirm（包括停用前已有的 Quote/Preview）。保留 migration、历史读取和既有生命周期兼容；首版没有独立配置开关，不得回退到无法读取既有例外记录的旧数据库守卫。

## 11. 首版后续生命周期边界

原 `CREATE_ORDER` amendment 及其中的 `temporaryOtherRoomArrangement` 永不改写。允许的后续命令只追加自身的类型化 amendment 和必要的零元 pricing revision；Effect、Receipt、同键重放和恢复查询必须返回同一原安排摘要及原创建 amendment 引用。

以下既有操作继续允许，并必须识别和保留临时安排事实：

- `CHECK_IN`：将既有 HELD coverage 从原 Lot 核销为 CONSUMED。
- `CHECK_OUT`、`COMPLETE_STAY`：不重复核销权益。
- `CANCEL_ORDER`、`MARK_NO_SHOW`：释放未使用的实际 Claim 和 HELD 权益。
- `REVOKE_CHECK_IN`：沿用既有补偿规则，保留原消费历史。
- `CORRECT_ORDER_OCCUPANT`：只改住客资料，不得改变临时安排、日期、实际房间、价格或权益来源。
- 仅减少日期集合的未入住 `RESCHEDULE_STAY`：只允许 `RESERVED/PLANNED` 订单；新服务日集合必须是当前连续服务日集合的严格、非空子集，至少删除一日且 `addedDates = []`。保留日期的实际房间、Claim 和 coverage 身份不变；删除日期只关闭实际 Claim，将对应 `HELD` coverage 变为 `RELEASED` 并逐晚追加唯一 `RELEASE`。不得新增、迁移、重新分配或核销 coverage，金额、cashLines 和 manual adjustment 始终为零。
- `SHORTEN_STAY`：只允许沿用现有 `CHECKED_IN/IN_HOUSE` 日期矩阵，从时间线尾部删除未来日期；arrival 不变，`businessDate <= newDepartureDate < oldDepartureDate`，保留日期的实际房间不变。只释放被裁日期的实际 Claim，追加缩短 amendment 和零元 revision；原 `CONSUMED` coverage、`CONSUME` ledger、Lot 余额以及 contract/Lot version 全部原样保留，不写 `HOLD/RELEASE/CONSUME/RESTORE`。新 revision 的 coverageSet 只包含新区间内的原 coverage 子集，被裁日期只进入 `retainedHistoricalConsumedCoverageDates`；重复缩短遵守同一守恒。`newDepartureDate = businessDate` 时继续使用既有同命令原子 `CHECK_OUT` 组合。

这里的“每晚扣除一晚”沿用现有会员住宿语义：创建订单时每个确认服务日 `HOLD` 一晚，`CHECK_IN` 时将该订单全部 `HELD` 核销为 `CONSUMED`；入住后的普通缩短不恢复已核销权益。本切片不得借临时安排改变普通会员住宿已经验收的核销和缩短规则。

以下首版失败关闭，并返回可操作中文提示“临时安排的订单如需增加日期或再次换房，请重新建立符合现场安排的订单”：

- `EXTEND_STAY`
- 会增加新服务日或整体迁移日期的 `RESCHEDULE_STAY`
- `MOVE_UNIT`
- `REPRICE_ORDER`
- `REFRESH_MEMBER_COVERAGE`
- `RECORD_COLLECTION`、`RECORD_REFUND`、`REVERSE_FACT`
- 会更换原 contract/Lot、迁移或重建 coverage 的会员纠错、作废重建与余额操作

未入住改期如果无变化、变为空集合、平移日期、增加任一服务日、改变保留日期的实际房间或迁移权益，也必须失败关闭。除上述明确允许的命令外，任何会改变日期、实际房间、价格、资金、coverage 或原会员链的操作均由领域和数据库拒绝；不得只通过隐藏按钮实现限制。只读一致性校验和历史读取必须认识合法的临时安排证据，不能仅因实际房型不等于会员产品房型而误报损坏。

## 12. 开发前失败测试

在实现前先补测试并证明当前代码失败：

### 12.1 Domain/API/Contract

- Quote 与 CREATE_ORDER 严格 Schema 接受合法新字段，拒绝未知、错误类型和越权组合。
- 普通匹配报价不返回临时安排结构。
- 整房错配未确认时返回结构化资格；床位、不完整余额和无效权益不返回可继续资格。
- Effect、Receipt 和 amendment payload 精确公开不可变安排快照。
- Confirm 只接受与 Preview 一致的 `TEMPORARY_OTHER_ROOM` 原因。
- 历史 Preview/Receipt 继续只读兼容，OpenAPI 属性集同步更新。

### 12.2 PostgreSQL Integration

- 公卫单人间权益安排独卫单人间成功；独卫单人间权益安排另一整房成功。
- coverage/ledger 使用原合同和原 Lot；Claim 只占实际目标房间；合同和产品不变。
- 全晚零现金、零人工调价且不产生 collection/refund。
- 未确认、空原因、相同房型伪标记、床位双向跨类型、跨物业和伪造来源全部拒绝且零业务写入。
- 未生效、过期、少一晚余额、多个可选来源和多 Lot 拼接全部拒绝。
- 两笔并发抢同一实际房间只有一笔成功。
- 两笔并发消耗不足以同时覆盖的原 Lot 只有一笔成功。
- Preview 后实际房间被占、余额变化、合同失效时陈旧。
- 同幂等键重放不重复 Claim、coverage 或 ledger；不同原因复用键冲突。
- 在 amendment、Claim、coverage、ledger、Receipt 前后的故障注入均整单回滚。
- 直接 SQL 构造缺日期、错 Lot、错房型、床位或残缺快照时 deferred guard 拒绝。
- readiness 对 migration、函数、触发器、绑定、指纹和 runtime 权限漂移失败关闭。
- 允许的生命周期操作保持守恒；增加日期、再次换房和重价失败关闭。
- 未入住日期减少分别覆盖左裁、右裁和两端裁剪；验证严格非空子集、零新增日期、保留日实际房间/Claim/coverage 身份不变、删除日 Claim 和 HELD 权益逐晚释放，并验证无变化、空集合、平移、增日、换房或换 Lot 均零写入拒绝。
- 入住后缩短和重复缩短验证只裁尾并释放实际 Claim；原 CONSUMED coverage、账本内容、Lot 余额和 contract/Lot version 不变，不允许追加 RESTORE/RELEASE 或改写原临时安排。
- 允许的入住、退房、完成、取消、未到、撤销入住、住客资料更正及受限日期命令在 Effect、Receipt、幂等重放和恢复查询中返回同一原安排摘要和原创建 amendment 引用。
- 资金命令、权益刷新、会员链纠错/作废重建以及直接 SQL 对原 contract/Lot、coverage 或安排快照的修改均失败关闭。

### 12.3 Web Unit/E2E

- 正常匹配路径 DOM 和请求不变。
- 结构化 409 才显示临时安排选项，不解析中文错误信息。
- 复选、原因必填、原房型有空提醒、重新报价和提交字段正确。
- 切换会员、日期或房间时清空确认态；恢复记录不能串到另一安排。
- 床位双向跨类型只显示硬拒绝。
- 桌面、412px、375px、320px 的提示、tooltip、原因和按钮无重叠或横向滚动。

## 13. 自动门禁

实现后依次通过：

1. TypeScript typecheck。
2. Unit/Domain 全量测试。
3. 真实 PostgreSQL Integration 全量测试及数据库锁运行器。
4. Contract/OpenAPI 全量测试。
5. 真实计价事实测试。
6. production build。
7. 空库 migration 001-052、受限 runtime readiness、迁移/门禁篡改测试。
8. 桌面和手机真实浏览器 E2E，并补充 375px/320px 页面像素与横向溢出检查。
9. `git diff --check`。
10. `gpt-5.6-sol + ultra` 最终安全、事务、并发、契约和高风险边界审查。

任一门禁失败不得进入人工验收。

## 14. 逐项人工验收

所有场景使用同一套本地真实 Web/API/PostgreSQL 构建，不使用 mock，不要求用户操作数据库或开发者工具。

1. **公卫单人间 -> 独卫单人间：** 从独卫单人间空房创建订单，选择公卫单人间会员，确认显示临时安排选项；填写原因后成功。订单详情显示原房型、实际房型、日期、原因和操作人。入住后会员原权益按每晚 1 间夜核销。
2. **独卫单人间 -> 其他整房：** 选择另一整房完成同样流程；房态只占用实际房间，原适用房型没有新增占用。
3. **原房型仍有空：** 保留至少一间原房型在整个区间可售；确认出现提醒，填写原因后仍可继续。
4. **床位权益 -> 整房：** 使用公卫四人间床位会员选择整房；明确拒绝，返回房态后无订单、库存或权益变化。
5. **整房权益 -> 床位：** 使用整房会员选择具体床位；明确拒绝且零写入。
6. **无效权益：** 分别使用未生效、已过期和少一晚余额的会员；全部不能继续，不出现现金补余晚。
7. **普通匹配会员订单：** 创建精确匹配房型会员订单；页面、报价、部分覆盖规则和入住核销与原版本一致。
8. **非会员流程：** 完成普通订单创建、收款、入住和退房；金额、库存和状态流转不受影响。
9. **权限一致：** 普通员工和管理员各执行一笔临时安排；入口、结果和限制相同，详情分别显示正确操作人。
10. **实际房间并发：** 两个独立会话同时确认同一目标房间；只允许一笔成功，另一笔提示目标房间已被占用，权益不重复扣减。
11. **桌面与手机：** 在桌面及 412px、375px、320px 宽度完成资格提示、原因填写、Preview 和 Confirm；确认无文字、按钮、tooltip 重叠或横向滚动。

另用一笔代表订单验证取消或未到能释放实际库存和 HELD 权益；再验证续住、增加日期和再次换房显示首版失败关闭提示。

## 15. 完成标准

本切片只有在以下条件全部满足后才可标记通过：

- 本规格已冻结且实现未偏离。
- 失败测试先在旧行为上形成红灯证据。
- 全部自动门禁通过。
- 本地真实版本完成上述人工验收。
- 用户明确回复本切片通过。

提交、推送 GitHub 和生产部署均须取得用户明确许可；2026-09-06 用户已授权本切片提交、推送并部署到服务器。

## 16. 2026-09-05 收尾记录

- 实现及失败测试已落地。最终专项审查发现并修复历史住宿安排更正绕过临时安排限制的数据库漏口；migration 052 显式拒绝 `CORRECT_HISTORICAL_STAY_ARRANGEMENT`。已用完成态临时订单和完整更正写链复现旧守卫放行，新守卫在 `qintopia_runtime` 下精确拒绝且事务无残留。生命周期函数实际 PostgreSQL `prosrc` SHA-256 为 `f48371f00b8377485122ef26f988ace3a1cf6a54711e94937f9c74d45c1f6a54`，readiness 指纹与 marker 数量已同步，专项只读复审无新增 finding。
- 原有手机取消/提前退房回归暴露收款表格读屏说明逃出滚动容器的问题；仅为 `.fact-reverse-action` 补相对定位，保留读屏说明、表格滚动和真实点击测试。2 个手机用例及 1 个桌面核心旅程已通过；收款断线恢复干净重跑通过。
- 最终数据库合并版本已完成：TypeScript；47 文件 / 1097 项 Unit/Domain；13 项测试锁运行器；41 文件 / 698 项真实 PostgreSQL Integration；11 文件 / 86 项 Contract/OpenAPI；7 项真实计价事实；production build；`git diff --check`。47 项临时安排数据库守卫全部通过，包含受限 runtime 身份的历史安排更正拒绝与事务零残留。此前并发 reset/角色更新冲突已由无并发的完整集成复验排除。
- 最终应用构建的完整浏览器回归记录为 154 项通过、152 项按平台或显式验收开关跳过、4 项失败。4 项均定位为旧测试问题：报价中断误命中抽屉中间报价且只等待恢复请求发出；桌面/手机收款更正按首行误选且内层定位带入祖先；手机返回房态仍期待旧的找不到位置行为。仅修正测试，保留业务实现和关键断言：精确报价类型/房间/日期、原幂等键与成功响应、原交易单号、恢复的完整日期/房间/选区/原订单。
- 上述失败项修正后，报价恢复连续重复 3 次全部通过；最后将全部 4 个失败场景与本功能的 3 个场景一起合并复验，结果为 7 项通过、3 项平台跳过、0 失败。全量运行发现的失败项全部关闭；此记录是“完整回归 + 修正项及本功能合并复验”，不声称单次全量运行零失败。最终应用构建之后没有再改业务代码。
- 独立本地验收页检查另发现临时安排帮助说明向桌面抽屉右侧越界；仅为该字段区增加局部定位和宽度约束，说明显示在选项下方。浏览器检查不再先自动横向滚动来掩盖越界，等待说明完全显示后核对几何。上述最终构建及合并复验均包含此修正；1280x720、412x839、375px、320px 真实页面和截图均完成核对，无页面横向溢出。
- 已重新构建并启动 `apps/web/dist-local-preview/`：Web `http://127.0.0.1:4199/`，API `4198`，专用 PostgreSQL 18 验收库 `qintopia_temporary_other_room_acceptance`。受限 runtime readiness 通过，12 位会员与今日普通退房样例保留。独立页面检查只到最终核对、不确认订单；只读复核临时安排订单数量仍为 0，B01 仍可售。实际服务资源为 `index-CAGpevQM.js` / `index-mevEE7eV.css`，与最终 E2E 构建一致。
- 历史阻塞已解除：此前本机自动权限审核超时及审查模型一次 502 均已恢复，未因此绕过门禁或替换高风险审查模型。`gpt-5.6-sol + ultra` 对核心守卫和最后局部差异只读复审无剩余可执行问题；回滚文档已澄清首版无独立运行期开关，停止新建必须前向兼容且保留历史和生命周期守卫。
- 用户随后反馈“功能测试没有问题，调整排版和视觉美观”，指出临时安排字段区勾选框与标题错位。本轮按 B 级只调整局部 CSS：解除勾选框继承的 40/44px 输入框最小高度，固定为 18px 并与标题居中对齐；整理房型标签和值、原因字段间距及提示层级。未改业务逻辑，未重置用户已验收的数据。1280、412、375、320px 真实页面实测勾选框与标题中心差均为 0，帮助说明在屏幕内、无横向溢出；视觉检查只到最终核对，不确认订单。
- 视觉修正验证通过：TypeScript、production build、`git diff --check`；临时安排专项 E2E 3 项通过、1 项按平台跳过，覆盖桌面与 412/375/320px 创建和原报价恢复，并新增勾选框 18px 尺寸及标题中心对齐断言。E2E 使用独立 `qintopia_e2e` 数据库，不清理或写入人工验收库。
- 2026-09-06 用户确认人工验证通过，本切片按完成标准最终标记通过；用户同时明确授权提交代码、推送 GitHub 并部署到服务器。最新本地构建资源为 `index-B7UxxXFr.js` / `index-Dbic7wJt.css`，访问地址保持 `http://127.0.0.1:4199/`。
- 提交前工作区为 `main@36d7e5e`、`origin/main@36d7e5e`；生产运行来源沿用此前只读核对的 `de920bb`。`apps/web/dist-step9/` 作为既有未跟踪本地产物保留，不删除、不提交。
