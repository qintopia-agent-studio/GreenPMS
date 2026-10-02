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

本 Draft PR 仍只新增本文 **1 个文档文件**。只读复审发现暂停权限缺口及恢复关联检查，后续实施范围从原 10 个调整为下表 **17 个文件：14 个现有文件、3 个新增文件**。不改 `.github/workflows/*`、`scripts/check-pr-tests.mjs`、历史迁移 067、支付事件协议或资金业务命令。下表是待总指挥复核的具体范围，不是本 PR 的实施授权。068 编号只在 2026-09-29 已 fetch 的 14 个远端分支 tip 中未被占用；实际提交迁移前须重查所有活跃分支。

| 文件 | 拟改范围 |
| --- | --- |
| `compose.server.yaml` | 增加 **1 个** `payment-worker` 服务：共用 `GREENPMS_IMAGE`，固定容器名、无端口、只注入 7 个支付变量，入口为编译后 `.js`。 |
| `scripts/release/server.py` | 复用 `transaction.json`、state before/after 与配置哈希；由实际 Compose 服务清单切换/检查两或三容器。迁移扩展失败禁止切不兼容旧版；现有管理员本地 `recover` 增加固定目标单次重试及显式、CAS 限定的修复制品接替选项。受限 SSH 命令集合不变。 |
| `scripts/release/payment_delivery_config.py`（新） | 复用 `ai_config.py` 的备份、哈希、journal 和原子 state 提交模式；严格校验唯一物业、7 项私有配置、来源暂停、镜像入口，实施安装/撤销及受管孤儿容器处理。敏感值不进日志/审计。 |
| `deploy/install.sh` | 增加显式受审升级：仅新增 `payment_delivery_config.py`、替换 `server.py`；其余已装受管运行时逐字节校验。新三服务模板不与旧已装 Compose 比较后拒绝，也不覆盖它；分步摘要、备份和中断恢复见下文。 |
| `scripts/release/tests/test_server.py` | 覆盖两到三再到两服务、健康/镜像门禁、前后 state 提交恢复、迁移扩展目标重试及修复制品 CAS 接替、受管孤儿和非受管容器不受影响。 |
| `scripts/release/tests/test_payment_delivery_config.py`（新） | 覆盖特殊字符配置与白名单、唯一物业、角色/入口/readiness 门禁、TLS 未确认投递、文件/备份/并发故障、journal 精确恢复及敏感值不外泄。 |
| `scripts/release/tests/test_install.py` | 覆盖只替换两项运行时、其余逐字节不变、旧 Compose 保留、混装/中断/重试拒绝或恢复。 |
| `scripts/release/tests/test_entry.py` | 覆盖配置事务及 `recover --replace-target` 仅管理员本地可调用，原 forced-command SSH/Sudo 命令集合不变。 |
| `scripts/release/tests/test_ai_config.py` | 新三服务布局下现有 AI 配置事务仍保留支付服务原字节，旧两服务行为不退化。 |
| `packages/db/src/migrations/068_payment_delivery_resume_guard.sql`（新） | 只增加窄化触发器：拒绝支付 worker 使 `paused=false`，保留它写 `paused=true` 的 401/403 自动暂停；不改历史 067 或授予新财务权限。 |
| `packages/db/src/database.ts` | 将 068 加入精确迁移名称列表；否则新镜像也会拒绝已应用 068 的库。 |
| `packages/db/src/payment-delivery-readiness.ts` | 更新 068 后预期 schema 指纹，核验触发器定义、启用状态与角色权限；不放宽旧检查。 |
| `tests/integration/payment-event-delivery.integration.test.ts` | 验证 worker 直接 RESUME 失败、自动 PAUSE 成功、维护者 control RESUME 留审计，以及触发器缺失/禁用时 readiness 失败。 |
| `tests/contract/restore-script.contract.test.ts` | 更新迁移数量和最后编号断言，验证备份恢复路线包含 068。 |
| `docs/implementation/spec-wecom-external-payments.md` | 补记 068 权限窄化及其不改变 067 发送协议、财务语义和人工确认门禁。 |
| `docs/operations/production-release-quickstart.md` | 增加支付接线与停用入口，区分发布成功和投递激活。 |
| `docs/operations/production-release-runbook.md` | 增加前置核对、升级/停止/恢复命令、迁移扩展失败后的管理员 CAS 接替、marker 收口与 forward-only 回退限制。 |

拟议配置事务从 root-only、0600 的输入文件读取支付变量；路径可作为参数，值不进入参数、Git、镜像或 GitHub Secrets。它只允许既定变量和唯一 `payment-worker` 服务，保留 app/企微配置原字节。现有 `app.env` 继续作为 Compose 插值来源；服务级 `environment` 白名单保证 app/企微容器不接收支付密钥。实际允许的唯一 propertyId 来自数据库维护者独立只读核对的 `QTP-XA` 映射，受审输入须逐字节与之匹配；worker 自身不能查询 `properties` 表，所以这仍是管理员审查加应用配置约束。正式 `deploy.json`、COS/CAM 身份、对外端口均不新增；新增迁移 068 属于独立权限修复。随迁移发布的版本 PR 还须核对 `deploy/release-policy.json` 的 `forward-only` 理由，并由 Release Please 更新版本/锁文件/CHANGELOG；这些属于后续版本 PR，不算入上表手工实施文件。

### 权限窄化与替代方案

推荐在 068 为 `payment_delivery_source` 增加 `BEFORE UPDATE OF paused` 触发器，调用显式 `SECURITY INVOKER` 的触发器函数：当 `current_user` 或 `session_user` 为专用 worker 且 `NEW.paused=false` 时以 42501 拒绝，覆盖直接 worker 连接与 `SET ROLE`；其他字段及 `paused=true` 仍按 067 授权。函数按现有数据库 owner 创建并撤销 PUBLIC 执行权。维护者使用独立维护连接，或先 `RESET ROLE`，再调用现有 invoker 的 `qintopia_payment_delivery_control('RESUME',reason)` 并核对审计。worker 的 401/403 必须继续由现有 `finishDelivery` **同一事务**提交投递结果、`paused=true` 和 audit。隔离 PG18 最小角色实验只验证直接 UPDATE：worker unpause 为 42501、写 `paused=true` 成功、维护身份 unpause 成功；它不替代未来完整 401/403 事务集成测试，也不是 068 已实施的证据。

备选方案是收回 worker 对 `paused` 的 UPDATE，新增仅允许 PAUSE 的受限函数，再改共享 `integration-worker.ts` 的支付分支和 readiness 权限指纹。该方案涉及更多运行路径，并可能影响旧住宿投递的共用完成函数；当前触发器只补缺失的不变量，因此推荐触发器。不能仅撤销 UPDATE 权限：现有 401/403 自动暂停会失败，且 readiness 明确要求此列权限。不能通过修改 067、关闭 readiness 或以部署环境变量代替数据库守卫。维护 owner 直接改表仍属于维护身份能力，审计操作规范继续要求走 control 函数。

### 受管配置与安装恢复

配置事务复用现有 `ai_config.py` 的同一部署锁、`transaction.json`、root-only 前后文件副本、逐文件 SHA-256 和 `state.json` 原子提交点。先验证旧配置哈希、当前镜像及来源 paused，再写带 `before`/`after` 的 journal；应用已审 Compose/env 后切换三服务并检查 app、企微和支付容器的项目/服务/容器身份、同一 image ID，以及支付入口的独立数据库角色、迁移 readiness 和来源匹配。可在支付容器内执行一次只返回退出码的只读启动自检，不能只看进程瞬时 running，也不把 URL/密钥传进命令参数。新配置健康后提交 state，再做审计并清 journal。服务器从实际 Compose 服务清单确定两或三服务，不凭容器是否碰巧存在推断。

恢复规则严格区分提交点：若 state 仍是 `before`，恢复旧 Compose/env 和旧哈希、启动旧两服务，然后只对同时匹配 `green-pms` 项目、`payment-worker` 服务和固定容器名的支付孤儿执行 stop/remove；旧 Compose 的 `up app wecom-worker` 自己不会删孤儿。若 state 已是 `after`，即使健康后审计或清 journal 失败，也恢复新文件/新哈希、三服务并补完审计；不能悄悄退回旧配置。文件为第三种内容、备份摘要损坏、state 与 journal 不匹配或恢复再失败时保留 journal，拒绝继续发布和清理，由管理员调查。撤销事务镜像地按 state 提交点处理三到两服务，并保留数据库中事件、receipt 和 audit；不会泛化删除其他容器或 volume。

迁移扩展的部署 journal 必须有可执行的前向恢复路径。现有 `promote` 在任何失败后都切 `before.current`，现有 `recover` 在 state 未提交时也切它，而 `deploy` 遇 journal 拒绝继续；068 后旧 v1.8.2 的精确迁移检查必失败。拟在现有 `server.py` 中仅对已核实的迁移扩展改动此分支：失败时保留 `before` state、原目标身份及 journal，停止自动回切不兼容旧镜像，不写成功 marker 或清理。无参 `recover` 在同一锁内对 journal 中**固定且已验证**的 active target 做一次有健康超时上限的切换；失败保留 journal，不循环选版本。若目标代码本身有缺陷，管理员本地显式使用 `recover --replace-target <journal-sha256> <version> <revision> <COS-key> <manifest-sha256>`。该选项读取 journal 原字节的 SHA-256 作 CAS，仅接受 state 仍为 `before`、配置哈希未变及迁移扩展 journal；严格校验版本、40 位 revision、由二者推导的固定 COS key、manifest SHA、完整 bundle/archive/OCI 与加载后的 image ID。维护者须先从数据库及 068 文件独立核对已应用迁移，并更新现有 root-only、0600 的 `/etc/greenpms/verified-migrations.json`；新 manifest 的 `requiredMigrations` 必须同时等于原失败目标和该已核实清单。原目标已通过 067→068 的 `forward-only` 门禁；同一 068 基线的后续修复 tag 可按现有策略使用 `same-migrations-only`，接替校验不能错误地重新要求它声明新增迁移。验证通过后，保存原 journal 原字节及 SHA-256 到 root-only 恢复证据，原子登记原目标、接替目标和理由，再切换修复目标；成功后只清活动 journal，审计保留新旧制品身份。绝不把任意本地镜像、`latest` 或不兼容旧版作为候选。受限 SSH、sudo 命令白名单和 workflow 均不新增入口。

| journal / state | 允许的单次动作 | 成功后的记录 | 失败或中断 |
| --- | --- | --- | --- |
| 原目标已核实、state 为 `before` | 无参 `recover` 重试 journal 固定目标一次 | 健康后原子提交 `current=target`、`previous=before.current`，持久化审计后清 journal | 保留原目标与 journal；不切不兼容的旧版 |
| 原目标有代码缺陷、state 仍为 `before` | 管理员 `recover --replace-target`，先 CAS 和全量制品/迁移校验，再保存旧 journal 并原子登记 active target | 健康后 `current=repair`、`previous=before.current`；恢复证据/audit 保留原目标与修复目标的身份链，随后清活动 journal | 下载/校验前失败不改 journal；登记后中断时，无参 `recover` 只重试已登记修复目标 |
| state 已提交为 journal 指定的 active target，journal 尚在 | 无参 `recover` 核对该已提交目标及健康、补审计 | 审计持久化后清 journal，保留已提交 state | 健康或审计失败保留 journal，不退回旧版 |
| state、配置、journal 或制品身份不吻合 | 拒绝切换与删除 | 无 | 保留原字节和审计证据，管理员调查；CAS 过期需重新只读核对，不静默重试 |

发布运行时升级须先记录三个既有 Actions workflow（`release.yml`、`rollback.yml`、`retention.yml`）的启用状态，并在维护窗口禁止发布 Release、暂停其手工触发；临时禁用这三个 workflow，等待已排队及运行中的 release/rollback/retention 作业自然结束。服务器管理员保存专用 `greenpms-deploy` 的 forced-command `authorized_keys` 原字节和摘要后临时撤下该唯一 key，确认新的受限 SSH 连接被拒绝；`sudo systemctl disable --now greenpms-release-recovery.timer` 并确认 recovery service 已退出。检查所有已启动的 `/opt/greenpms-release/entry.py` 进程和 deploy lock 持有者，等它们退出后再持安装锁升级；`entry.py` 在取锁前 import，单靠 deploy.lock 不能关闭新入口。升级仅对新模块及 `server.py` 两项建立旧/新摘要和 root-only 备份：先原子安装新模块，最后原子替换与旧两服务兼容的 `server.py`；其余受管运行时逐字节不变。中断重试只接受各文件属于已记录的旧/新摘要组合。核验升级后的两服务旧 Compose 仍可被新运行时读取及新模块/`server.py` 摘要后，按记录恢复 `authorized_keys` 原字节、原本启用的 timer 和 workflow 状态，最后放开 Release 发布与手工触发。已有两服务生产 Compose 与新三服务模板分别校验，不能以安装器当前 `cmp` 规则阻断，也不能在运行时升级时覆盖现用 Compose。未知内容、仍在运行的旧入口进程或恢复入口失败时保持封闭并保留证据。

## 未来安装与激活顺序

1. 接收方先完成生产宿主、HTTPS 证书、固定 ingress、持久 Inbox，以及可信 `(sourceInstance, propertyId, schemaVersion)` 和 key ID/物业白名单。按其契约以 READ Token 首次请求 `GET /api/v1/external-payment-events/head?propertyId=<QTP-XA 的真实 propertyId>`，原子保存 H；后续 feed 从 H 连续补拉，push 不推进 checkpoint。最终接收提交的本地联合验证和生产接收就绪分别留证。
2. 数据库维护者只读核实 `properties.code='QTP-XA'` 唯一对应的 **ID**、迁移 067 与 schema readiness、现有来源行/暂停状态、角色 LOGIN 状态和队列统计。`PMS_PAYMENT_PROPERTY_IDS` 写真实 ID，不写业务 code；本轮只配置这一处物业。保留当前 image ID、迁移清单、部署 state 和配置哈希证据。
3. 先在受审窗口升级 root-owned 发布运行时，仍保留现用两服务 Compose。随后在明确的发布/迁移窗口停 recovery timer，备份并应用 068；维护者从数据库和迁移文件核对清单，管理员更新现有 root-only `verified-migrations.json`。由新应用镜像接管同一数据库；新镜像仍按两服务切换并通过精确迁移及 API 健康门禁。`databaseReady` 对迁移名称精确匹配：068 应用后旧 v1.8.2 不能再作为健康回退目标，新镜像在 068 前也不能启动；切换失败须留 journal，以固定目标重试或管理员 CAS 接替修复，直到健康且 journal 清除后才恢复 timer。此顺序可能有计划停机，必须纳入具体发布批准。
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
# 仅供迁移扩展失败且原目标有缺陷时，填入已复核的旧 journal SHA 和已发布修复 tag 的精确制品身份。
sudo /usr/local/sbin/greenpms-deploy recover --replace-target <journal-sha256> <version> <revision> <COS-key> <manifest-sha256>
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

**镜像降级**走现有 GitHub Rollback workflow 或管理员 `rollback-local`，必须通过迁移基线、`rollbackCompatibility`、容器和健康门禁；068 应用后旧 v1.8.2 的精确迁移检查失败，当前 `v1.8.2` policy 也是 `forward-only`，不能直接镜像降级。失败时先 PAUSE/停支付容器并做前向修复，**不回滚业务库**，不因保留旧镜像就绕过门禁。若原目标有代码缺陷，先发布修复 tag，使现有 Release workflow 上传不可变修复制品；因旧 journal 未清，此轮自动 deploy 会拒绝。管理员按上表恢复原目标或 CAS 接替修复目标并通过健康检查后，对**最终健康目标的同一已发布 tag**重新运行现有 Release workflow 的 `workflow_dispatch`，让服务器走已实现的同镜像幂等健康回执，才由 orchestrator 校验 receipt、写 `deployed.json`、运行 retention 和本地清理。`recover` 本身不写 COS marker，也不视为发布成功。**同一镜像内的配置恢复**则按上述 state before/after 恢复两或三服务及配置哈希，不是镜像降级；数据库中的 payment_delivery_events、deliveries、receipt 和 audit 均保留。配置撤销也走独立管理员事务，不手改 state 哈希或删队列。

## 验证与权限清单

本次只读/隔离证据（2026-09-29）分三类，均不算正式实施通过：**arm64 镜像模拟**以 v1.8.2 源码和固定 revision 构建临时 `linux/arm64` 镜像；镜像内 Node `v22.23.3`，`packages/db/src/payment-event-worker-main.js` 存在，runtime 根目录没有 package.json。在 `--network none` 且给出无效数据库 URL 的容器中，未设置启用开关时返回 `PAYMENT_DELIVERY_DISABLED`、退出码 0；这不是生产的 linux/amd64 COS 产物，不能证明生产 image ID。**候选 Compose 模拟**只在忽略目录用模拟值叠加 1 个支付服务并运行 `docker compose config`：该服务恰有上述 7 项环境键、无端口，app/企微服务无支付键；去掉签名 key 时配置解析以缺必需变量失败。Compose JSON 将 `$` 再序列化为 `$$`，不能单凭其输出证明实际值；另以独立项目名、`network_mode: none` 临时运行该服务的 Node 检查，容器内模拟 `$`/`#`/`:` 值逐字节匹配且仅有 7 个支付键。未启动真实 worker、app、企微或数据库，检查后无残留容器/网络；候选覆盖文件未进入 PR。**独立 PG18 最小语义模拟**只验证触发器下的直接 UPDATE，不覆盖完整 `finishDelivery` 401/403 事务。现有发布入口 8 项、AI 配置事务 10 项离线单测均通过；这些验证只证明可复用机制，不证明拟议新事务已经实现。

实施文件获复核后，本地再做正式 Compose 解析与最小注入校验、`npm run test:release`、`npm run release:check`、`npm run typecheck`、`npm test`、`npm run build` 和 `node --test scripts/check-pr-tests.mjs`。离线 fake harness 须覆盖配置事务的前后提交点、坏备份/第三种文件/并发、受管孤儿容器及旧两服务不退化。发布恢复专项还要覆盖：迁移扩展时旧版不可用而初次切换失败、固定目标一次重试、目标代码缺陷后的 CAS 接替；过期 journal SHA、坏 bundle/manifest/image、错误迁移基线或策略、错误配置哈希均拒绝且不改变 state；下载前后、接替 journal 提交前后、state 提交后中断均能按上表重入，审计和制品身份可追溯；健康恢复后同 tag 重跑得到幂等 receipt，并完成 marker/retention。测试还须证明受限 SSH 不能调用接替选项、运行时升级封闭入口且混装失败不恢复入口。还需在本任务专用 Docker/PG18 实例实跑同一镜像两服务→三服务→两服务：只支付容器持有包含 `$`、`#`、`:` 等特殊字符的模拟签名值且逐字节不变；paused 时投递 attempts 不增长；错误数据库角色、入口缺失或 readiness 漂移使安装健康门禁失败；错误 TLS 在实际发送时不得形成 accepted/receipt，应留下可诊断的未确认重试状态。分别注入 state 提交前后、文件/备份/并发故障并核对恢复结果；完整 401/403 `finishDelivery` 应在同一事务提交投递结果、自动 `paused=true` 和审计，触发器缺失/禁用时 readiness 拒绝；非零 H 的历史补拉衔接也须验证。fake harness 和只读 Compose 解析不能替代真实容器入口与数据库证据。现有支付 8/8 与 2026-09-24 联合 5/5 属于历史证据，不充作本轮重跑。

剩余联合模拟在总指挥协调的独立数据库、端口与接收窗口运行：两个**合法**来源实例分别绑定两个合法的**模拟**物业（需两个隔离 PMS 实例，因为单个 PMS 的 `payment_delivery_source` 只有一个不可变 sourceInstance），验证各自 H、连续 feed、push receipt 和 WorkItem 隔离；对同一事件身份跨绑定重放应拒绝且两边 checkpoint/receipt 不变。`tests/joint/payment-events-local.mjs` 当前固定 55448、单一库、source 和演示物业，`setup` 会重建该库，不能直接运行两份来证明隔离。联测准备须使用独立实例、库名、loopback 端口、签名 key/CA、来源和模拟 propertyId；初始化/销毁只允许命中各自本任务容器，且不能配置真实第二物业或启用生产 worker。接收端共享恢复/宿主接线结束后，先锁定双方实际提交，再验证最终接收代码的安装后接收与确认门禁；不重复旧五事件剧本。生产最后仍需单独核对证书、数据库权限、角色 LOGIN 撤销、配置哈希、发布审计、接收 receipt 和人工验收。

### 九原则适用映射

| 核对项 | 本提案的依据与收敛 |
| --- | --- |
| 实际必要性 | 当前两服务部署与安装器不接受第三服务/新运行时，067 又允许 worker 直接解除暂停；068 后现有失败恢复会切回必定不健康的旧镜像。 |
| Job 与步骤数量 | 不新增 CI、Release、Rollback、Retention job 或步骤；复用既有 Release 上传、受限部署、同 tag 重放和健康回执。新增的只是管理员本地恢复参数及配置事务。 |
| 规则、依赖与配置数量 | 不增生产入口、COS/CAM 身份或 GitHub Secret；新增 1 个 Compose 服务、7 个私有变量、1 个窄化迁移触发器和 1 个运行时模块。PG18/Compose 模拟只作证据，不成为生产依赖。 |
| 代码依据 | `server.py` 的固定两服务、无条件旧镜像恢复和 journal 门禁，`install.sh` 的逐文件 `cmp`，`entry.py` 的锁前 import，以及精确迁移 readiness 分别对应上述改动。 |
| 简单备选 | 手改 Compose/env 绕过 state 哈希；仅收回 `paused` UPDATE 会破坏 401/403 自动暂停；只留 journal 而无接替入口无法修目标代码缺陷。故需受管事务、窄化触发器及 CAS 前向恢复。 |
| 最小范围 | 17 个拟议文件各自对应运行行为、回归、规格或操作入口；历史 067、共享 CI 脚本与工作流均不改。版本 PR 自动文件另按现有发布机制处理。 |
| 无业务特例 | 恢复按迁移基线、制品身份、state 提交点和 Compose 实际服务清单判断；不按物业、支付事件或某一 tag 写发布特例。 |
| 仅部署相关 | `server.py`、安装器和管理员恢复只管理制品、镜像、配置与健康；资金事实、队列协议及订单生命周期不改变。068 是单列的权限不变量修复。 |
| 复用优先 | 沿用部署锁、journal、state、COS bundle 校验、OCI 核验、健康回执、`ai_config.py` 的配置备份模式和原有审计；不建第二套发布通道。 |

完成上线所需权限限于：GreenPMS PR/版本发布权限；一次性服务器管理员权限用于受管运行时和 root-only 配置；现有数据库维护者权限用于核对迁移、设置专用角色密码/LOGIN、插入来源、PAUSE/RESUME/必要的逐事件 REPLAY；接收方管理员权限用于 ingress 绑定和签名 key；PMS READ Token 用于 head/feed 与付款查询。登记收款的 WRITE Token 及具体命令必须另有逐笔人确认，不属于通知 worker 的权限。当前任务没有申请、读取或使用任何生产口令、Token、SSH 或数据库权限。
