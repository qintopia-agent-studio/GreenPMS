# 通用 Green PMS API Skill

源码位于 `skills/greenpms-api/`，任何运行时均通过同一组 API 和现有 API Key 权限办理业务。Skill 不扩大命令、物业或角色权限，不改变 PMS 服务端业务规则；门店已有职责、展示口径和业务授权要求仍有效。

## 包与执行方式

部署包只有 `SKILL.md`、`scripts/greenpms.py` 和两份业务/恢复参考。执行器使用 Python 3 标准库，依赖 POSIX 文件锁与信号；不需要安装 requests。连接沿用 `GREENPMS_BASE_URL`、`GREENPMS_API_TOKEN`、`GREENPMS_PROPERTY_ID`，要求 HTTPS。每次 HTTP 请求默认有 30 秒完整响应期限，可通过 `GREENPMS_HTTP_TIMEOUT_SECONDS` 在 1–120 秒内调整。

执行器持久化相互独立的 Preview、Confirm 和恢复幂等键，以私有文件保存原输入和结果。命令来源、门店、凭据指纹或业务目标不符时不继续写入。HTTP 断连、超时或无法确认结果时保留原身份；再次执行 `commit` 不会盲目重提，只能查询或显式恢复原尝试。状态文件包含业务数据，应保存在运行时私有目录，不上传到代码仓库或群聊。

员工明确业务需求且预览无新增影响时连续办理；对象歧义、未确定事实或新风险决定才需要对话确认。正式提交与业务回读分开判断。执行器的 `businessVerified=false` 是刻意保留的边界：HTTP 成功无法自动代替所有命令各自的金额、库存、会员权益和履约核验，调用者须按业务索引核对。

## 版本化安装到 Hermes Profile

先核对目标 Profile、运行中服务和现有 Skill 清单。仅在已授权的目标 Profile 安装，不触碰 `.env`、配置、会话、记忆、定时任务或 Hermes core。不要用符号链接绕过 Profile 的 Skill 路径约束。

从已提交并验证的精确 Git commit 创建归档，不使用含未提交文件的工作目录打包：

```bash
RELEASE="完整的40位Git提交"
git archive --format=tar "$RELEASE" \
  skills/greenpms-api/SKILL.md \
  skills/greenpms-api/scripts/greenpms.py \
  skills/greenpms-api/references/business.md \
  skills/greenpms-api/references/recovery.md \
  scripts/skills/install-hermes-skill.py \
  | gzip -n > greenpms-api.tar.gz
shasum -a 256 greenpms-api.tar.gz
```

把完整归档上传到该运行用户的私有 staging 目录，核对 SHA-256 后解包。用归档内安装器执行。以下参数均替换为本次明确值；凭据不出现在命令行：

```bash
python3 "$STAGE/scripts/skills/install-hermes-skill.py" \
  --profile "$PROFILE" --source "$STAGE/skills/greenpms-api" \
  --release "$RELEASE" --artifact "$ARCHIVE" --artifact-sha256 "$ARCHIVE_SHA"
```

默认为只读预检。核对预检对象和变化后以相同参数加 `--apply` 安装。安装器核验归档摘要、Git archive 提交、四个源文件和自身字节；安装与回退共享 Profile 锁，拒绝 symlink 路径和并发变化。安装收据、原文件备份与渲染包保存在 Profile 的 `.skill-deployments/greenpms-api/<commit>/`，使用私有权限。

已有 `greenpms-operator` 需要转用通用执行器时，先只读获取其摘要，再追加 `--expected-operator-sha256 "$OPERATOR_SHA"`。安装器只插入通用入口，并纠正“每次顺序读取四个接入接口”和“从 Preview 取 propertyId”这两处旧 API 指引；保留其余运营规则。目标文件摘要变化就停止，不能用重试覆盖他人更新。未提供此参数时不修改原 operator Skill；只读 Skill 始终保留。

源 Skill 使用通用 frontmatter。安装时增添 Hermes 读取的根级 `required_environment_variables`，声明三个既有环境变量；安装器不写变量值。部署后应使用目标机器实际版本的 `skills_list`、`skill_view` 和配置作用域核对加载与环境就绪，不依赖上游新版本行为。

## 验证与回退

部署后检查四个文件摘要、安装收据、原 operator 指引与只读 Skill 保留情况，以及 gateway 仍在运行。通过 Profile 的正常密钥作用域执行 `me` 和按需 `schema CHECK_OUT`，只输出身份权限和 schema 存在性摘要，不输出 Token、认证头或完整凭据文件。默认不重启服务、不清除会话、不代员工办理真实业务。

安装和只读连通成功，不等于真实模型已自动采用 Skill 或业务人工验收通过。使用下一次已获授权的日常业务验证：能够加载执行器；正常流程无需重复四接口接入；只有必要业务问题才追问；正式成功与回读吻合后才报告完成。断连恢复应使用原状态文件，禁止换键重办。

如需撤销本次安装，执行归档内安装器：

```bash
python3 "$STAGE/scripts/skills/install-hermes-skill.py" \
  --profile "$PROFILE" --release "$RELEASE" --rollback
```

回退前校验现有内容和备份摘要，恢复部署前 Skill 与 operator 原文；有后续修改就拒绝覆盖。收据为 `PREPARED` 时，先按收据核对已知文件状态，由安装器恢复；未知状态须保留现场调查，不手改收据使检查通过。

## 开发验证

```bash
python3 -m unittest discover -s skills/greenpms-api/tests -v
node --import tsx tests/helpers/run-database-test-suite.ts -- \
  npx vitest run tests/contract/skill-client.contract.test.ts
```

合同测试仅连接隔离测试库，以受限数据库角色提供本地 HTTPS API；验证真实执行器的报价、建单、入住、退房以及提交成功后丢响应的恢复。测试中的收退款及客房数据均为合成数据。不要将测试连接指向生产库。Skill 前向场景测试与真实模型/群聊验收分别记录。
