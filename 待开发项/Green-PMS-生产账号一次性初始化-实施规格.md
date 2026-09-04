# Green PMS 生产账号一次性初始化实施规格

## 目标

在不建设通用账号管理页面的前提下，完成一次性生产账号初始化：

- 保留现有管理员 `subject_qintopia_admin / qintopia_admin` 的身份和全部历史责任链，只重设登录密码；
- 新增普通员工 `subject_qintopia_operator / qintopia_operator`，显示名固定为 `QinTopia Operator`；
- 两个账号均只获得 `prop_qintopia` 的 `WRITE` 业务访问；
- 新建版本化清单 `qintopia_production_20260904_accounts_v2`，明确将管理员列为 `ADMIN`、普通员工列为 `STAFF`；不得改变旧清单的既有含义；
- 管理员是普通员工权限的严格超集，普通员工不得获得管理员专属修改或 Token 管理权限。

## 范围与约束

- 本次不开发 9.6，不提供页面化创建、删除、停用或密码重设能力。
- 不删除或改名现有管理员，不修改任何历史订单、资金、权益或历史操作者。
- 密码使用独立随机强密码；明文不得进入 Git、数据库日志、容器镜像或长期服务器脚本。
- 数据库只保存随机 salt 和 scrypt 哈希。
- 管理员密码重设时 `auth_version` 加一，并撤销全部未撤销 Web 会话；独立 API Token 不随普通密码重设自动撤销。本次生产管理员不存在 API Token。
- 账号、门店授权、权限投影和密码重设必须在一个串行化事务内完成；任何一步失败则全部回滚。
- 事务由数据库直接所有者执行，并获取专用 advisory transaction lock；运行账号不得执行。
- 权限投影必须复用 `qintopia_reconcile_staff_profile_manifest`，不得逐项手工拼装权限。
- 一次性事务不得静默覆盖已存在的普通员工 ID 或用户名；重复执行必须失败关闭。
- 生产结果生成不含密码、salt 或哈希的执行记录，并把记录摘要及校验结果写回本规格；密码只通过权限为 `600` 的临时凭据文件交付。
- 通用账号管理、后续密码修改、停用和删除规则仍归 9.6。

## 安全执行顺序

1. 只读确认生产迁移、现有账号、会话和 Token 状态。
2. 停止应用并确认写入冻结。
3. 使用 PostgreSQL 18 创建 custom-format 备份，执行 `pg_restore --list`，计算 SHA-256，并通过 SSH 保存到本机。
4. 在独立 PostgreSQL 18 容器恢复备份，执行一次性账号事务、新版权限清单 reconciliation、runtime readiness 和两个账号的真实登录/退出测试。
5. 演练通过后，在生产执行同一事务。
6. 使用受限运行账号验证数据库 readiness，启动应用，并分别登录/退出两个账号。
7. 核对管理员 34 项权限、普通员工 24 项权限，且普通员工权限是管理员权限的真子集。
8. 将一次性凭据文件以 `600` 权限传回本机；确认交付内容后删除服务器明文和临时脚本。

## 最低验收标准

- 原管理员 subject ID、用户名、显示名、创建时间和历史关联不变，`auth_version` 恰好加一。
- 重设前未撤销的管理员 Web 会话全部失效；既有会话历史仍保留。
- 新普通员工账号唯一、启用、门店权限为 `WRITE`、档案为 `STAFF`。
- 当前生产配置选择新版清单；`qintopia_admin` 为 `ADMIN`，有 34 项命令权限；`qintopia_operator` 为 `STAFF`，有 24 项命令权限。
- 两个新密码均与各自哈希匹配，且不互相匹配。
- 两个账号均可通过生产 API 登录、读取 `/api/v1/me` 并退出；测试会话最终为已撤销状态。
- readiness 和公网 `/health/ready` 均通过；生产业务数据基线不发生变化。
- 最终备份、校验和、非敏感执行结果及回滚材料可追溯；密码不进入提交。

## 生产执行结果

- 执行时间：2026-09-05（Asia/Shanghai）。
- 部署提交：`de920bbc33f4490de69d27f368001b70494b07bd`。
- 部署镜像：`sha256:345cb21d000016d39624903cf0737b4433aec85ce3b86af28bd84b58a842f762`；旧镜像保留为 `green-pms-app:62e55f7`。
- 停机后备份：`qintopia_pms_prod-account-init-pre-de920bb-20260905.dump`；SHA-256 为 `0bd33a201cf0007a25d9c3ec017c3797ae850205c0db78840610fdd511bf25d0`，服务器与本机副本一致，且 PostgreSQL 18 `pg_restore --list` 通过。
- 隔离演练使用 PostgreSQL 18，从已审查的迁移 045 生产备份恢复并迁移至 051；账号事务、runtime readiness、两个账号登录/退出及业务基线守恒全部通过。
- 演练绑定制品：备份 SHA-256 `609ec3ba549f4b471f35f22564f2e8a1ed5d1c51642322d9b4ad307653e732b0`；provision 脚本 SHA-256 `961c190352492473b5b4ef669560d3f29a7306ca9a1321b03b89ebeccac39b0d`；login 脚本 SHA-256 `7f8e8eed8a3719f9033b994b2e0fb44a576df8d82fac894a799f3f117050b5cd`。
- 生产事务结果：管理员 `auth_version` 从 1 增至 2，撤销 11 个此前未撤销的 Web 会话，API Token 为 0；新建普通员工账号成功。
- 最终权限：`qintopia_admin` 为 `ADMIN`、34 项命令权限；`qintopia_operator` 为 `STAFF`、24 项命令权限；两者均且仅有 `prop_qintopia / WRITE`，员工权限是管理员权限的真子集。
- 最终会话：两个账号真实登录、读取 `/api/v1/me`、退出及退出后 401 均通过；终检未撤销会话均为 0。
- 业务基线前后均为 `1|4|45|45|4|4|4|4|15|33|3328900|496800|4744800|120|-15`，涵盖物业、会员、订单、住宿、会员订单、会员缴费、合同、权益批次、权益流水、收款事实及对应金额/数量汇总。
- 运行验证：受限运行账号 `db:ready`、容器健康检查和公网 `https://pms.qintopia.cn/health/ready` 均通过；生产配置已选择 `qintopia_production_20260904_accounts_v2`。
- 两个 192-bit 随机密码未写入 Git、镜像、数据库日志或本文件；凭据仅交付到项目目录之外、权限为 `600` 的本机文件，服务器明文在交付确认后删除。
