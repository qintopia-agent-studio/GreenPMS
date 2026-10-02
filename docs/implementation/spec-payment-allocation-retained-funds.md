---
title: 多订单收退款分配与客户留存款
created: 2026-10-02
status: implemented-pending-human-acceptance
route: dispatch
baseline_commit: 9b152e119c84ec435a0c39cb76eb5ab358f0e01c
---

# 多订单收退款分配与客户留存款

## 已确认目标（用户已批准）
同物业一笔企业微信收款按金额分配多张住宿订单；支持合并退款分配、取消一间后部分退款、受控撤销分配、客户留存清单和再次使用。复用订单页面，不新增独立台账；不扩展会员、银行、渠道结算和充值钱包。客户款允许代订，但必须核实归属并记录授权。子代理按最新用户指令使用 gpt-6.1-sol / medium，文件写集互斥（此前已完成切片使用 gpt-6-astra / low）。仅开发至本地人工验收和 PR，不部署生产。

## 不变量
- 原始流水不拆分、不覆盖；金额整数分。分配/资金事实/审计在一个 Preview/Confirm 事务提交，锁顺序确定，确认重算、幂等重放。
- 原始现金与内部归属分开：ALLOCATE 对应订单 COLLECTION/REFUND；内部转移用 REALLOCATION_OUT/IN，金额相等、同命令原子提交，不增加现金收入。
- 取消 B 后：A400+B600 的实收仍1000；B显示已取消已收未退600，不自动释放余额、不自动退款。
- 退款始终引用同订单 COLLECTION 或 REALLOCATION_IN 份额，校验原始交易；真实退款不释放可分配收款。未完成归属的成功退款冻结来源的新增使用与释放。
- 留存只从已取消/未到/已退房普通直接订单的经核实多余企微资金产生。保留 source fact、bill、客户姓名、联系方式/核验依据、确认说明、操作人及时间。不能以同名/昵称推断所有权。
- 留存是现有订单款项的预留，不新增现金。source剩余=份额-有效退款-转出；预留余额=留存金额-USE/REFUND/RELEASE。登记、普通退款、转出、撤销不能重复花费预留。
- 使用留存时源订单 OUT、目标订单 IN 和USE条目一事务提交。源归属和原始流水保持可追溯；允许客户授权代订。目标取消可退款或再次留存，不能恢复上游已用余额。
- 误标留存可解除未使用部分，回到源订单待处理而非公共可分配；已使用部分不可直接抹掉。
- 收款分配仅在无退款、留存、转会员、待核对退款占用时可显式撤销；普通冲销不自动释放。拆分或内部划转来源禁止转会员。
- 旧匹配保留并全额映射，不新增收款、不发迁移通知、不释放历史冲销占用；会员仍整笔独占。
- 新功能默认关闭（PMS_PAYMENT_ALLOCATION_ENABLED=true 才可用），旧接口保持整笔语义。启用生产前须消费方兼容；CI/生产配置不变。

## 协调接口与写集
主模型：contracts、API、TS资金业务/命令集成、测试集成与验收。
数据库子代理：069迁移（068为另一任务预留）、schema.ts、database.ts、external-payments-readiness.ts、wecom-refund-readiness.ts、新schema专项测试。
前端子代理：apps/web/src 下文件与前端测试，不改其他目录。

### SQL 契约
- external_payment_allocations(id text PK,bill_id FK,collection_fact_id UNIQUE FK,amount_minor int,command_id nullable FK,origin CONFIRMED/HISTORICAL_LINK,created_at)
- external_payment_allocation_releases(id PK,allocation_id UNIQUE FK,reversal_fact_id FK,command_id FK,created_at)
- retained_funds(id PK,property_id FK,source_order_id FK,source_fact_id FK,bill_id FK,owner_name,owner_contact,confirmation_note,amount_minor,command_id FK,created_at)
- retained_fund_entries(id PK,retained_fund_id FK,kind USE/REFUND/RELEASE,amount_minor,target_order_id nullable FK,source_out_fact_id nullable FK,target_in_fact_id nullable FK,refund_fact_id nullable FK,authorization_note,command_id FK,created_at)
- collection_facts.external_payment_bill_id nullable FK；REALLOCATION_IN/OUT.references_fact_id 指源资金份额；OUT和IN用command_id配对。
- append-only、shape/额度/权限/原子对称由数据库再防线；READINESS仅接受已核验结构。

### API / command 契约
GET /api/v2/external-payments 使用原查询参数，返回旧基本字段 + allocatedMinor,remainingMinor,allocations[]，状态新增 PARTIALLY_MATCHED。新方法独立于旧v1。
GET /api/v2/retained-funds?propertyId&query&orderId&status=AVAILABLE|ALL&limit&beforeId，返回 {enabled,items,hasMore,nextBeforeId}。
retained item: id,propertyId,sourceOrderId,sourceFactId,billId,ownerName,ownerContact,confirmationNote,amountMinor,usedMinor,refundedMinor,releasedMinor,remainingMinor,createdAt。
RECORD_COLLECTION/REFUND 增加 externalPaymentBillId；原 amountMinor 为本次份额，退款保留 referencesFactId。
REVERSE_FACT 增加 releaseExternalPaymentAllocation?:boolean。
RETAIN_ORDER_FUNDS: propertyId,orderId,sourceFactId,amountMinor,ownerName,ownerContact,confirmationNote。
APPLY_RETAINED_FUNDS: propertyId,orderId（目标）,retainedFundId,amountMinor,authorizationNote。
RELEASE_RETAINED_FUNDS: propertyId,orderId（来源）,retainedFundId,amountMinor,note。
REFUND_RETAINED_FUNDS: propertyId,orderId（来源）,retainedFundId,amountMinor,externalPaymentBillId,refundReference,note。
所有命令走原preview/confirm；新能力不能自动加给旧token。

## Tasks & Acceptance
- [x] 数据库迁移/guards/readiness：Given旧匹配 When升级 Then业务净额不变、非法写入失败。
- [x] 分配/退款：Given1000 When分A400/B600并取消B再退600 ThenA400、B净0、现金净400、可分配0。
- [x] 更正：Given未占用分配 When显式撤销并重分 Then历史保留，重复/占用撤销失败。
- [x] 留存：GivenB600 When留存600、代订C400 Then留存200、现金不增加；退/再用200后归零。
- [x] 查询/UI：Given客户有留存 When订单列表筛选/新订单搜索 Then可查可追溯、仅授权使用。
- [x] 事件v2：Given部分分配/撤销/留存变化 When投递 Then不误报全部匹配、重复乱序安全；旧v1不改变。
- [x] 资金与权限：Given并发/重复/陈旧预览/跨物业/越权 When确认 Then零超额、零部分写入。
- [x] 相关自动验证：typecheck/unit/资金与权限integration/新增contract/e2e/build及PR格式通过，CI原样；全量数据库回归非全绿，见下方限制。
- [x] 本地人工验收数据、URL、说明、截图已准备；功能分支通过 PR 交付，状态待人工验收。

## 验收与回退
独立本地库模拟企业微信，不真实付款/退款，不读生产凭据。生产启用另走正式授权；有新事实后不可回退到旧一对一应用，关闭新写能力保留数据再修复。外部消费方适配与人工验收单列未完成状态。

## 事件兼容与运行配置
- 新查询 `GET /api/v2/external-payment-events/head` 与 `GET /api/v2/external-payment-events` 返回 `pms.payments.v2`；游标与版本使用十进制字符串，按已提交顺序读取。事件携带状态引用，消费方回读 v2 流水确认当前分配/留存状态，不能把部分分配视为整笔结清。
- 推送默认仍为 `pms.payments.v1`，既有持久化事件字节不重写。仅显式设置 `PMS_PAYMENT_DELIVERY_SCHEMA_VERSION=pms.payments.v2` 才选择新投递队列；须使用独立 `qintopia_allocation_delivery_worker` 身份及既有 endpoint/property/key 配置。未配置或未启用不会自动推送；本任务未配置真实外部接收方。
- `PMS_PAYMENT_ALLOCATION_ENABLED` 只控制新写入口。关闭后仍保留历史查询、占用与审计，不把已有留存释放为公共余额。
- 新迁移编号为 069/070，保留现有 068 空位约定；不修改 CI、发布入口或真实数据库。

## 工程验证记录（2026-10-02，待人工验收）
- 独立 PostgreSQL 18 / 55439 合成库：分配、留存、SQL 守卫专项 45 项通过；事件专项 13 项通过；最终同步/确认屏障并发 2 项通过（此前连续 5 轮 10 项通过）；旧外部流水/事件投递 25 项通过；权限矩阵 24 项通过；修复后的三份契约测试 41 项通过。
- 浏览器桌面与手机各完整跑通一条合付→取消未退→留存→授权代订→登记模拟退款→历史查询链路（2/2）。实际收款合计1000、内部转移400、退款200，最终 A400/B0/C400；原收款可分配额0。
- 全量数据库回归曾运行67套件（992通过/24失败/11跳过），运行期间有代码修复，**该数字不是最终失败数，也不代表全绿**。已修复的新功能问题均按影响范围复跑；完整分诊留存于忽略目录 `.local-workspace/payment-allocation/regression-current-handoff.log`。
- 剩余非本次功能问题：旧会员退款fixture缺退款单号；历史迁移fixture和当前查询不兼容；跨月日期fixture触发既有价格规则；临时其他房并发测试只观察advisory而实际等待transactionid；部分套件硬编码55432，本机测试端口为55439。未更改安全门禁或放宽断言规避这些问题。
- 本地使用 Node24，仓库指定 Node22 的 CI 结果单独记录；不将本地证据替代远端 CI 或人工验收。

### 最终补充验证
- TypeScript、1350项单元测试、生产构建/release:check、8项PR格式检查通过。发布harness在本地Python3.12虚拟环境下120项通过（系统Python3.9不满足原安装器要求，未修改安装器或测试门禁）。
- 最新069包含迁移后历史匹配退款冲销守卫；SQL专项26项通过，包含去掉守卫的失败对照及旧冲销迁移兼容。58项资金/留存/SQL/事件检查通过；同步竞态首次被本地runner附加数据库名后缀触发隔离保护而未执行，修正仅忽略目录中的映射后2/2通过。
- 本地清理工具补齐显式FK闭包，10项适用集成测试通过、4项固定55432入口未执行。房型当前配置、报价、外部原始流水及v1/v2事件投递正文保留；经营目录修改历史随命令审计清空，不使用CASCADE。
- 最后重建独立合成验收库，runtime身份启动且`/health/ready`返回ready，桌面/手机完整链路再次2/2通过；手机留存金额和归属客户在同一屏可读。人工一/人工二两组保留未操作。
