# 版本与发布约定

产品名称为 QinTopia PMS，首个正式编号版本为 `v1.0.0`。根 `package.json` 的 `version` 是应用版本唯一来源；根锁文件同步，私有内部工作区包版本不代表部署版本，`/api/v1` 表示接口兼容系列。

## 版本规则

- 修订号：兼容的缺陷修复或小优化，例如 `v1.0.1`。
- 次版本：兼容的新业务能力，例如分段同住人管理可使用 `v1.1.0`。
- 主版本：不兼容接口、重大业务规则或升级兼容性变化，例如 `v2.0.0`。数据库迁移本身不必然升级主版本，按实际兼容性判断。
- 每次部署新代码都必须使用新的版本号；普通开发提交不必发布。Git 标签不可复用、移动或覆盖；同一标签必须对应同一提交。

## 每次发布

1. 业务 PR 合并到 `main` 后，`GreenPMS Release Please` 自动创建或更新版本 PR。它根据 Conventional Commits 计算 patch/minor/major 版本，自动更新根 `package.json`、`package-lock.json`、`CHANGELOG.md` 和 `deploy/release-policy.json` 的版本字段。无需手动执行 `npm version`、编辑锁文件或创建 Git tag。
2. 两人团队只需检查版本 PR；如果本次包含数据库迁移或改变回退兼容性，在该 PR 中修改 `deploy/release-policy.json` 的 `mode` 和 `reason`。`CHANGELOG.md` 是自动发布说明入口；`docs/releases/vX.Y.Z.md` 可继续补充详细的中文说明，但不是自动发布的阻塞项。
3. 合并版本 PR 后，Release Please 自动创建不可变的 `vX.Y.Z` tag 和 Draft GitHub Release。确认说明和上线时机后，在 GitHub 点击 **Publish release**，表示批准上线。仅正式 Release 发布事件触发 Actions 检查、干净构建 linux/amd64 镜像、上传私有 COS 并回读校验，然后自动通过受限 SSH 部署；只推 tag、保存草稿或发布预发布版不会部署。首次接入按 [两人团队操作指南](../operations/production-release-quickstart.md) 配置；真实 COS/生产首发仍待验收。GitHub Release 仅存文字，不附加二进制、不上传 Actions Artifacts 或 GHCR。
4. `release.published` 触发 Actions 检查、干净构建 linux/amd64 镜像、上传私有 COS 并回读校验，然后自动通过受限 SSH 部署；不再追加 production Environment 审批。服务器只载入预构建镜像，不源码构建；OCI labels 记录版本、完整 revision、source 和 created。
5. 切换容器后验证镜像身份、容器健康、公网 `/health/ready`、`/api/v1/version`、前端版本和本次相关行为。失败执行对应回退方案，不宣布上线成功。
6. 服务器健康通过后，Actions 验证回执，创建 COS `deployed.json` 并在持锁期间清理；COS 保留最近 5 个成功版本，服务器按唯一 image ID 保留当前和一个回退镜像，所有容器引用均保护。Actions 自动记录部署文字摘要，服务器保留审计记录；发布 Release 本身不表示部署已经成功，以 workflow 和健康结果为准。无需手动再次发布 Release 或复制日志。准确记录业务人工验收状态，未反馈仍为待反馈；内部运维证据不加入公开发布说明。

需要回退时：Actions → GreenPMS Rollback → Run workflow（main）→ 填写已有成功版本号。脚本自动取得 COS 身份和 checksum，复用本地上一镜像或下载更早产物，再执行迁移兼容性与健康检查。详见操作指南。

迁移清单或 `rollbackCompatibility` 不允许直接切换时，自动发布/回退拒绝执行，进入单独审批的迁移和恢复流程。保留旧镜像不意味着数据库可回退。

## 页面与接口

登录页显示版本，登录后的版本链接打开对应 GitHub Release；私有仓库需要 GitHub 访问权限。版本仅用于识别发布，不展示账号、密钥或服务器配置。数据库迁移编号、业务订单版本与应用版本分别管理。
