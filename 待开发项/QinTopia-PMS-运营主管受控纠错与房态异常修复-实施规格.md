---
title: QinTopia PMS 运营主管受控纠错与房态异常修复实施规格
status: frozen
stage: 17
classification: A
created: 2026-09-01
code_baseline: 2f1b52fa6e70965f24f2575ab9514248fef28c14
production_baseline: 2f1b52fa6e70965f24f2575ab9514248fef28c14
depends_on:
  - QinTopia-PMS-分步开发与人工验收计划.md
  - QinTopia-PMS-第4步-4.1-实施规格.md
  - QinTopia-PMS-在住升级会员与历史补录-实施规格.md
  - QinTopia-PMS-会员资料字段调整-实施规格.md
---

# 运营主管受控纠错与房态异常修复

## 1. 目标与权威边界

本轮只交付五个顺序检查点：

1. 计划退房日仍在住时保留库存安全阻断，但房态显示原订单日期和“待退房”；计划退房日以后仍在住时显示原历史区间和“未退”，不阻断今天及未来库存。
2. 建立物业内、主体级、精确到命令的运营主管权限；不新增万能管理员、SQL 入口或任意事实修改能力。
3. 为 108 鹏哥/小尚切换期的已完成错误订单提供整组、原子、可审计的历史住宿安排纠正。
4. 为 Cathy、晶晶提供专用“撤销错误办卡并按历史住宿重新升级”：冲销错误的 CNY 936.00 记账，作废错误会员订单、合同和完全未使用权益，保留会员档案，再按真实住宿净收款重新执行升级。
5. 主管只输入或选择事实来源，核对实际办卡日期、会员资料和系统推导的合同与权益；不得分别编辑合同日期、权益余额、订单状态、资金金额或数据库字段。

人工验收步骤和完成状态以 `QinTopia-PMS-分步开发与人工验收计划.md` 第 9 步为准。本规格定义字段、状态机、命令、事务、并发、权限和自动测试规则。既有 4.1、4.7、8.5、8.6 规则继续有效；冲突时以本规格对上述五项的更窄规则为准。

本规格不把真人姓名作为数据库键，也不预设生产订单、会员、合同、收款或权益 ID。主管必须从受权限约束的页面选择真实记录；Preview 与 Confirm 由服务端按本规格重新验证全部身份、版本和资金图。

## 2. 基线与现有能力结论

- 2026-09-01 核对时，本地分支为 `main`，本地 HEAD、`origin/main` 与生产版本均为 `2f1b52fa6e70965f24f2575ab9514248fef28c14`，工作区干净，生产 readiness 正常。
- 现有房态在计划退房日为 `CHECKED_IN / IN_HOUSE` 的订单生成一段 `[businessDate, businessDate + 1)` 合成阻断，同时把该合成边界暴露成 `sourceStartDate/sourceEndDate`。Web 由此把安全阻断误识别为今天至明天的普通订单。
- 现有库存层通过退房日 Stay blocker 在 Quote、Preview、Confirm 阶段失败关闭同房/同床冲突；该安全守卫不得删除或放宽。
- 现有 `COMPLETE_STAY` 只适合把特定错误预订原子完成为历史住宿，不支持已经 `CHECKED_OUT / COMPLETED` 的安排日期纠正。
- 现有会员订单只有 `DRAFT / ACTIVE`，合同只有 `ACTIVE / EXPIRED`，没有可表达“错误办卡已作废”的终态；在住升级是正向原子转换，没有逆转换命令。
- 现有 `READ / WRITE` 是物业级粗门禁，`WRITE` 可进入全部写命令；不能区分普通员工、管理员和只供系统派生的命令，也不能在撤权后统一阻断历史恢复与幂等重放。

## 3. 全局不变量

### 3.1 追加式事实与单命令原子性

- 不删除订单、Stay、会员、合同、权益、资金、命令、Receipt、Audit 或历史修订。
- 不覆盖原订单日期、原会员收款或原权益流水；状态终结和当前投影只能由受控命令及其追加事实产生。
- 每次纠错只能通过一个类型明确的 Preview/Confirm 命令完成；Confirm 在一个 PostgreSQL 事务中成功或全部回滚。
- Preview 固化资源版本、相关事实集合哈希、权限快照所需标识和系统推导结果；Confirm 在锁后重建效果，任一变化返回 `PREVIEW_STALE`。
- 幂等重放只能返回同一主体、同一物业、同一命令类型、同一规范化请求的原结果；并发 Confirm 最多产生一组业务事实和一个最终 Receipt。

### 3.2 禁止能力

- 不提供 SQL 控制台、数据库凭证、表格字段编辑器、任意 JSON Patch、任意 `UPDATE/DELETE`、任意事实 ID 冲销或万能 `ADMIN`。
- 普通员工继续可以使用已经存在且受命令协议、事务和审计约束的重价、冲销、退款、会员收款纠错、撤销入住和权益余额纠正；本轮不因新增管理员而收窄一线现有业务能力。
- 上述单项命令不得被客户端拼装成本轮历史纠错。108 历史安排只能使用 `CORRECT_HISTORICAL_STAY_ARRANGEMENTS`；错误办卡撤销并重升只能使用 `VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY`，服务端在一个事务中校验和写入全部结果。
- 错误记账冲销不是实际退款。若 CNY 936.00 曾真实收取且需要退回，必须停止本命令并走未来另行确认的真实会员退款流程；该流程明确排除在本轮。

### 3.3 用户界面

- 所有危险操作先显示中文只读 Preview，明确列出原事实、拟追加事实、保持不变项和失败关闭原因。
- 页面不得暴露内部协议名、数据库表名、SQL、内部 ID 或可编辑的派生字段。
- 自动刷新沿用上一轮刘珊反馈的结论：数据过期时保留当前真实上下文和草稿，只暂停写入并静默刷新；不得重载未变化页面、丢失焦点/选区或反复闪烁禁用。

## 4. 检查点 9.1：计划退房日“待退房”与逾期“未退”

### 4.1 冻结语义

住宿安排仍采用半开区间 `[arrivalDate, departureDate)`。计划退房日不是新增住宿一晚。

| 服务端事实 | 房态显示 | 原订单日期 | 今天库存 | 今天以后库存 |
|---|---|---|---|---|
| `CHECKED_IN / IN_HOUSE` 且 `departureDate = businessDate` | `在住` + `待退房` | 必须显示原 `arrivalDate -> departureDate` | 继续阻断 | 按原安排不自动延长 |
| `CHECKED_IN / IN_HOUSE` 且 `departureDate < businessDate` | 原历史区间 + `未退` | 必须显示原 `arrivalDate -> departureDate` | 不阻断 | 不阻断 |

正式新增：

- `RoomStatusOperationalAttention = DUE_OUT`，中文为“待退房”。
- `RoomStatusBlockingFactKind = DUE_OUT`，只表示计划退房日尚未完成退房的库存安全事实，不是 Claim，也不是新增住宿区间。
- `RoomStatusIntervalDto.orderDepartureDate`，与已有 `orderArrivalDate` 配对。所有订单身份、打开订单、返回房态和页面日期文案使用原订单日期字段；不得从合成阻断边界推断订单日期。

计划退房日的合成事件可以继续作为单日安全投影存在，但必须满足：

- 携带 `DUE_OUT`，冲突类型为 `DUE_OUT`，并引用唯一 Order、Stay 和实际库存单元；
- 不进入普通订单候选、普通住宿来源卡片或普通订单区间日期文案；
- 保留“打开订单”和“办理退房”旅程；桌面、手机、Tooltip、无障碍名称和返回锚点均显示真实订单日期与“待退房”；
- 整房阻断整房；床位阻断同床位以及现有整房/床位互斥范围，不改变兄弟床位现有可售语义。

逾期“未退”继续沿用 `OVERDUE_IN_HOUSE`：只投影原历史区间和异常任务，不生成今天至明天区间、不生成当前 Claim、不阻断当前或未来。

### 4.2 库存与并发

- 保留 `loadDepartureDayStayBlockers`、Quote fingerprint、Preview fingerprint、Confirm 锁后效果重建和 `assertUnitAvailable`。
- 补充创建订单与退房并发测试。退房先线性化完成时，新建可继续；新建在退房提交前观察到仍在住事实时必须以 `PREVIEW_STALE` 或 `INVENTORY_CONFLICT` 失败且零业务写入。
- 补充营业日切换前后 Quote/Preview/Confirm 陈旧竞态，不允许昨天的“未退”或今天的“待退房”结果跨日误用。

## 5. 检查点 9.2：运营主管命令级权限

### 5.1 授权模型

保留 `READ / WRITE` 作为物业级粗门禁，新增主体命令授权和 Token 命令上限。运行时有效写能力为：

`主体有效 ∩ 物业 WRITE ∩ 主体 exact command grant ∩ Token exact command ceiling ∩ 发布特性开关`

- 命令授权只允许规范化后精确匹配；无通配符、前缀、命令组推断或 `ADMIN`。
- 主体 command grants 按物业分别存储和投影；多物业主体不得把一个物业的命令能力带到另一个物业。
- 角色模板只用于受控配置一组 exact grants，运行时不因角色名自动放权。
- 本系统只设普通员工和管理员两个工作人员层级。本规格中的“运营主管”即新增管理员，不再引入审批员、财务员、超级管理员或其他中间层级。
- 普通员工以信任和可审计为原则，保留当前工作人员页面已经交付的受控业务动作；迁移不得把当前合法业务旅程意外关闭，也不得继续让 `WRITE` 隐式代表全部写命令。
- 普通员工 exact grants 冻结为：
  - 会员：`CREATE_MEMBER`、`CREATE_MEMBERSHIP_ORDER`、`RECORD_MEMBERSHIP_PAYMENT`、`CORRECT_MEMBERSHIP_PAYMENT`、`ACTIVATE_MEMBERSHIP_ORDER`、`CORRECT_MEMBER_ENTITLEMENT_BALANCE`；
  - 订单与履约：`CREATE_ORDER`、`RESCHEDULE_STAY`、`EXTEND_STAY`、`SHORTEN_STAY`、`MOVE_UNIT`、`REPRICE_ORDER`、`CANCEL_ORDER`、`MARK_NO_SHOW`、`REVOKE_CHECK_IN`、`CHECK_IN`、`CHECK_OUT`、`COMPLETE_STAY`；
  - 库存与资金：`LOCK_MAINTENANCE`、`RELEASE_MAINTENANCE`、`RECORD_COLLECTION`、`RECORD_REFUND`、`REVERSE_FACT`、`CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP`。
- 管理员继承上述普通员工 exact grants，并额外获得：
  - 系统管理：`ISSUE_TOKEN`、`ROTATE_TOKEN`、`REVOKE_TOKEN`、`COMPLETE_CLEANING`；`COMPLETE_CLEANING` 在清洁特性开关关闭时仍不可执行；
  - 专用纠错：`CORRECT_ORDER_OCCUPANT`、`CORRECT_HISTORICAL_STAY_ARRANGEMENTS`、`VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY`。后两条只在 9.3、9.4 对应命令实现且特性开关开启后成为有效能力，9.2 不提前实现其业务状态机。
- `REFRESH_MEMBER_COVERAGE`、`ADD_MEMBER_ENTITLEMENT_LOT`、`ADJUST_MEMBER_ENTITLEMENT`、`EXPIRE_MEMBER_ENTITLEMENT` 没有工作人员直接入口，只允许作为受控命令内部派生效果，不授予任何人工主体。`PLACE_INTERNAL_USE`、`RELEASE_INTERNAL_USE`、`BACKFILL_COMPLETED_STAY` 保持不可新执行的历史兼容类型。
- `CREATE_QUOTE` 是不写经营事实的价格试算，继续由物业 `READ` 门禁控制，不纳入写命令 profile，也不得据此获得 Confirm 能力。
- 权限授予/撤销不提供给普通员工或管理员。初始人员映射通过代码审查的部署配置和受控迁移完成，不接受手工 SQL；通用权限管理 UI 不在本轮。

### 5.2 执行与恢复

- 同一授权器覆盖 Preview、Confirm、stored Preview、历史 Preview 回放、Command/Receipt/结果读取、find、resolve 和恢复。
- Confirm/resolve 在事务内锁定并重新验证主体、物业 grant、command grant 和 Token/session；必须先鉴权再返回幂等 replay。
- 授权撤销和 Confirm 以锁顺序确定线性化结果：撤销先完成则旧 Preview 不得执行；Confirm 先完成则该一次命令有效，后续读取仍按当前权限重验。
- Token 的命令上限必须是调用者当前有效命令集合的子集，不得扩大物业、WRITE、命令范围或有效期。
- Token 管理由管理员执行。管理员只能管理同物业内有效主体的 Token；签发或轮换后的 command ceiling 必须同时是管理员当前有效能力、目标主体同物业 grants 和调用 Token 自身 ceiling 的子集，且不得超过调用 Token 的有效期。跨物业目标按不存在处理。
- `/me`、房态、订单、会员和恢复页面只渲染服务端返回的 allowed actions；Web 不得从 `WRITE` 自行推导按钮。

### 5.3 拒绝、审计和数据库角色

- 跨主体/跨物业资源返回 `404` 防枚举；同物业缺命令能力返回 `403`。
- 鉴权拒绝不得写 Preview、command execution、Receipt、业务事实或幂等键；只允许在独立事务追加脱敏安全审计。
- 审计包含物业、主体、命令类型、阶段、拒绝原因、凭证种类/fingerprint、correlation ID 和幂等键哈希；不记录 Token 明文或个人敏感字段。
- migration owner 与 API runtime 数据库角色分离。runtime role 禁止 schema/role/trigger DDL、`DISABLE TRIGGER`，并对 append-only/protected facts 撤销 `UPDATE/DELETE`；应用所需状态迁移只能通过最小表/列 DML 和数据库守卫完成。

## 6. 检查点 9.3：108 切换期历史订单整组纠正

新增唯一命令 `CORRECT_HISTORICAL_STAY_ARRANGEMENTS`。不复用 `COMPLETE_STAY`、`RESCHEDULE_STAY`、重价或退款命令。

### 6.1 v1 资格与状态机

- 输入为同物业 `correctionSet`，至少一项，每个 `orderId` 唯一；鹏哥/小尚需要交换或联动的记录必须在同一集合中一次确认。
- 每项旧状态必须严格为 `order = CHECKED_OUT`、`stay = COMPLETED`，并携带当前 `expectedVersion`。
- v1 只纠正最终有效历史住宿安排的日期和/或库存单元；不改 Order/Stay ID、住宿人、会员、来源、渠道号、价格、收退款、结算结果或生命周期终态。
- 新日期必须形成非空半开区间，至少一个受控字段变化；目标房/床必须与原订单销售 kind 和计价产品适配。
- 若真实记录不是上述终态、需要改住宿人归属、需要按新日期重价或需要改变资金，必须失败关闭并另立状态机，不扩宽本命令。

### 6.2 原子性与投影

- 按 Order、Stay、房间、服务日稳定排序锁定整组订单、当前安排修订、segments、历史占用证据、相关会员覆盖/权益和资金基线。
- 先从全部输入计算“整组最终状态”，再校验历史占用；相互交换不因逐单中间态产生假冲突，集合外冲突必须整体拒绝。
- 每个订单追加一条 typed `CORRECT_HISTORICAL_STAY_ARRANGEMENT` amendment 及新 revision/segment；旧 amendment/revision/segment 保留。
- 约束触发器在事务末验证每个输入恰好一条纠正 amendment、before/after 与 expectedVersion 一致、终态/身份/资金不漂移、整组最终安排无冲突。
- Receipt 按订单列出 before/after 日期与房源、新 amendment/revision/segment ID，并显示未变化的住宿人、金额和收款摘要。

## 7. 检查点 9.4/9.5：撤销错误办卡并按历史住宿重新升级

新增唯一复合命令 `VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY`。该命令不能拆成“先冲销”“再改合同”“再调权益”“再转换”多次提交。

### 7.1 v1 严格资格

旧会员链必须同时满足：

- 同一物业、同一会员，旧 membership order、contract、entitlement lot 精确互链；旧订单与合同当前为 `ACTIVE`。
- 旧卡是普通直接办卡，不是住宿转换产物，不存在 stay transfer bridge。
- 旧权益完全未使用：不存在 coverage，entitlement ledger 为空，可用余额等于产品总权益。出现 `HOLD / RELEASE / CONSUME / RESTORE / ADJUST / EXPIRE / CONVERSION_CONSUME` 任一事实都拒绝；不能仅凭“余额仍为 30”放行。
- 旧订单全部尚未冲销的直接会员收款由系统自动选取，净额必须精确为 CNY 936.00；操作员不能挑选部分事实或输入冲销金额。
- 若该 CNY 936.00 是真实全额收款且需要退款，本命令拒绝；v1 只处理“系统把实际升级差额误记成全价”的错误记账。

源住宿必须同时满足：

- 与旧卡同一会员、同一物业；按当前已确认规则由主要住宿人规范化手机号匹配会员。
- `order = CHECKED_OUT`、`stay = COMPLETED`，为普通 WECOM 住宿，当前尚未转换成会员，资金图完整且可唯一推导全部有效 WECOM 净收款。
- 房型/床位、历史服务日期和夜数适配旧卡产品；历史住宿服务日必须位于主管核实的实际办卡日及系统计算的合同有效期内。
- 住宿、会员、收款、退款、转换 bridge、权益或会员资料在 Preview 后变化均返回 `PREVIEW_STALE`。

### 7.2 单一事实输入与系统推导

主管页面只允许：

- 选择错误会员订单；
- 选择源历史住宿；
- 输入 `actualMembershipDate`；
- 填写必填纠错原因和证据说明；
- 核对会员档案、旧交易引用和系统推导结果后一次确认。

`actualMembershipDate` 的冻结含义为“真实会员购买业务生效日/合同起始日”，不是本次纠错提交日。系统以它计算 `validFrom` 和按既有一年规则计算 `validUntil`。主管不得输入或编辑 `validUntil`、产品、成交价、冲销金额、住宿转入额、差额收款金额、总权益、历史核销数量、剩余权益、合同状态或会员状态。

系统只读推导并在 Preview 展示：

- 会员昵称、姓名、手机号、微信号及旧/新订单关联，会员档案保持不变；
- 旧错误 CNY 936.00 COLLECTION 集合及将追加的逐笔 REVERSAL；
- 住宿全部有效 WECOM 净收款与转入明细；
- 新会员订单成交价（沿用产品/已确认价格规则）；
- 新直接会员收款差额 = 新会员成交价 - 住宿净收款；金额不可编辑；
- 新合同起止日；产品总权益；历史住宿按服务日期自动核销数量；剩余权益 = 产品总权益 - 历史住宿核销；
- 保持不变的会员档案和原住宿资金历史。

旧错误会员收款的唯一真实交易引用可在新订单作为“纠错重分类后的直接会员收款”复用，但金额必须等于系统推导的差额，并由专用 reclassification bridge 连接旧 COLLECTION、旧 REVERSAL 和新 COLLECTION。若证据表明该交易实际金额不等于推导差额，必须拒绝，不能编辑金额凑平。

### 7.3 原子状态机

同一事务内按以下顺序产生一张不可拆分的事实图：

1. 对旧错误会员收款逐笔追加 REVERSAL，不删除原 COLLECTION。
2. 旧 membership order `ACTIVE -> VOIDED`；旧 member contract `ACTIVE -> VOIDED`；旧 entitlement lot `ACTIVE -> VOIDED`，并追加专用 `VOID` entitlement fact 使其可用余额为 0。
3. 保留 `members` 与 `member_property_links` 原样，不更新会员资料字段。
4. 创建新 membership order 并在同一命令内 `DRAFT -> ACTIVE`，创建新 ACTIVE contract 和 ACTIVE lot。
5. 复用既有住宿正向转换资金图：住宿净收款转入会员、住宿侧追加对应 REVERSAL、写 transfer bridge；差额写新的 DIRECT_WECOM COLLECTION 和 reclassification bridge；住宿追加零价 revision。
6. 按历史服务日逐日追加 `CONVERSION_CONSUME`，系统计算新权益余额；不得写目标余额型调整。
7. 写一条命令 Audit 和一个 Receipt，列出旧链作废、新链创建、资金守恒、日期、历史核销和剩余权益。

数据库 deferred constraints 必须验证：旧链恰好作废一次、旧 payment 恰好反转一次、新旧交易重分类一一对应、住宿转入守恒、新权益等于产品总量减历史核销、会员档案零更新。任一子事实、Audit 或 Receipt 失败均全部回滚。

## 8. 失败测试优先与自动门禁

每个检查点必须先提交能在当前基线失败的测试，再写实现。最低测试集如下：

### 8.1 9.1

- 真实 PostgreSQL 投影：整房/床位、直订/渠道/会员/免费，计划退房日与次日逾期严格分离。
- 断言原 `orderArrivalDate/orderDepartureDate`、`DUE_OUT / 待退房`、阻断冲突与 Quote/Confirm 安全；断言不出现今天至明天普通订单身份。
- 桌面 Grid、快捷框、订单上下文、移动“今日离店”、Tooltip、无障碍名称和返回锚点。
- 创建与退房、跨营业日 Quote/Preview/Confirm 竞态。
- Contract/OpenAPI 对新枚举、`orderDepartureDate`、非法组合与额外字段失败关闭。

### 8.2 9.2

- 每条 command type 参数化验证普通员工/管理员 exact allow/deny，覆盖 Preview、Confirm、stored Preview、replay、Receipt/Command/find/resolve。
- 跨物业、跨主体、同主体不同 Token、READ grant、Token ceiling 升权、Preview 后撤权和撤权/Confirm 竞态。
- 拒绝后业务表、协议表与幂等域零写入，只有一条脱敏拒绝审计。
- runtime 数据库角色直接尝试修改 protected facts、`ALTER TABLE`、`DISABLE TRIGGER` 均失败。

### 8.3 9.3

- 单笔日期纠正、两笔日期交换、房/床边界、集合外冲突、终态/版本/资金/权益依赖拒绝。
- 并发集合顺序相反、重复 Confirm、事务中间失败、Receipt/Audit 失败全部零部分写入。
- 投影只显示新最终安排，详情完整保留 before/after 和旧历史。

### 8.4 9.4/9.5

- 完全未使用旧卡成功；任一 coverage/ledger/transfer/旧冲销/非 93600/真实退款场景拒绝。
- 历史住宿身份、手机号、房型、有效期、状态、WECOM 资金图、重复转换和混合资金边界。
- 系统计算日期、差额、30 夜、历史核销与剩余权益；所有派生字段 API 不接受输入。
- 命令事务中每个写点故障注入、双人并发选择同一旧卡/住宿、幂等重放、Preview stale、Receipt/Audit 失败。
- 数据库约束直接构造部分作废、重复 bridge、权益不守恒、会员资料更新时必须拒绝。

每个检查点的相关 Unit、真实 PostgreSQL Integration、Contract/OpenAPI、TypeScript、production build、数据库 migration/readiness 和对应真实浏览器 E2E 必须全绿。共享权限、命令协议或数据库守卫变更时，扩大到全部相关命令回归；不得只采信局部测试数量。

## 9. 顺序交付与人工验收门禁

| 检查点 | 本次只交付 | 通过口令 |
|---|---|---|
| 9.1 | 待退房/未退房态语义、原日期与库存安全 | `9.1 通过` |
| 9.2 | 运营主管 exact command 权限、恢复与数据库角色边界 | `9.2 通过` |
| 9.3 | 108 两单整组历史安排纠正 | `9.3 通过` |
| 9.4 | 错误会员链原子作废并按历史住宿重新升级 | `9.4 通过` |
| 9.5 | 实际办卡日期、会员资料与自动权益核对旅程 | `9.5 通过` |

每个检查点执行“冻结规格 -> 失败测试 -> 开发 -> 自动检查 -> 启动真实 Web/API/PostgreSQL 版本 -> 人工验收”。未收到当前通过口令时，不开始下一检查点；任一不通过只返工当前项。未经用户明确确认，不提交、不推送、不部署，也不对生产业务数据执行纠错写入。

## 10. 明确非目标

- 企业微信历史流水查询问题。
- 小雨 202 补录完成状态。
- 真实退会、真实会员退款或实际资金退回。
- 任意 SQL 修改、万能超级管理员、通用终态重开、通用会员逆转换或任意事实冲销。
- 批量会员导入、批量历史订单纠正、跨门店会员共享。
- 会员资料字段编辑；本轮只核对并保持 Cathy、晶晶现有会员档案。

## 11. 冻结结论

第 9 步的业务语义已按最窄可交付范围冻结：

- 9.1 不改变住宿半开区间和库存安全，只纠正安全阻断的业务表达。
- 9.2 只增加 exact command grants，不创造广义管理员。
- 9.3 只处理已完成历史安排且保持身份、生命周期和资金不变；真实记录不满足资格即失败关闭。
- 9.4/9.5 只处理“错误 936 记账、旧权益完全未使用、源住宿可唯一正向转换”的情况；实际退款、已使用权益、旧卡已转换或资料需修改时失败关闭。

因此 9.1 没有阻断实施的业务歧义，可以开始失败测试与开发。9.3 至 9.5 在各自开始前仍须由主管在受控 Preview 中选择真实记录并核对事实；该核对是命令资格验证，不授权扩大上述状态机。
