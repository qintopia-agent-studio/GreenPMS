# 发布方案参考与机制映射

本文记录可公开复用的实现机制。生产目录快照、进程身份和安全调查原始证据保留在本地运维记录，不进入公开仓库。调查结论来自仓库实现与只读运行检查交叉验证；本文不是生产接入成功证明。

## Agent OS 已有方案

参考仓库 `qintopia-agent-os-monorepo` 的 `.github/workflows/deploy-production.yml`、`.github/workflows/rollback-production.yml`、`deploy/runner/`、`docs/operations/production-deploy-runner.md` 和 `docs/operations/cos-artifact-distribution.md`。

- 发布非草稿 GitHub Release 作为批准点；Actions 构建精确提交对应的产物。
- COS 分发产物及签名请求；服务器定时轮询请求，通过正式 runner 验证并执行部署、回退，返回结果。
- staging 用于未提交的下载、校验和准备；正式 release 不可变，current 表示当前选择，previous 表示上一个版本，rollback-from 记录回退来源。进程可能仍引用旧目录，因此链接状态不能单独作为删除依据。
- 部署锁串行化切换，健康检查和 smoke test 门禁决定成功；失败恢复原版本。持久配置、密钥和运行数据独立于 release。
- systemd 管理运行与恢复入口，部署记录保留身份与结果；清理检查实际运行引用，并处理旧 release 与遗留 staging。

参考方案也使用 GitHub Artifacts 暂存和不同的 COS 保留数量、清理时机。这些不符合本项目约束，因此没有复制。现场临时调整不作为 GreenPMS 的安装前提；正式行为全部由本仓库脚本表达。

## GreenPMS 旧流程与变化

旧发布以严格 Git tag 的 detached HEAD 为源码身份，在服务器执行 Compose build/up。生产 Compose 只运行应用，数据库为外部 TencentDB。镜像可有版本、commit、latest、pre-* 等多个标签；版本数量必须按唯一 image ID 统计。临时 build 工作区不是回退版本。

旧流程依赖人工完成版本检查、迁移核对、构建、切换、健康确认和发布记录，缺少完整的自动部署、失败恢复与产物保留入口。文档要求 OCI labels，但仅有要求不能证明镜像实际携带身份；新流程在构建、归档及载入三个阶段验证 labels 和 image ID。首次接管通过显式 adoption 登记旧镜像精确身份和迁移基线。

## 机制映射

| 原则 | Agent OS | GreenPMS 实现 |
| --- | --- | --- |
| 不可变版本 | 精确提交的 release 目录 | COS 版本/commit 路径、Docker archive config digest、rootfs diff IDs、不可变本地 tag |
| 临时 staging | 下载与准备目录 | mktemp 下载目录，退出清理 |
| current / previous / rollback-from | release 指针与实际进程引用 | 原子 state.json、目标 daemon 的 runtime image ID、rollbackFrom |
| 切换与恢复 | 服务切换、健康门禁、恢复原指针/进程 | 固定 Compose 项目和容器、健康门禁、恢复原镜像 |
| 防止并发 | runner 部署锁 | Actions concurrency + 服务器 flock |
| 清理保护 | 检查进程对 release 的引用 | 检查所有容器对 image ID 的引用，保护 current/previous/rollbackFrom |
| 配置分离 | 外部配置和持久数据 | root-owned 外部 env/COS 配置，外部 TencentDB |
| 审计和恢复入口 | runner 记录、systemd | 审计日志、事务 journal、systemd recovery timer |

GreenPMS 单容器 Compose 重建会有短暂中断；原子性指状态提交，不代表零停机。普通发布由 GitHub Release 发布动作批准，不再增加 Environment 二次审批。无需复制 Agent OS 的源码目录结构或引入 COS 请求轮询服务。

## 交付与验证边界

自动测试替换 COS、Docker 和 SSH，覆盖身份检查、失败恢复、锁、清理、幂等与禁止文件。真实 CAM 权限、COS 传输、服务器安装、外网健康检查与首次上线须另行验收。操作顺序见 [quickstart](production-release-quickstart.md)，状态与清理算法见 [runbook](production-release-runbook.md)。
