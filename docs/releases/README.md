# 版本与发布约定

产品名称为 QinTopia PMS，首个正式编号版本为 `v1.0.0`。根 `package.json` 的 `version` 是应用版本唯一来源；根锁文件同步，私有内部工作区包版本不代表部署版本，`/api/v1` 表示接口兼容系列。

## 版本规则

- 修订号：兼容的缺陷修复或小优化，例如 `v1.0.1`。
- 次版本：兼容的新业务能力，例如分段同住人管理可使用 `v1.1.0`。
- 主版本：不兼容接口、重大业务规则或升级兼容性变化，例如 `v2.0.0`。数据库迁移本身不必然升级主版本，按实际兼容性判断。
- 每次部署新代码都必须使用新的版本号；普通开发提交不必发布。Git 标签不可复用、移动或覆盖；同一标签必须对应同一提交。

## 每次发布

1. 更新根 `package.json` 和 `package-lock.json` 版本，新增 `docs/releases/vX.Y.Z.md`，并在 `CHANGELOG.md` 顶部添加链接。每份说明包含优化说明、升级说明、验证与已知问题、回退说明；写清迁移、配置、用户操作和已知限制，没有则明确写无。
2. 执行 `npm run release:check`、适用回归、类型检查与构建。`npm run build` 已强制执行发布说明检查；有已知基线失败时记录证据，不能写成全量通过。
3. 只提交本次已授权范围，创建同版本的附注 Git 标签，推送提交和标签。核对 GitHub 标签指向该提交；不把未提交文件打入部署镜像。
4. Git tag 触发 Actions 干净 checkout、检查、构建 linux/amd64 镜像，并将 Docker archive、manifest、SHA256SUMS、SBOM 上传私有 COS 回读校验。production Environment 审批后，受限 SSH 调用服务器正式入口；服务器只载入预构建镜像，不再源码构建。OCI labels 记录版本、完整 revision、source 和 created。首次切换到此流程前必须完成 [生产发布 runbook](../operations/production-release-runbook.md) 的授权配置；当前生产仍属于旧流程。GitHub Release 仅保存文字说明，不附加二进制文件，不上传 Actions Artifacts 或 GHCR。
5. 切换容器后验证镜像身份、容器健康、公网 `/health/ready`、`/api/v1/version`、前端版本和本次相关行为。失败执行对应回退方案，不宣布上线成功。
6. 服务器健康通过后，Actions 验证回执，创建 COS `deployed.json` 并在持锁期间清理；COS 保留最近 5 个成功版本，服务器按唯一 image ID 保留当前和一个回退镜像，所有容器引用均保护。Actions 记录文字摘要；经授权后由发布负责人在 GitHub Release 正文追加实际部署时间、发布提交和上线检查结果，验证成功后发布 Release。服务器路径、备份位置、镜像详情和内部运维证据保留在服务器审计记录，不加入公开说明。把准确状态写回项目验收记录；未反馈的人工验收仍保留待反馈。不移动已发布标签。

迁移清单或 `rollbackCompatibility` 不允许直接切换时，自动发布/回退拒绝执行，进入单独审批的迁移和恢复流程。保留旧镜像不意味着数据库可回退。

## 页面与接口

登录页显示版本，登录后的版本链接打开对应 GitHub Release；私有仓库需要 GitHub 访问权限。版本仅用于识别发布，不展示账号、密钥或服务器配置。数据库迁移编号、业务订单版本与应用版本分别管理。
