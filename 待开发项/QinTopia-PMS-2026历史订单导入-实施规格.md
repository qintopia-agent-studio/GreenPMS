---
title: 'QinTopia PMS 2026 历史订单导入'
type: 'migration'
created: '2026-08-09'
status: 'in_progress'
risk: 'A'
source_start_date: '2026-03-13'
---

# QinTopia PMS 2026 历史订单导入

<frozen-after-approval reason="human-owned import scope and corrections - do not modify unless human renegotiates">

## Intent

**Problem:** “订单来了”从 2026-03-13 才正式使用，历史订单缺少部分渠道订单号、联系方式和会员资料，且旧状态不能可靠代表切换时的真实状态。普通 `CREATE_ORDER` 会使用当前计价政策并生成标准创建、入住和退房事实，不能诚实表达这些历史数据。

**Approach:** 从 2026-03-13 起导入完整跨界住宿区间。490 条已结束/取消住宿进入只读历史归档，44 条在住/预订住宿进入当前运营订单，1 条非住宿结账记录只保留来源归档。历史金额按源系统实际值保存，不按当前政策重算；全批使用来源级幂等、单事务写入、dry-run 对账和割接前重导。

## Confirmed Business Rules

- 导入起点为 `2026-03-13`，跨越该日期的住宿保留完整入住和离店区间。
- `自来客`、`小红书小程序`、`微信` 统一映射 `WECOM`；`Agoda/Aogda` 映射 `YOUMUDAO`；携程映射 `CTRIP`；美团酒店/民宿映射 `MEITUAN`。
- 历史渠道订单号没有记录时保存 `null + HISTORICAL_NOT_RECORDED`，不得编造。
- 历史住宿实价以旧系统主表住宿小计为准，同时保留房费明细、结账金额和差异说明；不生成历史收款、退款或结清事实。
- 弱匹配或歧义的飞书入住申请不得自动采用；姓名、昵称、手机号缺失时诚实保存为历史未记录。44 个运营订单都有姓名，其中 38 个没有确认昵称；这 38 个订单以姓名作为房态显示 fallback，并保存 `nickname_provenance=FULL_NAME_DISPLAY_FALLBACK`，不声称该姓名是已确认花名。
- 免费住宿不消耗会员权益。郑亮是明确确认的会员权益住宿；蘑菇是 `FREE_RECEPTION`，原因为“社区 logo 奖品，一周标间兑换”。
- 周慧玲保持姓名/昵称“周慧玲”、房间 306、状态在住；不篡改已过的原计划离店日，导入后由操作员确认真实离店日并完成迁移基线续住。
- 郑亮当前入住 D01，2026-08-06 至 2026-08-25 共 19 晚；迁移前确认的剩余 19 `ROOM_NIGHT` 全部用于本次住宿，不归为免费房。
- 小休预订使用 A03、金额 1020 元；丢弃同单“未排房、金额 0”的占位段。

</frozen-after-approval>

## V4 Audited Baseline

权威复核文件：`QinTopia-order-import-review-from-2026-03-13-v4-corrected.xlsx`。

| 项目 | 数量/金额 | 导入语义 |
|---|---:|---|
| 唯一候选 | 535 | 来源键无重复 |
| 历史住宿归档 | 490 | 只读归档，不写 core 生命周期/库存/资金 |
| 当前运营订单 | 44 | 36 在住、8 预订 |
| 非住宿归档 | 1 | 不创建 PMS 住宿订单 |
| 运营有效住宿段 | 50 | 全部映射当前库存，彼此零冲突 |
| 历史住宿实价 | ¥221,054.06 | 归档展示值 |
| 运营住宿实价 | ¥60,350.32 | 运营订单迁移基线 |
| 合计 | ¥281,404.38 | dry-run 与提交后必须完全相等 |

渠道分布为 `WECOM 503 / CTRIP 15 / MEITUAN 11 / YOUMUDAO 4 / null 2`。外部渠道缺号共 24 条，其中 23 条只在历史归档，1 条是张彩云 Agoda/游牧岛运营订单 `12520973947428843011`。

## Boundaries & Constraints

**Always:** 来源文件 SHA-256、来源行号、源渠道、源金额、规范化载荷和人工确认来源必须不可变留存。相同来源键和相同载荷重放返回已有结果；相同来源键载荷变化必须冲突。导入事务提交前必须完成数量、金额、房态、权益和目标引用对账。

**Ask First:** 若割接刷新后 44 个运营 ID、状态、房间、区间、金额或互斥结果变化；若需要自动采用弱匹配资料；若要推断历史收款/退款；若郑亮需要补建正式会员档案或把 legacy contract 关联到新档案；若周慧玲不再在住或真实离店日已确认，停止并重新生成候选。

**Never:** 不复用普通 `CREATE_ORDER`；不伪造渠道订单号、价格政策基准、历史操作人、命令、Receipt、Audit、收款、入住或退房事件；不把 490 条归档塞入 core `orders`；不从旧状态自动判定当前在住；不在生产库跳过 backup、dry-run、候选库恢复验证和最终重导。

## Data Model

### Import provenance and idempotency

- `migration_import_runs`：property、source system、idempotency key、request/manifest hash、correlation、状态、输入及对账摘要；同 key 同 hash 重放，同 key 变 hash 冲突。
- `migration_import_files`：run、来源角色、文件名、SHA-256、导出时间、行数；append-only。
- `migration_order_sources`：`(property_id, source_system, source_order_id)` 唯一，保存 canonical payload/hash、渠道号缺失原因和 disposition；append-only，不直接保存目标 FK。
- `migration_order_targets`：source 唯一，保存 `archive_id xor order_id`；在 source 和目标都插入后追加，两个目标 FK 使用延迟校验。`orders.migration_source_id` 只指向已经存在的 source，因此不存在 source/target 循环插入。
- 来源键跨 run 仍执行同 payload replay / changed payload conflict。历史错误只能由后续显式 migration correction batch 修正，不能静默覆盖。

### Historical archives

- `historical_order_archives` 保存可搜索规范列、完整 canonical payload、历史金额证据和来源 FK。
- `record_kind=MIGRATED_ARCHIVE`、`allowed_actions=[]`；不创建 core order、stay、segment、amendment、pricing revision、claim、coverage、ledger、collection、command 或 audit。
- 非住宿记录 `12520954138885286811` 使用 `NON_ACCOMMODATION_ARCHIVE`；取消且未排房记录 `12520958544448301266` 只归档，不产生库存。

### Operational snapshots

- 仅 44 条写 core `orders/stays/stay_segments/pricing_revisions/order_occupants`，并由 `orders.migration_source_id` 唯一绑定不可变来源。
- 首条 amendment 类型为 `MIGRATED_OPERATIONAL_SNAPSHOT`，表达“切换时观察到 RESERVED/IN_HOUSE”，不伪装成 `CREATE_ORDER` 或历史履约事件。
- 037 和读模型明确增加受限分支：只有订单有合法 `migration_source_id` 时，首 amendment 才可为 `MIGRATED_OPERATIONAL_SNAPSHOT`、首 segment 才可为 `MIGRATED_INITIAL`。payload 必须严格绑定 source、cutover timestamp、observed status、inventory/date 和 amount。
- 生命周期投影从 snapshot 的 `observedStatus` 初始化 `RESERVED` 或 `CHECKED_IN`，返回 `observedAtCutover`；不要求也不生成历史 CHECK_IN fact。普通订单仍必须从 `CREATE_ORDER/INITIAL` 开始。
- manifest 的 50 个运营住宿段全部保留在 canonical source evidence；它们不等同于 core `stay_segments`。每个迁移运营订单仍只创建一个 `MIGRATED_INITIAL`，其 core 日期和 active claims 只承载切换时有效的连续运营 component，避免把历史间断伪造成连续占房。
- `12520972552889746820` 的完整来源为 `2026-07-19..2026-08-02` 和 `2026-08-07..2026-08-23` 两段；core snapshot/order/segment/claims 使用当前 component `2026-08-07..2026-08-23`，早先段及源总区间只保留在 immutable canonical payload。历史实价 ¥2,160 仍按来源保留，不声称它由当前 component 重算。
- `12520969448508191339` 同期占用 `108-A` 与 `108-B`。snapshot timeline 和 active claims 必须逐日保留两个 unit pair；core arrangement 以 snapshot `inventoryUnitId=108-B` 作为主展示房源，同源的 `108-A` claims 继续在库存和房态中阻塞并展示。数据库以 `(serviceDate, inventoryUnitId)` 多重集合精确核对 timeline 与 claims，不得压缩或丢弃第二间房。
- 除周慧玲外，运营订单为各自切换时有效的连续 component 创建 active claims，包括该 component 已经经过的服务日；终态命令按现规则一次性释放。周慧玲的源区间 claims 只覆盖合法的 `2026-08-08` 服务日，额外占用由 overdue hold 表达。
- `orders.ts` 的 amendment type set、首事实、首 segment、fulfillment 和 active timeline 校验只在 migration source 被验证时接受上述形态；缺 source、source disposition 不符或 payload 不匹配均按生命周期损坏失败关闭。

### Historical actual pricing

- 037 将 `pricing_revisions.policy_base_amount_minor` 改为 nullable，并新增非空 `pricing_origin`：既有及普通新记录默认 `STANDARD`，首次迁移记录为 `MIGRATED_ACTUAL`，周慧玲专用续住后的版本为 `MIGRATED_ACTUAL_PLUS_POST_CUTOVER`。
- 迁移实价保存在 `current_contract_amount_minor`；`manual_adjustment_minor=0`，`policy_base_amount_minor=null`，明确表示没有可信历史政策基准。
- 业务 basis 仍按订单性质保存：外部渠道为 `CHANNEL_CONTRACT`，WECOM 为 `POLICY`，会员为 `MEMBER_ENTITLEMENT`，免费为 `FREE`；basis 表示业务来源，不代表该金额由当前政策计算，不得为了通过旧约束把历史实价伪装成人工调价。
- 037 重写 pricing trigger：`STANDARD` 必须保持 base 非空、原金额方程和原首修订规则；`MIGRATED_ACTUAL` 必须 base=null、adjustment=0、amendment=`MIGRATED_OPERATIONAL_SNAPSHOT`、order/source/disposition/amount hash 完全匹配。普通写路径不能选择该 origin。
- `MIGRATED_ACTUAL_PLUS_POST_CUTOVER` 同样要求 base=null、adjustment=0，只允许 `RESOLVE_MIGRATED_OVERDUE_STAY` 的 `EXTEND_STAY` amendment。其 payload/cash lines 必须严格保存 `historicalActualAmountMinor`、`postCutoverIncrementAmountMinor` 和 `newContractAmountMinor`，数据库验证新金额等于前一版迁移金额加本次新增区间金额，前一版 origin 必须是 `MIGRATED_ACTUAL`，且 order/source/hold/command 互相绑定。它不把完整区间伪装成当前政策价。
- `pricing_policy_version_id/policy_version_id` 继续非空：免费单使用 FREE policy，其余使用已发布的 QinTopia public policy，角色只作为切换后命令兼容锚点。source payload 明确保存 `policy_role=POST_CUTOVER_CHANGE_ANCHOR`，不得声称它生成了历史金额。
- Kysely、API/contracts、订单读模型和 Web 将 policy base/difference 改为 nullable，并返回 `pricing_origin`。`MIGRATED_ACTUAL` 展示“历史实价（无历史政策基准）”；`MIGRATED_ACTUAL_PLUS_POST_CUTOVER` 展示“历史实价 + 切换后续住金额”，并展示两部分金额；两者都不做政策差额运算。`STANDARD` 的现有非空展示和校验保持不变。

### Restricted missing channel reference

- 普通新建外部渠道订单继续强制渠道订单号。
- 仅当 `orders.migration_source_id` 指向 `OPERATIONAL` 来源，canonical 源渠道号确实为 null，且 `channel_reference_missing_reason=HISTORICAL_NOT_RECORDED` 时，允许外部渠道号为空。
- WECOM、会员权益和免费住宿仍保持渠道/渠道号现有规则。

### Zhou Huiling overdue occupancy

- 原区间保持 `2026-08-08` 至 `2026-08-09`，订单为 `CHECKED_IN/IN_HOUSE`；不得制造未来离店日，也不得给已结束 segment 塞入区间外 claim。
- 新增 append-only `migration_overdue_inventory_holds` 和一对一 append-only `migration_overdue_inventory_hold_releases`。active 定义为不存在 release fact；hold 本身永不 update/delete。
- hold 保存 order/source/property/room/unit/starts_on/cutover，且只允许 migration snapshot、`CHECKED_IN/IN_HOUSE`、源 departure 不晚于 starts_on 的订单。周慧玲 starts_on=`2026-08-09`。
- 库存报价、availability、fingerprint、房态和 claim insert 数据库 trigger 都必须识别 active hold：同 room 下 room/bed 互斥语义沿用现有规则，任意 `service_date >= starts_on` 都不可售；房态在所查窗口内投影为关联订单的 `IN_HOUSE`，不是维修。
- 专用一次性 `RESOLVE_MIGRATED_OVERDUE_STAY` 使用现有 Preview/Confirm、WRITE 权限、property scope、request hash、idempotency、receipt 和 audit。Preview 输入真实新离店日、新增区间金额及原因，返回原历史实价、新增金额、新总额和 hold 解除摘要。
- Confirm 使用与普通库存相同的 property/room/date 稳定锁顺序，再锁 hold/source/order；同事务先追加 release fact，使本事务可见的 active hold 消失，再创建真实 `EXTEND_STAY` segment、`MIGRATED_ACTUAL_PLUS_POST_CUTOVER` pricing revision 和 `[starts_on,newDeparture)` claims。新增 revision 金额严格为前一版历史实价加操作员确认的新增区间金额。release 的延迟数据库守卫要求命令为 APPLIED、order/source/hold 匹配、所有新增日期 claim 完整；失败或回滚时 release 与 claims 同时消失，306 继续锁定。
- 普通 claim insert trigger 对 active hold 一律拒绝；Resolve 不是绕过 trigger，而是靠同事务已追加的 release fact消除 active 谓词。并发事务在提交前仍看见 active hold并失败关闭。

### Zheng Liang entitlement reconstruction

- 在缺少身份证、手机号、微信的情况下不得创建 synthetic `members`。创建 `member_id=null, member_name=郑亮` 的 migration-provenance legacy contract 和 19 `ROOM_NIGHT` lot。
- contract/lot 有效服务日明确为 `2026-08-06` 至 `2026-08-24`（含首尾 19 日），order departure 仍为 `2026-08-25`；不伪造会员购买、收款、原始 30 晚或销售有效期。
- 为 D01 的 19 个服务日逐日写 coverage、HOLD(-1) 和 CONSUME(0)，最终可用余额为 0；order 绑定 contract，member/channel/reference 均为 null，价格 basis 为 `MEMBER_ENTITLEMENT`。
- 未来取得完整身份后，关联正式会员档案必须走显式迁移更正设计；当前 contract owner 不得静默更新。

## Manifest Contract

受控 JSON manifest 是生产导入器唯一输入；Excel 只作为上游人工复核证据，不在生产进程内临时解释表头或公式。

- Header：schema version、property code、source system、start date、cutover timestamp/business date、V4 workbook hash、生成工具版本。
- Files：原始三张导出、飞书快照/复核文件的 role、name、SHA-256、row count。
- Records：source order id、source row、disposition、lifecycle observation、完整 dates/segments、guest snapshot、raw/mapped channel、reference status、stay type、amount evidence、manual confirmation/provenance、特殊迁移 flags。
- 金额一律使用整数分，日期使用 `YYYY-MM-DD`，时间保留原始字符串作为 provenance；所有 keys 排序后计算 stable SHA-256。
- 生成器必须使用 `订单审核` 的 V1 权威列、`订单主表` 的有效段及 V3/V4 人工确认；不得使用 `导入概览` 中已过期的周慧玲说明。
- `FREE_RECEPTION` 是 manifest 业务分类，落 core 时严格映射为 `stay_type=FREE`、`free_stay_category_code=RECEPTION`。
- Manifest 含个人信息，不进入 Git、不写入普通日志；CLI 错误和 reconciliation 默认只显示 source order id/计数/hash，不输出姓名、手机号或证件号。生成文件使用仅当前用户可读权限，生产传输和留存沿用备份级保护。

## Transaction and Run States

1. 解析 JSON、验证 schema、stable hash、来源文件 hash、535/490/44/1、50 段和金额总额。
2. dry-run 只读连接候选数据库，验证 migration/readiness、property/catalog、库存映射、现有 source key、渠道例外、会员重建和 cutover 冲突；零业务写入。
3. apply 使用 `SERIALIZABLE`，取得 property/source advisory lock，检查 run replay/conflict 和 source replay/conflict；新 run 以 `EXECUTING` 插入，身份字段不可变，事务末只允许一次 `EXECUTING -> APPLIED`。
4. 按 room/date 排序锁定库存；写 run/source/files，再写 491 个归档和 44 个 operational snapshot。
5. 写运营 claims、郑亮 contract/lot/coverage/ledger 和周慧玲 overdue hold。
6. 在同事务重算并核对所有计数、金额、来源目标 XOR、active claims、overdue hold 和权益守恒。
7. 对账完全一致后把 run 标为 `APPLIED` 并提交；任一点失败整批回滚。

run 只允许 `EXECUTING -> APPLIED`；失败事务不保留半成品 run。dry-run 返回独立只读报告，不制造一个看似已执行的 run。

## Post-import command boundary

- 44 个 migrated operational orders 可继续使用不重算价格的 `CHECK_IN`、`CHECK_OUT`、`CANCEL_ORDER`、`MARK_NO_SHOW`、资料更正和切换后新增资金记录；这些动作保留迁移实价 revision。
- 普通 `RESCHEDULE_STAY`、`EXTEND_STAY`、`SHORTEN_STAY`、`MOVE_UNIT`、`REPRICE_ORDER`、住宿转会员和其他会按当前政策重算完整区间的命令，对任何 `orders.migration_source_id IS NOT NULL` 的订单一律由 effect、apply 和数据库守卫失败关闭，并返回中文说明“历史实价订单需使用迁移更正流程”。门禁不依赖最新 revision origin，因此 Resolve 完成后也不会意外开放普通重价命令。
- 本切片只为周慧玲提供已冻结语义的 `RESOLVE_MIGRATED_OVERDUE_STAY`；其他 migrated order 若确需日期/房间/价格变化，先取得具体业务事实，再设计显式 migration-aware correction，不自行推断增量或重价。

## I/O and Edge Cases

| Scenario | Expected behavior |
|---|---|
| 同 manifest 重放 | 返回同 run/targets，对业务表零新增 |
| 同 idempotency key 不同 manifest | 冲突，零写入 |
| 同 source key 相同 payload 出现在新 run | 返回已有 target，不重复创建 |
| 同 source key 不同 payload | 冲突，要求显式 correction batch |
| 外部渠道号缺失 | 历史归档诚实保存；仅迁移运营来源触发受限例外 |
| P1 歧义入住申请 | 不采用候选资料，保存缺失与歧义证据 |
| 历史金额证据冲突 | 保存双值与说明，以已确认 V1 实价为展示金额；不生资金事实 |
| 小休 0 元占位段 | 丢弃；只导入 A03/1020 元确认段 |
| 朵的历史间断住宿 | canonical 保留两段；core 只承载当前 `2026-08-07..2026-08-23` component，不制造 5 天 gap claims |
| 小尚鹏哥同期双房 | snapshot/claims 同日保留 108-A 与 108-B；core 主展示 108-B，两个 unit 都不可售 |
| 周慧玲旧 departure | 原日期不变，active overdue hold 保护 306 |
| 郑亮资料不完整 | 不建虚假 member；legacy contract + 19 夜守恒重建 |
| 任何库存/来源/金额/权益对账失败 | 整批零写入 |

## Implementation Map

- `packages/db/src/migrations/037_historical_order_import.sql`：来源、归档、pricing origin、渠道例外、运营 snapshot 和 overdue hold 数据库守卫。
- `packages/db/src/schema.ts`、`packages/db/src/database.ts`：Kysely 类型和 readiness migration 清单/关键守卫。
- `packages/db/src/historical-order-import.ts`：manifest 解析、纯校验、dry-run、串行化事务、replay/conflict 和 reconciliation。
- `packages/db/src/import-historical-orders.ts`：显式 `--manifest`、`--dry-run`、`--apply` CLI；apply 需生产确认 token/环境门禁。
- `scripts/purge-production-acceptance-data.ts`：仅针对已冻结的 7 条上线验收订单和 demo 业务图执行受控清理；默认 inspect，apply 使用精确快照哈希、停服/demo seed 门禁和私密正式操作员密码文件。
- `packages/db/src/orders.ts`、`packages/db/src/room-status.ts`、`packages/db/src/inventory.ts`：migration snapshot/overdue hold 的只读投影与库存冲突。
- `packages/db/src/commands/*`：只新增 `RESOLVE_MIGRATED_OVERDUE_STAY` 所需最小契约/事务；普通命令规则不放宽。
- `packages/contracts/src/index.ts`、`apps/api/src/schemas.ts`、API routes、`apps/web`：nullable historical price presentation、只读历史订单列表/详情和 migrated command 边界。
- `tests/integration/historical-order-import.integration.test.ts`：来源幂等、事务、归档隔离、实价、渠道例外、库存、郑亮和周慧玲金标。
- `tests/integration/database-readiness.integration.test.ts`：037 migration 和关键 trigger/constraint 完整性。

## Tasks and Acceptance

- [x] 冻结并对抗审查本实施规格，解决所有 A 级 blocker。
- [x] 新增 037 migration、schema/readiness 和 append-only/受限例外守卫。
- [x] 实现 manifest parser、dry-run、apply、idempotency 和 reconciliation。
- [x] 实现历史归档与运营 snapshot 持久化，禁止伪造资金和生命周期事实。
- [x] 实现迁移实价 origin、周慧玲 overdue hold 与一次性解除路径。
- [x] 实现郑亮 19 夜 legacy entitlement 守恒重建。
- [ ] 生成 V4 canonical manifest 和简化 cutover review，运行候选库 dry-run。
- [ ] 完成自动门禁、backup/restore 验证和生产割接人工指引。

### Automated gates

- Manifest unit：表头/version、整数金额、日期、枚举、重复 source key、hash 和特殊规则。
- PostgreSQL integration：归档零 core 写；44 operational、50 个来源段证据完整；朵只投影当前连续 component；小尚鹏哥双房 claims 不丢失；同载荷 replay；变载荷 conflict；整批回滚；并发 source/run；普通外部渠道缺号仍拒绝、迁移例外通过。
- Pricing：迁移实价合计精确、policy base null、无 collection facts、普通订单现有 pricing guards 不回归。
- Inventory：运营区间零冲突；周慧玲 306 不可售；专用续住原子创建 claims 并释放 hold；失败时继续锁房。
- Membership：郑亮无虚假 member/payment，恰好 19 coverage、19 HOLD、19 CONSUME，余额 0，D01/日期/单位严格匹配。
- Readiness、typecheck、unit、全量 integration、contract/build 与 `git diff --check` 通过。
- Readiness 必须核对 037、四张 import/archive 表、source/target/run 唯一与 XOR/FK、所有 append-only/identity/state triggers、`orders.migration_source_id` 唯一 FK、nullable base + pricing origin check/trigger、overdue hold/release 一对一和 active-conflict trigger/索引；破坏任一对象都返回 not ready。

### Production acceptance

1. 冻结旧系统写入并重新导出三张源表，生成最终 manifest；确认仍为 535/490/44/1、50 段，或对任何变化重新复核。
2. 对生产备份执行可恢复验证；在由该备份恢复的候选数据库运行 migration + dry-run。
3. 复核 dry-run：金额 ¥281,404.38、44 运营订单零冲突、朵无虚假 gap claims、小尚鹏哥 108-A/108-B 均被占用、张彩云缺号为受限例外、郑亮 19 夜守恒、周慧玲 306 active hold。
4. 在正式库 apply 一次并保存 run/correlation/reconciliation；立即再次 dry-run/replay，确认零新增。
5. 打开房态确认 44 个运营订单，重点检查 306、D01、A03；随后由操作员完成周慧玲真实离店日/续住处理。
6. 历史问题通过显式迁移更正批次处理；当前运营订单在导入后发生的新业务变化才使用正常系统操作。

历史归档在系统中提供只读列表和详情，可按源订单号、姓名、渠道、入住/离店日期和 disposition 搜索/筛选。完整手机号仍保留在受保护存储中，普通 READ 用户只返回脱敏值；手机号模糊搜索暂缓，待增加专用 PII 权限后再启用。详情展示来源证据、实价证据和缺失原因，明确标注“历史导入，只读”。它不进入房态，也不提供住宿、资金或会员操作按钮。

## Verification

Expected commands:

- `npm run typecheck`
- `npm run test`
- `npm run test:integration`
- `npm run build`
- `npm run backup`
- `npm run verify:restore`
- `npm run db:import:historical-orders -- --manifest <path> --dry-run`
- `npm run db:import:historical-orders -- --manifest <path> --apply --approval <owner-private-path>`
- `npm run db:purge:production-acceptance -- --mode inspect`
- `npm run db:purge:production-acceptance -- --mode dry-run`
- `git diff --check`

## Status Log

- 2026-08-09：用户确认从 2026-03-13 开始同步，采用历史实价方案，并完成 4 项 P0 人工确认。
- 2026-08-09：V4 只读审计闭合 535/490/44/1、50 段和 ¥281,404.38；确认张彩云渠道号、郑亮权益和周慧玲逾期在住为专用迁移边界。
- 2026-08-09：进入 A 级实施规格、对抗审查和开发，尚未写入生产或飞书。
- 2026-08-09：两轮 A 级对抗审查完成，生命周期、历史实价、overdue hold、来源绑定和后续命令边界 blocker 清零。
- 2026-08-09：集成导入发现一条间断住宿和一条同期双房来源；规格改为 canonical 完整留证、core 仅当前连续 component，并用多 unit timeline/claims 保真双房占用，禁止制造 gap 或丢房。
- 2026-08-10：完成 037、manifest 生成/解析、原子导入、历史归档、运营 snapshot、迁移实价、周慧玲 306 overdue hold 和郑亮 19 夜权益重建；未写入正式库或飞书。
- 2026-08-10：增加独立 Ed25519 恢复证明和短时审批凭据；apply 使用 `--approval <owner-private-path>`，且审批密钥与恢复密钥必须分离。
- 2026-08-10：自动门禁通过：typecheck、790 项 unit、311 项 integration、74 项 contract、build 和 whitespace check 全绿。手机号搜索暂缓至专用 PII 权限建立；普通 READ 仅返回脱敏值。
- 2026-08-10：最终审查后加固 44 单人工批准 tuple hash，同时绑定姓名、昵称、手机号、各字段来源和人工确认；检查输出仍只显示 SHA-256，不输出 PII。加固后 typecheck、790 项 unit 和 16 项历史导入 integration 复验通过。
- 2026-08-10：生产仍阻塞于同一割接日的三张新导出、重建并审核 V4、44 单 tuple hash 人工批准、真实备份/恢复验证、候选库与正式库双 dry-run，以及短时签名审批凭据。
- 2026-08-10：用户确认 8 月 9 日导出即为最终割接数据，8 月 10 日无变化；V4 重建后闭合 535/490/44/1、50 段和 ¥281,404.38，44 单批准哈希为 `cf3a390e6b57ed2e4f8c2007535e1207a0b4c95d33149a45a94719d17e7751c9`。
- 2026-08-10：生产只读审计发现 7 条上线验收住宿订单及完整 demo 会员/认证数据。用户明确选择保留当前生产数据库、不新建正式库，并授权删除这些验收和演示数据；清理必须先停服、关闭 `SEED_DEMO_DATA`、完成备份恢复验证，再用精确快照、单事务 `TRUNCATE ... RESTRICT` 和正式操作员密码轮换执行。
- 2026-08-10：真实割接时间固定为 `2026-08-09T13:31:00+08:00`；唯一允许使用早期导出例外的来源固定为 `COST_EXPORT / Accommodation Cost Details.xlsx / eca5cd18eed450aaa457ac2e2bb1cd085650a59417da684a066c0f695045c789 / 2026-08-08T21:30:14+08:00`。它只能绑定用户于 `2026-08-10` 的原文“用户于2026-08-10确认今天数据无变化，沿用昨日提供数据”；确认日必须晚于割接日。生成器与导入器双重拒绝未来来源、缺确认、错误 role/文件名/SHA-256/导出时间/cutoverAt、泛化文本或日期，以及 confirmation 的额外字段；同日来源不携带该例外证明。
