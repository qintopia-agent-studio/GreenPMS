# 生产发布 harness

状态：仓库实现和离线验证完成；真实 COS、服务器接入与首次生产发布待配置和验收。

## 已确定的范围

- 发布非草稿、非预发布 GitHub Release 作为部署批准，严格校验 vX.Y.Z 和 main 提交身份。
- 干净 Actions 构建 linux/amd64 镜像，仅私有 COS 长期保存产物；禁止 GHCR、GitHub Artifacts 和 Release 二进制附件。
- 一个 production Environment、一把受限 deploy SSH key、上传/清理/服务器只读三个 CAM 身份。普通发布与回退不要求人工登录服务器。
- COS 保留最近五个成功版本，候选独立过期清理；本机按唯一 image ID 保留 current/previous，保护所有容器引用。
- 不自动修改数据库；迁移集合与哈希不兼容时拒绝直接部署/回退。

## 实施

- [x] 对照 Agent OS 仓库与只读运行证据确定机制，公开文档使用参数化说明。
- [x] 多阶段镜像、OCI labels、归档检查、checksum、manifest 和 SBOM。
- [x] COS 不可变上传与回读、重试复用、成功 marker、保留与候选清理。
- [x] 受限部署、回退、恢复、引用保护、审计与临时目录清理。
- [x] GitHub Release/rollback/retention workflows，以及离线 fake 测试。
- [x] 一次性配置生成器、安装器、quickstart 和 runbook。
- [x] 集成 main 的 PR format 和 Node and release checks，保留作者自行合并规则。
- [ ] 用户审核并合并发布 PR。
- [ ] 经明确授权配置真实 COS、CAM、GitHub Secrets 与服务器。
- [ ] 首次部署及实际回退验收。

## 决策与限制

使用 Docker config image ID 表示归档身份，不冒充 registry manifest digest。状态原子写入，单容器切换有短暂中断。服务器仅能读取 COS，由 Actions 在健康回执后写成功 marker；服务器持锁直到清理结果 ACK。健康成功后的 marker/清理失败保持新版本并将 workflow 标为失败，可幂等重试。

上传与 marker 共用 CAM 身份，健康门禁依赖可信 workflow 与服务器回执。不同身份隔离 Delete 权限。桶版本控制 Enabled/Suspended 均拒绝，避免非当前版本或删除标记继续占用空间。

正式自动检查：`npm run release:check`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:release`、`node --test scripts/check-pr-tests.mjs`。离线通过不替代真实 COS、Docker Compose 冷启动与生产验收。

## 本次集成验证

在最新 main 的独立 checkout 使用 Node 22 安装锁定依赖后，类型检查、1124 项应用测试、构建、82 项离线发布测试、6 项 PR 格式测试通过。运行时 JS 构建、安装器 Bash 语法、四个 workflow 的 YAML 和 35 个 shell step 语法检查通过。

构建任务按 SHA checkout 必须同时取得 Git tag，故使用完整拉取并增加契约检查。所有 GitHub Actions 引用固定到已核验的官方 commit。生产配置与上线验收仍未执行。
