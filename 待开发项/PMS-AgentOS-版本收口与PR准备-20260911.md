# PMS 与 Agent OS 联合验收：版本收口与 PR 准备

日期：2026-09-11。状态：本地可审阅 PR 材料准备完成；未推送、未创建远端 PR、未合并或发布。范围仅为已验收 B 切片及最终 A 兼容回归的版本归档，没有重新开发 Webhook。

## 固定版本与持久引用

PMS 分支：`codex/pms-agentos-joint-acceptance-20260911`。独立工作区 `/private/tmp/green-pms-joint-20260911` 保留；提交对象和分支引用位于原项目的持久 `.git`，可从该分支重新创建工作区，不依赖临时目录中的源码文件。当前材料随本分支后续归档提交保存；准确 HEAD 以交付消息及 `git rev-parse HEAD` 为准，不手工升级应用版本或创建 release tag。

| 固定提交 | 内容 |
| --- | --- |
| `4b598c61fc5af04ee9c5951f4f09d6ab409bf55f` | 验收起点；v1.3.2 支付 readiness 指纹修复 |
| `4d71a1ac119b4c3fad0cd5b2570d81ec56809114` | PMS 两处兼容修复、两处 OpenAPI 声明/夹具同步、联调工具与 v2 完整19项证据 |
| `d1d13ae36c58e1e2b3fc58e4950ca3d1a3541cbf` | 最终 A 的4项共享构建/迁移兼容回归及独立证据 |
| `43ece6dc0e0cdd26202c27b43fa5758daab16e36` | 当时跨任务回传被拒的历史记录，不含业务改动 |

负责人转交的决策复核 `qintopia-agent-os/docs/reports/2026-09-11-pms-agentos-joint-acceptance-review.md` 已确认最终 A 状态通过共享计划对齐。此前回传受阻不再是待办，本次没有重新发消息。

[版本索引](../docs/implementation/evidence/pms-agentos-joint-20260911/version-index.json) 记录 PMS 提交、关键文件hash和两端程序hash。两份**原始字节**源码清单已归档本仓：

- [Agent OS v2 清单](../docs/implementation/evidence/pms-agentos-joint-20260911/agentos-v2-baseline.json)：152文件，SHA256 `56cc9ee18f93eabd6be177f73be7ca523cd5f91f5105e4f63069e59ca05da291`。
- [Agent OS 最终 A 清单](../docs/implementation/evidence/pms-agentos-joint-20260911/agentos-a-final-baseline.json)：162文件，SHA256 `ea995750d41e039f2af0cd0661d65700fb7ecf2e0058cdbf9d5f274e19cde35d`。

清单只含文件名、长度、hash及来源身份，不复制 Agent OS 源码或另立共同协议。它们对应源 HEAD 加明确未提交快照，不能用旧 HEAD 独自复现。Agent OS 责任方仍需将精确源码纳入其长期版本管理并建立“提交→清单”映射；PMS 不代为提交兄弟仓库。现有冻结副本和二进制保留供复跑，清单本身不替代源码/程序备份。唯一共同协议hash为 `77a055c7e252884dc4e61fcadd4da49e968c194587fce75cd43e6c6eb4b91512`。

## 远端核对与改动范围

只读查询 origin 分支、全部当前21个PR（含已关闭/合并）、提交关联PR，并 fetch main。观察到 main 为 `7c755a7cfdd7fb38299711ef18d96f0189c7012c`；没有本切片同名分支或PR。上述三个本切片提交的 GitHub API 查询均返回422“commit not found”；`git cherry origin/main HEAD` 也确认三个补丁未等价合入。已有开放版本 PR #6（1.3.3）由 Release Please 管理，与本切片PR不同，不创建重复版本PR。

相对验收起点，main 新变化集中在发布 harness、Docker构建上下文、回退策略和企业微信Worker部署。它们与本切片文件无交叉。本地 `git merge-tree --write-tree` 对固定main的合并预演无冲突；该命令只生成Git对象，不合并分支或修改工作区。保留验收提交身份，不将远端的生产配置改动混入本切片；未来PR合并结果仍由必需CI检查。

本切片精确范围：

| 类别 | 文件与行为 |
| --- | --- |
| 运行代码（3文件） | `apps/api/src/integration.ts`：feed过期时准确410；`packages/db/src/external-payments-readiness.ts`：接受两个已有精确指纹；`apps/api/src/external-payments.ts`：补现有500错误响应声明 |
| 既有测试（3文件） | `tests/integration/integration-events.integration.test.ts`：真实HTTP410；`tests/integration/external-payments.integration.test.ts`：受限runtime就绪与触发器漂移拒绝/恢复；`tests/contract/openapi.contract.test.ts`：补既有refundReference字段 |
| 联调工具 | `tests/joint/`：专用容器门禁、真实API/Worker/接收器、HTTPS及故障代理、19项全链和4项限定回归、说明与临时报告忽略规则 |
| 文档与归档 | 验收记录、P01—P08状态、分步计划、脱敏失败/成功JSON、两份清单及版本索引、README版本纠正、本记录和PR标题正文 |

不含迁移、锁文件/依赖、共同协议、Agent OS源码或生产配置变更；不改已确定的单物业READ权限取舍。此次版本收口仅补文档和清单，前述10个关键PMS运行/联调文件与最终19项证据hash一致。

## 数据库目标与发布前缺项

| 依据 | 可以作出的结论 |
| --- | --- |
| 本轮19项与4项机器报告、隔离夹具 | 联调实测PostgreSQL 18，不能外推为16已验收 |
| `packages/db/src/integration-readiness.ts` 开头及指纹实现 | 事件指纹冻结于PG18；包含pg_get_constraintdef/indexdef/triggerdef/functiondef等输出，不能仅凭SQL可执行就假定跨主版本hash相同 |
| [v1.3.2发布记录](../docs/releases/v1.3.2.md) | 既有发布证据明确写生产迁移后为PostgreSQL **18.4**，并经只读诊断取得部署指纹；本轮没有现场复核服务器 |
| [企业微信实施规格](../docs/implementation/spec-wecom-external-payments.md) 本地验收段 | 既有记录显示PG16与事件冻结指纹不兼容，转用PG18；不能写成PG16只是“尚未跑测试” |
| `compose.yaml`、README启动示例 | 本地默认镜像仍为16-alpine，是未对齐的开发入口；本次只纠正README“始终PG16”的概括，不修改Compose或升级库 |
| `compose.server.yaml`、发布runbook | 生产依赖外部TencentDB，应用Compose不声明数据库镜像；默认本地镜像不代表生产版本 |

发布候选目标按**既有生产记录的PG18.4**准备，状态为“有既有证据、待当次目标核实”，不是本轮直接探测到的当前版本。获准发布前只读核对目标 `server_version` / `server_version_num`、迁移集合/hash、实际受限角色readiness和两个指纹；只留版本、结果与校验值，不保存连接信息或业务数据。

若目标仍是18.4且既有证据不能覆盖其具体版本/结构差异，再补与目标一致的隔离新安装/readiness及受影响事件验收；若确需16或其他主版本，先界定该版本结构差异并完成明确兼容修复/验收，不能加宽指纹或关闭校验来通过，更不能把升级数据库视为本PR附带动作。PG16默认入口的统一需在明确支持矩阵后单独落实，本PR不宣称其可直接运行当前事件模块。

## 检查与可审阅 PR

本次只读重核314个Agent OS文件、两份清单、两个可执行程序及10个PMS关键文件hash。没有启动数据库、重建夹具或复跑已通过全链。沿用原始记录的v2 **19/19**与最终A **4/4**，不相加为“最终版23项全链”。既有事件23项、单元1135项、类型/构建/release检查及readiness/OpenAPI分批结果见[完整验收记录](./PMS-AgentOS-事件联合验收-20260911.md)。

针对新增PR材料执行项目PR校验器8项及实际标题正文验证；新增/改动文档的本地链接、JSON、清单hash和diff静态检查通过。远端 `PR format` 和 `Node and release checks` 尚未触发，不能把本地通过写成GitHub通过。无相关代码变更或新缺陷，不重复跑数据库套件。

准备交付文件：

- [PR标题](../docs/plans/pms-agentos-joint-pr-20260911/title.txt)：`fix(integrations): 修复事件补偿响应与新安装就绪检查`
- [PR正文](../docs/plans/pms-agentos-joint-pr-20260911/body.md)：按“改动说明 / 验证结果 / 风险与回退”模板完成。
- head分支为本记录开头的独立分支，base为main。实际创建前再次查是否已有相同PR并核对main变化；只在另行外发授权后推送并创建草稿PR。本次不执行这些远端写动作，也不等待重复的跨任务回传。

## 发布与回退

本切片不手动选择版本号；业务PR以后获准合入时，由现有Release Please更新版本PR。GitHub Release的Publish仍是独立生产批准点，不能由“准备PR”推导发布授权。

以本次只读获取的main发布runbook为准：向前切换要求实际迁移基线与目标manifest一致；直接回退要求当前和目标均为same-migrations-only，任一forward-only则拒绝。旧工作区runbook尚未带入main后来修订，不能据其旧措辞判断真实回退许可。本切片无新增迁移，但仍要核验最终待发布镜像与现网完整迁移集合。

如未来发生事件消费异常，先按已有受控入口暂停投递并核对在途回执，保留Outbox、水位、Inbox、原event_id/body；恢复从原记录继续。应用回退使用harness中已有成功且迁移兼容的版本，不删除事件、不回退数据库。本修复撤回会重新出现410变500与新安装拒绝，优先前向修复。main现已管理企业微信同步Worker随应用部署；不能将其与本切片的事件投递Worker混为一谈，本次均未启用或变更。

后续门禁仍包括生产域名/TLS、READ权限范围、签名与密钥轮换、规模/24小时积压、保留与灾备，以及身份/审核/群路由/完整真实欢迎验收。B版本收口不启动C/D、不启用真实投递，不修改Base/Workflow/Hermes或真实PMS。
