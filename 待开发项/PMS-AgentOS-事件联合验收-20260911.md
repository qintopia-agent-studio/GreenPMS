# PMS 与 Agent OS 事件联合验收

状态：v2 固定版本双程序合成联合验收 **19/19 通过**；A 最终冻结版共享构建/迁移限定回归 **4/4 通过**；未部署、未启用真实投递或欢迎。用户于 2026-09-11 授权执行交接文件 §1—2、§4 B。

## 范围与固定基线

- PMS：`4b598c61fc5af04ee9c5951f4f09d6ab409bf55f`（1.3.2），独立分支 `codex/pms-agentos-joint-acceptance-20260911`，工作区 `/private/tmp/green-pms-joint-20260911`。
- Agent OS：由“实现统一人员与欢迎 V1”交付 v2（源 HEAD `2815ab46f2cc0efb3e34cda56f6242bb9af5abf0` 加其确认归属的未提交文件清单）。B 逐项核验152文件后复制到 `/private/tmp/green-pms-joint-agentos-20260911-v2` 离线构建，运行后再次核验源码未变。
- 唯一协议仍为兄弟仓库 `docs/plans/active/unified-person-welcome-v1-contract.md`，重点 §10—11。本文件不定义新协议。
- 只修改 PMS；接收端缺陷由 Agent OS 实现任务修复并交固定版复测。
- 专用合成 PostgreSQL：PMS `127.0.0.1:55442/qintopia_joint_test`；Agent OS `127.0.0.1:55443/qintopia_test`。容器均带本任务标签；重置前核对标签、端口及现有连接。
- 不读写真实 PMS、生产配置、Base、Workflow、Hermes；不连接外部适配器。签名材料运行时生成，仅在进程内传递；报告只保留状态、计数、代码及合成引用。

## 验收与工具设计

复用真实 PMS API、事务命令、Outbox、投递 Worker 和 Agent OS ingress/Store/recovery。测试工具放在 `tests/joint/`。PMS API 仅用测试包装器限定 loopback，并可复用既有测试时钟；不绕过 readiness 或鉴权。

PMS Worker 通过本地 HTTPS 代理发送原始字节，临时公有测试证书仅用于该子进程的 `NODE_EXTRA_CA_CERTS`，不修改系统信任库，私钥不落盘。GET 故障代理只允许最小读取接口，正常响应来自真实 PMS；可缩小分页及注入读取失败、并发屏障或投影冲突，故障不改 PMS 存储事实。

计划覆盖：原字节/HMAC/ACK，重试/重复/乱序，push/pull 并发去重，ACK 丢失、断网与重启，scope 隔离，分页持久化，CAS/重建代次，同向量冲突隔离，410 重建，成员/库存墓碑，跨营业日安排收敛，历史/重建禁发，晚提交与业务/发布回滚。

## PMS-J01：新建合成库被现有启动指纹拒绝

复现：在固定 PMS 提交上依次应用 001—060 原始迁移、seedDemo，用受限 runtime 调用真实 API 启动。`databaseReady=false`；基础检查及事件模块均通过，失败项为 `externalPaymentsReady`。

证据：同一新建 PostgreSQL 18 库在 owner/runtime 下的结构指纹均为 `705eeaf432a39efbb9611b4bab5be004b1dfeb7924ad52a3841280a41e403063`，与提交 `4b598c6` 之前已冻结的原迁移指纹相同。该提交把唯一允许值替换为现有生产指纹 `0e14e25d9c534fe01032a239e60eec03ccf0385f616e0a4ebd529fafe8edc799`，因此拒绝原迁移的新安装。

最小修复设计：只允许这两个已有明确来源的精确指纹；保留后续表/列/角色/函数权限检查，未知指纹继续失败关闭。不更改迁移、生产库或支付行为；本轮不宣称核验生产指纹背后的实际库状态。补新安装通过及结构漂移拒绝的回归，并重新以真实 API 启动验证。

## 当前结果

双端已完成真实运行。初始化夹具首次尝试直接改合成 Token hash，被既有不可变约束拒绝；已改为复用 `seedDemo` 的测试凭证，不改业务权限规则。该失败属于测试工具。PMS-J01/J02 已修复并通过下列检查；没有未关闭的本轮事件链路缺陷。

## PMS-J02：410 在真实 HTTP 边界被错误序列化为 500

首轮双端 18 项中 17 项通过；扩大 scope/准入断言后第二轮 19 项中 18 项通过。失败共同位于 J16：PMS 在清理已真实 ACK 的连续前缀后，函数层抛出 `410 CURSOR_EXPIRED`，但实际 HTTP 返回 `500 FST_ERR_FAILED_ERROR_SERIALIZATION`。

证据：`readPmsEventFeed` 附带 `details.rebuild_required=true`；`apps/api/src/integration.ts` 的 410 复用通用 `ErrorResponse`，其 details union 不允许该结构。现有函数测试只证明抛出410，没有覆盖 HTTP 序列化。Agent OS 未收到410，因此不会进入契约要求的重建状态；这不是接收端缺陷。

最小修复设计：只为事件 feed 的410声明精确响应，固定 `code=CURSOR_EXPIRED` 和 `details.rebuild_required=true`，保留其他错误、鉴权与响应字段约束。不改共同协议、不放宽全局错误 details。给现有保留期专项补真实路由状态码/JSON断言，随后在 Node 22 全链复测。对方任务已收到脱敏复现和责任归属。

扩展 OpenAPI 检查另发现两处既有契约文档缺漏：退款夹具未收录既有规格明确的 `refundReference`；支付事件查询未声明通用500响应。只同步该测试字段并为原接口补 `500: ErrorResponse`，不改支付同步、资金写入或住宿共同事件协议。此项在最终双端验收后调整，另做受影响的 OpenAPI/类型检查，不冒称重新执行了支付业务联调。


## 固定版本与最终证据

最终完整运行：2026-09-11 15:04:26—15:08:07（Asia/Shanghai），Node **22.23.2**、独立 PostgreSQL **18**。原始机器记录只含合成引用、版本、状态与计数，见 [final-run.json](../docs/implementation/evidence/pms-agentos-joint-20260911/final-run.json)。前两轮未通过记录分别保留为 first-run.json、second-run.json，不覆盖历史失败事实。

| 对象 | 固定校验 |
| --- | --- |
| Agent OS 152文件清单 | `56cc9ee18f93eabd6be177f73be7ca523cd5f91f5105e4f63069e59ca05da291` |
| 实际 Agent OS 可执行程序 | `31079d9f0890653cf26c5e33e1593f013e96591357ad53a4bcb29e8a562f136f` |
| 冻结的唯一共同协议 | `77a055c7e252884dc4e61fcadd4da49e968c194587fce75cd43e6c6eb4b91512` |
| PMS 共享 order-projection.json 文件 | `7c9001ea62a3b3850b96356c23437f6d7884e9da5ba7696dcee1951f8e9fad56` |

共同投影的规范 hash 仍为 `b46f00b6121e9f6bda068dcbef5b7219c4f35dee0b07d82b21d46c6a1cc79399`。它与文件字节 hash、Webhook body hash 分开记录。PMS 最终双端运行的关键源码与工具逐文件 hash 在 final-run.json 的 `pms_runtime_files`；代码由上述固定 HEAD 加本分支明确改动复现。最后两处支付 OpenAPI 声明/夹具调整在该运行之后完成，并单独复测，事件链路代码未再变化。

Agent OS 责任任务已明确确认：v2 可以作为本轮 B 收口基线；A 工作台仍在开发/浏览器验收，尚无最终版。v2 之后欢迎/合成驱动无行为变化，仅格式调整；新工作台迁移和 run-collaboration-local 接线不纳入本次通过范围。A 完成后由其交新冻结清单，涉及共享构建/迁移时做限定回归。

## 逐项联合验收

下面全部经过真实 PMS HTTP/API、受限 Worker 或发布事务，以及独立运行的 Agent OS ingress/合成 CLI 调用真实 Store/recovery。测试控制器没有替代接收器或直接写“消费完成”。

| 项目 | 验收行为 | 最终结果 |
| --- | --- | --- |
| J01 | 真实预订入住及原字节签名ACK | 通过 |
| J02 | 签名错误与跨来源跨物业拒绝 | 通过 |
| J03 | ACK丢失后同事件重试并保持单Inbox | 通过 |
| J04 | push与pull同时到达及乱序去重 | 通过 |
| J05 | 同event_id异原字节冲突保留原记录 | 通过 |
| J06 | 断网重启后事件与投递状态恢复 | 通过 |
| J07 | 分页失败检查点不前进且新进程继续 | 通过 |
| J08 | 并发拉取CAS只允许一次推进 | 通过 |
| J09 | 同版本投影冲突持久隔离 | 通过 |
| J10 | 库存墓碑恢复与关联修订 | 通过 |
| J11 | 真实会员删除得到200墓碑且不可见不作删除 | 通过 |
| J12 | 未来换房跨营业日无新事件仍收敛 | 通过 |
| J13 | 历史补录复合事件只同步不准入欢迎 | 通过 |
| J14 | 晚提交位于已消费水位之后且回滚不留事件 | 通过 |
| J15 | 分scope领取互不干扰 | 通过 |
| J16 | 410过期重建及分页重启始终禁发 | 通过 |
| J17 | 旧重建代次不能提交覆盖新代次 | 通过 |
| J18 | 所有补偿重建无制卡上传发送效果 | 通过 |
| J19 | 真实签名失败暂停Worker并受控恢复 | 通过 |

关键断言与故障证据：

- J01/J03/J04/J05：PMS 存储 body、HTTPS 代理收到字节的 SHA256、Agent OS Inbox body_hash 相等；同 ID 重投/pull 只保留一条 Inbox，重复命令无新增 Outbox，同事件不同字节409且原记录不变。正常 ACK 不代表已欢迎。
- J03/J06/J19：丢 ACK 后 PMS 仍 pending；原 body 重投得到 duplicate；每次 delivery_id 不同。关闭 API/接收器并重启后恢复；错误签名使真实 Worker 暂停，修复后通过受控 RESUME 恢复。最终 TLS 代理记录119次真实尝试（13次202、104次200，另2次为故障注入）；直接 HTTP 验签/冲突请求另计，不冒称全部经 TLS。
- J07/J08/J15：两条真实记录一页；读取503时 cursor 不变，下一个 CLI 进程从持久位置继续；并发两页提交只有一个 CAS 成功。另一 scope 既不能领取主scope排队项，其403重建也不改变主scope状态。
- J09：仅在读取代理中注入同向量不同合法 hash，源库不改写；接收端持久 conflicted、保留旧投影，普通回读不能解封；真实更高订单修订到来后解除。
- J10/J11/J12：库存停用/恢复、真实合成会员误建删除产生明确200墓碑，404不作删除；未来 MOVE 在测试营业日切换后同 hash、无新事件，Agent OS 通过真实回读更新 business_date。此处时钟只覆盖 PMS 既有测试包装器。
- J13/J14：历史复合补录3条独立事实共享最终版本3、全部 historical_correction，case 未准入；未提交事务不进入发布水位，晚提交事件出现在已消费cursor之后；业务回滚没有残留事件。
- J16/J17/J18：所有旧事件先经真实 Worker 取得 ACK，再只在隔离库压缩“31天”测试时间并执行真实 prune；HTTP410触发禁用/重建。扫描页失败不推进，旧代次不能提交；扫描中新发现订单 admitted=false。全状态订单投影数量与 PMS 一致，完成扫描不自动重新启用来源，制卡/上传/发送动作数量保持0。

## 其他验证

- 既有事件专项23项通过（含新增HTTP410断言、Outbox/发布回滚、租约fencing、权限和清理边界）。
- readiness专项1项通过：新安装和受限runtime就绪，关闭关键触发器拒绝就绪，恢复后通过。该定向检查早于切换Node22；最终Node22双端运行重新证明正常启动路径。
- Node22 TypeScript、Unit **1135项**及构建/release元数据检查通过。
- OpenAPI共21项：首轮19项通过、2项失败；补齐既有refundReference夹具与支付事件500声明后，失败2项定向复测通过。没有把第二轮跳过的19项计成重新运行。
- PR格式检查器8项通过；本分支 diff 空白检查通过。无协议文件、迁移、依赖锁或生产配置变更。

## 复跑、运行差别与交接

可复制命令与隔离门禁见 [tests/joint/README.md](../tests/joint/README.md)。启动测试前核验清单，不读取活动 Agent OS 目录，不从它的旧 HEAD 重建缺少未提交实现的版本。

这次 PMS 使用真实 HTTPS、正常证书校验及 HMAC；Agent OS 固定版读取采用非默认、literal-loopback HTTP 测试传输。测试代理可以制造故障，但正常数据来自真实 PMS，不是共享fixture代替联调。生产HTTPS接收域名、根证书部署、密钥轮换与真实READ凭证适用范围没有在本轮验证。

本轮没有完整欢迎业务资料/目标/真实适配器；禁发结果限于事件接收、历史补偿、重建准入和动作表，没有将此结果当作完整欢迎T01—T16或真实渠道验收。Person/审批/制卡/群路由仍属于Agent OS后续切片。

## 发布、回退与剩余事项

本次只修PMS新安装启动兼容和过期cursor的HTTP错误声明，并补联调工具/回归/文档。没有创建新迁移、提交生产配置或启动真实投递。PMS-J01保留已部署精确指纹，不重新认定生产库结构正确；未知结构和权限漂移仍拒绝启动。

后续代码合入仍走本项目PR和既有检查。发布前沿用P01—P08第13.3节的试点/回退流程：暂停投递、保留Outbox/水位/Inbox及在途回执，再按原ID恢复；本次修复不需要数据库迁移或清理。回退HTTP修复会重新出现410变500的问题，不建议用回退掩盖消费失败。

生产网络与凭证轮换、规模吞吐/24小时积压、生产切换/灾备恢复、真实账号及完整欢迎业务仍需各自后续验收。本轮B没有新增业务判断要求，也未启动C/D或生产试点。接收端无待修复的本轮缺陷；A最终版本的共享构建/迁移差异回归单独交接。

收尾已确认两端应用/测试进程退出，专用库活动连接数均为0，PMS Worker恢复NOLOGIN，Agent OS来源全部synthetic且禁用，欢迎动作数为0。两个本任务容器已停止并保留合成数据，其他容器未改动。独立Git工作区、Agent OS冻结副本/构建及证据保留供复查；临时目录不替代长期版本归档，后续A应把其最终基线纳入自身版本管理。


## A 最终冻结版的限定兼容回归

A 责任方随后交付最终固定清单，B 于 2026-09-11 15:33:57—15:34:25（Asia/Shanghai）完成受影响范围回归。本节补充此前“A 最终版本待交付”的状态；不把 v2 的19项证据改标为 A 最终版完整19项验收，也不代替 A 的组织工作台/真实登录验收。

- PMS 使用本地提交 `4d71a1ac119b4c3fad0cd5b2570d81ec56809114` 的事件代码，追加工具 `tests/joint/shared-baseline-regression.mjs`。本轮没有新增业务代码修订。
- A 源基线为责任方的 `codex/org-person-workbench-a`、HEAD `2815ab46f2cc0efb3e34cda56f6242bb9af5abf0` 加明确文件清单；162文件由 B 校验后复制到 `/private/tmp/green-pms-joint-agentos-a-20260911-v1`，运行后再次逐文件核验未变。
- A 清单 SHA256：`ea995750d41e039f2af0cd0661d65700fb7ecf2e0058cdbf9d5f274e19cde35d`。独立离线构建的程序 SHA256：`03635dfc8fb8f89bdf231939eacdb3f4eb5b9e3fb02724db43053b3a5bb0c3ea`；使用 `welcome-synthetic-driver`，Node 22.23.2。
- 唯一共同协议、旧迁移及共享样例未变。接收器相关4个文件经 rustfmt 规范化比较一致；其他变动属于组织工作台。新增迁移 `202609110001_organization_person_workbench.sql` 创建三张组织工作台表并登记 schema_change_log，没有修改欢迎表。

| 限定检查 | 实测结果 |
| --- | --- |
| 保留 v2 合成库上运行 A 的真实迁移器 | 26条旧迁移 checksum 不变，仅新增一条；16张 welcome 表逐表数量与完整内容 hash 不变；三张新工作台表为空 |
| 全新合成库安装与启动 | 原迁移正常应用，真实 PMS API 与 A 的真实 ingress 均启动 |
| 实际预订/入住、HTTPS签名投递、pull去重与消费 | 两个新事件由真实 Worker 获 ACK，Inbox 各一条且原字节 hash 一致，订单消费到 revision 2 |
| 重建、扫描与恢复入口 | 来源保持禁用；欢迎动作、上传意图、产物绑定均为0 |

升级检查先运行真实 `welcome-synthetic init`：迁移成功后重复来源注册按预期拒绝，退出码1；结合迁移记录与全表 hash 证明升级未改变旧来源或欢迎历史。随后才重建干净专用库做新安装和双程序检查。

首次追加脚本误把 SQLx 迁移表写成 `public._sqlx_migrations`，报 `42P01`，发生在迁移执行前；按真实 `db.rs` 的 search_path 修正为 `qintopia_messages._sqlx_migrations` 后4项通过。此为 PMS 验收工具错误，没有修改 Agent OS。失败证据保留为 [a-final-shared-regression-first-run.json](../docs/implementation/evidence/pms-agentos-joint-20260911/a-final-shared-regression-first-run.json)，最终证据为 [a-final-shared-regression.json](../docs/implementation/evidence/pms-agentos-joint-20260911/a-final-shared-regression.json)。

收尾再次只读确认：两专用实例无其他客户端连接，PMS Worker 为 NOLOGIN，欢迎三类效果记录均为0。两个本任务容器再次停止，合成数据保留。A 最终版共享构建/迁移兼容性无本轮未关闭缺陷；生产网络、账号、完整欢迎与真实发送仍不在本次结论内。
