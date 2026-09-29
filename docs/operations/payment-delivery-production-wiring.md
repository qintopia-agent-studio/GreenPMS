# 支付通知 worker 生产接线提案（待技术复核）

状态：仅完成部署接线设计，未安装、启用或验收生产投递。本文的命令是未来授权窗口的操作草案，不是已执行记录。基线为 `main` 的 `4642e12e375adca3dd17f289f2c829e925d94d16`（`v1.8.2`）；公网 `/api/v1/version=1.8.2`、`/health/ready=ready` 只证明 API 就绪，不证明支付通知运行。生产迁移 `067_payment_event_delivery.sql`、来源行和角色 LOGIN 状态尚未现场回读。

## 已有边界

- `v1.8.2` 的 Dockerfile 和 `scripts/build-runtime.mjs` 会将支付入口编译为 `packages/db/src/payment-event-worker-main.js`；拟复用同一不可变镜像，以 `node packages/db/src/payment-event-worker-main.js` 启动，不需要第二份 worker 或运行时 `tsx`。生产镜像内容仍须现场核对；本地 `npm run payments:worker` 是源码入口，runtime package.json 不保留该 npm 脚本。
- 迁移 067 已定义独立 `qintopia_payment_delivery_worker`，初始为 NOLOGIN；仅有支付投递状态表的受限读写和发布函数执行权，没有资金事实写权，也不能调用 `qintopia_payment_delivery_control`。来源行默认 paused，`source_instance` 不可修改。worker 未启用时在连接数据库前退出。
- 现有发布函数接受调用方传入的 property ID，数据库角色本身没有单物业行级限制。首期以 root-only 配置只列 QTP-XA 的真实 ID、接收 key 只绑定该物业、启用前后检查队列物业分布约束实际投递；若复核要求数据库级单物业限制，需另列迁移与权限变更范围，不能把现有权限说成物业隔离。
- 现有 `integration-worker.ts` 提供固定 HTTPS 路径、HMAC-SHA256、10 秒请求超时、30 秒租约、代次隔离、回执精确校验和有限退避。支付队列正文、receipt、audit 保存在数据库；进程停止或镜像切换不删除这些状态。`200 duplicate` / `202 accepted` 只表示接收方持久接收，不表示收款登记。
- `compose.server.yaml` 当前只有 app 和企微 worker。`scripts/release/server.py` 只切换并检查这两个服务；`app.env` 和 Compose 的哈希已写入部署 state。`deploy/install.sh` 遇到已安装的不同 Compose 或运行时文件会拒绝覆盖。因此直接编辑生产 Compose/env 或只加一个服务，都不能形成受恢复门禁管理的正式接线。
- [2026-09-24 联合报告](../../待开发项/PMS-AgentOS-支付事件联合验收-20260924.md) 的五事件、丢 ACK、重复 receipt、push/feed 合流、乱序和无当笔确认拒绝是旧接收版本的本地证据，不重跑为本提案的结果。Agent OS 最新 `8173e537` 尚无本轮联合结论。

## 最小拟议改动

本提案本身只新增本文 **1 个文档文件**。后续实施拟限定为下表 **10 个文件：8 个现有文件、2 个新增文件**；不改 `.github/workflows/*`、`scripts/check-pr-tests.mjs`、支付事件协议、迁移 067 或业务命令。需要先复核此范围及配置事务的失败恢复语义，再实施这些部署文件。

| 文件 | 拟改范围 |
| --- | --- |
| `compose.server.yaml` | 增加 **1 个** `payment-worker` 服务：与 app 共用 `GREENPMS_IMAGE`，固定容器名、无端口、只注入下文 7 个支付变量、`restart: unless-stopped`，入口为编译后 `.js`。 |
| `scripts/release/server.py` | 只接受旧的两服务或新的三服务清单；切换、镜像身份和健康诊断同时覆盖支付容器。增加仅管理员可用的配置事务入口及 journal 恢复分派；不开放 forced-command SSH 的新命令。 |
| `scripts/release/payment_delivery_config.py`（新） | 在现有部署锁下严格校验已审 Compose、私有配置、来源暂停及当前镜像入口；原子安装/撤销 root-owned Compose/env，保存校验过的前后副本并更新配置哈希；失败按 journal 恢复，禁止日志输出密钥或正文。撤销须先暂停并停止支付容器，清除 7 个支付变量。 |
| `deploy/install.sh` | 增加管理员显式的受审发布运行时升级路径：校验现有受管文件、备份并更新发布 Python 文件，不在安装器中启用支付、修改数据库或偷偷覆盖 Compose/env。 |
| `scripts/release/tests/test_server.py` | 覆盖两服务到三服务切换、第三容器缺失/镜像不符/退出、失败恢复及旧镜像入口不兼容。 |
| `scripts/release/tests/test_payment_delivery_config.py`（新） | 覆盖配置完整性、哈希、权限、安装与撤销、半途失败和 journal 恢复、敏感数据不进审计。 |
| `scripts/release/tests/test_install.py` | 覆盖显式运行时升级的拒绝、备份和幂等行为。 |
| `scripts/release/tests/test_entry.py` | 确认新增操作只允许管理员本地调用，原受限 SSH/Sudo 命令集合不变。 |
| `docs/operations/production-release-quickstart.md` | 增加支付接线与停用入口，标明发布成功与投递激活是两件事。 |
| `docs/operations/production-release-runbook.md` | 增加前置检查、安装/停止/恢复命令、配置事务和版本回退限制。 |

拟议配置事务应从 root-only、0600 的临时输入文件读取支付变量；路径可以作为命令参数，变量值不进入参数、Git、镜像或 GitHub Secrets。它只允许既定变量和唯一 `payment-worker` 服务，保留 app/企微配置原字节。现有 `app.env` 继续作为 Compose 插值来源；通过服务级 `environment` 白名单，app 和企微容器不接收支付签名密钥或支付数据库口令。正式的 `deploy.json`、COS/CAM 身份、对外端口和业务迁移均不新增。

## 未来安装与激活顺序

1. 接收方先完成生产宿主、HTTPS 证书、固定 ingress、持久 Inbox，以及可信 `(sourceInstance, propertyId, schemaVersion)` 和 key ID/物业白名单。按其契约以 READ Token 首次请求 `GET /api/v1/external-payment-events/head?propertyId=<QTP-XA 的真实 propertyId>`，原子保存 H；后续 feed 从 H 连续补拉，push 不推进 checkpoint。最新接收代码的本地联合验证和生产接收就绪分别留证。
2. 数据库维护者只读核实 `properties.code='QTP-XA'` 唯一对应的 **ID**、迁移 067 与 schema readiness、现有来源行/暂停状态、角色 LOGIN 状态和队列统计。`PMS_PAYMENT_PROPERTY_IDS` 写真实 ID，不写业务 code；本轮只配置这一处物业。核对目标版本镜像实际含 `.js` 入口与 067 兼容，保留当前 image ID、部署 state 和配置哈希证据。
3. 在受审窗口用维护账号设置专用角色的 SCRAM 密码并 `LOGIN`，只插入一次来源行；若行已存在，必须逐值比对 sourceInstance，不更新它。来源继续 paused。维护连接不交给 worker；支付 URL 仅使用该角色，启用 TLS 身份验证。角色的已有限权由 readiness 复核，不授予 runtime/owner 权限。
4. 管理员从干净、已审核的 `main` 产物升级 root-owned 发布运行时；其后运行拟新增的 `configure-payment-delivery install <root-only-config-path>`。事务先验证 7 个值、Compose 和当前镜像，再切换至三服务布局，验证 app、企微及支付 worker 均运行在同一 image ID，最后提交配置哈希。此时来源仍 paused；worker 可以物化已提交事件，但不能领取发送。失败恢复旧文件、旧哈希和旧两服务布局，保留支付数据库队列。
5. 人工核对 worker 状态码、来源 paused、发送统计和接收方 H/feed 连续性。接收方明确就绪后，维护者执行 `SELECT qintopia_payment_delivery_control('RESUME','PRODUCTION_ACTIVATION');`，读取新增审计行，并以一笔**经允许的真实后续事件**验证接收 receipt、PMS accepted 状态与 feed 合流。无事件时保持“已运行，投递未验收”，不制造真实付款。

拟议私有配置恰为 7 项：`PMS_PAYMENT_DELIVERY_ENABLED=true`、`PMS_PAYMENT_DELIVERY_DATABASE_URL`、`PMS_PAYMENT_DELIVERY_ENDPOINT`、`PMS_PAYMENT_SOURCE_INSTANCE`、`PMS_PAYMENT_PROPERTY_IDS`、`PMS_PAYMENT_KEY_ID`、`PMS_PAYMENT_SIGNING_KEY`。endpoint 必须是目标 HTTPS origin 加精确 `/api/v1/ingress/pms/events`，无 query、片段或凭据；签名 key 至少 32 字节。既有 app `DATABASE_URL`、企微 secret 和 worker URL 不复用。生产网络只需支付容器到该 HTTPS 主机的出站连接及到现有 TencentDB 的私网连接；无需入站端口、新 COS 身份或新 GitHub Secret。

待实现并复核的管理员命令形状如下；当前版本没有这些参数，现阶段不得执行。输入文件只存服务器 root-owned 目录，退出窗口后按审计和恢复要求处置；恢复备份同样可能含密钥，始终保持 0600 并在撤销时核对与轮换。

```sh
sudo bash deploy/install.sh --upgrade-release-runtime --deploy-public-key /root/greenpms-setup/deploy.pub
sudo /usr/local/sbin/greenpms-deploy configure-payment-delivery install /root/greenpms-payment-delivery.json
sudo /usr/local/sbin/greenpms-deploy configure-payment-delivery remove
```

## 未来停止、撤销与恢复命令

以下 SQL 均由现有数据库维护身份执行，不由 worker 或 Actions 执行；应使用不回显密码的受控连接。以下 shell 命令由获授权的服务器管理员执行，不经受限 deploy SSH 身份。

```sql
-- 首次安装前和每次恢复前只读核对；不得用 API ready 代替。
SELECT id, code FROM properties WHERE code = 'QTP-XA';
SELECT name FROM schema_migrations WHERE name = '067_payment_event_delivery.sql';
SELECT rolcanlogin FROM pg_roles WHERE rolname = 'qintopia_payment_delivery_worker';
SELECT source_instance, paused, reason_code FROM payment_delivery_source;
SELECT state, count(*) FROM payment_deliveries GROUP BY state ORDER BY state;

-- 紧急停发的第一步；暂停持久化并写审计，最多仍有已领取的在途请求。
SELECT qintopia_payment_delivery_control('PAUSE','OPERATOR_STOP');
```

```sh
# PAUSE 及审计核对后，在服务器管理员会话中停止独立容器。
sudo docker stop --time 35 qintopia-pms-payment-worker
# 生产恢复入口仍为现有管理员命令；先核对未完成 journal，再按原门禁恢复。
sudo /usr/local/sbin/greenpms-deploy recover
# 仅当目标已登记为 previous 且迁移/策略/健康检查允许时使用。
sudo /usr/local/sbin/greenpms-deploy rollback-local
```

停止后的 `accepted` receipt 不变；`pending` 留待恢复，`sending` 租约过期后由新代次重领，旧代次不能完成。恢复时先检查 receiver 的来源/物业绑定、head/checkpoint 与 TLS，再按已审配置启动容器，确认来源仍 paused，最后由维护者以新原因码 `RESUME`。不得批量改写 `accepted`、清空队列或整体 REPLAY；仅确认为 retained `dead_letter` 且查明原因时，逐事件执行 `qintopia_payment_delivery_control('REPLAY',reason,event_id)`。

永久撤销另需拟议 `configure-payment-delivery remove` 配置事务：先 PAUSE、停容器并确认无在途数据库会话，按受管容器身份移除该服务，原子清除 root-owned env 中的 7 项及 Compose 服务，恢复配置哈希；随后 `ALTER ROLE qintopia_payment_delivery_worker NOLOGIN` 并仅终止该角色残留会话，撤销接收方签名 key。`NOLOGIN` 不会断开已有连接，不能单独视作停发。业务库中的不可变事件、receipt 与 audit 继续保留。

```sql
-- 撤销阶段，维护者在容器已停止后执行；只结束专用角色的连接。
ALTER ROLE qintopia_payment_delivery_worker NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE usename = 'qintopia_payment_delivery_worker' AND pid <> pg_backend_pid();
```

镜像回退须走现有 GitHub Rollback workflow 或管理员 `rollback-local`，且通过迁移基线、`rollbackCompatibility`、同镜像三容器和健康门禁；**不回滚业务库**。当前 `v1.8.2` 的 release policy 是 `forward-only`，因此不能声称新版本可直接回退到 `v1.8.2`。若无兼容的已部署目标，先 PAUSE/停支付容器并做前向修复；不能因保留旧镜像就绕过回退门禁。配置撤销也应作为独立管理员事务执行，不通过手改 state 哈希或删数据库队列代替。

## 验证与权限清单

实施文件获复核后，本地先做 Compose 解析与最小注入校验、`npm run test:release`、`npm run release:check`、`npm run typecheck`、`npm test`、`npm run build` 和 `node --test scripts/check-pr-tests.mjs`。离线 fake harness 必须证明新服务启停、配置事务中断恢复、镜像不兼容拒绝、旧两服务发布不退化、敏感值不进错误/审计。现有支付 8/8 与 2026-09-24 联合 5/5 属于历史证据，不充作本轮重跑。

剩余联合模拟在总指挥协调的独立数据库、端口与接收窗口运行：两个**合法**来源实例分别绑定两个合法物业（需两个隔离 PMS 实例，因为单个 PMS 的 `payment_delivery_source` 只有一个不可变 sourceInstance），验证各自 H、连续 feed、push receipt 和 WorkItem 隔离；对同一事件身份跨绑定重放应拒绝且两边 checkpoint/receipt 不变。再以 Agent OS `8173e537` 的最终接收代码验证一次安装后接收与确认门禁；不重复旧五事件剧本。生产最后仍需单独核对证书、数据库权限、角色 LOGIN 撤销、配置哈希、发布审计、接收 receipt 和人工验收。

完成上线所需权限限于：GreenPMS PR/版本发布权限；一次性服务器管理员权限用于受管运行时和 root-only 配置；现有数据库维护者权限用于核对迁移、设置专用角色密码/LOGIN、插入来源、PAUSE/RESUME/必要的逐事件 REPLAY；接收方管理员权限用于 ingress 绑定和签名 key；PMS READ Token 用于 head/feed 与付款查询。登记收款的 WRITE Token 及具体命令必须另有逐笔人确认，不属于通知 worker 的权限。当前任务没有申请、读取或使用任何生产口令、Token、SSH 或数据库权限。
