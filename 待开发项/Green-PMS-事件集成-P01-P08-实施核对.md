# Green PMS 事件集成：P-01 至 P-08 实施核对

日期：2026-09-09。状态：原只读核对完成；用户随后明确“开始开发”，已授权本地实施及必要隔离验证，尚未验收、未部署。下文原核对记录保留，最新执行决定以本节及文末实施记录为准。

### 开发授权后的实施决定

- 2026-09-09 用户明确开始开发，并要求简单轻量、暂不设计接口级权限体系：复用现有单物业 READ，新增投影严格白名单；明确 READ 凭证仍能访问原有读接口。此决定覆盖此前“严格限制另增 1–2 人日”的建议。
- 原生产/真实业务/外部消息边界继续有效。仅本地代码、版本化迁移、合成测试和专用隔离数据库；不运行既有验收库 reset、不修改兄弟仓库或生产配置、不启用真实投递。
- P1 使用数据库事务捕获：在权威命令 APPLIED/会员删除操作/受控上下文变更的提交事务内写 Outbox；通过延迟触发器读取最终版本，独立发布事务分配序号；捕获 epoch 切换使用事务共享/排他门闩。模式默认关闭，启用基线后才建立集成状态。
- 对共同协议新增结构只实现已收口语义；Agent OS 当前 decoder 的 source_fact_ref 是有类型前缀的不透明字符串，PMS 事件保持兼容，不擅自改成上一轮建议的对象。最小投影 DTO 的联合验收状态单独记录，未验收前不启用真实回读/消费。
- PMS 验收按主计划新增事件集成段执行：P1/P2 工程及自动检查可连续完成，再提交事务/投影两个检查点；P3/P4 的独立开发与本地故障验证可继续，生产激活须另有发布授权。

核对基线：本地 HEAD `aaeb8d9ef02f765693092b68691ccb91b25efc17`，package 版本 `1.2.3`，源码迁移目录截至 `057_order_directory_read_indexes.sql`。这是本地源码事实，不是服务器版本或数据库迁移已应用证明。本轮未连接服务器或数据库。原有未跟踪目录 `apps/web/dist-f01-f05-manual/`、`apps/web/dist-step9/`、`docs/instruction-audit/` 保留未动。

共同协议唯一来源：[统一人员与入群欢迎 V1，第 3 节](../../qintopia-agent-os/docs/plans/active/unified-person-welcome-v1-contract.md)。核对输入：[Green PMS 交接清单](../../qintopia-agent-os/docs/plans/active/green-pms-event-integration-handoff.md)。本文件仅记录 PMS 实现映射、差异和未来工程切片，不作为第二份协议；以下 D 项均为待回传建议，不是双方已接受的新字段或事件。未向其他任务或外部系统发送消息，未修改兄弟仓库。

## 1. 结论和复用边界

**可实现，但当前仓库尚无 Outbox、发布器、投递 Worker、事件 feed 或 Agent OS 最小投影。** 现有命令事务、订单 amendment/version、稳定 Order/Stay/occupant ID、外部引用唯一键及受限数据库身份可复用。主要新增工作在完整捕获、成员/库存集成修订、同一发布日志、最小投影与运行恢复，不需要新建人员库或改住宿业务状态机。

| 交接项 | 核对结论 | 具体落点 |
| --- | --- | --- |
| P-01 写路径 | 已列现行 40 个命令、历史禁用入口、数据库函数、迁移/初始化及运维路径；不能只钩住常见住宿命令 | 第 3 节 |
| P-02 版本 | order.version 可覆盖现行订单自身事实；member/inventory 没有完整版本；相关对象变化与时间派生值不能当 order 版本变化 | 第 4 节 |
| P-03 事务/水位 | 兼容共同契约的“两阶段事务”：业务+Outbox；已提交 Outbox+物业发布计数器+不可变信封 | 第 5 节 |
| P-04 同源 push/pull | 可共享发布日志；共同契约还需补轮询事件原始字节提取、游标错误及清理边界 | D-03、D-06、第 6 节 |
| P-05 最小投影 | 可复用生命周期核验；当前 DTO 不能直接透传；成员/库存回读和墓碑读取契约缺项 | D-02、D-04、D-05、第 7 节 |
| P-06 投递运维 | 签名/ACK/重试规则兼容；需要新 Worker、受控配置、独立权限和持久尝试状态 | 第 8 节 |
| P-07 时间/来源 | 只有营业日与记录时间，不能伪造准确到店 UTC；迟录、复合补录和纠错须按效果分类 | D-07、第 9 节 |
| P-08 测试/发布 | 可接现有 runner、迁移/readiness/备份链；没有现成 Worker 运行入口 | 第 10 至 12 节 |

相容条款直接复用：共同契约 §3.1 的固定 webhook 主触发、轮询兜底及现有 READ 物业授权；§3.2 的稳定 ID、不可变信封、字符串版本与隐私白名单；§3.3 已覆盖的住宿事件；§3.4 整张签名与 ACK 表；§3.5 的事务 Outbox、提交后分配发布序号、Inbox durable accept 后推进 page cursor、过期重建及 baseline 不自动欢迎；§3.6 的逐人稳定引用、未知床位和 member 不等于 occupant。这里的“兼容”表示不需要改变既有业务不变量，不表示接口已经存在。

适用 A 级来源：

- [核心规格](../docs/implementation/spec-qintopia-pms-core-operations-mvp.md)与[业务不变量](../docs/architecture/invariants-and-decisions.md)：命令事实、回执、审计同事务；住宿安排和实际履约分离。
- [会员目录规格](../docs/implementation/spec-step-2a-member-directory.md)、[会员资料调整](QinTopia-PMS-会员资料字段调整-实施规格.md)：稳定 memberId、档案与订单快照分离。旧“证件为唯一必填业务键”的表述已被后续资料规格及 037/053 的有效手机号唯一规则覆盖，不能重新用于自然人匹配。
- [4.1](QinTopia-PMS-第4步-4.1-实施规格.md)、[4.2](QinTopia-PMS-第4步-4.2-实施规格.md)、[4.5](QinTopia-PMS-第4步-4.5-实施规格.md)、[在住升级与补录](QinTopia-PMS-在住升级会员与历史补录-实施规格.md)、[受控纠错](QinTopia-PMS-运营主管受控纠错与房态异常修复-实施规格.md)：日期、追加版本、复合命令和历史来源。
- [账号与误建会员删除](QinTopia-PMS-第9步-9.6-账号管理与误建会员删除-实施规格.md)、[撤销退房](spec-revoke-checkout.md)、[同住人](spec-whole-room-companions.md)：独立删除事务、完整恢复与名单撤销；人员登记共用整单日期。
- 人工验收仍归[主计划](QinTopia-PMS-分步开发与人工验收计划.md)。本文件没有更新任何既有验收状态，也没有启动后续步骤。

## 2. 回传共同契约的具体差异

只需把下列条款核定后更新共同协议同一入口及共享合成 fixtures。无需重新决定产品方向。除 D-08 为权限含义澄清，其余会影响 P1/P2 或双路接收的确切实现。

| 编号 / 条款 | 源码或契约证据 | 影响 | 最小调整建议（待共同协议维护方采纳） |
| --- | --- | --- | --- |
| D-01 §3.3 订单上下文事件缺项 | `commands/apply.ts:1603`、`:1623` 转会员改变 order.member_id/member_contract_id 并增版本；`commands/member-corrections.ts:2360`、`:2395` 重建也改变关联；`apply.ts:2259` 重价/刷新 coverage 增 order.version。既有事件表没有纯订单关联/版本刷新类型 | 发 checked_in、occupants_changed 或 arrangement_changed 都会歪曲事实；只发 member 事件不足以精确表达哪个订单关联发生变化 | 在同一协议登记一个纯失效/回读事件，建议名 `pms.order.context_changed`，覆盖转换/重建及无其他已定义事件的订单版本变化；不能直接产生入住资格。若选择复用某个原类型，须明确扩展其语义，双方不能各自猜测 |
| D-02 §3.1/§3.3/§3.6 成员、库存回读及申请引用缺项 | 只有订单三条拟定读取入口；member/inventory 事件却要求更新源镜像。`members.ts:143`、`:194` 的现有查询包含私密档案和权益；外部引用属于 member+property，不是 occupant+stay。无订单会员也可删除 | 单靠订单回读不能收敛未关联订单的成员变化、库存失效；也无法从只含 member ID 的 member_ref 取得可靠申请来源 | 共同协议补两个受限实体当前态/墓碑读取能力（具体路径统一登记），以及 member_ref/occupant 关联引用的嵌套字段。只提供源 ID、版本、删除/有效标志、受控 provider/container/table/record 引用；申请引用是候选来源，绝不宣称已经绑定本次 occupant。不新建 PMS 申请/Person 库或外部引用写接口 |
| D-03 §3.2/§3.5 原始字节与数组事件 | webhook 对原 body 字节签名；feed 拟定 `events` 数组，但未规定消费者如何获得每个事件完全相同的字节。当前 Fastify 路由/TypeBox 会按 DTO 序列化（`server.ts:777`、`:786`），源码无原始事件通道 | 通用 JSON parse/stringify 可改变键序、空白、转义，使同一 event_id 在 Inbox 形成假 hash 冲突 | 保留信封结构，明确 producer 在 feed 数组中嵌入已存 UTF-8 JSON 原片段，consumer 提取该对象原始字节再 durable accept，不能用平台默认重序列化；共享 fixture 验证 Unicode、转义及键序。若接收实现不支持原片段提取，再在唯一协议选择原始载荷编码字段，勿各自添加 |
| D-04 §3.6 hash/版本比较与当前有效性 | `orders.ts:1634` 的 effectiveArrangement 带 businessDate；观察时间每次读取变化，未来 MOVE 的“当前位置”随营业日变化，订单无新写入。成员/库存修订变化也不增加 order.version。受控纠错规格 §4.1 另区分到期 DUE_OUT 与逾期 OVERDUE_IN_HOUSE | 若整个最小 DTO（含 observed_at）都进入 hash，每次 GET 就发生“同版本不同 hash”；只比较 order_revision 会漏关联变化。未来换房到生效日没有第二条命令事件；IN_HOUSE 也不单独证明今天有住宿区间 | 定义稳定 hash 覆盖集：排除 observed_at、hash 自身和“此刻”派生字段；包含稳定安排、登记状态及规范排序后的 related_revisions。比较完整版本向量，不只 order_revision。`是否当前有效` 明确区分“当前安排版本”与“今日所在区间”；后者按物业日期回读/定时重评，不另造入住事件。共同协议补物业时区/观察营业日及到期、逾期的确切表达，不用末段房源填充不存在的今日住宿 |
| D-05 §3.2/§3.6 嵌套字段、墓碑和安排来源未闭合 | `OrderArrangementIntervalDto`（contracts `:919`）只有库存引用和日期；`orders.ts:1519` 完整替换可用一条 segment 对应 payload 内多房源区间。`members.ts:146` 直接过滤 deleted_at；当前 404 没有墓碑版本 | 不能把最大 segment 所在房当当前位置；一条区间与一条物理 segment 非必然一一对应。缺少响应 union 和枚举将导致两边生成不同 DTO | 在唯一协议定全 source_fact_ref、refs、related_revisions、arrangement、occupants、列表分页响应及墓碑形状。segment_id 定义为“建立该安排区间的权威安排版本引用”，允许同一版本 ID 出现在多个区间，不当作逐人入住流水。墓碑返回源/物业/类型/ID/单调修订/失效事实引用，采用显式 200 tombstone 分支；真实从未存在和无权限另行定义，不能由旧 404 推断删除 |
| D-06 §3.5 cursor 有效期/边界 | 定义了 410，但未规定空 cursor 和 floor 的数学关系、未知/篡改/错来源游标错误；当前只有订单 beforeId（`order-list.ts:19`） | 清理边界 off-by-one 可跳漏；“无事件”可能无法建立可靠起点；未来 cursor 可越过实际 head | 明确 cursor 表示“已接收至序号 c”，查询为 seq>c；floor 表示已删除的连续前缀末序号，c=floor 有效，c<floor 为 410；空库 head=floor=0。格式/校验失败及未来序号为 400，授权越物业为 403；对应稳定错误码在唯一协议登记。范围错误不假装过期或空结果 |
| D-07 §3.3/§3.5/§3.6 迟录和复合事务来源 | `apply.ts:1064`、`:1074` 一次 CREATE_ORDER 可追加入住/退房；COMPLETE_STAY 在 `:2382`、`:2400` 配对追加；`effects.ts:3015` 普通 CHECK_IN 也可 LATE_RECORDED；精确实际到店时间不存在 | 不能按命令名把 CREATE_ORDER/CHECK_IN 全标 live；原子补录不能在接收端短暂冒出 live 在住；启用前开事务、启用后提交也不能自动越过准入 | 明确这些补录/迟录及管理员纠错为 historical_correction，所有状态仍同步；普通当天真实办理为 live；启用前初始化/影子来源为 baseline，重放不改 origin。复合事务内各事件统一使用该订单最终提交版本、各自权威 fact_ref。准入边界必须覆盖在途旧事务，建议按受控捕获 epoch 的事务门闩排空后切换；仅 publish_seq 截止不够。此分类写回同一协议后再实现 |
| D-08 §3.1 “最小 READ”权限含义 | `auth.ts:62` 起的 Bearer ceiling 为物业 READ/WRITE，`:107` 仅一个 property_scope；`server.ts:786`、`:802` 等既有读接口同样接受 READ | 现有 READ 能满足首期不写 PMS，但不是“只能调用这几条投影接口”的 endpoint scope；单 Token 也不表达多物业集合 | V1 直接复用现有单物业 READ，多个物业配独立凭证；在协议明确这是业务写权限最小化，不能宣称凭证被限制为仅最小投影路由。Agent OS 客户端仅调用新白名单路由；若另要求凭证也无法访问原有详情，须单列新增读能力 ceiling 的安全切片，当前不自动扩展 |

PMS 内部缺口而非协议差异：成员/库存集成版本、会员删除捕获、SQL 约束/readiness、新 Worker 与状态表。它们按共同协议落实，不另起事件命名。D-03 是编码约定，不变更 HMAC 的现有签名串或 ACK 语义。

## 3. P-01：完整写路径覆盖

以下是未来应产生的事件，当前均未接入。事件名称除标注 D-01 者外引用共同契约 §3.3。为减少表宽：O=order；M=member；I=inventory_unit；V=该订单本次最终提交的 `orders.version`；IM/II=拟新增对应集成修订。L=live；H=historical_correction；B=baseline。历史对象上的普通资料/安排纠正按 H；初始化一律 B。所有表格行都受第 9 节来源规则约束。

### 3.1 通用命令主干

入口 `POST /api/v1/command-previews/:previewId/confirm`（`apps/api/src/server.ts:971`），转 `confirmCommandPreview`。成功事实在 `packages/db/src/commands/service.ts:1789` 的事务提交后才对外成立：锁/重建 effect → `applyCommand`（`:1973`）→ room-status revision → command APPLIED → Receipt → audit（`:1989`–`:2027`）。事务失败后的 REJECTED/NOT_EXECUTED 是独立恢复事实，不能产出住宿事件。Preview/quote 可能持久化协议记录，但不是已预订住宿。

下表覆盖 `packages/contracts/src/index.ts:45` 的全部 40 个现行命令；表中合并行里的每个命令都必须有独立覆盖断言。

| 命令/分支 | 提交效果与源码 | 应发事件 / 聚合 / 修订 / origin |
| --- | --- | --- |
| CREATE_ORDER 普通/会员/免费/临时其他整间 | `apply.ts:876`、`:994`：订单、名单、Stay、amendment、segment、Claim 同事务；会员/免费不是另一路 | pms.order.created / O / 1 / L；源 ref 为 CREATE amendment。临时房以 actual inventory 为事实，不用会员原产品路由 |
| CREATE_ORDER 已完成住宿补录 | `apply.ts:1023`、`:1064`、`:1074`、`:1085`：CREATE+CHECK_IN+CHECK_OUT，最终 V=3 | created、checked_in、checked_out / 同 O / 全部 3 / H；各自 fact_ref；不得曝光未提交中间状态 |
| CREATE_ORDER 跨今天在住补录 | 同分支，最终 CHECKED_IN、V=2 | created、checked_in / 同 O / 全部 2 / H；不是当天首次 live 到店 |
| CHECK_IN | `apply.ts:2600`、`:2635`、`:2673`；`effects.ts:3015` | pms.stay.checked_in / O / V / 当天 L，LATE_RECORDED 为 H（D-07） |
| CHECK_OUT | `apply.ts:2638`、`:2673`，业务日在 effect 保存 | pms.stay.checked_out / O / V / 当天 L，迟录 H；无清洁欢迎事件 |
| COMPLETE_STAY | `apply.ts:2338`、`:2382`、`:2400`、`:2414`：同事务入/退，V 增 2 | checked_in、checked_out / O / 同最终 V / H |
| RESCHEDULE_STAY、EXTEND_STAY | `apply.ts:1767`、`:1892` | pms.stay.arrangement_changed / O / V / L；留原 Order/Stay，不新发 created |
| SHORTEN_STAY 普通缩短 | `apply.ts:1935`、`:1967`、`:2021` | arrangement_changed / O / V / L |
| SHORTEN_STAY 提前退房 | 同分支 `:1998` 同时 CHECK_OUT，版本增 2 | arrangement_changed、checked_out / O / 同最终 V / L；保留两条 amendment 引用 |
| MOVE_UNIT | `apply.ts:2068`、`:2221` | arrangement_changed / O / V / L；未来生效仍是安排变化，不是即时搬入 |
| CANCEL_ORDER | `apply.ts:2600`–`:2679` | pms.stay.cancelled / O / V / L；终态不是实体删除 |
| MARK_NO_SHOW | 同上 | pms.stay.no_show / O / V / L |
| REVOKE_CHECK_IN | 同上及 `:2666`，保留入住及补偿 | pms.stay.check_in_revoked / O / V / H；不是取消、退房或删除 |
| REVOKE_CHECK_OUT | `commands/checkout-reversal.ts:164`–`:210`，恢复完整安排并增版本 | pms.stay.check_out_revoked + arrangement_changed / O / 同 V / H；不能另发新的 checked_in |
| CORRECT_ORDER_OCCUPANT | `apply.ts:1701`–`:1749`，追加资料纠正，occupant ID 不变 | pms.order.occupants_changed / O / V / H；即使白名单无身份字段变化仍使审核/关联待复核 |
| MANAGE_ORDER_OCCUPANTS ADD/REMOVE | `commands/companions.ts:72`–`:94` | occupants_changed / O / V / ADD 在当前预订/在住可 L；误录 REMOVE 为 H。两者都只登记名单，不证明个人到店/离店 |
| CORRECT_HISTORICAL_STAY_ARRANGEMENTS | `apply.ts:1370` → `admin-historical-stay-corrections.ts:909`、`:995`；一个 correctionSet 涉及多单 | 每个受影响 O 一条 arrangement_changed / 各自 V / H；不能只取 resourceRefs[0] |
| CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP | `apply.ts:1384`–`:1623`，关联会员和新合同，入住状态不变 | D-01 订单 context_changed / O / V / 在住 L、已完成 H；若真正新增 member_property_link，再发 M context_changed/IM；不发新的入住 |
| VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY | `member-corrections.ts:2360`、`:2395`，旧链作废、新链和源住宿关联同事务 | D-01 / 源 O / V / H；仅当最小 M 上下文或属性关联变化才附 M context_changed。旧会员合同 VOID 不等于 member invalidated |
| REPRICE_ORDER、REFRESH_MEMBER_COVERAGE | `apply.ts:2259`–`:2292`，新 amendment/revision，order.version+1 | D-01 / O / V / L；仅告知版本需回读，不导出价格、资金或权益明细 |
| RECORD_COLLECTION、RECORD_REFUND、REVERSE_FACT | `apply.ts:2306`–`:2324`，只追加资金事实，不增 order.version | 不发 V1 事件：最小投影不含资金/结算/allowedActions。不得用资金 fact 时间充当住宿版本 |
| CREATE_MEMBER | `apply.ts:630`–`:659`，档案+当前物业 link | pms.member.context_changed / M / IM / L；若来自动作前基线则 B；建会员不等于入住 |
| CORRECT_MEMBER_PROFILE | `member-corrections.ts:1716`–`:1758`，append correction + 更新档案 | member.context_changed / M / IM / H；资料正文不出库到事件，历史订单快照不改 |
| CREATE_MEMBERSHIP_ORDER | `apply.ts:663`：购买草稿，member 引用已存在 | 不发：未改变最小人员引用或住宿；不把 DRAFT 合同当入住 |
| ACTIVATE_MEMBERSHIP_ORDER | `apply.ts:792`：contract/Lot；016 trigger 可补物业 link | 若新增 link，member.context_changed / M / IM / L；否则无事件。不把合同/Lot version 当 member revision |
| RECORD_MEMBERSHIP_PAYMENT、CORRECT_MEMBERSHIP_PAYMENT | `apply.ts:715`、`:745` | 无事件：购买资金/版本不是本轮人员/住宿最小投影 |
| CORRECT_MEMBERSHIP_EFFECTIVE_DATE | `member-corrections.ts:1781`：订单/合同/Lot 日期和各版本 | 无事件：V1 不导出会员资格、合同日期或余额；若 D-02 将这些纳入，必须同步扩大覆盖，本方案不建议纳入 |
| BACKFILL_HISTORICAL_MEMBERSHIP | `member-corrections.ts:1873`：既有会员补合同/Lot/收款 | 仅当新增物业 link 时 member.context_changed / M / IM / H；否则不发 |
| ADD_MEMBER_ENTITLEMENT_LOT、ADJUST_MEMBER_ENTITLEMENT、CORRECT_MEMBER_ENTITLEMENT_BALANCE、EXPIRE_MEMBER_ENTITLEMENT | `apply.ts:1187`、`:1213`、`:1235` | 无事件：权益数量/到期不等于居住人或住宿状态；日期自动失效也不标 member deleted |
| LOCK_MAINTENANCE、RELEASE_MAINTENANCE | `apply.ts:1129`、`:1151`，维修 Claim | 无住客事件：不改变 inventory 单元层级/楼栋/active，也不改变有效订单事实；已有库存冲突规则保证互斥 |
| COMPLETE_CLEANING | `apply.ts:1168`，当前 feature=false | 当前不能执行；历史恢复不发新事件，未来启用仍不创造住客资格 |
| ISSUE_TOKEN、ROTATE_TOKEN、REVOKE_TOKEN | `apply.ts:1271`、`:1303`、`:1345` | 无业务事件；继续既有即时认证撤销。签名/投递配置轮换不借此扩大 Token command ceiling |

### 3.2 核心入口之外与历史路径

| 路径 | 权威依据/事实 | 捕获与不发理由 |
| --- | --- | --- |
| DELETE_MEMBER | `apps/api/src/account-management.ts:118`、`:147` → qintopia_manage_account → `054_unused_member_deletion.sql:162` 的 qintopia_delete_member_business；`:187` 保存 operation，`:206` 更新 deleted_at。旧 053 由 054 替换对应分支 | 必须在这个 SQL 事务内部更新 IM、写墓碑及 pms.entity.invalidated / M / IM / H；source_fact_ref 用 operation_id，不能要求必须 command_id。在 API 返回后补发会漏崩溃窗口 |
| CREATE_STAFF/停启/删员工/密码/会话动作 | 同账号管理函数；身份是 subjects，不是 members/occupants | 无 PMS 住宿事件；Agent OS 员工 Person 与角色不从 PMS 登录账号推导。撤权仍影响后续 READ |
| member_external_references 追加 | `010…sql:133` 表与 append-only；`:145` source 唯一；`016…sql:40` 联动物业 link。当前业务 TypeScript 仅有 `members.ts:194` 读取，未找到现行外部引用追加 API/命令，runtime INSERT 白名单也不含该表 | 复用已存在数据；未来经授权 owner 导入/附加引用必须在同事务捕获 M context_changed/IM（历史导入 H，基线 B）。本轮不补建外部引用写功能；无来源变更引用的旁路写须拒绝或在完整重建门禁下处理 |
| member_property_links 追加 | CREATE_MEMBER 显式写；contract/external reference 的 016 trigger 自动写；历史迁移回填 | 物业可见集合变化要捕获；一次操作里新档案+新 link 不生成不同身份。同一事实去重，不让 trigger 与应用重复累计同一语义修订 |
| 库存目录初始化/纠正 | `seed.ts:183`–`:184`；迁移 012/015/020/036。036 在 `:72` 暂停旧身份保护、`:91`/`:175`/`:188` 调整目录和 active、`:220` 恢复；不是现行 Web 命令 | II + inventory_unit.context_changed；active=false 可同 II 附 entity.invalidated，表示当前失效而非删除 ID。已应用旧迁移仅进入 B，不追发 L。后续 owner 更正须提供迁移/维护事实引用并捕获父房及受影响床位，不能关闭所有事件触发器后继续消费 |
| 库存运行时直接修改 | 020 的身份保护禁止楼栋/父子/容量身份变更；047 runtime 无 inventory_units 写权限 | 不存在合法现行 API 写入口；不为事件实现开放楼栋/房床改写。捕获保留给受控维护路径 |
| reference-catalog 导入 | `reference-catalog.ts:771`–`:816` 写封存的 REFERENCE_ONLY 批次/价格参考；不写 inventory_units | 不发：参考目录不是生效库存目录 |
| CREATE_QUOTE / command Preview / 查询恢复与 resolve | service quote/preview/恢复记录有自身持久化和回执 | 不发：没有新住宿事实；NOT_EXECUTED/UNKNOWN 不能当 committed；恢复 EXECUTED 也只返回原回执 |
| BACKFILL_COMPLETED_STAY 旧命令 | `contracts/index.ts:88` 是 ObsoleteCommandType；`apply.ts:2501` 留历史分支，但 stayBackfillSubmission=false | 不开放新写。历史事实仅基线或保持原事件重放；未来重新启用需纳入相同配对 H 测试 |
| PLACE_INTERNAL_USE、RELEASE_INTERNAL_USE | `contracts/index.ts:87` 为 DeferredCommandType | 当前禁止创建；历史内部占用不生成人员资格 |
| reset、seed、隔离验收 setup/purge、restore | `scripts/purge-local-acceptance-business-data.ts:334` TRUNCATE；restore 新库；迁移/seed 使用 owner | 不是生产业务事件来源。本轮未运行。隔离测试实例不得复用生产 source_instance；生产灾备先停消费并核对 epoch/head 再重建，不用 TRUNCATE+重新播报伪装删除事件 |

覆盖范围为本仓静态检索到的运行入口及维护源码；不能据此声称服务器上不存在仓外脚本、手工 SQL 或旧版本写者。上线前必须只读核对运行版本、owner 维护入口、触发器启用状态和授权；发现额外写者先补覆盖或停其写入准入，不能靠轮询掩盖永久漏事件。

## 4. P-02：版本与唯一性

| 对象 | 可复用证据 | PMS 内部实现建议 |
| --- | --- | --- |
| Order/Stay/名单 | `orders.version` 与 amendment 数量/连续 sequence/prior/new_version 在 `orders.ts:1358` 校验；`appendAmendment:2001`；同住人也增 order.version。stays.order_id 唯一，Stay 自身无 version | 复用订单 V；Outbox 在 apply 完成后读取每个受影响订单最终 V。复合事务可跃增 2/3，版本不要求逐个对外可见；同 V 的不同 event_type/fact 不丢。无需给 Stay、occupant 平行编号 |
| Member | schema `:32` 无 version/updated_at；profile correction.sequence 只覆盖资料纠正，不覆盖创建、外部引用、物业 link、删除 | 新增窄集成修订状态，不改会员业务 ID/资料模型。建议每 `(source_instance,member,id)` 一个全局 IM，事务锁后递增；因为各关联物业投影都带此 IM，每次提升向全部已关联物业扇出同 IM，payload 只保留该物业来源引用。物业新 link 也递增，不能用各物业独立计数却省略物业比较维度 |
| Inventory unit | schema `:21` 的 catalog_version 是来源标签，不是单调变化计数；room/bed day.version 只覆盖某日 Claim；room_status_revisions 是物业 UI 刷新水位 | 新增 II，覆盖最小库存上下文实际变更。楼栋从父房继承时，related_revisions 必须含父房；若物化到床位投影则受影响床位也递增。不拿 room-status revision 作事件发布序号 |
| 关联/时间派生 | order version 不随 member、inventory、营业日变化 | 返回完整相关版本向量（D-04）。名单资料纠正只需订单 V 提升即可失效审核，不返回私密值或私密值 hash；时间派生不自动写新业务版本 |
| 墓碑 | member_deletions、deleted_at 有记录，无可比较事件版本；库存 active=false 可保留 ID | 同事实事务写集成修订及最小墓碑；墓碑版本不能因清理事件而丢失或归零。删除后新建会员是新 ID；不按手机号把历史身份复活 |

现有数据库唯一键（仅列结构，不取真实值）：

- `stays(order_id)`；`amendments(order_id,sequence)`；`stay_segments(stay_id,sequence)`；`pricing_revisions(order_id,revision_no)`：001 迁移。
- `order_occupants(id)`、`(order_id,ordinal)`：020；corrections `(occupant_id,sequence)`、amendment_id、created_by_command_id：022；removals occupant_id/amendment_id/created_by_command_id 各唯一：056。REMOVE 再 ADD 必须新 ID。
- `member_external_references(provider,source_container_id,source_table_id,external_record_id)`：010；唯一键**不包含 property_id**，不能在集成层改成“每物业可绑定另一 member”。`member_property_links(member_id,property_id)`：016。
- 活跃 `members(phone) WHERE deleted_at IS NULL`：053；这是档案防重复约束，不是 Agent OS 合并依据。源关系始终使用 memberId/occupantId。
- `command_executions(subject_id,property_id,command_type,idempotency_key)`：006；`command_receipts(command_id)`：001；`account_management_operations(actor_subject_id,request_id)`：053。账户删除重放与命令重放不是同一个幂等 namespace。

拟新增结构及键见下一节，均为未来内部设计；本轮没有创建迁移或 schema 文件。

## 5. P-03：Outbox 与发布水位事务方案

### 5.1 业务事务 T1

保留原业务资源锁顺序，追加事件写入位于成功 effect 应用之后、事务返回之前。`service.ts` 是命令集成入口；受控会员删除在 SQL 函数内部接相同语义；目录/引用维护路径另接受控捕获。业务事务中不访问外部 HTTP，不等待 Worker。

拟新增逻辑结构：

| 结构 | 必要键/状态与限制 |
| --- | --- |
| 集成修订与墓碑 | `(source_instance,aggregate_type,aggregate_id)` 主键，IM/II 为数据库 bigint；失效状态、最小事实引用；order 可复用 V 而不新增业务版本。锁顺序按聚合类型与 ID 固定，不反向再取原业务锁 |
| Outbox | 稳定 event_id 主键；唯一 `(source_instance,property_id,aggregate_type,aggregate_id,aggregate_revision,event_type,source_fact_ref)`，全部规范化非空；待发布的最小事实字段、origin/捕获 epoch。source_fact_ref 是 typed opaque ref，不存 payload/原因/回执正文；唯一键不依赖可空列的默认 NULL 行为 |
| 已发布日志 | event_id 唯一且关联 Outbox；`(source_instance,property_id,publish_seq)` 唯一；UTF-8 body 原始字节、byte hash、schema/source、发布记录时间；发布后不可变，不仅存 JSONB（JSONB 不保留原字节） |
| 物业发布状态 | `(source_instance,property_id)` 唯一；bigint head、floor、cursor epoch；只能在发布/清理事务持锁更新 |
| 订阅投递状态 | `(subscription_id,event_id)` 唯一；next_attempt_at、attempts、状态、lease generation、暂停/死信；尝试记录 delivery_id 唯一。不把“最后 ACK 序号”当作所有低序号都已 ACK |

SQL/应用双重门禁：可复用现有 deferred constraint 风格，验证成功命令需要的事件集合与最终聚合修订匹配；DELETE_MEMBER 验证 operation、墓碑、Outbox 同事务。Outbox 冲突必须核对同一事实的内容一致，不能 `ON CONFLICT DO NOTHING` 吞掉不同内容。已执行命令重放绕过重新 apply，返回原 Receipt，不再创建事件。

成员档案/外部引用/新 link 的多表写同一操作需要明确一个权威 capture 归并点，防止应用与 trigger 各发一次。对于 owner 维护的引用/目录，使用受控维护事实 ID 或触发器强制的操作上下文，不接收任意客户端 origin。初始化写入可 B；捕获启用后无权威来源的维护写应拒绝或显式进入暂停+重建流程。不能只通过 coding convention 假定所有写者永远调用 service.ts。

Outbox 本地存储失败时，启用后的相关事实事务应失败并回滚，以满足“不丢已提交事实”。外部接收器宕机只造成积压，不影响 PMS 业务提交。两者不能混称“集成永不影响业务”。

### 5.2 发布事务 T2

独立发布器：先锁某物业发布状态行，再读取该物业**已提交且未发布**的 Outbox 小批次；分配 head+1 至 head+n，构造/校验最终信封（加入 publish_seq），保存原始字节与投递待处理行，标记 Outbox 已发布，最后推进 head，整体提交。以 READ COMMITTED 短事务实施，网络完全在事务外。

同一物业不以 SKIP LOCKED 越过另一个发布事务领取的事件；多个 Worker 可先 SKIP LOCKED 选择不同物业状态行，然后严格串行发布该物业。只有已存信封才构成公开序号；Outbox 内部 ID 和 recorded_at 不作筛选下界。非法尺寸/无法序列化的待发布行保留并告警，不分配伪成功序号或静默跳过；上线前用固定有界白名单尽量把这类错误前置到 T1。

不漏事件证明（待测试验证）：

1. 业务 A 先分内部 ID 后等待，B 先提交；T2 只能看到 B，B 取得 seq=k。A 后提交仍是未发布行，下轮取得 seq>k；消费者从 k 继续会看到 A，不受 A 的旧 ID/旧 recorded_at 影响。
2. T1 在 Outbox 后、Receipt/audit 或 deferred constraint 处失败：所有业务事实和 Outbox 回滚；拒绝审计不发布。T1 已提交但响应丢失：原 command 幂等恢复，事件只有一套。
3. T2 在写信封、投递行、head 中任一步崩溃：全部回滚；重试仍只给未发布行编号。T2 提交后投递前崩溃：信封和 delivery pending 已持久化，feed 已可读，Worker 可恢复。
4. 多发布器同物业由同一行锁串行；head 和日志原子提交，读者不会看到高水位却没有相应信封。不同物业可并行，跨物业/跨聚合不承诺业务先后。
5. 投递成功但 ACK/本地状态更新丢失：用同 event_id/body 重试；新的 delivery_id 不产生新的业务身份。最坏重复传输，不丢事实。

## 6. P-04：feed、游标、基线与清理

feed 与 webhook 只能读取同一已发布日志，不能分别从当前订单重新生成事件。源事实记录时间、版本、origin 在重放中都不能改变。D-03 的字节规则与 ACK fixture 收口后实施。

游标内部建议签名不透明 token，绑定实例、物业、schema、发布 epoch 与 seq；游标签名用途与 webhook 密钥分离。服务端所有 seq/bigint 解析、比较在数据库或 BigInt 层完成，对外十进制字符串，不经 Number。每页在一致读事务取得 head/floor 和 `c < seq <= sampled_head` 的至多 100 条；只推进到实际返回末条，空页保留可继续位置。has_more 针对该页 sampled_head，不承诺未来无新事件。授权校验先于返回 cursor/实体存在状态。

清理只移走满足保留策略的**连续已发布前缀**并原子推进 floor；与读页保持快照一致。30 天为共同协议拟定最小窗口，未确认死信及未处理积压另保留，不把 floor 越过仍需保留的事件造成洞。若因旧死信阻塞清理，优先报警/扩容/处理，不能悄悄丢弃。墓碑与聚合修订的寿命独立于 30 天 feed，须能支持更久离线后的重建；事件身份/去重证据也需满足双方恢复期限。

首轮/410：Agent OS 关闭该来源自动发布 → 保存 H0 → 全状态 ID 升序扫描 → 从 H0 追赶 → 周期全量对账。PMS 列表按 `(property_id,id)` 索引、有界分页，不能复用现有按创建时间倒序的 UI 列表，也不能以 workDate/状态筛选替代全状态扫描。扫描每页一致，但不是跨页快照。

随机新 ID 可能落在 afterId 之前，扫描期间提交的新建/取消/纠正由 H0 后事件补齐；先开但晚提交事务同样由 T2 补齐。扫描中断/权限失败必须停止重建完成判定，不能按“没扫到”删除。已知缺项逐个回读有权限的墓碑。Agent OS 的“整页 Inbox durable accept 与 cursor 同事务”属于接收方实现，PMS 无法替其完成，也不能把 webhook 202 当成业务处理完成。

建议增加 `(property_id,member_id,id)` 等关联反查索引以支持 member 失效后的已知订单检查；具体索引以最小查询执行计划定，不为所有可能查询预建。Outbox feed 只能修复投递丢失，独立扫描与写路径约束仍必须保留。

## 7. P-05：最小投影映射与墓碑

映射不是新 DTO 定义；确切嵌套结构按 D-02/D-04/D-05 回写共同协议后生成合同和 TypeBox schema。

| 共同字段/概念 | 源事实与读取方式 | 限制 |
| --- | --- | --- |
| source_instance/property/order/revision/stay | 受控实例别名；orders.property_id/id/version；stays.id | 实例别名不来自请求 body；物业先鉴权；order_revision 字符串 |
| stay_status / fulfillment_state | stays.status；复用 `projectOrderLifecycle` 的状态链核验及 `fulfillmentState`（`orders.ts:1228`） | PLANNED/IN_HOUSE/COMPLETED 等与 NOT_CHECKED_IN/IN_HOUSE/CHECKED_OUT 等两组枚举分别定义；订单取消/未到/撤销不是墓碑 |
| checked_in_at / effective_at | typed fulfillment 只有 effectiveDate、recordedBusinessDate、recordedAt（`orders.ts:664`） | 两个准确业务时间字段当前均为 null；不能把 created_at、Receipt.committed_at 或日期当地零点冒充实际到店时间 |
| effective_arrangement | `projectOrderLifecycle:1347` 按 amendment/segment/payload 完整时间线与 active Claim 校验；`loadActiveStayTimeline:301` 验证在用订单逐日 Claim | 不取 currentSegment 或最大 sequence 推断当前房间。终态用 LAST/BEFORE_* 安排，不能标为当前在住。保留区间的权威版本引用，完整替换可一版本多区间 |
| 房/床/楼栋 | inventory_units.id/kind/parent_room_id/building_code/active，必要时父房引用与 II | 床位订单使用实际 BED；整房 occupant 无逐床分配，个人 bed=null。building_code 缺失保持未知，不按房号前缀猜楼栋；active=false 不把住客归到另栋 |
| occupants | 直接白名单选 order_occupants 的 id/role；left join order_occupant_removals 得 active/removed；correction 引用可用但不读正文输出 | 现有 `active_order_occupants` 只返回有效名单，不能单独提供 removed；稳定 ID 不复用。名单 active 不等于“这个人此刻已实际办理个人入住”；PMS 只有整单履约 |
| member_ref / 申请引用 | 直接使用 orders.member_id，可空；外部引用来自 members 表族。仅有 member_contract_id 的历史订单不凭合同名称推导人员 | member 是权益/关联上下文，不自动绑定 PRIMARY 或同行人。旧订单缺 member ID 保持 null；V1 不把合同日期/余额/宽泛 contract.version 放入关联版本向量。既有申请引用可列多个，Agent OS 人工确认本次申请与实际 occupant |
| related_revisions / hash | IM/II 和所有被读取关联（含父房）构成稳定排序的版本向量；稳定白名单内容 hash | 不 hash 姓名、电话、证件来替代版本；D-04 明确可变观察字段排除规则 |
| observed_at | 服务端观察时刻，按一次一致读采样 | 仅新鲜度，不是事实时间、游标或聚合版本 |

最小投影建议新建只读查询模块并以 REPEATABLE READ 读取完整一页/一个对象，沿用生命周期核验算法。不要调用现有 `getOrderView` 后把对象直接展开；其返回包含身份、计价、资金、审计和 allowedActions，允许 `READ` 的遮蔽 DTO 也不是这里的严格白名单。内部可复用验证所需源数据，但 HTTP、队列、日志、错误响应都只返回最小安全结果；完整性损坏返回安全错误码，不附 raw facts。

到期日 DUE_OUT 是尚未退房的库存安全投影，不新增住宿一晚；逾期 IN_HOUSE 只保留原历史安排和“未退”异常，不生成今天的 Claim/住宿区间。PMS 应诚实返回这种边界，Agent OS 无法证明当前安排时进待处理，不能把列表中的 clamped last position 当作住客今日真实房间；这不新增欢迎窗口业务规则。

墓碑方案：member.deleted_at 的 SQL 操作原子持久化 IM 和引用；以后同一 member 读取返回最小 tombstone。库存 active=false 返回失效当前态/同修订墓碑语义，仍保留该库存历史引用；以后合法重新 active 必须更高 II 才恢复，不把 invalidated 解释为不可逆物理删除。当前订单无业务删除入口，终态订单仍在全量扫描；不新增订单删除命令。墓碑/源实体查询必须先核对物业权限，403、超时、源损坏、分页缺项都不当失效事实。旧历史墓碑以 B 初始化，不改写旧删除审计。

## 8. P-06：固定投递、权限与恢复

完全使用共同契约 §3.4 的签名原文、header、时窗、ACK、重试与轮换表，不在本地定义第二套。202 accepted / 200 duplicate 必须核验 status、相同 event_id、有效非空 receipt_id；不只看 HTTP 成功码。源端只记录接收回执引用，不宣称欢迎成功。

未来配置分开：capture、publisher、delivery 开关；固定订阅实例/物业/HTTPS endpoint；当前/前一签名 key_id；并发、超时、退避上限、24h 死信、保留期与容量阈值。保存配置别名/版本，不把密钥放数据库业务记录、URL、文档、源代码或日志。目标不由事件或模型提供；不跟随重定向；固定 host/path 与 TLS 验证，DNS/网络出口也受部署边界控制。接收端的 64 KiB、重复 JSON 键/编码/嵌套拒绝由共享 fixture 验证；PMS 发出前也验证上限，不能截断事件。

Worker 领取投递状态时使用短事务 lease+递增 generation，发请求在事务外；状态更新 compare-and-set generation，过期 Worker 不能覆盖新持有者的结果。网络在途仍可能重复，由稳定 event_id/body 兜住。请求必须有总时限，lease 大于单次时限并可控续期；SIGTERM 停止领取、等待有界在途完成，未知结果保留待重试。

401/403 暂停受影响订阅/凭证配置并报警，保留积压；400/413/422/409 按共同表隔离且不修改原信封；429/5xx/超时/ACK 不匹配重试。转死信也保留事件；不允许因为一次后续事件成功就把更早失败标已接收。人工暂停/恢复/重放/轮换记录操作者、范围、配置版本、原因码与结果，不保存响应 body 或请求正文。重放保持 ID/bytes，只换 delivery_id、sent_at、签名；内容修正需要新权威事实事件，原事件可被新事实引用但不能被编辑。

数据库权限分离：现有 qintopia_runtime 增加有限捕获能力而不是 Worker 全表写权限；发布器只读 Outbox、写发布日志/计数器/投递状态；投递器只读信封、写尝试/状态；迁移 owner 保持独立。047 的默认新增表 SELECT 授权要显式审查/收窄，不能让 Worker 继承所有业务表读取或修改权限。READ API 凭证不授予数据库连接、PMS 命令、订阅管理或重放权限。

本轮只核对配置设计，未读环境凭证、未创建/轮换密钥、未配置 endpoint，未发送测试请求或运维消息。

## 9. P-07：记录时间、生效日期、来源

`recorded_at` 取 authority amendment/correction/operation.created_at；`appendAmendment` 使用 `greatest(transaction_timestamp(),既有最大 created_at)` 保持历史顺序（`orders.ts:2022`），并非精确 COMMIT 时间。Receipt 中 committed_at 在提交前写入，也不能宣称精确提交时刻。T2 published_at 可供内部积压指标，但不替代源 recorded_at。

仅有日期的事实，`effective_at=null`；日期仍在最小安排中。未来换房根据 effectiveDate 及物业时区形成安排区间，不暗中造具体搬家时间。普通 CHECK_IN 到达计划日后、退房日前可 LATE_RECORDED；不能以早期不变量“仅当天普通入住”的旧描述否认现行受控迟录能力。

来源映射待 D-07 入共同协议：

- L：启用后当天真实办理的创建、入住、退房、正常改期/续住/缩短/换房、当前 ADD 登记，以及纯上下文变化。L 是事件来源分类，仍不是“可以欢迎”的最终授权。
- H：CREATE_ORDER 补录、COMPLETE_STAY、普通 LATE_RECORDED 履约、历史安排/资料纠错、撤销入/退房、误录 REMOVE/会员删除、历史会员补录与重建。终止/失效事件无论 origin 都要同步并停止不适用任务；“不补历史欢迎”不等于忽略终态。
- B：上线已有状态、旧事实/墓碑初始化与影子同步。影子积压不改成 L；原事件重放保持来源。未能证明来源的历史事实不升级 L，进重建/人工处理。

启用边界不能只看 publish_seq：旧业务事务可在启用后才提交/发布。内部可在首个相关写入前取得共享捕获 epoch 门闩，启用转换持排他门闩等待旧事务结束；旧 epoch 事件固定 B，新 epoch 按真实操作分类。该锁仅在启用转换时排空在途写者，平时共享，不持有发布计数器锁。开关操作需要既有发布授权且应有有界等待；超时保持未启用。具体门闩实现和 Agent OS 激活检查点在共同协议收口后用并发测试证明，不能靠模型猜测时钟先后。

## 10. 测试与验收（本轮仅列设计）

未运行任何测试程序、数据库 setup/runner、应用启动、备份或恢复；下表全部为开发后待验证。现有测试已读用例名称/代码作为覆盖基础，未把历史通过数字当本次验证。

| 范围 | 复用测试/新增行为判据 |
| --- | --- |
| P-01 全写路径 | 以 commandTypes 的 40 项为覆盖集合，逐项关联“应发/有条件/无事件”行为。同住人/整组纠错/删除 SQL 函数/引用与库存维护分别有行为用例；不是只断言一个映射字典等于自身 |
| T07 事务 | `command-protocol.integration.test.ts`、`whole-room-companions.contract.test.ts`、`admin-historical-stay-corrections.integration.test.ts`、`admin-membership-corrections.integration.test.ts`：apply 后、Outbox 后、Receipt/audit/deferred constraint 失败，业务与事件全部回滚；Preview、拒绝、quote 0 事件；同键重放一套事件；多订单 correctionSet 整体回滚 |
| T08 发布并发 | 双连接屏障：A 先分 ID 不提交，B 提交发布、cursor durable 后 A 再提交；必须还能读到 A。T2 各中断点、两个 publisher 同物业/跨物业、全批次失败和 restart 检查 head/log 无洞/无重编号 |
| T09 双路/ACK | 本地接收器模拟 202/200、ACK 丢失、错 event_id/空 receipt_id、同 ID 不同 bytes、push/pull 同时；共享 UTF-8/Unicode/escape fixtures。PMS 验证保持原 ID/body，Agent OS 验证单 Inbox/效果 |
| T10 签名/授权 | 标准 HMAC fixture、时钟偏差、key_id 范围、旧 body 新 sent_at 合法重放、双 key 重叠/撤旧；跨物业、撤权、Token 到期/只读不能写。禁止 redirect/任意目标/超限 body；不调用真实接收方 |
| T11 feed/基线 | 空库、seq>2^53、页末重复、篡改/未来/错物业 cursor、floor 等于/小于、读取与清理并发；扫描中随机低 ID 新建/取消/删除/晚提交、页中断、403/源损坏；重建可收敛且未完整时不推断删除 |
| 投影/版本 | `stay-date-changes.integration.test.ts`、`move-unit-stage11.integration.test.ts`、`checkout-reversal.integration.test.ts`、`stay-date-change-lifecycle-corruption.integration.test.ts`：多房段/完整恢复/终态 LAST/当前与未来；跨午夜同版本 stable hash 不变；member/父房 revision 变化使向量变化；同名、多 occupant、removed 再 ADD、未知床位保持未知 |
| 时间/来源 | 两类 CREATE_ORDER 补录、COMPLETE_STAY、迟录 CHECK_IN/CHECK_OUT、同日普通办理、未来换房、生效日重评、管理员恢复；复合事务共享最终 V；启用边界旧事务晚提交保持 B/H；重放不改 origin |
| 权限/SQL 旁路 | `runtime-database-role.integration.test.ts`、`runtime-database-isolation.contract.test.ts`、账号/删除及 `resource-scope-token-lock.integration.test.ts`：运行角色不能篡改版本/信封/墓碑，删除函数事务不能漏 Outbox，维护无来源不得绕捕获；凭证/身份字段不出 HTTP 或结构化错误 |
| 运行恢复 | 24h 接收器不可用、15min 封顶退避、429 Retry-After 有界、403 暂停/修复、死信重放、多投递器 lease/fence、SIGTERM、T16 影子/回滚；保留窗口与容量报警，不因外部故障阻断原业务事务 |
| 现有契约/发布 | `openapi.contract.test.ts`、`command-effects.contract.test.ts`、`agent-core-journey.contract.test.ts`、`backup-script.contract.test.ts`、`restore-script.contract.test.ts`、`api-runtime-startup.integration.test.ts`；原响应保持兼容，新白名单严格序列化；readiness 验证新索引/函数/约束/权限 |

后续执行入口：`npm run verify` 仅 typecheck+unit，不包含数据库验证；数据库用现有 `npm run test:integration`、`npm run test:contract` 及 lock runner 的受支持范围；必要 E2E 同样走 runner。不得直接绕锁运行数据库 vitest、不得默认读 `.env` 指向的数据库就是隔离库。所有合成 fixture 明确使用新隔离库与 loopback 接收器；部署文件测试只静态检查，发布演练另经授权。

未来人工验收可分三组并回写主计划对应增量段：① P1 同事务/重放/晚提交；② P2 最小投影/删除墓碑/基线收敛；③ P3/P4 断网恢复/暂停重放/影子启用回滚。每组先自动检查，通过后才请求人工验收；本轮状态全为“未开始”。

## 11. P-08：发布、容量与回滚方案

现有承载：Node 22/TS 模块化单体、Fastify、Kysely/PostgreSQL；`apps/api/src/runtime-startup.ts:41` 启动前强制数据库 readiness；`compose.server.yaml` 当前仅 app 服务，没有 Worker；`compose.yaml` 有 migrate/seed/reference-import/app 分离。`migrate.ts` 区分 owner/runtime；backup 使用 pg_dump，restore 明确只恢复新库并验证迁移/readiness。本次只读这些源码结构，没有运行它们。

未来阶段（均非本轮授权）：

1. 协议 D 项与同一套合成 fixtures 收口；只读核对目标应用/迁移/权限及是否存在仓外写者，不能把本地 057 等同生产。
2. 经发布流程增加兼容结构/约束/权限/readiness，部署具备捕获的应用；publisher/delivery/Agent OS 自动副作用默认关闭。捕获 B 基线、成员/库存修订及旧删除墓碑，不重写旧业务事实。混用旧写者期间不宣称事件完备。
3. 固定隔离接收器故障验收，测试开关与 Worker 状态、备份恢复。生产只读影子按共同协议进入隔离模拟控制面，不写 live Person/任务、无欢迎/上传/审批发送。
4. 取得对应发布/试点授权后，按物业切换捕获 epoch，记录 H0、扫描和追赶完成，核对无未解释漏路径/版本差异，再激活投递及接收消费。发历史 backlog 只同步，不因启用转成实时欢迎。

指标仅保留计数/时间/错误码/受控引用：未发布数量与最老年龄、publish lag、head/floor、每订阅 pending/retry/dead-letter/paused、ACK 延迟、失败分类、租约冲突、feed 页大小/过期、扫描差异数与完成时间、白名单序列化拒绝。不要采集完整信封/响应/业务日志，更不采集身份正文。

容量以实测日事件数 E、平均信封 B 字节、保留天数 R 估计日志约 E×B×R，再加 Outbox/投递尝试/索引/WAL/备份和死信余量；不能把 64 KiB 上限误当平均值。以合成高峰、24h 积压恢复和限流压测确定 Worker 并发/批量/HTTP 时限。未确认死信不清理；超容量先报警/停投递非必要重试，不能停止持久捕获却继续承诺可靠事件。若需暂停捕获，必须同时停止自动消费准入、记录缺口并完整重建。

回滚优先操作开关：停新投递/接收副作用，停领取并核对在途请求；保留 Outbox、发布序号、墓碑、投递/死信。PMS 住宿业务继续，网络恢复后原 event_id 重放；不撤回住宿、不修改历史 body、不删除队列。新旧投递器切换用单执行 epoch/租约，不能另生成新 ID 表达同一事实。

仅回退到“不懂捕获”的旧应用可能造成新业务写入不再产事件，且旧 readiness 可能拒绝新增结构：必须保留捕获兼容版本/数据库门禁，或关闭自动消费并按缺口重建，不能宣传裸镜像回滚无损。数据库灾备恢复可能令 head 倒退/重复 publish_seq，须隔离新恢复库，核对已发送事件和接收方 checkpoint；换 cursor epoch 强制重建并保持仍可恢复的 event_id，必要的 source_instance 变更由共同恢复流程明确，不能自动换实例别名以绕过去重。保留源数据备份不等于已恢复外部投递一致性。

## 12. P1–P4 文件范围、修订工作量与停止点

文件名仅表示未来拟新增模块类别，不在本轮创建。既有业务规格直接复用；事件增量据本核对收口后加入现有实施规格/主验收计划，不重复写整份产品方案。

| 切片 | 未来文件范围 | 工作量（含该切片自动测试，不含生产部署等待） |
| --- | --- | --- |
| C0 差异收口 | 唯一共同契约由其维护方更新；PMS 仅维护本核对和后续共同 fixture 引用 | 0.5–1 人日；D-01 至 D-07 精确契约/编码/错误边界收口 |
| P1 事务事件基础 | `packages/db/src/commands/service.ts`、apply/companions/member-corrections 的效果提取；会员删除受控函数后续增量迁移；schema、事件捕获/修订模块、database/readiness；不得改旧迁移文件冒充增量 | 4–6 人日；完整 40 命令覆盖、多订单/多事实、会员/库存版本、维护入口、T1/T2 并发与约束 |
| P2 feed/最小投影 | `apps/api/src/server.ts`、`schemas.ts`、`packages/contracts/src/`；新的 integration query/feed 模块，复用 orders 生命周期；相关索引/墓碑读取；原 order-list 保持语义 | 3–5 人日；含 D-02 成员/库存回读与 D-04 版本/hash、游标/清理/扫描并发 |
| P3 固定 webhook | 新后台入口/投递与租约模块、持久尝试状态、配置校验；`apps/api` 或独立 worker 子入口；不把 HTTP 放 service.ts | 2–3 人日；签名、ACK、暂停/死信/轮换/重放与故障注入，共用 P1 日志，避免重复实现 |
| P4 运行与发布准备 | package scripts、Compose/容器启动、readiness、备份恢复测试、现有 release/runbook/主验收计划的增量段 | 2–3 人日；隔离恢复、容量与开关验收，不自动部署 |

PMS 工程合计 **11–17 人日**，加 C0 约 **11.5–18 人日**；双方联合故障验收另计约 **1–2 人日**。较交接原粗估需要显式计入 SQL 删除旁路、维护路径版本、实体回读/墓碑、编码及恢复边界；发布日志共用已去除 feed/webhook 重复存储与序号实现的重复估算。若另要求 endpoint 级 READ ceiling，D-08 安全切片再估约 1–2 人日；不默认纳入。实际吞吐/上线环境未测，以上是有范围的工程估计，不是工期承诺。

当前阻塞只针对未来实施：共同协议的 D 项未收口会阻塞相应 DTO/事件编码；未收到“开始开发”阻止全部开发；目标版本/凭证范围/容量未验阻止生产激活。没有把完整客房 Agent、真实住客群或真实欢迎发送列为 PMS 接口开发前置条件。

本轮交付边界：仅此 PMS 核对文档；文档引用、命令覆盖和格式做静态核验。没有代码、迁移、PMS/数据库写入、生产配置变更、凭证产物或外部消息。文档完成即停止，等待用户明确“开始开发”。

## 13. 本地实施记录（2026-09-09；覆盖上文的“未开发”状态）

### 13.1 实现与共同契约

用户已明确“开始开发”。P1/P2/P3 已实现本地代码，P4 已完成默认关闭的 Worker 入口、readiness、运行说明及本地验证；工程检查与人工/联合验收分开记录。没有提交、推送、部署或真实外部调用。共同契约第 10/11 节已采纳 D-01 至 D-08，本仓仅实现其字段，不再维护第二份协议。列表包装确认采用 `schema_version/source_instance/property_id/orders/next_after_id/has_more`：空页保留入参位置或 null，非末页推进。

| 范围 | 最终落点与实现 |
| --- | --- |
| P1 / T1 | `packages/db/src/migrations/058_integration_events.sql`：对 amendments 延迟捕获，提交时读取 APPLIED + business_committed Receipt 与最终 order.version；复合事务每条 amendment 保留独立事实引用和同一最终修订。成员、物业链接、外部引用、库存变更同事务维护修订；会员删除从既有 member_deletions.operation_id 取权威根 |
| 来源归属 | 正常命令沿用共同事件类型；迟录、补录、撤销、管理员纠错、同住人 REMOVE 为 historical_correction；基线只生成 baseline。仅 owner 的 baseline 导入可承接既有 APPLIED、无完整 Receipt 的历史图；实时命令仍须 Receipt，不把历史导入升级 live |
| 维护根 | owner 的实时成员/库存维护需 `qintopia.integration_maintenance_ref`，只接受 baseline/migration 的受控不透明引用；同一引用仅能属于一个数据库事务。基线无显式引用时生成 epoch + transaction ID。没有给 runtime 增加库存、资料或外部引用写权限 |
| 切换捕获 | 相关写表在语句开始取得共享事务门闩；configure 使用 **try-exclusive**。存在旧写事务时立即返回 `55P03 / INTEGRATION_CAPTURE_BUSY`、保持原模式，由控制方待旧写者排空后重试；不排队占用排他锁，避免“业务行锁 → 共享门闩 → 排队控制锁”的循环。成功切换后才改变 epoch，旧事务的 baseline 来源不变 |
| P1 / T2 | 独立发布函数按物业锁 head，每批最多 100 条；仅查询 `publish_seq IS NULL` 的部分索引。Outbox 业务字段不可变，内部 publish_seq 只允许从 null 追加一次；同事务存不可变 JSON 正文/hash、delivery 与 head。该标记长期保留，清理正文后不会再次发布，空队列查询也不扫描全部历史 |
| P2 | `packages/db/src/integration-queries.ts`、`apps/api/src/integration.ts`、`packages/contracts/src/pms-integration.ts`：新增 5 个 GET 路径。单对象/整页 REPEATABLE READ；订单复用既有生命周期验证后逐字段组装白名单；removed 名单保留，成员/库存墓碑返回明确 200 union；未知/无权限不推断删除 |
| 版本与 hash | 订单、成员/库存修订统一输出十进制字符串；父房及全部安排库存进入 related_revisions。JCS 无数字子集按 UTF-16 排序，排除 observed_at/hash/read_context；相同营业日语义由共同契约消费方重评。Agent OS 的独立 Python hash 合成 fixture 已只读复制到测试目录，固定 hash 一致 |
| 游标 | 绑定 schema/source/property 的认证不透明位置，使用 bigint 比较；不自造时间高水位。每页嵌入数据库保存的 JSON 事件原片段；同一 body 供 webhook 与 pull。等于 floor 有效、低于 floor 为 410，错物业为 403，篡改/无效/未来位置为 400 |
| P3 | `integration-worker.ts`：固定 HTTPS/path、证书验证、不跟随重定向；签名原始 body；核验 ACK 状态/event_id/receipt_id。401/403 暂停，契约错误/冲突隔离，未知结果原 ID/body 重试；退避封顶 15 分钟，持续失败 24 小时进入死信。短事务 lease/generation、网络在事务外，过期 Worker 不能确认新一代投递 |
| 清理/恢复 | 仅清理已确认且超过 30 天的**连续前缀**；待确认/死信阻挡 floor 推进，正文不丢。owner 可暂停/恢复/按 event_id 重放，记录操作/配置版本/原因码；重放不改 body/event_id。Outbox 与发布标记、控制/投递审计不被正文清理删除 |
| 权限/启动 | runtime 新增只读表权限；Worker 独立角色默认 NOLOGIN，只读发布/投递状态并执行有限发布、清理、汇总函数，不能读业务人员表。readiness 校验新增表列/约束/索引/触发器/函数指纹和表级、列级权限。Worker 默认完全关闭；启用后验证专用数据库身份，连接/SQL 等待有界，SIGTERM 停止领取 |

按用户决定复用单物业 READ，不新增 endpoint ceiling。该凭证仍可访问现有获准的详情读取接口；“客户端只用最小投影”并不表示凭证被技术限制为只能读这些接口。未来增加字段时优先修改此白名单和唯一共同契约，只有出现明确的不同接入方/不同可见范围时才追加权限能力。

### 13.2 本地验证证据

所有数据库操作仅发生在本任务新建容器 `green-pms-events-test-20260909` 的 `127.0.0.1:55440`；各测试库为合成数据，数据库测试全部经过既有 lock runner。未访问 55432/55433 既有库，也未修改 Agent OS 的 55439 容器。运行日志未保存为交付物；文档只留结果、数量和错误类别。

- `npm run verify`：TypeScript 与 Unit 全套通过（最终 1131 项）；其中共享 hash、HMAC、ACK/重试分类、固定目标、拒绝重定向和 ACK 大小上限有独立用例。
- `tests/integration/integration-events.integration.test.ts`：23 项通过。覆盖默认未配置、业务/发布回滚、幂等重放、最小 HTTP 读权限、removed、库存恢复、会员 SQL 删除墓碑、晚提交/双发布器、原字节分页、切换边界、Worker 身份/租约、列权限漂移、>2^53 游标、清理/410、跨日未来 MOVE、历史复合最终版本、死信重放，以及独立受限 Worker 启动/SIGTERM 退出。
- 既有 8 组命令/住宿/会员/删除回归共 307 项已通过，采用启用 baseline 捕获的合成库；另 39 项 OpenAPI、启动、备份/恢复脚本契约通过。按失败范围定向修复/复测，没有把第一轮失败冒称通过。历史纠错夹具使用的旧 FLAT_NIGHTLY 政策在运行日期跨月时失败；关闭捕获也复现，现改用已批准的 2026 政策，40 项整组复测通过。恢复测试仍固定 52 个迁移，已更新为当前 58 个并验证新增迁移末项。基线 owner 无 Receipt 的合法历史图兼容问题修复后定向通过。
- `npm run build` 与 release 元数据检查通过。`npm run integration:worker` 在三个开关关闭时直接返回 `INTEGRATION_DISABLED`，不连接数据库、不请求网络。
- 上述为**本地自动验证**，不是生产部署、真实双端联合运行、真人手工验收或生产容量结论。未实现 Person/Inbox/欢迎/群路由，这些仍属于 Agent OS。

### 13.3 发布准备与回滚步骤（待另行发布授权）

1. 确认目标 PostgreSQL/应用基线、仓外维护写者与备份恢复能力；迁移 058 按现有 owner 迁移流程应用，不执行 seed/reset。应用必须包含相应 readiness；旧应用的严格迁移清单可能拒绝新增迁移，不能只回退旧镜像。
2. 新 Worker 使用现有应用镜像中的 `npm run integration:worker` 入口，作为独立进程/容器运行，不放入 API 请求事务。本次不修改 compose.server.yaml、生产环境文件或任何真实订阅配置。按部署机制为 `qintopia_integration_worker` 设置登录能力及安全连接凭证，不能借用业务 runtime/迁移 owner 连接。
3. 保持三个进程开关关闭，owner 配置 source 为 baseline；有在途写者时保留原模式并稍后重试。初次配置建立已存在成员/库存修订和所有物业 head；历史订单通过全状态扫描建基线。维护操作提供唯一事实引用，不暂停捕获触发器绕写。
4. 可单独开启 publisher 形成可对账日志，保持 delivery 暂停、Agent OS 自动副作用关闭；记录 head、完成全状态扫描并追赶 feed，检查物业范围、墓碑、版本向量、写路径覆盖和未发布积压。
5. 双方在隔离接收器联合验证 raw JSON、签名、ACK 丢失/重放、权限撤销、时钟、限流、游标失效/重建；生产接收 URL、TLS、密钥当前/前一 ID 重叠由真实部署验证。本仓已做共享 fixture 和注入传输验证，**未调用真实接收器**。
6. 经试点发布授权，排空旧写者后 configure 为 live。owner 使用受控 control 的 RESUME 激活订阅；配置版本与原因码入审计。只对正式边界后的合格 live 事实开放消费，baseline/historical 积压始终只同步。PMS 不决定欢迎许可。
7. 回滚先 PAUSE 订阅并关闭 delivery 开关，SIGTERM 停止新领取，核对在途请求；保留捕获、Outbox、发布序号/正文、修订/墓碑、死信。恢复时沿原 event_id/body 重放。不能删除队列或改历史 origin，也不能为绕过去重自动更换 source_instance。
8. 灾备恢复先在新隔离目标库完成恢复，保持 delivery 与 Agent OS 自动副作用关闭；核对已发送事件及接收 checkpoint。发现 head 倒退、备份后事实缺口或 cursor epoch 变化时先重建并人工确认；数据库恢复成功不等于外部投递一致性恢复。真实恢复演练仍为发布前待验。

### 13.4 配置、容量与验收状态

配置名（不含任何实际值/凭证）：

| 配置/控制 | 默认与含义 |
| --- | --- |
| PMS_INTEGRATION_PUBLISH_ENABLED / DELIVERY_ENABLED / PRUNE_ENABLED | 均为 false；分别启用发布、投递、保留期清理 |
| PMS_INTEGRATION_WORKER_DATABASE_URL | 专用 Worker 连接，通过安全部署机制注入；不写入源码、文档或日志 |
| PMS_INTEGRATION_SOURCE_INSTANCE / PROPERTY_IDS | 受控实例别名及订阅物业集合，与源配置一致 |
| PMS_INTEGRATION_ENDPOINT / KEY_ID / SIGNING_KEY | 固定 HTTPS 接收路径、当前签名 key ID、密钥；仅 delivery 开启时需要，READ Token 独立 |
| qintopia_integration_configure | owner-only；baseline/live 与 epoch，不启用网络；忙时保持原状态 |
| qintopia_integration_control | owner-only；PAUSE/RESUME/REPLAY，带配置版本、原因码；Replay 指定 retained event_id |
| qintopia_integration_status | 有限汇总函数；未发布数/最老时间、pending/sending/dead letter、paused、head/floor，无业务正文 |

V1 每 Worker 一条在途请求，HTTP 总时限 10 秒、租约 30 秒，数据库连接 10 秒/单 SQL 15 秒上限；发布一批 100，空闲节拍 1 秒，状态计数每 60 秒输出。部署需将 dead_letters、paused、未发布最老时间及连续进程失败接入既有监控；本次不创建外部告警或消息。

30 天只是已确认事件正文的最小保留期。**Outbox 源引用/一次发布标记、维护根及审计长期保留，会随事件量增长**；当前不实现长期归档删除。未确认/死信也继续保留，不能拿 30 天估算全部磁盘上限。上线前用真实规模的合成压测核验吞吐、24 小时积压追赶、100 条投影页延迟、数据库/WAL/备份增长及报警阈值；现有本地测试不是生产容量承诺。实际高峰需要时可增加 Worker 数量，仍由数据库租约与接收方幂等约束。

人工验收仍见主计划新增 P1/P2/P3/P4 三组检查点，均未冒记通过。当前不需要新增业务判断；下一阶段是双方联合验收与试点发布授权。未收到发布授权前保持本地交付状态。

### 13.5 双方源码与 fixture 最终兼容回传

2026-09-09 收到 Agent OS 协作更新后，只读复核共同契约第 11 节与当前 PMS 路由、scanPmsOrders/feed 实现；本次未修改代码、共同契约或兄弟仓库。

- **接口兼容**：扫描列表六字段、order_id 升序、空页位置与非末页推进规则一致；订单/成员/库存投影和墓碑沿用第 11 节。事件类型、字符串 source_fact_ref、版本向量、营业日/read_context、原字节 feed 与游标边界沿用第 10/11 节；当前未发现需要新增或调整共同条款的差异。共同文件第 10 节仍有旧“等待 DTO”等进度文字，技术定义以已收口的第 11 节为准，状态维护仍由共同文件维护方处理。
- **fixture 兼容**：双方 order-projection.json 的 JSON 内容完全相同，独立重算得到同一 projection_hash：`b46f00b6121e9f6bda068dcbef5b7219c4f35dee0b07d82b21d46c6a1cc79399`。本轮复跑 PMS hash 测试 2 项通过。两份文件仅空白排版不同，原始文件字节并非相同；不改 fixture，也不把此投影规范 hash 结论外推为 webhook 事件原字节已联合验收。
- **待联合验收**：真实运行的两个本地进程之间仍需验证 push/pull 并发去重、原始事件字节/HMAC/ACK 丢失、逐 scope 隔离、分页持久化与重建代次/CAS、重建禁发、同向量冲突持久隔离、晚提交与 410 重建、墓碑/跨日安排收敛。Agent OS 新增 Worker/重建能力为对方回传进展，本轮未独立执行其测试或验证运行效果。
- **生产边界**：真实 HTTPS/TLS、凭证范围与轮换、吞吐/24 小时积压、切换及灾备恢复仍待验证；完成联合验收并获得试点发布授权前，不启用真实源读取、网络投递或欢迎副作用。本轮只回传兼容结果，未启动联调。

回传渠道状态：尝试向来源 Agent OS 任务发送上述兼容摘要时，自动审批以既有“禁止外部消息”约束及目标披露授权不足拒绝；消息未发送。结果保留在本 PMS 文档及当前任务回复中，没有绕过拒绝或采用其他发送渠道。

## 14. 2026-09-11 固定版本双程序联合验收

用户已明确授权交接文件 §1—2、§4 B，包含隔离合成写入和与 Agent OS 实现任务交换技术交接；本轮按新授权正常回传，没有复用此前被拒绝的发送授权假设。

**19项本地双端联合验收通过**。PMS 固定起点为 `4b598c61fc5af04ee9c5951f4f09d6ab409bf55f`，在独立 `codex/pms-agentos-joint-acceptance-20260911` 工作区修复新安装readiness及HTTP410错误序列化。Agent OS使用实现责任方交付的v2冻结清单（152文件），只在B的隔离副本构建运行；未修改其源码或共同协议。两端真实程序在专用合成55442/55443数据库和固定loopback端口互通。

最终Node22运行已证明原字节/HMAC/ACK、重复/乱序、push/pull并发、ACK丢失、断网重启、scope隔离、分页CAS/重建代次、冲突隔离、410、墓碑、跨日与历史/重建禁发。既有事件专项23项、Unit1135项、类型和构建通过；其余专项及失败修复过程见[完整联合验收记录](./PMS-AgentOS-事件联合验收-20260911.md)。可复跑工具在 `tests/joint/`，机器证据在 `docs/implementation/evidence/pms-agentos-joint-20260911/`。

以上覆盖第13节历史“未进行双端联调”的状态，不覆盖生产网络、真实账号、规模压测、灾备恢复及完整欢迎流程。Agent OS责任任务确认v2可供B收口；A工作台最终共享构建/迁移变化另交冻结版回归。没有部署、生产写入或真实欢迎发送。
