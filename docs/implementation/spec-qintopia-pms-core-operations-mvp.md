---
title: 'QinTopia PMS Core Operations MVP'
type: 'feature'
created: '2026-07-19'
status: 'done'
pending_increment_status: 'room-status-all-occupant-nicknames-pending'
pending_continuous_stay_context_status: 'pending'
pending_room_status_lifecycle_status: 'pending'
pending_increment:
  - '../../待开发项/房态与订单运营流程分步开发计划.md#阶段-5多人间首页显示全部住客昵称'
  - '../../待开发项/房态与订单运营流程分步开发计划.md#阶段-7连续订单区块选择与订单上下文'
  - '../../待开发项/房态与订单运营流程分步开发计划.md#阶段-8入住与退房'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - 'design-system/qintopia-pms/MASTER.md'
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** 从空目录建立房间/床位库存、订单、住宿履约、会员权益、版本化计价和人工收退款事实的唯一权威系统，并让运营 Web 与外围智能体 API 完成同一核心旅程。

**Approach:** 交付 PostgreSQL 支撑的模块化单体，以共享命令/查询层驱动 Fastify API 与 React Web；从可运行纵向切片推进到真实数据库并发、契约和浏览器验收。真实计价样例未返回前，只发布按夜固定价与免费政策，未知周/月/跨周期规则明确拒绝。

## Boundaries & Constraints

**Always:** 日期为物业时区半开区间 `[arrival, departure)`，金额为单币种最小货币整数。整房与子床逐日双向互斥，不同床位可并存，维修使用同一 claim。每单一个不可变主要居住人快照和一个 Stay；变更追加 segment、amendment、完整 pricing revision。确认锁定不可变政策版本，后续重算仍用该版本；新 revision 不继承旧手工调整。会员先形成逐日逐单元 coverageSet，再算 cashRemainder。收款/退款/冲销为订单内不可变事实，退款引用原收款。只暴露 `currentContractAmount`、`netRecordedCollection`、`collectionDifference`，不推导会计语义。所有写命令持久化幂等键、correlation ID、审计和 Receipt。

**Ask First:** 只有真实样例揭示新的计价、舍入、会员核销时点、未到释放或退款经营边界时才暂停确认。

**Never:** 读取旧 PMS/Git 历史；兼容、迁移、双写；通用公式/动态定价；支付或会计结算；跨订单资金分摊；内置 AI；外围投影回写或数据库直连；用 mock/占位金额通过核心验收。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 核心旅程 | 可售、报价、会员、订单、两笔收款、缩短、退款、入住/退房 | Web/API 产生等价事实和永久引用 | 统一错误 DTO |
| 库存竞争 | 同房同夜整房与床位并发 | 恰好一个事务成功；不同床可同时成功 | `INVENTORY_CONFLICT`，无部分写入 |
| 高风险确认 | 有效 Preview + reason + Confirm（正文重复精确 `propertyId`、`commandType` 和 effect hash） | 重验授权、版本、库存、权益和计价后原子提交 | 过期/变化为 `PREVIEW_STALE`，零业务写入 |
| 幂等恢复 | 同主体/物业/命令/键重放或响应中断 | 同载荷返回原 Receipt；以 `propertyId`、`commandType`、幂等键查询 EXECUTED/NOT_EXECUTED/UNKNOWN | 异载荷 `IDEMPOTENCY_KEY_REUSED` |
| 未配置计价 | 周/月/跨周期且无真实政策 | 不报价、不确认 | `PRICING_POLICY_UNCONFIGURED` |

</frozen-after-approval>

## 2026-07-26 Current-Version Override

当前版本的清洁行为以 [`spec-disable-cleaning-workflow.md`](./spec-disable-cleaning-workflow.md) 为准，并覆盖本文件中更早的清洁生成、投影、展示和完成口径：`CHECK_OUT` 只把住宿更新为“已退房”、释放后续库存并保持既有会员权益行为；不新增、投影、展示或完成清洁任务。既有 `PENDING` 清洁记录不进入房态或订单界面；清洁数据库结构、历史记录、命令契约、Receipt 与审计继续保留。

当前 4.1 验收只覆盖计划到店营业日的普通入住、计划退房营业日的普通退房、会员入住时的权益核销和退房后的库存释放，不进入正式检查点 4.2。未来入住、提前退房、逾期未到和逾期在住在各自权威流程完成前失败关闭且零写入。未来重新启用清洁工作流前必须单独确认：清洁日期语义、逾期呈现、与可售/互斥规则的关系、权限边界，以及历史 `PENDING` 记录的激活范围与截止政策；不能只翻转开关发布。

## Post-Approval Confirmed Facts

本节记录用户在批准冻结块后提供的真实经营事实；与冻结块中“周/月/跨周期尚未配置”的早期描述冲突时，以本节的有限 rev561 政策为准。冻结块本身保持只读。

**库存目录：** 44 间实体房、91 张实体床。独立基础库存为 77：31 个按间单元与公卫两人间/四人间的 46 个按床单元。13 个多人间整间入口是锁定全部子床的组合 claim，不新增库存；90 只能表示 77 个基础单元加 13 个组合销售入口。源表 `97` 重复计算两人间 6 张床，必须拒绝。标间、单人间、大床房、套房不按床卖；电费不另行计算且不产生现金行。C 栋是原 I 栋的当前业务名称；D/E 房号为 `PMS_GENERATED` provenance，不伪称源表房号。

**2026 有限计价政策：** 对外价取飞书工作簿 revision 561 的 `2026价格表!A28:F44`，排除底线测算版和取整日均价。`effectiveFrom=2026-02-25`，结束日开放。`N<7` 使用 `N×P1`；`7<=N<14` 使用 `N×P7/7`；`14<=N<30` 使用 `N×P14/14`；`N>=30` 使用 `N×P30/30`。完整住宿精确求和后只对最终总价按人民币元 positive half-up 舍入一次。跨月不拆，允许 6→7、13→14、29→30 夜倒挂。两人/四人整间先把锚点乘 2/4，再应用同一规则。

**连续 Stay：** 计价累计周期是一个 Order 的同一 Stay 当前有效、连续且不重叠的住宿安排。未入住改期可改变有效入住日和/或退房日；入住后不再追溯改变已经发生的入住边界。改期、续住、缩短、跨月和无缝 MOVE 都按完整有效安排重选一次档位，并继续使用成交时锁定的 policy version；原始预订日期作为不可变历史保留但不重复计入当前价格。跨产品换房对每段使用该统一档位下对应产品的精确日分数，所有段求和后最终舍入一次。两个已完成订单不自动合并，也不创建 `continuationOfOrderId`；至少空出一个服务日后的新订单从新入住日重新计价。每笔新 COLLECTION/REFUND 由服务端自动保存本次操作所依据的不可变 pricing revision，REFUND 同时引用原 COLLECTION；一个 revision 可对应多笔分次资金事实，该关系只用于追溯原始预订或后续变更，不构成会计分摊、到账、结清或核销。

**订单改期与履约边界：** 调整已预订订单的入住日、退房日或两者时保留同一 `orderId/stayId`，不得删除、取消后重建，也不得覆盖原 segment。确认在同一事务追加 amendment、住宿安排版本和完整 pricing revision，迁移 Claim，并释放/重建仍为 HELD 的会员覆盖。已入住后缩短不会恢复 CHECK_IN 时已经 CONSUMED 的权益。阶段 10 对在住缩短严格区分 `newDepartureDate > businessDate`（继续在住）、`=`（原子提前退房）和 `<`（拒绝追溯改写）。入住当天退房会形成零夜，最低收费口径确认前失败关闭。

**状态乘营业日期：** 普通 CHECK_IN 只用于计划到店营业日，普通 CHECK_OUT 只用于计划退房营业日。逾期未到必须进入工作人员队列，补办入住/改期/取消/未到的开放时点由阶段 12 Gate 决定。超过计划退房日仍在住时，真实超期住宿必须延长、重价并处理库存冲突；工作人员迟录退房需要独立受控补录和真实离店依据。二者未区分前，普通退房失败关闭。

**住宿安排与履约投影：** `stay_segments` 是创建、改期、续住、缩短和换房形成的不可变住宿安排版本，不是实际入住流水。订单 Query 应分别提供原始预订安排、当前/最后有效且不重叠的安排、CHECK_IN/CHECK_OUT typed 履约结果和安排变更历史。办理营业日、记录时间与操作人可以作为履约事实展示，但记录时间不得伪称为住客实际到店时间；未来生效换房必须区分当前位置和计划换至位置。

**会员、免费与手工价：** 会员订单确认时冻结逐日 ROOM_NIGHT/BED_NIGHT coverage，成功 `CHECK_IN` 时核销 HELD；入住前取消/未到释放，普通变更不恢复 CONSUMED。权益不足允许部分覆盖，已选择会员但 0 余额时也对每个未覆盖日期使用 P1，不按未覆盖晚数切档；续充追加新 Lot，可覆盖尚未覆盖日期。免费住宿必须保存原因、金额为 0、永不触碰会员权益；免费变更追加 amendment/revision/审计并要求本次原因。WECOM 直订手工调价输入非负整数元最终总价，保存政策基础价与 `target-policyBase` 并要求人工调价原因；后续 revision 不继承。会员合同购买款不可退款。

**正常与免费住宿渠道：** 新建正常住宿订单必须保存 `YOUMUDAO|CTRIP|MEITUAN|WECOM` 之一；`YOUMUDAO|CTRIP|MEITUAN` 必须同时提供非空渠道订单号，`WECOM` 的渠道订单号必须为 `null`。免费入住不是渠道订单，`bookingChannelCode` 与 `channelOrderReference` 都必须为 `null`，并改为保存 `freeStayCategoryCode=VOLUNTEER|RECEPTION` 和具体免费原因。数据库可为历史免费订单保留真实 `null` 分类，Query/DTO 原样返回且 Web 仅派生显示“历史未记录”；不得虚构回填义工、接待或第五个渠道。本段是对早期“所有新 Order 渠道必填”表述的用户最新精确覆盖。

**渠道订单合同金额：** 对 `YOUMUDAO|CTRIP|MEITUAN`，渠道是住宿订单的客户；工作人员填写的“本单渠道应结金额”就是订单首个 pricing revision 的 `currentContractAmount`，不得另存第二个渠道结算金额。该金额不是住客支付额、平台批次打款或银行实际到账。政策基础金额与政策版本继续不可变保留。渠道金额相对政策基础金额的绝对差异率不超过 15%（含 15%）时不要求自由文本说明；超过 15% 时必须保存“渠道价格差异说明”，由服务端用 `abs(target - policyBase) * 100 > policyBase * 15` 的整数比较判定。渠道金额差异不是人工调价。CREATE_ORDER 必须在同一事务中形成目标合同金额的首个 revision，禁止先按政策价建单再追加 REPRICE_ORDER。订单创建后的任何价格更正仍必须填写原因并追加完整 revision，后续 revision 不继承旧渠道价格。

**渠道财务边界：** PMS 不为外部渠道对账新增平台结算单、合并打款批次、银行实际到账/流水、跨订单分摊、“待结算”状态或独立预计/实际实得金额。PMS API 只提供订单号、渠道、渠道订单号、政策基础金额、订单合同金额、计价修订及追加式业务变更事实。财务对账智能体在系统外使用用户提供的平台和银行资料完成总账汇总与差额核对；PMS 不推导到账、结清、会计分摊或财务核销。

**会员身份：** 会员档案手工保存姓名、唯一身份证号业务键、手机号和微信号；内部关系使用不可变 `memberId`。余额必须由该会员 Lot/Ledger 服务端计算，支持身份证号查找，不把余额当作可覆盖档案字段。

**居住人昵称与身份边界：** 每个新建订单的不可变主要居住人快照必须保存去除首尾空白后仍非空的昵称；昵称属于该订单成交时的居住人事实，不从会员档案动态读取，也不随会员资料变化而改写历史订单。历史主要居住人快照可能缺少 `nickname` JSON 键，也可能显式保存 `null`；Query/API 必须忠实保留原始缺键或 `null` 形态，不伪造业务值，也不把两者强制归一化成新事实。Web 可对这两种情况派生显示“历史未记录”，但不得持久化该提示或其他虚构昵称。会员只表示权益/结算方式差异，不拥有或替代居住人身份；非会员与会员订单使用同一主要居住人快照规则。

**多人间父房聚合：** 拆床销售房间的逐日父格使用 `已占床位数/实体床位总数`，例如四人间三个子床具有有效住宿事实时显示 `3/4`。分子只统计当天由有效正常 `Order` 或 `FREE_STAY` 住宿事实占用的不同子床；维修/锁房、`INTERNAL_USE` 和其他非居住人来源不进入该住客占用比例。当前版本不投影清洁来源；历史清洁记录也不进入房态或订单 DTO。父房格必须按床位稳定顺序直接显示当天每一个有权查看的居住人快照昵称，不得折叠成“首个昵称 +N”、只保留比例或要求悬停后才能看到其余昵称；同名住客也按不同床位分别保留。格子和整行应换行或增高以容纳最多四个昵称，不能覆盖比例、日期或相邻内容。Tooltip/键盘详情继续补充床号、来源和完整语义，但不是昵称的唯一载体。该聚合是服务端事实投影，不改变整房与子床的双向互斥规则。

**连续住宿选择与订单上下文：** 房态中的正常或免费住宿必须以服务端稳定 Order/Stay 引用作为选择身份。点击已占连续区块、其中任一天或对应住客昵称，选择同一 Stay 从原始入住日至当前退房日的完整连续住宿；续住不拆分成另一张订单，无缝换房则同时选择跨房源行的全部住宿分段，但选中容器内部必须保留原始预订、续住、缩短和换房 segment/amendment 的可见审计边界。不同订单、存在日期间隔的新住宿和相同昵称的其他住客不得合并。已占订单被选择后，工作人员右侧先显示当前住宿安排，再显示可定位到具体日期段的变更记录、对应计价修订及相关收退款事实；只查看某次变更不得改变整张订单的选择身份。右侧同时使用服务端当前允许动作，不显示报价、会员搜索、草稿日期或创建订单控件；空白选区仍进入创建住宿或 Block 的流程。浏览器不得根据昵称或相邻逐日格重建 Stay。

**房态工作人员状态语言：** 新订单至入住前显示“已预订”，`CHECK_IN` 成功后活动 Stay 显示“在住”，`CHECK_OUT` 后订单显示“已退房”并按库存事实释放后续日期；当前版本不显示清洁状态或完成入口。服务端 `blocking`、`conflicts`、Claim 和稳定引用继续作为可售、互斥、重验与审计事实，但正常已预订/在住格、Tooltip、屏读名称和常规订单上下文不得显示“阻断、N 个阻断、阻断库存、库存 Claim”等机器语言；只有实际业务操作被已有事实拒绝或房态异常时，才以具体房源、日期和原因的中文业务句子说明。

**待实施状态：** 上述“父房格直接显示全部昵称”“连续住宿选择与订单上下文”“房态工作人员状态语言”和“资金事实关联所依据计价修订”均为原 MVP 完成后的最新增量，分别由 `待开发项/房态与订单运营流程分步开发计划.md` 阶段 5、阶段 7、阶段 8 与阶段 13 跟踪。阶段 8 已于 2026-07-26 按当前覆盖决定完成入住、退房、会员权益核销与库存释放的人工验收，清洁重新启用另列后续版本。本文件 frontmatter 的 `status: done`、既有 Execution 勾选和历史测试数量只代表 commit `4fbf90d` 之前的核心基线，不能作为其他增量已完成的证据。

**飞书申请引用：** 飞书 Base 原生 `record_id` 只标识一次入住申请，不是会员 ID；同一自然人可有多个申请。PMS 以 `provider + source container + table + external_record_id` 唯一保存 append-only 外部引用并关联 `memberId`。身份证号已存在时复用既有会员并追加申请引用，不覆盖档案；Base 回写 `memberId` 只是可选投影，失败不影响 PMS。Base 不得发放、冻结或核销权益，现有 webhook 认证值不得进入代码、日志或文档，必须作为独立受控密钥轮换。

## Code Map

- `apps/api/` -- Fastify 认证、版本化 Query/Command API、OpenAPI、健康检查。
- `apps/web/` -- React 运营房态、订单详情与移动履约。
- `packages/domain/` -- 库存、订单、计价、权益、收退款不变量和命令处理。
- `packages/db/` -- Kysely PostgreSQL 模型、迁移、种子、事务仓储与恢复校验。
- `packages/contracts/` -- 共享 DTO、错误码、权限、Receipt/Preview 契约。
- `tests/` -- 单元、领域、PostgreSQL 集成、OpenAPI contract、Playwright E2E 与真实计价事实。

## Tasks & Acceptance

**Execution:**
- [x] 根配置与 `README.md` -- 可重复安装、Docker 启动、迁移、种子、备份恢复。
- [x] `packages/contracts/`、`packages/domain/` -- 固化 ID、命令、计价和领域不变量。
- [x] `packages/db/` -- 建模、日槽锁、事务、审计、Preview、Receipt、Token。
- [x] `apps/api/` -- 完整 `/api/v1` 查询/命令、OpenAPI、认证授权与 readiness。
- [x] `apps/web/` -- 使用相同 API 完成桌面核心旅程和移动入住/退房。
- [x] 已确认字段增量 -- 订单渠道与逐笔 COLLECTION/REFUND 外部交易单号贯通迁移、命令、Preview/Confirm、Receipt/Query、Web 与自动化验收。
- [x] `tests/` -- 覆盖计价金标、并发/回滚/陈旧/重放、安全、契约、无障碍和 E2E。

**Confirmed field increment acceptance:**
- Given 新建正常住宿订单，when Preview/Confirm，then 必须持久化 `YOUMUDAO|CTRIP|MEITUAN|WECOM` 稳定 code 与 nullable 渠道订单号；`WECOM` 只能保存 `null`。
- Given `YOUMUDAO|CTRIP|MEITUAN` 新订单，when Preview/Confirm，then 渠道订单号和本单渠道应结金额均必填，订单首个 revision 同时保留政策基础金额与目标合同金额；15% 及以内不要求说明，超过 15% 无说明失败关闭且零业务写入。
- Given `WECOM` 新订单，when 使用政策价，then 不要求人工说明；when 目标合同金额偏离政策价，then 人工调价原因必填。任何目标金额均随 CREATE_ORDER 原子创建，不产生第二条 REPRICE revision。
- Given 新建免费入住，when Preview/Confirm，then 渠道与渠道订单号必须为 `null`，并保存 `VOLUNTEER|RECEPTION` 稳定免费类型和具体原因；历史分类空值不得虚构回填。
- Given 新 COLLECTION 或 REFUND，when Preview/Confirm，then 必须保存该事实自身的非空 `transactionReference`，并由服务端绑定 Preview 所依据的不可变 pricing revision；退款仍引用原 COLLECTION，REVERSAL 保持无交易号语义。若确认前 current revision 改变则陈旧拒绝且零写入；历史资金事实缺少 revision 关联时保持真实 `null`，不得虚构回填。
- Given 缺失/非法字段或幂等重放，when 命令执行，then 缺失值零业务写入，同键同载荷返回原 Receipt 且不重复产生 Order/Fact。
- Given Web/API 查询，when 查看 Preview、Receipt 与订单详情，then 渠道和每笔交易号均可追溯，且不被解释为外部已到账、已结清或已核销。

**Confirmed guest nickname and room-status acceptance:**
- Given 新建正常或免费住宿订单，when Preview/Confirm，then 主要居住人快照必须包含非空昵称，Receipt/Query 返回最终持久昵称；会员选择与否不改变该校验。
- Given 历史订单的主要居住人快照缺少 `nickname` 键或显式保存 `null`，when Query/API/Web 展示，then API 忠实保留对应的缺键或 `null` 形态，Web 只派生显示“历史未记录”，且不会产生回填写入。
- Given 多人间的不同子床在同一天由正常订单或免费住宿占用，when 查询/展示父房格，then 同时显示 `已占/总床数` 与按床位稳定顺序排列的全部有权昵称，不得使用“昵称 +N”、去重、截掉后续昵称或仅在悬停时补全；悬停和键盘聚焦继续提供床号与来源详情。
- Given 同一多人间存在维修、内部占用或历史清洁记录，when 计算住客占用比例，then 维修和内部占用不增加分子但仍按既有 typed source 与冲突规则呈现；当前版本不投影历史清洁记录。
- Given 点击已占订单的任一天、连续区块或住客昵称，when 房态选择该来源，then 必须通过稳定 Order/Stay 引用选择完整连续住宿；续住后的日期和无缝换房的跨房分段共同高亮，但原始预订和各次 amendment/segment 边界仍可见、可定位、可查询，相邻独立订单、有日期间隔的新住宿及相同昵称订单不合并。
- Given 已占订单被选择，when 打开右侧上下文，then 显示权威订单基础信息、完整日期与分段，以及服务端按状态和权限返回的合法操作；不得显示 Quote、会员搜索、草稿日期、“应用选区”或创建订单控件，也不得由浏览器拼接逐日格推断 Stay。
- Given 正常或免费住宿已占用库存，when 工作人员查看格子、Tooltip、屏读名称或订单上下文，then 只看到“已预订/在住”、昵称、日期和适用业务信息，不看到“阻断、Claim、冲突数量”等机器词；底层冲突事实仍完整参与可售与事务校验。
- Given 工作人员依次办理入住和退房，when 房态刷新，then 工作人员文字依次为“已预订 → 在住 → 已退房”，会员覆盖只在入住时核销，退房后的后续库存按库存事实恢复可售，界面不出现清洁任务、清洁状态或完成清洁入口。

**Acceptance Criteria:**
- Given 空目录与 README，when 安装并启动，then PostgreSQL 迁移/种子、演示账号、health/readiness、Web 和 OpenAPI 可用。
- Given 种子数据，when 执行完整核心旅程，then 三金额可复算、历史追加且所有引用可查询。
- Given 受限 Token，when 查询、Preview/Confirm、幂等重放及中断恢复，then 权限不扩大且 Receipt 可判定结果。
- Given 两个真实数据库连接，when 竞争库存或制造事务故障，then 互斥与全量回滚成立。
- Given 用户提供的每个真实计价样例，when 运行金标验收，then coverageSet、现金明细、舍入和金额完全一致。

## Design Notes

PostgreSQL 按需创建 `room_day`，按稳定顺序 `SELECT ... FOR UPDATE`。成功业务事实与 Receipt 同事务提交；opaque Token 由客户端生成和保管、服务端仅存哈希，Preview/Receipt 均不返回 secret；有效权限取主体当前授权与 Token 上限/物业范围的交集。Preview 绑定主体、物业、命令类型、规范化输入哈希、effect hash、订单/库存/权益/政策版本和有效期；Confirm 正文必须重复精确的 `propertyId` 和 `commandType`。

订单渠道、外部交易号与计价修订兼容边界：历史 `orders.booking_channel_code`、历史 `collection_facts.transaction_reference` 及历史资金事实的 pricing revision 关联允许保持真实 `null`，Query/DTO 原样返回，Web 仅派生显示“历史未记录”或“历史未关联”。不得以 `WECOM`、`UNKNOWN`、`LEGACY`、Fact/Receipt/Command/correlation/idempotency 标识伪造业务事实。数据库 nullable 列兼容历史行，但新插入触发器与应用命令共同保证：新建正常住宿 Order 必须使用四个已确认渠道之一，`WECOM` 的渠道订单号必须为 `null`；新建免费住宿 Order 的渠道和渠道订单号必须为 `null`，并严格校验免费类型和原因；新 COLLECTION/REFUND 必须录入自身非空外部交易号，并自动绑定 Preview 时本次操作所依据的 pricing revision；REVERSAL 的交易号保持 `null`，通过被冲销 Fact 间接追溯。一个 revision 可关联多笔分次资金事实，REFUND 还要引用同订单原 COLLECTION。历史空值属于待运营补录的兼容状态，不降低新写入校验，也不得把该关联解释成外部到账或会计结算。

外部渠道价格不新增 Order 金额列：CREATE_ORDER 输入携带目标合同金额，effect 以锁定政策版本重算政策基础金额并判断 15% 门槛，Confirm 在同一事务写入首个完整 revision。渠道来源、渠道订单号、初始 amendment、政策基础金额、当前合同金额和适用说明共同构成可供外围智能体追溯的业务证据；平台/银行总账证据由外部对账智能体持有，不回写为 PMS 财务事实。

连续日期边界不扩展成跨订单资金关系：只有同一 Stay 内前段 departure 等于后段 arrival 的 segment 才能无缝累计。已结账订单与后来订单保持各自稳定 orderId、pricing revisions 和资金 Facts，避免自动合并破坏“不跨订单分摊”。

会员档案与合同分离：`members.member_id` 是内部不可变关联 ID，规范化身份证号是全局唯一业务键；姓名、手机号、微信号不承担唯一性。新档案通过 `CREATE_MEMBER` Preview/Confirm 原子创建首个空 ACTIVE 合同，既有身份证仅匹配档案并可追加申请引用，不静默覆盖资料或自动发放权益。飞书申请记录只进入按物业隔离、append-only 的 `member_external_references`，固定保存 provider/container/table/record provenance，既不进入会员档案也不成为运行依赖。当前权益余额由服务端按物业时区日期从 Lot/Ledger 复算，已过 `expires_on` 但尚未显式执行 EXPIRE 的 Lot 在查询中派生为 0；显式 EXPIRE 仍负责追加审计事实。

会员权益在订单确认时形成 HELD；`CHECK_IN` 成功与订单状态变更同事务将仍冻结 coverage 转为 CONSUMED，`CHECK_OUT` 不重复核销。入住后的续住、同权益类型换房、重计价或覆盖刷新若产生新 HELD，同一命令事务立即转为 CONSUMED；缩短、取消和未到只释放 HELD，普通命令不得恢复或改写已 CONSUMED coverage。同类型换房保留已核销 coverage 的原库存身份，实际 Stay segment 仍记录新库存。

## Verification

**Commands:**
- `npm run test -- packages/domain/src/pricing.test.ts packages/domain/src/pricing-2026.test.ts` -- 公开价矩阵、连续 Stay、舍入、会员现金余量、免费和资金差额的聚焦领域回归。
- `npm run test:pricing-facts` -- 7 个用户确认 JSON 案例通过生产领域执行器复算 revisions、coverageSet、现金行证据与金额。
- `npm run typecheck`、`npm run test:integration`、`npm run test:contract`、`npm run test:e2e` -- 合并 010 目录/计价/会员变更后必须重新取得完整结果；不得沿用 001-009 时期的数量。
- `./scripts/verify-cold-start.sh`、`./scripts/verify-backup-restore.sh`、`npm run verify:compose` -- 必须在 010 及后续最终迁移上重新完成后才可作为 Goal 完成证据。

## Spec Change Log

- 2026-07-26：根据 4.1 人工验收对“已预订、已订未到、已入住、已住延长、已住缩短、提前退房和普通退房”完成全矩阵审计。确认“尚未履行的未来住宿日期”不等于“尚未核销的房间”；任何日期变化都保留同一 orderId/stayId、追加不可变安排历史并按原锁定政策完整重价，不通过删单、取消后重下模拟改期。阶段 8/4.1 只开放计划到店日普通入住和计划退房日普通退房；阶段 9 负责未入住改期与在住续住，阶段 10 负责在住缩短与原子提前退房。`stay_segments` 明确为住宿安排版本，订单详情后续按原始安排、当前/最后安排、履约结果和安排变更历史四层呈现。本轮只修订权威文档，尚未修改产品代码。
- 2026-07-26：用户批准 [`待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md`](../../待开发项/sprint-change-proposal-2026-07-26-channel-order-pricing-and-4.2.md)。对 YOUMUDAO/CTRIP/MEITUAN，“本单渠道应结金额”成为订单唯一合同金额，渠道订单号和金额均必填；绝对价格差异率 15% 及以内无需说明，超过 15% 必须保存渠道价格差异说明。WECOM 直订偏价和事后更正始终要求原因。目标金额随 CREATE_ORDER 原子形成首个 revision，不新增重复渠道金额、平台打款、银行流水或 PMS 内财务对账模型。
- 2026-07-26：按已批准的 [`spec-disable-cleaning-workflow.md`](./spec-disable-cleaning-workflow.md) 增加当前版本覆盖：`CHECK_OUT` 只更新已退房状态并释放库存，不生成清洁任务；房态与订单不投影历史 `PENDING` 记录，完成清洁当前失败关闭；清洁 schema、历史记录、命令契约、Receipt 和审计保留。当前 4.1 验收收窄为入住、退房、会员权益核销与库存释放，未来重新启用须重新确认五项经营决策。
- 2026-07-19：安装、领域、数据库、API、Web 与非计价事实验收均已实现并完成发布级回归；`tests/` 仅因真实计价样例尚未提供而保持未完成，未将临住以外的周期规则或金标结果标记为完成。
- 2026-07-19：加固数据库测试 runner 的 descendant PGID fail-closed 清理与快照故障验收；参考目录新增封存、hash/投影一致性、双连接竞态和全核心零写验证；E2E 改为生产 build/preview 并关闭会话、landmark 与键盘可访问性缺口。当前树通过 unit/domain 25/25、PostgreSQL integration 87/87、contract 42/42、浏览器 E2E 14/14 适用场景（14 项按 project 明确跳过）、冷启动、备份恢复和 Docker smoke；真实计价金标仍为唯一阻断项。
- 2026-07-19：完成订单来源渠道与逐笔收退款外部交易单号增量。009 migration 不回填、不设置业务默认值，历史渠道与交易号继续以真实 `null` 返回并列为待运营补录的迁移债务；所有新建 Order、COLLECTION 与 REFUND 在领域、Command、数据库、Preview/Confirm、Receipt/Query、OpenAPI 和 Web 全链路严格执行已确认规则。最终回归为 unit/domain 34/34、PostgreSQL integration 92/92、contract 42/42、浏览器 E2E 14 个适用场景通过（14 个 project 跳过），冷启动、备份恢复和 Docker image/smoke 全部通过；`tests/` 仍仅因真实计价金标未提供而保持未完成。
- 2026-07-19：用户确认 revision 561 的 44 房/91 床/77 基础库存、10 个价格产品、2026-02-25 生效、跨度公式、最终 half-up、累计续缩/跨月/换房、会员 P1 现金余量、免费零金额、手工指定最终价及会员合同不可退款。新增 10 产品 × 8 晚数金标和 7 个真实 pricing-facts 案例；旧 001-009 全量回归数量仅保留为历史记录，当前完成判断必须等待 010 及会员增量的最终整套复验。
- 2026-07-19：会员增量拆分不可变 memberId 档案、物业合同与外部申请引用；新增身份证精确匹配、服务端 Lot/Ledger 余额、过期 Lot 查询归零、`CHECK_IN` 核销以及入住后新增覆盖即时核销。历史 `member_contracts.member_id` 可保持 `null`，迁移后新合同必须关联真实 member；普通缩短/取消/未到不得恢复已核销权益。
- 2026-07-19：最终整套复验完成：TypeScript 通过，unit/domain 147/147，PostgreSQL integration 104/104，OpenAPI/安全/智能体/脚本 contract 44/44，用户真实 pricing-facts 7/7，浏览器 E2E 14/14 适用场景通过（另 14 项按 desktop/mobile project 明确跳过）。带 CJK 字体的桌面/Pixel 7 截图通过人工布局检查；全新镜像冷启动、隔离 Compose 冷启动及包含 Order/Stay/revision/claim/COLLECTION/REFUND/Receipt/audit/密封目录的备份恢复均通过。数据库 suite runner 同时兼容 macOS/GNU 与 BusyBox `ps`，在容器 PID 1 场景仍保持信号目标防护。
- 2026-07-19：发布收口使用最终镜像 `qintopia-validation:final-20260719-r5`（manifest-list digest `sha256:f615ee0e7117a61c46d873cac0c5de23d4dd15c64a452987acc03196d662be71`，依赖审计 0 vulnerabilities）。同一镜像通过 TypeScript、unit/domain/Web 158/158、PostgreSQL integration 113/113、OpenAPI/安全/智能体/脚本 contract 47/47、真实 pricing-facts 7/7；Chromium desktop/Pixel 7 E2E 17 项通过，另 17 项按 project 条件明确跳过。冷启动、随机端口 Compose（含精确 Session Origin、真实 Quote 写入及 `/docs/`）、非空备份恢复和 `127.0.0.1:4312` 最终实例均通过；中断恢复查询返回同一 `EXECUTED` Receipt。独立完成门禁与 Quote 竞态复审无剩余 must-fix。非阻断外部事项仅为历史真实空渠道/交易号的运营补录，以及飞书既有 webhook 认证令牌的外部轮换。

## Suggested Review Order

**命令与事务主干**

- Confirm 重验授权、版本、库存和权益后原子提交永久 Receipt。
  [`service.ts:622`](../../packages/db/src/commands/service.ts#L622)

- 统一 effect 构造承载订单、资金、履约和权益不变量。
  [`effects.ts:284`](../../packages/db/src/commands/effects.ts#L284)

- 单事务应用追加事实、revision、coverage 和审计引用。
  [`apply.ts:244`](../../packages/db/src/commands/apply.ts#L244)

**真实目录与计价**

- 有限 rev561 目录导入封存来源、投影与内容哈希。
  [`reference-catalog.ts:592`](../../packages/db/src/reference-catalog.ts#L592)

- 连续 Stay 跨产品统一落档并仅最终 half-up 一次。
  [`pricing.ts:162`](../../packages/domain/src/pricing.ts#L162)

- 会员、免费、目录和版本化价格结构在数据库固化。
  [`010_qintopia_2026_catalog_pricing_and_free_stays.sql:1`](../../packages/db/src/migrations/010_qintopia_2026_catalog_pricing_and_free_stays.sql#L1)

**运营 Web**

- Quote 恢复租约隔离卸载、主体、物业和迟到回调。
  [`InventoryPage.tsx:84`](../../apps/web/src/pages/InventoryPage.tsx#L84)

- 会员档案、Lot/Ledger 余额和到期命令共用协议。
  [`MembersPage.tsx:207`](../../apps/web/src/pages/MembersPage.tsx#L207)

- 每笔收退款保存独立外部交易号并完整展示事实链。
  [`OrderDetailPage.tsx:95`](../../apps/web/src/pages/OrderDetailPage.tsx#L95)

**API 与运行边界**

- Fastify 暴露同源 Web/API、OpenAPI、健康检查和精确 Origin。
  [`server.ts:92`](../../apps/api/src/server.ts#L92)

- Compose Origin 跟随公开端口，避免随机端口 Session 写入失败。
  [`compose.yaml:24`](../../compose.yaml#L24)

**验收与恢复**

- 浏览器旅程覆盖核心经营、移动履约、恢复与无障碍。
  [`core-journey.spec.ts:378`](../../tests/e2e/core-journey.spec.ts#L378)

- 外围智能体契约验证权限收窄、幂等和中断恢复。
  [`agent-core-journey.contract.test.ts:235`](../../tests/contract/agent-core-journey.contract.test.ts#L235)

- 真实 PostgreSQL 验证 rev561、连续计价与历史追加。
  [`real-pricing-policy.integration.test.ts:83`](../../tests/integration/real-pricing-policy.integration.test.ts#L83)

- 非空恢复核对订单、资金、Receipt、审计和封存目录。
  [`verify-backup-restore.sh:113`](../../scripts/verify-backup-restore.sh#L113)
