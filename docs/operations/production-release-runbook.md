# GreenPMS 生产发布与恢复

本方案为待上线的仓库实现。生产仍运行旧流程，未上传真实 COS、未更改账号/Secrets、未轮换凭据、未替换或删除生产镜像。调查依据见 [现场调查](production-release-investigation.md)，工程状态见 [实施计划](../plans/production-release-harness.md)。

## 发布模型

```text
严格 vX.Y.Z tag（main 历史中的精确提交）
  → Actions npm ci / release check / typecheck / test / build
  → 干净 checkout，linux/amd64 多阶段镜像，OCI labels
  → Docker archive + zstd + manifest + SHA256SUMS + SPDX SBOM
  → COS 不可覆盖写入并回读 SHA-256
  → production Environment 人工批准
  → 专用 SSH forced command → 服务器 flock
  → 临时下载 → 所有校验 → docker load → Compose 替换
  → Docker healthy + 本地/公网 ready + 本地/公网 version
  → 原子 state.json + 追加审计 → 返回健康回执（继续持锁）
  → Actions 写 deployed.json → COS retention → ACK
  → 服务器按唯一 image ID 清理 → 释放锁
```

GitHub 不保存构建产物：不使用 GHCR、`upload-artifact`、Release 二进制附件或 BuildKit 远端 cache。文字摘要可以保存在 Actions 日志和 job summary；公开 Release 正文由发布负责人按实际检查结果更新，不含服务器内部详情。本 workflow 不自动创建或发布 GitHub Release。

**镜像身份**：`greenpms:vX.Y.Z-<完整40位Git revision>`。manifest 的 `imageId` 是 Docker config 内容的 SHA-256，archive 的 SHA-256 另行计算；两者均不是 registry manifest digest。OCI labels 包含带 `v` 的版本、完整 revision、GitHub source 和 UTC created。API 的版本仍不带 `v`。

**配置分离**：服务器只保留 root-owned 入口、Compose、外部应用配置、只读 COS 凭据、状态/审计以及 Docker 镜像。不会使用 `/home/ubuntu/green-pms` 作为构建上下文。单容器 Compose 替换存在短暂不可用；原子性指状态文件提交，不能保证零停机。

## COS 对象与保留

```text
greenpms/releases/vX.Y.Z/<40位revision>/
  greenpms-linux-amd64.docker.tar.zst
  manifest.json
  SHA256SUMS
  sbom.spdx.json
  deployed.json  # 仅健康成功回执之后
```

`manifest.json` 保存应用/版本/revision/platform/imageId/imageTag、archive/SBOM 哈希、时间/source、完整有序迁移文件名及哈希，以及 `rollbackCompatibility`。外部传入的 manifest SHA 是服务器的信任锚，不能只信任同一下载包中的 checksum。

上传使用 `x-cos-forbid-overwrite: true`。相同对象只能通过读取确认字节一致实现幂等，不会覆盖。marker 由 Actions 专用写身份创建，服务器 COS 身份保持只读。不可变 `deployedAt` 表示该版本首次健康成功时间；重新执行和回退的实际时间写在服务器审计中，不通过覆盖 marker 更改历史。

成功 retention 默认 5：只接受严格版本路径、有效 manifest 与绑定其 SHA/imageId/identity 的成功 marker、完整产物集合；按 marker 时间排序，循环删除最早且不受保护的完整版本。current、previous、rollbackFrom 的 COS 前缀均保护。多出的被保护版本可以暂时超过 5，不能为了凑数量破坏回退能力。上传中、未知文件、损坏/不完整状态不能被算作有效成功版本或误删。

候选过期是独立策略，默认 7 天；无成功 marker 且整个候选的最新对象也已经过期才可删除，不占成功版本的五个名额。长期待审批超过期限的发布需重新构建/上传校验；缺失对象会阻止部署。上传与清理共用 Actions concurrency，生产当前指针检查与删除共用服务器锁。正式删除失败让 Actions 非零失败并在服务器记录，运行的新容器不回退；先运行 dry-run、调查不完整候选，再重试维护。不能把失败清理报告为完全成功。

桶要求：私有、TLS、服务端加密、关闭公开访问；使用独立 GreenPMS 桶最简单，或严格隔离此前缀。**选择从未启用版本控制的新桶**。脚本拒绝 Enabled 和 Suspended；否则旧版本和 delete marker 会保留容量，而防覆盖头也失效。不要为了消除拒绝错误直接暂停版本控制。已有版本化桶必须先独立设计 versionId/delete-marker 清理与迁移，经授权后实施。

Lifecycle 只配置终止过期分片上传（建议 1 天）；不要在整个 releases 前缀配置按天到期，否则可能删除 current。候选由仓库脚本管理。数量保留必须由 retention 算法完成。

## 身份与权限

| 身份 | 允许动作 | 范围 |
|---|---|---|
| Actions upload | PutObject、GetObject、HeadObject、GetBucket、GetBucketVersioning | 四种产物对象；仅 GreenPMS release 前缀 |
| Actions marker | PutObject（仅 deployed.json）、GetObject、HeadObject、GetBucket、GetBucketVersioning | GreenPMS release 前缀 |
| Actions retention | GetObject、HeadObject、GetBucket、GetBucketVersioning、DeleteObject | 仅 GreenPMS release 前缀 |
| 服务器 reader | GetObject、必要的 HeadObject/GetBucket | 仅 GreenPMS release 前缀；无 Put/Delete |

上传必须 Get 才能回读完整字节，单靠 Head/ETag 无法满足 SHA-256 校验。GetBucketVersioning 是写/删身份的必要额外只读检查。SDK 如未来需要更多权限，应先核对实际调用，禁止直接授予 COS 管理员。

CAM `resource` 使用精确 `qcs::cos:<region>:uid/<appid>:<bucket>/greenpms/releases/*`。List 使用桶 resource，但必须配 `cos:prefix` 条件，按官方示例使用 URL 编码的 `greenpms%2Freleases%2F`（允许需要的子前缀）；同时拒绝根目录/其他前缀的列举，不能通过已有宽泛策略绕过。不要授予其他桶、备份、TencentDB、其他项目权限。上线前用 CAM 策略模拟和隔离测试前缀验证允许及拒绝用例，再开启真实发布。

优先由组织已审核的 STS/OIDC broker 给三个 Actions 身份提供短期 SecretId/SecretKey/Token，并限制仓库、tag、Environment、audience 和 session policy。本仓库不创建信任提供商，也不虚构腾讯云到 GitHub 的即用 OIDC 集成；`Token` 参数已支持。服务器优先实例角色短期凭据，经受控刷新程序写入 root-only 配置。

没有 broker 时，用独立 CAM 子账号各自独立的 key，保存在 **GitHub production Environment Secrets**，不能用个人账号。Environment secret 只有审批后才能读取，因此静态凭据方案的打包/上传 job 也需一次前置审批，上传后的部署 job 仍需第二次 production 审批。不得为了省去第一次审批把长期 key 放到仓库普通 secret；后续接入短期 broker 才可调整第一道 gate。定时 maintenance 使用同一 production Environment，静态凭据方案也会等待审批；每次成功部署内的清理自动执行。若需要候选清理完全无人值守，须先提供受限短期身份方案，不能绕过审批偷偷暴露长期 key。

## GitHub 配置

2026-09-09 通过 GitHub API 确认目标仓库为公开仓库、默认分支 main；仍需管理员核实并实际配置 required reviewers。如果以后迁为私有仓库而套餐不支持，流程上线阻塞，不能把仅写 `environment: production` 当作人工审批已经生效。

| 类型 | 名称 | 说明 |
|---|---|---|
| Variables | `COS_BUCKET`, `COS_REGION` | 私有桶全名（含 APPID）和地域，当前不提供默认真实资源 |
| Variables | `DEPLOY_HOST`, `DEPLOY_USER` | 主机和专用用户 `greenpms-deploy` |
| Secrets | `UPLOAD_COS_SECRET_ID`, `UPLOAD_COS_SECRET_KEY`, `UPLOAD_COS_TOKEN` | 上传身份；TOKEN 对 STS 必填 |
| Secrets | `MARKER_COS_SECRET_ID`, `MARKER_COS_SECRET_KEY`, `MARKER_COS_TOKEN` | marker 写身份 |
| Secrets | `RETENTION_COS_SECRET_ID`, `RETENTION_COS_SECRET_KEY`, `RETENTION_COS_TOKEN` | 唯一可删除身份 |
| Secrets | `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` | 专用私钥与事先独立核验的服务器主机公钥 |

Environment 限制可部署 tag，配置 required reviewers、防止自批、禁止管理员绕过（如套餐支持）。保护 main，限制 `v*` tag 创建/删除和 workflow 修改；tag 本身不可移动。PR CI 无 production 环境、无生产凭据、无生产数据库。所有发布和 retention workflow 共用 `greenpms-production` concurrency，`cancel-in-progress: false`。

## 服务器首次配置（全部待单独授权）

1. 由管理员安装 Docker/Compose v2、Python 3、venv、zstd；配置专用用户 `greenpms-deploy`，不加入 docker 组，不授予通用 sudo。用户需能够让 sshd 执行 forced command，但禁止交互式会话。
2. 将 `scripts/release/*.py` 放到 `/opt/greenpms-release/lib/`，`deploy/entry.py` 放 `/opt/greenpms-release/entry.py`；独立 venv 安装锁定的 `scripts/release/requirements.txt`。这些文件、venv、所有父目录必须 root-owned、用户不可写。服务器不安装 Node 构建工具、Git 源码或镜像构建 cache。
3. 将 `deploy/greenpms-deploy` 安装 `/usr/local/sbin/greenpms-deploy`，`deploy/ssh-entry.py` 安装 `/usr/local/libexec/greenpms-ssh-entry`，root:root 0755。通过 `visudo -cf` 验证 `deploy/greenpms-deploy.sudoers` 后安装 0440。部署用户只能调用已验证固定参数的入口，不获得任意 Docker 或 shell 能力。
4. sshd 使用 root-owned、部署用户不可写的 AuthorizedKeysFile（例如 `/etc/ssh/authorized_keys/greenpms-deploy`，父目录同样受控）。SSH 专用 key 的条目使用 `restrict,command="/usr/local/libexec/greenpms-ssh-entry"`。sshd 对该用户设置 `DisableForwarding yes`、`PermitTTY no`、`PasswordAuthentication no`、`X11Forwarding no`、`PermitUserRC no`，可加来源网络限制。known_hosts 从独立可信渠道核验；禁止 `StrictHostKeyChecking=no`，不要把首次 `ssh-keyscan` 结果直接当作可信 key。
5. 建立 root:root 0700 的 `/etc/greenpms` 和 `/var/lib/greenpms-release`。安装本仓库 `compose.server.yaml` 为 `/etc/greenpms/compose.server.yaml`。由管理员将已有生产配置迁入 `/etc/greenpms/app.env`（0600），核验腾讯云数据库 URL 和运行权限但不在日志输出。数据库仍是外部 TencentDB，不属于清理对象。
6. 复制 `deploy/server-config.example.json` 到 `/etc/greenpms/deploy.json`（0600）并替换桶/地域/公网域名；只读 COS 配置 `/etc/greenpms/cos-readonly.json`（0600）仅含 `COS_SECRET_ID`、`COS_SECRET_KEY` 和可选 `COS_TOKEN`。应用 env 与 COS 凭据分开，不能复制进镜像。
7. 初次 adoption 需要管理员核实正在运行的完整 image ID、Git tag/revision、健康版本及当前 57 项迁移的文件哈希。把已核实 baseline JSON 写在 root-owned 目录，然后执行下节 adopt；此步骤只登记状态，不替换容器、不轮换数据库密码。不能用缺失的 OCI labels 或 latest 推断精确身份。
8. 可安装提供的 `greenpms-release-recovery.service/.timer`。启动后两分钟、之后每小时持同一锁恢复未完成事务、清理专用 tmp 目录遗留文件；不处理其他 `/tmp` 路径。锁被占用导致该次失败可在下一轮重试，需监控真正持续的故障。

审计文件逐次打开写入，可安装 `deploy/greenpms-release.logrotate` 按周保留 12 份；不对 state/journal 轮转。日志磁盘写失败会阻止正常成功记录，但不能阻断失败容器恢复。

安装 sudoers 和 forced command 后，必须验证任意 shell、额外参数、路径穿越、端口转发、交互终端、`sudo docker` 均被拒绝；固定部署请求能到达入口但在真实发布前不执行切换。仓库 fake SSH 测试不能代替目标 sshd/sudo 配置的现场验收。

## 操作入口

仓库本地验证（所有外部系统使用 fake；无需桶）：

```bash
rtk npm ci
rtk npm run test:release
rtk npm run release:check
rtk npm run typecheck
rtk npm test
rtk npm run build
```

管理员首次登记与恢复（以下**不是现在执行的命令**；先完成上述授权配置，替换身份参数）：

```bash
sudo /usr/local/sbin/greenpms-deploy adopt v1.2.3 FULL_GIT_REVISION sha256:FULL_IMAGE_ID /etc/greenpms/verified-migrations.json
sudo /usr/local/sbin/greenpms-deploy recover
sudo /usr/local/sbin/greenpms-deploy rollback-local
```

`rollback-local` 是管理员应急入口：使用已登记 previous 精确镜像，先检查迁移兼容性，检查健康后原子记录；不依赖 COS、不删除镜像、不触发 COS retention。首次迁移的 previous 可能是受污染旧镜像，恢复它会重新暴露该风险，需受控应急授权。普通 Actions 受限 SSH 不暴露 adopt/recover/rollback-local。

Actions/运维编排调用：

```bash
python3 scripts/release/orchestrate.py deploy --version vX.Y.Z --revision FULL_REVISION --key greenpms/releases/vX.Y.Z/FULL_REVISION/ --manifest-sha MANIFEST_SHA256
python3 scripts/release/orchestrate.py rollback --version vX.Y.Z --revision FULL_REVISION --key greenpms/releases/vX.Y.Z/FULL_REVISION/ --manifest-sha MANIFEST_SHA256
python3 scripts/release/orchestrate.py maintenance --dry-run
python3 scripts/release/orchestrate.py maintenance
```

rollback 命中 previous 已登记的前缀/manifest SHA 时直接复用本地镜像；更早版本从 COS 重新下载和验证。`state.json` 保留 current、previous、rollbackFrom 和配置哈希；`transaction.json` 是未完成事务，`audit.jsonl` 是审计。所有配置变更都会阻止自动切换/恢复，要求管理员在独立配置变更窗口重新核实，不会隐式把新配置套给旧镜像后宣布成功。

## 数据库迁移与失败处理

本切片不会执行自动数据库写入。readiness 要求完整迁移列表完全相等，因此新增迁移不能通过简单旧镜像回退恢复。manifest 的完整迁移文件哈希必须与当前基线相同，两端 policy 都须为 `same-migrations-only`。`forward-only` 或任何差异在切换之前拒绝。

需要新增迁移时：单独确认业务规格、备份/恢复演练、停写窗口、前向兼容步骤及恢复条件；由迁移管理员运行已有 owner 专用迁移入口，并验证新完整基线，再设计受控接管。不能把数据库 owner 凭据给 Actions，不得将迁移包装成普通自动发布；本 PR 未实现跨迁移自动升级。数据库保留和恢复策略独立于“COS 五个镜像”。

| 失败位置 | 结果与处理 |
|---|---|
| 测试/构建/上传/回读 | 不调用部署，不创建 marker |
| 下载/哈希/manifest/镜像扫描 | 不执行 docker load；删除临时下载 |
| load 后身份/标签校验 | 不替换原容器；不清旧镜像 |
| 启动/健康 | 尽力恢复原容器并检查健康；无 marker、无 COS retention |
| 恢复也失败 | 保留 journal，人工处理或 recover；不清旧镜像 |
| SIGTERM/HUP/INT | 清理临时文件，已切换阶段尝试恢复；失败保留 journal |
| SIGKILL/主机断电 | 无法执行 trap；下一次 recovery timer/入口持锁根据 journal 恢复，再清理专用 tmp |
| 健康后 marker/retention/本地清理失败 | 保留健康新容器，任务失败便于监控；重试幂等维护，不把清理失败当发布回退条件 |

本地镜像按 image ID 去重；同一个 ID 的 `latest`、commit、语义版本和 `pre-*` 标签不是多个版本。只清理明确 GreenPMS 仓库标签；当前、previous 和任何容器引用都保护。没有容器引用的共享 image ID 仅移除 GreenPMS 标签，其他仓库标签和镜像内容保留。额外引用导致无法缩减为两个时任务报告维护失败，由管理员处理引用，不强删。不会执行 `docker system prune`、`image prune -a`，不删除任何 volumes、数据库、备份或其他项目容器。

## 首次发布和现有凭据处理

1. 审核/合并本 PR；选择一个未发布的新版本，更新 package/lock、CHANGELOG、发布说明与 `deploy/release-policy.json`。不可复用 v1.2.3 tag。
2. 在隔离环境完成首次构建和 fake harness；设置桶、CAM、Environment reviewers、known_hosts、服务器入口并现场验收。先执行 retention dry-run，确认不触及其他前缀。
3. **现有凭据按已泄露处理**：已知 `/app/.production-operator-password-20260810` 出现在当前镜像；不读取、输出或提取其内容。由管理员核查它代表的账号/用途与所有使用方，计划轮换该操作员凭据并撤销相关旧会话/令牌；如不能排除其他现场文件进入历史镜像，另行审计并扩大受影响集合，不能无证据声称只有这一项。
4. 分别申请生产凭据轮换、首次干净镜像替换、旧源码/归档/cache 清理的明确授权。先准备数据库备份/恢复证据，再按批准顺序执行。回退到受污染旧镜像只用于受控应急，缩短保留时间。
5. 人工登记旧镜像和迁移基线，创建并推送新 tag，观察 Actions 完成 COS 上传，再批准 production 部署。此时服务器只下载载入，不源码构建。
6. 验收公网 ready/version、主要登录/房态读取、发布行为；确认没有 seed、迁移、数据库写入；确认 marker 与两侧保留计划。人工验收没有执行之前保持待验收。
7. 首次成功和回退窗口结束后，再经授权清理历史 `/home/ubuntu/green-pms` 构建内容、`/tmp/green-pms-build-*`、残留归档和属于 GreenPMS 的 BuildKit cache。本脚本不会推断共享 BuildKit cache 归属并全局 prune；应由管理员按 cache ID/原构建上下文逐项确认。外部配置、数据库备份、业务资料不能当源码垃圾删除。

## 上线前检查清单与监控

- [ ] PR 审核，Node 22/npm 检查通过，真实 linux/amd64 镜像构建/扫描成功；无凭据进入最终任一 layer。
- [ ] 桶从未启用版本控制；独立身份、前缀限制、拒绝其他桶与备份访问；真实 SDK/CAM 在隔离前缀验证。
- [ ] GitHub 套餐支持 required reviewers，审批与 tag/main 保护真实生效，不只看 YAML。
- [ ] 专用 SSH key、固定 known_hosts、root-owned 入口、sudo/转发/交互拒绝测试通过。
- [ ] 生产 Compose/env 已按授权迁入固定外部路径；当前身份、迁移基线和回退镜像正确。
- [ ] 凭据轮换、污染镜像替换及历史文件清理分别明确授权，备份和恢复演练通过。
- [ ] 本地和公网 ready/version、Docker health、失败恢复、dry-run、一次真实 marker 与 retention 验收完成。
- [ ] 监控 Actions 失败、systemd recovery 失败、`recovery-required`、`local-cleanup-failed` 和 COS finalization 失败；不能仅监控 HTTP 200。

残余边界：本次无真实 COS、生产部署、账号配置或数据库演练；CAM/OIDC 与服务器配置必须现场验收；哈希与受限身份防止传输/身份混淆，不替代对发布仓库和 CI 供应链的信任；同主机拥有管理员 Docker 权限的人仍可绕过本锁，必须规定所有 GreenPMS 变更走此入口。归档扫描可拒绝已知禁入路径与模式，不是对所有可能秘密的数学证明，干净 checkout、显式 COPY、最小最终文件集仍是主要防线。

官方契约核对：腾讯云 [禁止覆盖上传](https://cloud.tencent.com/document/product/436/7749)、[版本控制不可完全关闭](https://cloud.tencent.com/document/product/436/19889)、[限制目录 List 权限](https://cloud.tencent.com/document/product/436/71307)；[GitHub Environment 审批与 Secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。
