---
title: '将数据库升级纳入同一次受控发布'
type: 'feature'
created: '2026-10-20'
status: 'done'
route: 'dispatch'
baseline_commit: 'fd33c14193fc0c97f8bdea34edb4a198fb73f681'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/operations/production-release-runbook.md'
  - '{project-root}/docs/repository-contributing.md'
---

<frozen-after-approval reason="用户已确认方案并授权实施">

## Intent

生产反复因未执行新增迁移在发布最后一步失败。用户于 2026-10-20 明确授权修改发布 Actions 和服务器受限入口，发布前批准同时涵盖本版本数据库升级与应用上线。实现“镜像准备→数据库备份/隔离恢复演练→停写/最终备份/正式迁移→部署健康检查”，无新增迁移走原路径。

## Boundaries & Constraints

- 保留不可变 tag/产物/哈希验证、main 来源、root-owned 配置、受限 SSH、同一发布锁、最终数据库预检、COS 成功标记和 retention；数据库 owner 凭据只在服务器，禁止上传 GitHub 或输出日志。
- 只改 release.yml 和相关实现；ci.yml、pr-format.yml、rollback.yml、retention.yml、固定 Action 版本、既有检查范围与 main 保护不变。
- 备份与演练失败保持旧服务；停止 app/worker 前必须有持久 journal。最终备份必须恢复演练，正式迁移仅用已校验目标镜像内的正式入口，不任意接收 SQL/path/env。
- 迁移开始前中断恢复旧服务；一旦可能执行生产 SQL，状态必须按未知/部分提交处理，停止相关写进程并保留备份/journal，不得自动切旧镜像。恢复 timer 同样遵守；显式重试仅允许相同发布身份并重查状态，不能伪报成功。
- 备份目录独立且 root-only，不在下载临时清理范围；演练 PostgreSQL 无外网，固定镜像身份和生产等效版本/角色/ACL/时区；只清理本任务确定拥有的容器/卷。
- 本次交付实现、自动验证、部署配置说明与 PR；不自行合并、安装生产新入口或发布新版本。员工功能/助手问答不变，PR 说明知识无影响。

## I/O & Edge-Case Matrix

| 场景 | 预期 |
|---|---|
| 无新增迁移 | 不访问 owner 凭据、不停写、不备份，原部署成功 |
| 已批准追加迁移 | 完整备份恢复演练、最终停写备份复验、迁移与目标 readiness 通过后部署 |
| 缺失旧迁移、额外迁移、改写哈希或清单非前缀 | 停写前拒绝，明确诊断 |
| 备份/恢复/演练/配置失败 | 无生产 SQL 写入，旧服务保持或恢复 |
| 停服务一半失败、信号/SSH 中断 | journal 可解释实际阶段，锁防并发，不能遗留无记录维护 |
| 迁移超时/部分提交/回执丢失、迁移后健康失败 | 终止写进程，停写保留恢复证据，禁止旧镜像回退 |
| 同版本重试/不同版本冲突 | 成功不重复迁移；未完成仅允许相同身份安全恢复，其他拒绝 |

</frozen-after-approval>

## Code Map

- `.github/workflows/release.yml`, `scripts/release/orchestrate.py`, `deploy/ssh-entry.py`, `deploy/greenpms-deploy`：现有锁定 SSH/ACK 协议；新增备份演练准备操作与含迁移部署操作，不能分成无锁的生产迁移/部署两个命令。
- `scripts/release/server.py`：Deployer.deploy/promote/recover，Docker.database_preflight，atomic_json 和 deployment_lock。现 promote/recover 会恢复旧镜像，须新增迁移阶段分支。
- `scripts/release/database_upgrade.py` 及必要 `.mjs` helper（新）：root-owned 配置、备份恢复/角色准备/正式迁移适配、可靠取消和诊断，复用现有模块模式。
- `scripts/build-runtime.mjs` 当前排除 migrate.ts；需把正式迁移入口按相同转译规则纳入发布镜像，不改变 CI 入口或测试发现机制。对应 runtime/package 测试同步。
- `.local-workspace/deploy-v1.16.0/`：本次已成功执行的备份、恢复、正式迁移与对比脚本供参考，不直接硬编码版本/身份/业务字段；恢复后的约束归一化需基于源元数据，不能写死 058 表达式。
- `packages/db/src/migrate.ts`：各文件独立事务，尾部员工对账可能失败；非零退出不能证明未提交，不启用密码轮换。保持业务入口语义。
- `deploy/install.sh`, `deploy/server-config.example.json`, `scripts/release/tests/`：安装与本地 fake 回归；新增受限配置须校验 root/0600、独立备份目录、固定 PostgreSQL 镜像，旧服务器未配置时明确失败，不绕过。

## Tasks & Acceptance

- [x] 实现准备/部署协议、配置和镜像内正式 migrate.js；为无迁移旧版本保留兼容。
- [x] 实现 root-owned 数据库升级步骤、持久状态、前缀/哈希校验、备份/隔离演练/最终备份与迁移。
- [x] 修复迁移阶段信号/超时/部分提交/恢复 timer 与重试分支；防止自动旧镜像回退。
- [x] 更新 release.yml、安装说明、快速开始、runbook 和 AGENTS.md 本次限定授权记录。
- [x] 为矩阵补真实行为断言，运行完整 release harness 和相关 runtime 构建检查；在独立合成 PostgreSQL 上验证正式适配器路径，不能以 mock 当真实备份恢复证明。
- Given 已发布合法 tag，when 准备与部署，then Actions 明确显示数据库准备结果，COS 成功标记只在应用就绪后产生。
- Given 维护中断，when recovery/retry，then 无未验证的旧镜像恢复或重复 SQL；证据与备份保留，故障原因可行动。

## Implementation Notes

现有用户授权足以实施已确认范围，不重复请求规格批准。优先保持小而完整的接口，可采用“独立准备阶段只备份演练，正式停写/迁移与 promote 在单一 SSH/锁内完成”。

## Spec Change Log

## Review Triage Log


2026-10-20 三路独立审阅逐项裁定。以下均属于已确认发布安全目标内的实现/验证缺口，保留已验证部分并局部修复，不重新改写冻结意图。

| 来源 | 裁定 | 证据与处理 |
|---|---|---|
| Blind 1 | high | ENOSPC 时错误路径再次写 journal 阻断 stop/cancel，fixture 已复现；修正 finally 安全清理。 |
| Blind 2 | high | 目标 Compose 在 state 提交前恢复 unless-stopped，重启保护提前解除；目标开启阶段继续 restart:no，提交后恢复策略。 |
| Blind 3 | high | helper(cancel) 复用同一 job，run 首次删除仍失败时不会发出 SQL 取消；使用独立取消任务并测真实活动会话。 |
| Blind 4 | high | 恢复文件未 fsync 而 journal 已持久，断电可能缺少恢复材料；补文件及目录持久化顺序。 |
| Blind 5 | medium | 每轮 inspect 覆盖共同元数据，旧 dump 无独立配套资料；按备份保存不可变元数据及哈希。 |
| Blind 6 | medium | owner 会话时区并不等于数据库默认或 runtime 会话时区；分别核对并恢复有效配置。 |
| Blind 7 | medium | migration URL options 被覆盖，演练和生产会话可不同；保留支持的选项并强制追加超时。 |
| Blind 8 | medium | TLS 文件路径被接受但未挂载；明确拒绝本切片不支持的文件依赖参数，保留无文件 TLS，不降级。 |
| Blind 9 | high | 真实演练只取消空闲目标，不能证明活动 SQL 停止；补目标与无关长查询对照。 |
| Blind 10 | medium | 正式迁移错误缺文件与 SQLSTATE，阶段不足以定位；增加安全结构化诊断。 |
| Edge 1 | high | 与 Blind 1 同一根因，ENOSPC 复现 app/worker 仍运行；一并修复。 |
| Edge 2 | high | cancel 的 stage_record 抛错会阻断全部取消动作；改为 best-effort 并测试。 |
| Verification 1 | medium | 身份错配 guard 只有正例，删除错库比较也不会使现有检查失败；补两个合成数据库及同用户/不同实例负例。 |
| Verification 2 | high | 与 Blind 9 同一验证缺口，mock/helper空调用不能证明后端已停止；补真实取消、无关会话保留和失败关闭断言。 |

## Verification

`/opt/homebrew/bin/python3.12 -m unittest discover -s scripts/release/tests -v`；`node --test scripts/check-pr-tests.mjs`；相关 runtime 测试、`npm run release:check`、构建、类型检查；独立合成 PostgreSQL 演练并保存日志。测试发现排除已有 `.worktrees` 和 `.local-workspace` 副本但不改 CI 流程。生产安装与未来含新增迁移版本现场验收单独记录。


### 2026-10-20 实现验证

- `/opt/homebrew/bin/python3.12 -m unittest discover -s scripts/release/tests -v`：156 项通过，包含持久 journal、部分停写、信号/未知提交、同身份重试、目标健康失败、容器缺失、配置漂移、后端取消、准备回执和正式 migrate.js 构建覆盖。日志：`.local-workspace/release-database-preparation/release-tests.log`。
- `node --test scripts/check-pr-tests.mjs`：8 项通过；`npm run release:check`、`npm run typecheck`、`npm run build` 通过。宿主执行 Node v24.21.0；真实 Docker 运行时为 Node v22.23.3。
- `npm test -- --exclude '**/.worktrees/**' --exclude '**/.local-workspace/**'`：110 文件、1700 测试通过；仅本次本地调用排除历史副本，未修改 CI 入口/检查范围。
- 正式 `Adapter` 在独立合成 PostgreSQL 18 上运行真实 `pg_dump`、两次隔离恢复及正式 `migrate.js`：源 v1.15.0 数据库源码对应 74 个迁移，目标对应 75 个迁移。准备备份恢复、最终备份恢复、源 readiness、演练迁移、正式迁移、目标 readiness 和后端取消调用通过。结果：`.local-workspace/release-database-preparation/adapter-run-6/result.json`；SHA256 与恢复验证记录保存在同目录。仅清理本次 UUID 容器和其卷，既有验收容器未修改。
- 真实演练发现并修复了 `PGDATABASE` 环境不能展开 URL 的连接错误；备份改用分离 libpq 字段并保留白名单 TLS/连接参数，未知参数拒绝。源 CHECK 约束根据源元数据恢复 BETWEEN 分组，恢复后逐项精确核对定义及继承/validated 属性。
- `git diff --check` 通过。受保护 `ci.yml`、`pr-format.yml`、`rollback.yml`、`retention.yml`、main 保护配置无修改。
- 待主代理统一审阅和 PR；未合并、未安装生产入口、未发布版本。生产规模停写时长、生产 TLS/角色/ACL、实际业务数据迁移和首次含新增迁移版本现场验收仍待后续授权执行。员工功能、权限语义、助手知识和问答入口均无变化。

### 2026-10-20 审阅问题局部修正与定向验证

- 修正 ENOSPC 安全清理顺序：失败阶段的 journal/取消阶段诊断记录均不再阻断停写或取消，保留此前有效 journal；fixture 同时注入 state 提交与 blocked journal 写失败，确认 app/worker 停止且取消被执行。
- 迁移任务与取消任务分用可追踪的固定 UUID 容器名及归属 label。迁移容器删除失败仍可运行独立 SQL 取消；准备/恢复清理涵盖取消容器。持久记录失败不能跳过各取消边界。
- 数据库 opening 通过固定 Compose override 使用 `restart:no`；健康通过、state 提交后才按原 Compose 声明恢复策略。策略恢复失败保留健康已提交目标与 journal，恢复入口重试善后。SIGKILL 不承诺瞬间停写，由持久 journal/timer 接管；未提交服务的自动重启保护保持有效。
- 恢复文件使用原子写和文件/目录 fsync，备份目录建立后同步其父目录。每份 dump 保存独立不可覆盖的元数据文件集合及 SHA 清单，verified 记录同时绑定 dump 与该集合，后续 final 不覆盖旧 dump 的恢复依据。
- 源 owner/runtime 有效 TimeZone/search_path 分别读取并在隔离连接重现；真实数据库/角色设置按源元数据恢复，未用 owner 当前 TimeZone 代替数据库默认。支持的原 options 保留，固定 lock/statement timeout 追加在最后；真实副本验证实际为 15s/2min。外部文件 TLS 参数在连接前以安全代码拒绝，无额外挂载或 TLS 降级。
- 固定受限 helper 动态导入原目标 `migrate.js`，不改变其事务行为。安全回执只保存白名单迁移文件名、首个待执行文件、SQLSTATE、退出/超时状态；异常结果始终为 unknown，并读取实际 ledger 作诊断。helper 失败状态按动作更新，避免旧记录冒充当前结果。
- `prepare-database --dry-run` 现明确拒绝，不再接受后忽略参数而执行准备。
- 定向执行 `PYTHONPATH=scripts/release:scripts/release/tests /opt/homebrew/bin/python3.12 -m unittest test_database_upgrade test_server test_database_preflight -v`：85 项通过；日志 `.local-workspace/release-database-preparation/review-targeted-tests.log`。包含 ENOSPC、独立取消、opening 中断、提交后策略恢复失败、fsync 顺序/故障、备份元数据不可覆盖、超时/非零安全回执和 CLI 参数拒绝。
- 明确手动真实适配器路径 `.local-workspace/release-database-preparation/adapter-review-6/result.json` 通过：准备和最终两次恢复、源/目标 readiness、正式迁移；owner UTC/runtime Asia/Shanghai、不同 search_path 及原角色时区恢复；5 项错库/编码同用户/不同实例/TLS 文件/不支持 options 负例，三个合成库的 ledger/数据快照不变；活动长查询的任务 PID 被终止、无关 PID 保留；模拟 migration job 删除失败后仍真实终止目标后端；注入 SQLSTATE P0001 的正式迁移失败产生脱敏 unknown 回执，随后去除合成故障并验证正常迁移。详细证据见同目录 `negative-verification.json`、`active-cancellation.json`、`expected-migration-failure.json`、`session-verification.json` 和每份备份的 metadata/verified 文件。
- 真实演练另发现 PostgreSQL 初始化临时 Unix socket 可过早通过 pg_isready；改用容器 loopback TCP 探测最终实例，避免恢复命令与初始化关闭阶段竞争。历史源迁移按原 Asia/Shanghai 契约初始化后才启用测试会话差异，未改写历史迁移或放宽业务 readiness。
- 本轮只执行上述定向测试和明确手动真实 adapter 验证；全量验证交由主代理统一执行。冻结意图不变，已有通过功能保留；未安装或修改生产。


### 主代理最终复核

- 三路审阅的 14 条发现已逐项记录并修正/补证，无遗留阻断项。独立定向复核确认两项 ENOSPC 缺陷已消除，对取消、maintenance restart policy、备份快照及 fsync 路径未发现新的具体阻断问题。
- 最终完整 release harness 170 项通过；PR 格式 8 项、helper JavaScript 语法及 Actions 结构校验通过。默认 actionlint 的两条 SC2016 shellcheck 提示在原始 main 基线同样存在，未改动对应脚本或压低既有 CI 检查。
- 1700 项应用单测、类型检查和生产构建结果仍有效；后续修正仅涉及发布工具、其验证脚本与说明。最终发布工具日志为 `.local-workspace/release-database-preparation/release-tests-final.log`。
- 工程完成不等于线上启用；下一次 Publish 前必须先按 runbook 完成受限入口的一次安装升级和 root-owned 配置，生产现场验收另记。
