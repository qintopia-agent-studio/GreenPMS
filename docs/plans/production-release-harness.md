# 生产发布 harness 实施计划

状态：调查和设计完成，实现中；生产未改动。授权范围为仓库实现、离线验证、新分支和 PR；不包含上线、真实 COS 写入、账号或密码变更。

## 目标和验收

- Git tag → Actions 测试/干净构建 → COS 不可变归档 → production 审批 → 受限 SSH → 校验/载入/切换/健康 → 回执/成功标记 → 清理。
- COS 为唯一长期产物存储，保留最近 5 个成功版本；服务器按唯一 image ID 保留当前和上一个镜像，并保护所有容器引用。
- 上传、部署、清理使用 fake COS/Docker/SSH 自动测试；不访问生产数据库。

## 设计选择

1. 复刻 Agent OS 的源码 release 目录、使用镜像仓库、使用 COS Docker archive 三个候选中，选择第三项：适配单应用 Compose，且符合唯一长期存储约束。
2. 服务器使用一个原子 JSON 状态文件表达 current / previous / rollbackFrom，另有追加审计记录和未完成事务记录；不保存源码、镜像归档或 BuildKit cache。
3. 使用 Linux flock 保护所有服务器变更；固定 Compose 项目 `green-pms`、容器 `qintopia-pms-app` 和 root-owned 配置。单容器 Compose 切换有短暂中断，不宣称流量切换零停机；原子性指状态提交。
4. SHA-256 校验 archive、manifest、SBOM，外部传入 manifest 哈希作为信任锚；Docker config image ID 为归档镜像身份，不能冒充 registry manifest digest。
5. 服务器 COS 身份保持只读。Actions 验证服务器健康成功回执后，使用专用 marker 写身份创建 `deployed.json`；只有 retention 身份有 Delete 权限。
6. `packages/db/src/database.ts` 的 readiness 要求迁移列表完全一致。此 harness 不改变该业务约束，也不自动执行数据库写入：迁移集合变化/forward-only 部署或回退 fail closed，进入独立迁移与恢复流程。不能把 SQL 向后兼容等同于本应用可以回退。
7. 首次接管必须由管理员在单独授权窗口登记现有容器精确 image ID、版本和已核实迁移基线；不得信任现有空 OCI labels 或以 latest 作为回退身份。
8. 候选过期清理与成功版本 retention 分开。所有 COS 删除共用 Actions production concurrency；服务器持锁发放维护回执，并在维护期间拒绝其他部署，避免读取 current 后被并发切换。

## 步骤

- [x] Agent OS 与 GreenPMS 本地/生产只读交叉调查，记录证据和差异。
- [x] 完成迁移设计及子任务接口，再分工实现。
- [ ] 镜像最小化、上下文/归档检查、manifest 与 SBOM 构建。
- [ ] COS 上传/回读、marker、成功 retention 和过期候选清理。
- [ ] 服务器部署/恢复/回退/局部镜像清理、受限 SSH 配置模板。
- [ ] Actions、测试及运维文档。
- [ ] targeted tests → npm 类型检查/测试/构建 → 独立安全与恢复审查。
- [ ] 提交分支及 PR，生产步骤保持待授权和人工验收。

## 已知验证约束

- 本机默认 Node 为 26；仓库要求 Node 22，验证使用已安装的 `/Users/evans/.nvm/versions/node/v22.18.0/bin`。
- 本地网络、Git 元数据和 Docker socket 需要沙箱外权限；已授权范围内按工具审核执行，不据此扩大生产操作范围。
