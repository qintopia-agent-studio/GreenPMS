# PMS / Agent OS 支付事件本地联合验收（2026-09-24）

## 结论与版本

本轮真实本地服务验证了支付事件认证拒绝、丢 ACK 恢复、推送与补拉汇合、确认门禁、登记响应丢失恢复及 MATCHED 先到的乱序处理。最终五事件发送队列全部 accepted；三笔模拟流水中仅首笔和第三笔登记收款，每笔 12000 分，共两条 collection、24000 分。停止新增场景，保留环境与证据。此结论不代表生产部署或真人验收通过。

| 层 | 固定版本/来源 |
| --- | --- |
| PMS 业务源码及原联合工具 | `357f9cea044a1343332e6806cef1fda05899d408` |
| PR #51 squash 到 main | `e7f77163eb6d4cbc0142b356f96087b0a399458c`，2026-09-24 12:28:28 UTC |
| Rust 接收二进制 | `ed0bb6c63dd123421f978b7680be4af14256d72f`，接收方冻结并报告 |
| Python 业务链修复 | `7726a6f`，接收方报告 Python 23/23 及 hooks 通过 |
| 本报告 | 后续独立文档提交，不改变上述业务版本 |

合并授权定位：PMS 任务 `01a0d311-8700-75a0-8a7b-de4bb71b7b77` 中，2026-09-24 阶段交付之后、PR #51 合并执行之前的用户直接合并指令。未转录私密上下文。合并事实由本任务及总指挥分别 REST 核对。

源 head 的 PR format、Node and release checks 均通过。主线合并提交的最终 REST 结果另行核实：Node and release checks、Prepare release PR 为 success，PR format 为 skipped。本任务与总指挥均已核对，早先 in_progress 不是最终状态。

## 环境、边界与证据来源

仅本机合成环境：PMS API 18448、接收服务 18449、HTTPS 代理 18450、PG18.6 55448 / `qintopia_wecom_payment_joint`。source=`synthetic-pms-joint-20260924`，property=`prop_qintopia_demo`，key ID=`local-payment-joint`。接收方真实读取 head 后原子保存并独立 SQL 回读 baseline=cursor=0、bindingVersion=1；无历史付款时才生成第一笔。

PMS 独立 SQL、原 sender 响应、TLS 实录为本方证据；Inbox、WorkItem、action、接收游标及业务链执行结果由岸岸任务 `01a0d2c3-4d3e-7f72-9206-fce386254bef` 独立回读并回报。总指挥任务 `01a0c6ee-1de7-7302-8be1-3f7966f51bea` 另行核对接收快照。报告不把协作方证据描述为本方直接运行。

本地忽略目录 `.local-workspace/payment-events/joint/` 保存 `final-status.json`、`final-sql.txt`、`tls-records.json`、`tls-records-before-proxy-recovery.json`、`replay-evidence.jsonl`、`third-ui-registration.json`；上级 README 保留逐步执行记录。接收方保存对应 `bad-signature-receiver.json`、`dropped-ack-receiver.json`、`second-duplicate-conflict-receiver.json`、`wrong-source-receiver.json`、`wrong-property-receiver.json`、`third-matched-first-receiver.json`、`third-discovered-late-receiver.json`、`third-ordered-feed.log` 及回读资料。路径相对各自本地 joint 目录，不要求进入代码仓库。凭据、token、签名材料及业务快照不随文档提交。

## 实际联合结果

| 场景 | 实际结果 |
| --- | --- |
| 第一笔坏签名 | HTTPS 401；PMS 持久 paused=true；接收 Inbox=0、WorkItem=0、actions=[]、cursor=0 |
| 接收提交后丢 ACK | 上游 202、代理 dropped=true；PMS pending/TRANSPORT_UNCONFIRMED；接收 Inbox=1、WorkItem=1 |
| 原事件重试 | 200 duplicate；同 receipt；Inbox/WorkItem 仍各 1，无 action |
| push 后 feed | feed 从 0 到 1，同 receipt，不新增事项 |
| 无当笔确认 | 接收业务链报 human_confirmation_required，流水仍 AVAILABLE；未据此创建收款 |
| 模拟有权人确认首笔 | 明确订单、流水、金额，真实 RECORD_COLLECTION 提交；丢 Confirm 响应后为 unknown，沿原执行键 recover 成功并回读 MATCHED；仅一条 completed action，重复 execute 被拒 |
| 第一笔 MATCHED | 真实登记事务产生 sequence 2；202 accepted；两事件共用原 WorkItem，completed action 不被覆盖；feed 推进到 2 |
| 第二笔 feed 后 push | sequence 3 先 feed，cursor=3；后 HTTPS 200 duplicate，receipt 相同；Inbox=3、WorkItem=2、action=1 completed |
| 同身份冲突 | 原 seq3 body 仅在内存修改 occurredAt +1ms 并正确签名，HTTP409；接收状态及 receipt 不变 |
| 错误来源 | 仅内存 sourceInstance 变异并正确签名，HTTP403；接收状态及 receipt 不变 |
| 错误物业 | 仅内存 propertyId 变异并正确签名，HTTP403；接收状态及 receipt 不变 |
| 第三笔 MATCHED 先到 | 正常业务登记后，仅先发送真实 seq5 MATCHED，202；该事件 work=null；旧 seq4 DISCOVERED 后到也是 202、work=null，没有新增事项 |
| 乱序后 feed | push 不推进 cursor3；feed 连续读取 4、5 后 cursor5、baseline0，receipt 不变，总 Inbox=5、WorkItem=2、action=1 completed |
| 原发送队列收口 | 第三笔原 sender 正常发送 seq4/5，均 200 duplicate、同原 receipt；五事件全部 accepted，last_error_code 均 NULL |

第三笔采用 runtime 角色调用正常 createCommandPreview/confirmCommandPreview 业务事务，模拟 UI 人工接手；没有实际浏览器点击，也没有真人确认。第一笔同样是可信模拟 Person，不把本机真实服务等同真实人的授权验收。

乱序和负例使用本地显式启用、单次执行的 replay 工具：受限 worker 只读持久 body，复用原 sendClaim、签名及 HTTPS transport；未调用 finishDelivery、未写回变异 body。负例 outcome 的 pause/dead_letter 只是分类，不代表更改 PMS 订阅或队列。乱序使用真实事务产生的两个事件，不伪造 MATCHED；最后由原 sender 正常收口。

## 最终身份与资金回读

共同订单：`order_7602a28d-16c3-4fbf-b5f6-7d32cd8e559e`。三笔均为 COLLECTION、12000 分。

| 流水 | billId | 事件 sequence | 最终匹配/收款 |
| --- | --- | --- | --- |
| simulation-payment-one | `payment_c036f4cd-7196-43be-991d-b474a8db764f` | DISCOVERED 1 / MATCHED 2 | CONFIRMED；`fact_00f7ccbe-74bb-4510-adae-c933f89d43cb` |
| simulation-payment-two | `payment_a88058ac-959d-491b-9e93-62ab1911f352` | DISCOVERED 3 | 未匹配，无 collection |
| simulation-payment-three | `payment_7cee661a-f13a-482c-9bd9-c335cba1cf69` | DISCOVERED 4 / MATCHED 5 | CONFIRMED；`fact_ffdd5668-4265-4b51-8e1a-524933e1d855` |

事件 ID 格式为 `payment:<billId>:<eventType>`。

| sequence | 接收 receipt（最终原 sender 持久化值） |
| --- | --- |
| 1 | `526e52e7-7d9c-41d6-add1-3665611dd8f1` |
| 2 | `eb310e73-9e1c-4017-99ff-ee15d085a987` |
| 3 | `d2f6824d-4693-4efc-bd08-171c54d6edbd` |
| 4 | `5212eb66-f408-4209-9a4f-ba52dc4a72ea` |
| 5 | `d481c7fc-2c75-452c-88bc-7099d564072d` |

首笔业务 receipt=`receipt_dbafe6d0-b255-4c25-a109-13fa4312aa43`；第三笔业务 receipt=`receipt_902c6b5e-7219-4238-804d-9d6e77bab221`。业务 receipt 与投递 receipt 分开。最终独立 SQL 查询全库 collection_facts 仅两条；断言核对两流水、各自金额、五事件 accepted 及最后两次 TLS 200 均通过。

## 故障与恢复，不计为业务通过证据

- 第一笔 attempt2 因本方 CA 路径误拼导致加载失败、未到达 HTTP 代理；保留 TRANSPORT_UNCONFIRMED。修正原 CA 路径后的 attempt3 才取得上游 202 并丢 ACK，attempt4 为 duplicate。未关闭 TLS 校验或修改系统信任。
- 第二笔首次正常投递时原 TLS 代理已退出，18450 无监听，产生 TRANSPORT_UNCONFIRMED，未到接收端。归档旧 TLS 记录后恢复同一 18450 代理，生成新临时 CA，再由原 sender 投递成功；未重启 PMS API/接收端，未重建库。代理退出根因未定位，不宣称已根治。
- 首笔业务链最初的只读查询遗漏必填 kind，API 拒绝；接收方独立确认 actions=[]。Python 修复补 COLLECTION 与 status=ALL，版本 7726a6f；不是 PMS 规则失败，没有修改 PMS schema。
- 本地 replay 工具首次干跑相对 import 路径错误，修正后只读干跑通过，随后才显式发送；该错误未产生网络投递。

## 已有单侧证据与联合缺口

此前 PMS 交付已有支付专项 8/8、旧住宿事件 23/23、收退款原 16/16、head 并发两项、错误响应 25/25、恢复脚本 12/12、单元 1297/1297，以及 typecheck/build/PR 格式通过。这些属于此前单侧回归，不冒充本轮全套重跑。接收方报告支付 PG 5 项（含非零 H42 基线）、person82、welcome24、Python 修复后23、allfeatures866、两组 Clippy、light 及 hooks 通过，归属于对应接收版本。

本轮覆盖错误作用域授权拒绝；**两个合法来源/物业绑定之间的联合隔离尚未覆盖**。单侧测试不替代该联合缺口。本轮未覆盖真实浏览器人工操作、真人确认、生产 TLS/证书轮换和生产部署。未执行发布、部署或扩大生产权限。

## 保留与交接

保留当前 357f9ce 业务树、专用 PG/联合库、API、TLS、接收服务和本地证据；文档提交不改变业务版本。第三笔原队列已收口，无待确认事件；停止新增场景和手工投递。环境清理、剩余验收及生产发布均是独立后续动作。本报告的版本化提交仅包含文档。
