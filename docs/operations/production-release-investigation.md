# Agent OS 生产发布只读调查

调查时间：2026-09-09（Asia/Shanghai）

本文件记录本阶段的只读证据，不代表已修改 Agent OS、GreenPMS 或生产服务器。服务器检查使用本地 `rtk proxy ssh`；未读取密钥、环境文件、请求 JSON、部署结果 JSON 或任何业务 secret。

## 结论摘要

Agent OS 的正式发布实现位于 `qintopia-agent-os-monorepo/deploy/runner`，不是独立 `qintopia-agent-os` 仓库中的旧 gateway/operations 文档。正式模型是 COS 拉取式 immutable release：GitHub Actions 构建并上传 COS，服务器 systemd timer 轮询签名请求，校验后在服务器组装不可变 SHA release，切换 `previous/current`，重新安装受 allowlist 管理的 systemd units，执行 smoke，并把脱敏 deploy result 写回 COS。

服务器现场存在可确认的 release identity 漂移：`current` 和 `previous` 都指向 `9f9423a7...`，`rollback-from` 指向 `cc85e527...`；当前 Agent OS systemd units 和观测到的 qintopia-message 进程则直接引用 `cc85e527...`。因此，单独读取 `current` 不能代表真实运行版本，必须同时核对 systemd unit、进程工作目录/执行路径和 release manifest。

## 证据范围

本地参考仓库：

- `qintopia-agent-os/AGENTS.md` 将 `docs/engineering/operations.md`、`docs/architecture.md` 定为运行与架构入口；该仓库没有同等完整的 release runner。
- `qintopia-agent-os-monorepo/AGENTS.md` 将 `deploy/` 定义为部署脚本和 manifest 目录。
- `registry/deploy.yaml` 将 `deploy/runner` 标记为 active，`deploy/rollback` 和 `deploy/manifests` 标记为 draft。

关键正式文件：

- `docs/operations/release-current-model.md`
- `docs/operations/production-deploy-runner.md`
- `docs/operations/cos-artifact-distribution.md`
- `deploy/runner/README.md`
- `deploy/runner/poll-deploy-requests.sh`
- `deploy/runner/promote-release.sh`
- `deploy/runner/rollback-release.sh`
- `deploy/runner/qintopia-agent-os-deploy-runner`
- `deploy/runner/smoke-release.sh`
- `.github/workflows/deploy-production.yml`
- `.github/workflows/rollback-production.yml`

## Agent OS 正式流程

### 构建、请求与服务器入口

`deploy/runner/README.md` 描述的正式路径为：

```text
GitHub Release published
  -> 构建 sidecar/deploy-bundle
  -> 上传 COS
  -> 生成 HMAC 签名 deploy request
  -> 上传固定前缀下的 request 和 current.json
  -> 服务器 qintopia-agent-os-deploy-runner.timer 轮询
  -> 校验 schema、签名、TTL、仓库、环境、SHA、scope、restart target
  -> 下载并校验 COS manifest/SHA256SUMS
  -> 组装 releases/<release-sha>
  -> 切换 previous/current
  -> 安装 release 管理的 systemd units
  -> 重启固定 allowlist 中的服务
  -> smoke
  -> 写 deploy result 并归档本地 request 状态
```

`qintopia-agent-os-deploy-runner.service` 的实际安装入口为：

```text
ExecStart=/home/ubuntu/qintopia-agent-os-releases/current/deploy/runner/poll-deploy-requests.sh
WorkingDirectory=/var/lib/qintopia-agent-os-deploy
Environment=QINTOPIA_COS_ENV_FILE=/etc/qintopia/cos-artifacts.env
```

服务为 root oneshot，启用 `ProtectSystem=strict`、`PrivateTmp` 和有限的 `ReadWritePaths`。timer 为 enabled，`OnUnitActiveSec=1min`。

### staging、current、previous 与回退

`promote-release.sh` 使用 `.staging-<release_sha>`，在 staging 中下载、解包、校验并验证 release tree；退出 trap 会清理 staging。完整且身份一致的同 SHA release 可以走幂等修复路径，不能盲目覆盖不同内容。

正式切换顺序是：

1. 在部署锁内记录旧 `current` 和 `previous`。
2. 新 release 完整校验通过后，把旧 `current` 写入 `previous`。
3. 把 `current` 原子切换到新 release。
4. 从新 release 渲染并安装固定 systemd unit allowlist。
5. 重启固定目标并执行 smoke。

`rollback-release.sh` 会重新验证 current/previous SHA、两个 manifest 的 lineage 和 systemd installer manifest，然后设置 `rollback-from`、切换 `current`、恢复 `previous`，停用只存在于候选 release 的 units，执行 daemon-reload。仅 repoint `current` 不被视为完整回退。

普通 release 失败时，runner 会在 `current` 已切换的情况下恢复原 current、原 previous 和 managed units；下载、请求校验或 staging 阶段失败则不移动健康的 current。部署锁由主 runner 使用 `flock` 获取，防止并发 promotion/rollback。

### 健康检查与记录

`smoke-release.sh` 按固定 restart target 执行 release/profile smoke；故障输出限制为阶段、target 和 subject，不上传原始日志、环境文件、journal 或外部 payload。请求和结果记录在 `/var/lib/qintopia-agent-os-deploy`，用于幂等消费、profile dry-run 和 deploy result 审计。

## 正式实现与生产现场差异

服务器目录 `/home/ubuntu/qintopia-agent-os-releases` 只读观察到 10 个 SHA release 目录、6 个 `.staging-*` 目录，以及 `current`、`previous`、`rollback-from` 三个 symlink。staging 目录时间从 2026-07-07 至 2026-07-28；其中早期目录属 `lighthouse:ubuntu`，后期目录属 `root:root`，与“部署临时目录”语义一致，但现场没有自动清理掉它们。

现场指针为：

```text
current       -> 9f9423a7fa93fc802b17bcdd3c42cb628ee23ee8
previous      -> 9f9423a7fa93fc802b17bcdd3c42cb628ee23ee8
rollback-from -> cc85e5271b087c05fa9b14e48c0314499486b32d
```

`current/manifest.json` 的 `release_sha`、`runtime_sha`、`deploy_bundle_sha`、`commit_sha` 均为 `9f9423a7...`，但 `previous_sha` 为 `0b8ed7c1...`，再次证明现场 symlink 与 manifest 已漂移。

现场 `/etc/systemd/system/qintopia-message-sidecar.service` 和 `qintopia-agentos-daily-digest-worker.service` 的 WorkingDirectory、migrations 路径、ExecStart 和 `QINTOPIA_DEPLOYED_COMMIT_SHA` 均直接绑定 `cc85e527...`。观测到的 qintopia-message 进程工作目录也出现该 release。Erhua 的 `qiwe-platform` symlink 指向 `current/skills/qiwe`，但 systemd runtime 仍是直接 SHA 路径。正式 runner 没有通用的 `lsof/fuser` 旧 release 引用扫描；它依赖 release-managed unit manifest 和直接路径绑定，这正是 GreenPMS 需要显式补强 image/container 引用保护的地方。

服务器 `/var/lib/qintopia-agent-os-deploy` 的 root-only 元数据和文件名显示：

```text
deploy.lock
requests/current.json
requests/{pending,processed,failed}/
results/
profile-dry-runs/
profile-backups/
runner-unit-backups/
```

根目录为 `root:root 700`。本阶段只列文件名、大小、所有者和权限，未读取其中任何 JSON 内容。`/etc/qintopia/cos-artifacts.env` 为 `root:ubuntu 600`，未读取内容。`sudo -n sha256sum` 因服务器要求密码而拒绝，随后以普通只读权限计算了已可读脚本的 SHA-256。

脚本比较结果如下，仅表示同/异：

| 对象 | runner | promote | rollback |
|---|---:|---:|---:|
| 本地正式仓库 vs 服务器实际运行 release `cc85e527...` | 同 | 同 | 同 |
| 本地正式仓库 vs 服务器 `current` release `9f9423a7...` | 异 | 同 | 异 |

这只能证明文件内容身份，不足以推断服务器上的具体临时改动、修改时间线或修改者。

## GreenPMS 初步事实

以下事实来自主上下文中已确认的 GreenPMS 资料，本阶段没有重新读取生产 secret 或修改 GreenPMS：

- 生产 Compose 文件为 `compose.server.yaml`，Compose 项目名为 `green-pms`，固定容器名为 `qintopia-pms-app`。
- 当前生产流程从精确 Git tag 的 detached HEAD 构建，使用 `docker compose build` 和 `docker compose up`。
- 同一个 image ID 可能同时拥有语义版本、Git commit、`latest` 和 `pre-*` 标签；保留数量必须按唯一 image ID 计算。
- `/tmp/green-pms-build-*` 是临时工作区，不是正式回退 release。
- 生产数据库为外部 TencentDB，部署清理不得触碰数据库、volume、备份或业务数据。
- 当前没有完整的自动部署、回退和产物 retention 入口。
- 发布文档要求 OCI version/revision labels，但现有镜像的对应 labels 实际为空。
- Dockerfile 目前使用 `COPY . .`，服务器工作区存在未跟踪生产凭据风险；新流程必须只从 GitHub Actions 干净 checkout 构建，并使用增强 `.dockerignore` 与多阶段 Dockerfile。

## 机制映射建议

| Agent OS 机制 | GreenPMS 适配 |
|---|---|
| immutable `<sha>` release directory | COS 不可变对象前缀 `greenpms/releases/vX.Y.Z/<gitRevision>/`，身份由 version、revision、image digest 共同表达 |
| staging + trap cleanup | runner 临时下载目录和本地 docker archive，成功、失败、中断均由 trap 清理 |
| `flock` deployment lock | 服务器 GreenPMS root-owned deploy entrypoint 使用独立锁文件；GitHub workflow 使用同一生产 concurrency |
| manifest + SHA256SUMS + artifact validation | manifest、archive checksum、平台、OCI labels、image ID/digest 全部交叉校验后才允许 `docker load`/切换 |
| current/previous + smoke rollback | 服务器保存当前 image digest 与上一个 digest；compose 使用不可变本地 tag，健康检查失败恢复旧容器 |
| release-managed systemd units | GreenPMS 使用受限 SSH 调用固定 root-owned 部署入口；不接受任意 shell 命令 |
| COS deploy result | 只有健康检查和 `/health/ready`、`/api/v1/version`、公网健康地址全部通过后创建 `deployed.json` |
| release retention | 独立实现按有效 `deployed.json` 的成功版本排序，保留最近 5 个；当前和明确 rollback 版本受保护；候选和不完整版本不计入 |
| Agent OS systemd direct-path drift guard | 每次部署记录 Compose 项目、容器名、image ID、digest 和 labels，并在清理前查询所有容器引用；不以标签数量判断镜像数量 |

不能直接复用 Agent OS 的两点：其当前 COS 文档仍描述 GitHub Actions artifact 作为审计/回退副本，而 GreenPMS 明确禁止 GitHub Artifacts、GHCR 和 GitHub Release 二进制附件；其 release tree 也不适合机械套到单一 Docker Compose 应用。

## 未确认项与边界

- 未读取 COS 实际 bucket、region、对象列表、版本控制状态或 lifecycle 状态；GreenPMS 应继续使用 fake COS client 验证 retention，不创建真实腾讯云资源。
- 未读取 `/var/lib/qintopia-agent-os-deploy` 中 request/result 内容，因此没有判断具体历史发布成功/失败状态。
- 未执行 GitHub Actions、真实 COS 上传、SSH 部署、Docker load、Compose restart、数据库迁移或生产回退。
- 未确认服务器当前所有 systemd worker 的 active MainPID 与 release path 是否完全一致；已确认代表性 sidecar/worker unit 和观测到的 qintopia-message 进程存在 `cc85e527...` 直接引用。
- Agent OS 正式脚本没有发现按数量清理旧 SHA release、旧 staging 或运行引用扫描算法；这些应作为 GreenPMS 新 harness 的明确测试对象。
- GreenPMS 当前凭据轮换、现有运行镜像替换和服务器清理均未执行，仍需单独授权。

## `%ln` 现场文件

只读检查确认 `/Users/evans/qintopia/GreenPMS/%ln` 为 0 字节文件。此前本阶段使用的 shell 命令没有 `>`、`>>` 或其他重定向，且曾因 `find -printf` 引号错误失败；没有证据证明该文件由本阶段命令产生。因此本阶段未删除它，也不能把它归因于本 agent。

## 官方外部资料来源

参考仓库的 `docs/operations/cos-artifact-distribution.md` 引用了以下腾讯云官方资料，后续实现 COS 权限时应以官方当前文档复核：

- Tencent Cloud COS authorization for sync/download：<https://intl.cloud.tencent.com/document/product/436/43257>
- Tencent Cloud COS CAM policy examples：<https://www.tencentcloud.com/document/product/436/30580>
- GitHub Actions environments：<https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment>
- GitHub Actions concurrency：<https://docs.github.com/en/actions/using-jobs/using-concurrency>
- GitHub Actions OIDC hardening：<https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect>

本阶段未访问外部服务；以上 URL 是用于实现和复核的官方资料入口，不表示已在生产环境启用对应权限或身份。
