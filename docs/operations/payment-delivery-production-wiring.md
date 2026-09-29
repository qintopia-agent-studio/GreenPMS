# 支付通知 worker 生产接线提案（待范围复核）

状态：仅完成部署接线设计，未安装、启用或验收生产投递。本文的命令是未来授权窗口的操作草案，不是已执行记录。基线为 `main` 的 `4642e12e375adca3dd17f289f2c829e925d94d16`（`v1.8.2`）；公网 `/api/v1/version=1.8.2`、`/health/ready=ready` 只证明 API 就绪，不证明支付通知运行。生产迁移 `067_payment_event_delivery.sql`、来源行和角色 LOGIN 状态尚未现场回读。

## 已有边界

- `v1.8.2` 的 Dockerfile 和 `scripts/build-runtime.mjs` 会将支付入口编译为 `packages/db/src/payment-event-worker-main.js`；拟复用同一不可变镜像，以 `node packages/db/src/payment-event-worker-main.js` 启动，不需要第二份 worker 或运行时 `tsx`。生产镜像内容仍须现场核对；本地 `npm run payments:worker` 是源码入口，runtime package.json 不保留该 npm 脚本。
- 迁移 067 已定义独立 `qintopia_payment_delivery_worker`，初始为 NOLOGIN；没有资金事实写权，也不能调用 `qintopia_payment_delivery_control`。但它具有 `payment_delivery_source` 的 `UPDATE(paused,reason_code)`，可直接把 paused 写成 false，**目前不能称维护者独占激活**。来源行默认 paused，`source_instance` 不可修改；worker 未启用时在连接数据库前退出。
- 现有发布函数接受调用方传入的 property ID，数据库角色本身没有单物业行级限制。首期保留应用层单物业边界：root-only 配置严格只允许已独立核实的 QTP-XA 真实 ID 一个值，拒绝多值、重复值及与该 ID 不符的值；接收 key 只绑定该物业，启用前后核对队列物业分布。这个约束不等于数据库角色的单物业强限制，也不在此任务新造 RLS 体系。
- 现有 `integration-worker.ts` 提供固定 HTTPS 路径、HMAC-SHA256、10 秒请求超时、30 秒租约、代次隔离、回执精确校验和有限退避。支付队列正文、receipt、audit 保存在数据库；进程停止或镜像切换不删除这些状态。`200 duplicate` / `202 accepted` 只表示接收方持久接收，不表示收款登记。
- `compose.server.yaml` 当前只有 app 和企微 worker。`scripts/release/server.py` 只切换并检查这两个服务；`app.env` 和 Compose 的哈希已写入部署 state。`deploy/install.sh` 遇到已安装的不同 Compose 或运行时文件会拒绝覆盖。因此直接编辑生产 Compose/env 或只加一个服务，都不能形成受恢复门禁管理的正式接线。
- [2026-09-24 联合报告](../../待开发项/PMS-AgentOS-支付事件联合验收-20260924.md) 的五事件、丢 ACK、重复 receipt、push/feed 合流、乱序和无当笔确认拒绝是旧接收版本的本地证据，不重跑为本提案的结果。Agent OS `8173e537` 是后续接收开发的旧基线；最终联测须分别锁定双方实际提交，不能将该基线说成已验收最终代码。

## 最小拟议改动

本 Draft PR 仍只新增本文 **1 个文档文件**。只读复审发现暂停权限缺口及恢复关联检查，后续实施范围从原 10 个调整为下表 **17 个文件：14 个现有文件、3 个新增文件**。不改 `.github/workflows/*`、`scripts/check-pr-tests.mjs`、历史迁移 067、支付事件协议或资金业务命令。下表是待总指挥复核的具体范围，不是本 PR 的实施授权。

| 文件 | 拟改范围 |
| --- | --- |
| `compose.server.yaml` | 增加 **1 个** `payment-worker` 服务：共用 `GREENPMS_IMAGE`，固定容器名、无端口、只注入 7 个支付变量，入口为编译后 `.js`。 |
| `scripts/release/server.py` | 复用现有 `transaction.json`、state before/after 与配置哈希；由实际 Compose 服务清单切换/检查两或三容器，增加仅管理员可用的配置事务入口与恢复分派，受限 SSH 命令集合不变。 |
| `scripts/release/payment_delivery_config.py`（新） | 复用 `ai_config.py` 的备份、哈希、journal 和原子 state 提交模式；严格校验唯一物业、7 项私有配置、来源暂停、镜像入口，实施安装/撤销及受管孤儿容器处理。敏感值不进日志/审计。 |
| `deploy/install.sh` | 增加显式受审升级：仅新增 `payment_delivery_config.py`、替换 `server.py`；其余已装受管运行时逐字节校验。新三服务模板不与旧已装 Compose 比较后拒绝，也不覆盖它；分步摘要、备份和中断恢复见下文。 |
| `scripts/release/tests/test_server.py` | 覆盖两到三再到两服务、健康/镜像门禁、前后 state 提交恢复、受管孤儿和非受管容器不受影响。 |
| `scripts/release/tests/test_payment_delivery_config.py`（新） | 覆盖特殊字符配置与白名单、唯一物业、角色/入口/readiness 门禁、TLS 未确认投递、文件/备份/并发故障、journal 精确恢复及敏感值不外泄。 |
| `scripts/release/tests/test_install.py` | 覆盖只替换两项运行时、其余逐字节不变、旧 Compose 保留、混装/中断/重试拒绝或恢复。 |
| `scripts/release/tests/test_entry.py` | 覆盖新增操作仅管理员本地可调用，原 forced-command SSH/Sudo 命令集合不变。 |
| `scripts/release/tests/test_ai_config.py` | 新三服务布局下现有 AI 配置事务仍保留支付服务原字节，旧两服务行为不退化。 |
| `packages/db/src/migrations/068_payment_delivery_resume_guard.sql`（新） | 只增加窄化触发器：拒绝支付 worker 使 `paused=false`，保留它写 `paused=true` 的 401/403 自动暂停；不改历史 067 或授予新财务权限。 |
| `packages/db/src/database.ts` | 将 068 加入精确迁移名称列表；否则新镜像也会拒绝已应用 068 的库。 |
| `packages/db/src/payment-delivery-readiness.ts` | 更新 068 后预期 schema 指纹，核验触发器定义、启用状态与角色权限；不放宽旧检查。 |
| `tests/integration/payment-event-delivery.integration.test.ts` | 验证 worker 直接 RESUME 失败、自动 PAUSE 成功、维护者 control RESUME 留审计，以及触发器缺失/禁用时 readiness 失败。 |
| `tests/contract/restore-script.contract.test.ts` | 更新迁移数量和最后编号断言，验证备份恢复路线包含 068。 |
| `docs/implementation/spec-wecom-external-payments.md` | 补记 068 权限窄化及其不改变 067 发送协议、财务语义和人工确认门禁。 |
| `docs/operations/production-release-quickstart.md` | 增加支付接线与停用入口，区分发布成功和投递激活。 |
| `docs/operations/production-release-runbook.md` | 增加前置核对、升级/停止/恢复命令、配置事务与 forward-only 回退限制。 |

拟议配置事务从 root-only、0600 的输入文件读取支付变量；路径可作为参数，值不进入参数、Git、镜像或 GitHub Secrets。它只允许既定变量和唯一 `payment-worker` 服务，保留 app/企微配置原字节。现有 `app.env` 继续作为 Compose 插值来源；服务级 `environment` 白名单保证 app/企微容器不接收支付密钥。实际允许的唯一 propertyId 来自数据库维护者独立只读核对的 `QTP-XA` 映射，受审输入须逐字节与之匹配；worker 自身不能查询 `properties` 表，所以这仍是管理员审查加应用配置约束。正式 `deploy.json`、COS/CAM 身份、对外端口均不新增；新增迁移 068 属于独立权限修复。随迁移发布的版本 PR 还须核对 `deploy/release-policy.json` 的 `forward-only` 理由，并由 Release Please 更新版本/锁文件/CHANGELOG；这些属于后续版本 PR，不算入上表手工实施文件。

### 权限窄化与替代方案

推荐在 068 为 `payment_delivery_source` 增加 `BEFORE UPDATE OF paused` 触发器：当 `current_user` 或 `session_user` 为专用 worker 且 `NEW.paused=false` 时以 42501 拒绝；其他字段及 `paused=true` 仍按 067 授权。函数按现有数据库 owner 创建并撤销 PUBLIC 执行权。维护者调用现有、默认 invoker 的 `qintopia_payment_delivery_control('RESUME',reason)`，仍写原审计行；worker 在 401/403 后经现有 `finishDelivery` 自动写 `paused=true`。孤立 PG18 容器中的同授权/触发器语义验证得到：worker 直接 unpause 为 42501，worker 自动暂停样式的 UPDATE 成功，维护身份 unpause 成功。它不是 068 实施或完整迁移验证。

备选方案是收回 worker 对 `paused` 的 UPDATE，新增仅允许 PAUSE 的受限函数，再改共享 `integration-worker.ts` 的支付分支和 readiness 权限指纹。该方案涉及更多运行路径，并可能影响旧住宿投递的共用完成函数；当前触发器只补缺失的不变量，因此推荐触发器。不能仅撤销 UPDATE 权限：现有 401/403 自动暂停会失败，且 readiness 明确要求此列权限。不能通过修改 067、关闭 readiness 或以部署环境变量代替数据库守卫。维护 owner 直接改表仍属于维护身份能力，审计操作规范继续要求走 control 函数。

### 受管配置与安装恢复

配置事务复用现有 `ai_config.py` 的同一部署锁、`transaction.json`、root-only 前后文件副本、逐文件 SHA-256 和 `state.json` 原子提交点。先验证旧配置哈希、当前镜像及来源 paused，再写带 `before`/`after` 的 journal；应用已审 Compose/env 后切换三服务并检查 app、企微和支付容器的项目/服务/容器身份、同一 image ID，以及支付入口的独立数据库角色、迁移 readiness 和来源匹配。可在支付容器内执行一次只返回退出码的只读启动自检，不能只看进程瞬时 running，也不把 URL/密钥传进命令参数。新配置健康后提交 state，再做审计并清 journal。服务器从实际 Compose 服务清单确定两或三服务，不凭容器是否碰巧存在推断。

恢复规则严格区分提交点：若 state 仍是 `before`，恢复旧 Compose/env 和旧哈希、启动旧两服务，然后只对同时匹配 `green-pms` 项目、`payment-worker` 服务和固定容器名的支付孤儿执行 stop/remove；旧 Compose 的 `up app wecom-worker` 自己不会删孤儿。若 state 已是 `after`，即使健康后审计或清 journal 失败，也恢复新文件/新哈希、三服务并补完审计；不能悄悄退回旧配置。文件为第三种内容、备份摘要损坏、state 与 journal 不匹配或恢复再失败时保留 journal，拒绝继续发布和清理，由管理员调查。撤销事务镜像地按 state 提交点处理三到两服务，并保留数据库中事件、receipt 和 audit；不会泛化删除其他容器或 volume。

安装器升级先暂停发布与 recovery timer 的新入口、确认没有正在执行的受管进程，再在安装锁下核对当前受管文件。`entry.py` 在取得部署锁之前就 import `server.py`，所以不能声称共享 deploy.lock 可防止任意时间启动的进程读到混合版本。升级仅对新模块及 server.py 两项建立旧/新摘要和 root-only 备份：先原子安装新模块，最后原子替换与旧两服务兼容的 server.py；其余受管运行时逐字节不变。中断重试只接受各文件属于已记录的旧/新摘要组合，完成后再恢复 timer/发布入口。已有两服务生产 Compose 与新三服务模板分别校验，不能以安装器当前 `cmp` 规则阻断，也不能在运行时升级时覆盖现用 Compose。任何未知内容或正在运行的旧入口进程均停止升级并保留证据。

## 未来安装与激活顺序

1. 接收方先完成生产宿主、HTTPS 证书、固定 ingress、持久 Inbox，以及可信 `(sourceInstance, propertyId, schemaVersion)` 和 key ID/物业白名单。按其契约以 READ Token 首次请求 `GET /api/v1/external-payment-events/head?propertyId=<QTP-XA 的真实 propertyId>`，原子保存 H；后续 feed 从 H 连续补拉，push 不推进 checkpoint。最终接收提交的本地联合验证和生产接收就绪分别留证。
2. 数据库维护者只读核实 `properties.code='QTP-XA'` 唯一对应的 **ID**、迁移 067 与 schema readiness、现有来源行/暂停状态、角色 LOGIN 状态和队列统计。`PMS_PAYMENT_PROPERTY_IDS` 写真实 ID，不写业务 code；本轮只配置这一处物业。保留当前 image ID、迁移清单、部署 state 和配置哈希证据。
3. 先在受审窗口升级 root-owned 发布运行时，仍保留现用两服务 Compose。随后在明确的发布/迁移窗口备份并应用 068，由新应用镜像接管同一数据库；新镜像仍按两服务切换并通过精确迁移及 API 健康门禁。`databaseReady` 对迁移名称精确匹配：068 应用后旧 v1.8.2 不能再作为健康回退目标，新镜像在 068 前也不能启动；切换失败须保留 journal 和证据并前向修复，不能承诺自动恢复旧镜像。此顺序可能有计划停机，必须纳入具体发布批准。
4. 新镜像与 068 均健康后，维护者用独立账号设置专用角色的 SCRAM 密码及 LOGIN，只插入一次来源行；若行已存在，逐值比对 sourceInstance，不更新它。来源继续 paused。维护连接不交给 worker；支付 URL 仅使用该角色并启用 TLS 身份验证。readiness 复核触发器和既有限权，不授予 runtime/owner 权限。
5. 管理员运行拟新增的 `configure-payment-delivery install <root-only-config-path>`；事务先验证 7 个值、已审 Compose 和**当前已健康的新镜像**，再切换至三服务并提交配置哈希。此时来源仍 paused；worker 可以物化已提交事件，但不能领取发送。失败按 state 提交点恢复两或三服务及对应配置，保留支付数据库队列。
6. 人工核对 worker 状态码、来源 paused、发送统计和接收方 H/feed 连续性。接收方明确就绪后，维护者执行 `SELECT qintopia_payment_delivery_control('RESUME','PRODUCTION_ACTIVATION');`，读取新增审计行，并以一笔**经允许的真实后续事件**验证接收 receipt、PMS accepted 状态与 feed 合流。无事件时保持“已运行，投递未验收”，不制造真实付款。

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
SELECT name FROM schema_migrations WHERE name IN
 ('067_payment_event_delivery.sql','068_payment_delivery_resume_guard.sql') ORDER BY name;
SELECT rolcanlogin FROM pg_roles WHERE rolname = 'qintopia_payment_delivery_worker';
SELECT source_instance, paused, reason_code FROM payment_delivery_source;
SELECT state, count(*) FROM payment_deliveries GROUP BY state ORDER BY state;

-- 紧急停发的第一步；暂停持久化并写审计，最多仍有已领取的在途请求。
SELECT qintopia_payment_delivery_control('PAUSE','OPERATOR_STOP');
```

```sh
# PAUSE 及审计核对后，在服务器管理员会话中停止独立容器。
sudo docker stop --time 35 qintopia-pms-payment-worker
# 日常恢复只在配置与镜像未变、接收方已复核且无部署 journal 时启动原容器。
sudo docker start qintopia-pms-payment-worker
# 以下仅用于未完成部署 journal；不是手动停容器的启动命令。
sudo /usr/local/sbin/greenpms-deploy recover
# 仅当目标已登记为 previous 且迁移/策略/健康检查允许时使用。
sudo /usr/local/sbin/greenpms-deploy rollback-local
```

停止后的 `accepted` receipt 不变；`pending` 留待恢复，`sending` 租约过期后由新代次重领，旧代次不能完成。日常恢复先检查 receiver 的来源/物业绑定、head/checkpoint 与 TLS；若配置及镜像未切换，管理员使用 `sudo docker start qintopia-pms-payment-worker` 恢复原受管容器并核对同镜像/运行状态，来源仍应 paused，最后由维护者以新原因码 `RESUME`。只有存在未完成部署 journal 时才用 `greenpms-deploy recover`，它不是手动停容器的启动命令。不得批量改写 `accepted`、清空队列或整体 REPLAY；仅确认为 retained `dead_letter` 且查明原因时，逐事件执行 `qintopia_payment_delivery_control('REPLAY',reason,event_id)`。

永久撤销另需拟议 `configure-payment-delivery remove` 配置事务：先 PAUSE、停容器并确认无在途数据库会话，按受管容器身份移除该服务，原子清除 root-owned env 中的 7 项及 Compose 服务，恢复配置哈希；随后 `ALTER ROLE qintopia_payment_delivery_worker NOLOGIN` 并仅终止该角色残留会话，撤销接收方签名 key。`NOLOGIN` 不会断开已有连接，不能单独视作停发。业务库中的不可变事件、receipt 与 audit 继续保留。

```sql
-- 撤销阶段，维护者在容器已停止后执行；只结束专用角色的连接。
ALTER ROLE qintopia_payment_delivery_worker NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE usename = 'qintopia_payment_delivery_worker' AND pid <> pg_backend_pid();
```

**镜像降级**走现有 GitHub Rollback workflow 或管理员 `rollback-local`，必须通过迁移基线、`rollbackCompatibility`、容器和健康门禁；068 应用后旧 v1.8.2 的精确迁移检查失败，当前 `v1.8.2` policy 也是 `forward-only`，不能直接镜像降级。失败时先 PAUSE/停支付容器并做前向修复，**不回滚业务库**，不因保留旧镜像就绕过门禁。**同一镜像内的配置恢复**则按上述 state before/after 恢复两或三服务及配置哈希，不是镜像降级；数据库中的 payment_delivery_events、deliveries、receipt 和 audit 均保留。配置撤销也走独立管理员事务，不手改 state 哈希或删队列。

## 验证与权限清单

本次只读/隔离证据（2026-09-29）：以 v1.8.2 源码和固定 revision 构建本地临时 **linux/arm64** 镜像；镜像内 Node `v22.23.3`，`packages/db/src/payment-event-worker-main.js` 存在，runtime 根目录没有 package.json。在 `--network none` 且给出无效数据库 URL 的容器中，未设置启用开关时返回 `PAYMENT_DELIVERY_DISABLED`、退出码 0。此镜像不是生产的 linux/amd64 COS 产物，不能证明生产 image ID。只在忽略目录用合成值叠加 1 个候选 Compose 支付服务并运行 `docker compose config`：该服务恰有上述 7 项环境键、无端口，app/企微服务无支付键；去掉签名 key 时配置解析以缺必需变量失败。Compose JSON 将 `$` 再序列化为 `$$`，不能单凭其输出证明实际值；另以独立项目名、`network_mode: none` 临时运行该服务的 Node 检查，容器内合成 `$`/`#`/`:` 值逐字节匹配且仅有 7 个支付键。未启动真实 worker、app、企微或数据库，检查后无残留容器/网络；候选覆盖文件未进入 PR。现有发布入口 8 项、AI 配置事务 10 项离线单测均通过；这些验证只证明可复用机制，不证明拟议新事务已经实现。

实施文件获复核后，本地再做正式 Compose 解析与最小注入校验、`npm run test:release`、`npm run release:check`、`npm run typecheck`、`npm test`、`npm run build` 和 `node --test scripts/check-pr-tests.mjs`。离线 fake harness 须覆盖配置事务的前后提交点、坏备份/第三种文件/并发、受管孤儿容器及旧两服务不退化。还需在本任务专用 Docker/PG18 实例实跑同一镜像两服务→三服务→两服务：只支付容器持有包含 `$`、`#`、`:` 等特殊字符的合成签名值且逐字节不变；paused 时投递 attempts 不增长；错误数据库角色、入口缺失或 readiness 漂移使安装健康门禁失败；错误 TLS 在实际发送时不得形成 accepted/receipt，应留下可诊断的未确认重试状态。分别注入 state 提交前后、文件/备份/并发故障并核对恢复结果；非零 H 的历史补拉衔接也须验证。fake harness 和只读 Compose 解析不能替代真实容器入口与数据库证据。现有支付 8/8 与 2026-09-24 联合 5/5 属于历史证据，不充作本轮重跑。

剩余联合模拟在总指挥协调的独立数据库、端口与接收窗口运行：两个**合法**来源实例分别绑定两个合法的**合成**物业（需两个隔离 PMS 实例，因为单个 PMS 的 `payment_delivery_source` 只有一个不可变 sourceInstance），验证各自 H、连续 feed、push receipt 和 WorkItem 隔离；对同一事件身份跨绑定重放应拒绝且两边 checkpoint/receipt 不变。`tests/joint/payment-events-local.mjs` 当前固定 55448、单一库、source 和演示物业，`setup` 会重建该库，不能直接运行两份来证明隔离。联测准备须使用独立实例、库名、loopback 端口、签名 key/CA、来源和合成 propertyId；初始化/销毁只允许命中各自本任务容器，且不能配置真实第二物业或启用生产 worker。接收端共享恢复/宿主接线结束后，先锁定双方实际提交，再验证最终接收代码的安装后接收与确认门禁；不重复旧五事件剧本。生产最后仍需单独核对证书、数据库权限、角色 LOGIN 撤销、配置哈希、发布审计、接收 receipt 和人工验收。

完成上线所需权限限于：GreenPMS PR/版本发布权限；一次性服务器管理员权限用于受管运行时和 root-only 配置；现有数据库维护者权限用于核对迁移、设置专用角色密码/LOGIN、插入来源、PAUSE/RESUME/必要的逐事件 REPLAY；接收方管理员权限用于 ingress 绑定和签名 key；PMS READ Token 用于 head/feed 与付款查询。登记收款的 WRITE Token 及具体命令必须另有逐笔人确认，不属于通知 worker 的权限。当前任务没有申请、读取或使用任何生产口令、Token、SSH 或数据库权限。
