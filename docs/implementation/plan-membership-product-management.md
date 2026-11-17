---
title: 可配置会员产品开发清单
created: 2026-11-17
status: implemented-pending-human-acceptance
risk: A
---

# 可配置会员产品开发清单

业务及数据规则唯一依据为 [实施规格](spec-membership-product-management.md)，人工验收及其状态记录在 [主计划](../../待开发项/QinTopia-PMS-分步开发与人工验收计划.md)的 2026-11-17 章节。本清单用于 low effort 分步实施，不重复要求用户批准已明确规则；遇到会改变权益、钱款、归属或验收结果的新冲突，只澄清冲突点，继续独立工作。

用户已授权：本项目新对话使用 low effort 开发，先同步最新代码，完成必要验证、提供人工验收步骤并提交 PR；不合并、不发布。工程已实现，人工验收与真实助手问答仍待执行。每步结束更新真实进度与证据，不把下列待办提前打勾。

## 0. 接手与基线

- [x] 阅读仓库 `AGENTS.md`、本规格及本清单；保留已有文档分支和他人未提交工作。核对 `git status --short --branch`、`git worktree list`、远端及其他任务占用。
- [x] 执行 `git fetch origin`，核对当前提交与 `origin/main`。根目录可安全处理时先将 main fast-forward 到最新远端，再把最新 main 合入本任务分支，保留规格提交。已同基线时无需重复合并；不 reset、不丢文档、不新建 worktree。
- [x] 本文准备时基线 `02c81a7`、最新迁移 082。若远端更新，核对相关规格和实现差异，采用下一空闲迁移号；不要机械使用 083 或改旧迁移。
- [x] 验证 Node 22 / npm workspaces；依赖未安装或 lockfile 变化时运行 `npm ci`。数据库和浏览器验证只使用明确的本地合成数据库，遵循现有全局测试锁，绝不把测试／reset 指向生产。

接手记录（2026-11-17）：`git fetch origin` 成功；main 与 origin/main 均为 `02c81a7`，任务分支 `d0e9b86` 已包含该基线，无需切换或合并。唯一 worktree 为项目根目录，接手时干净；原对话明确交接后不再修改。已找到缓存 Node 22.23.2。数据库使用本任务本机 PostgreSQL 18.6（127.0.0.1:55432），只建立合成测试库，使用现有锁 runner。

验证环境发现：根目录 Vitest 会扫描 `.local-workspace` 中历史源码快照，首次日期定向运行当前文件 19 项通过，但历史快照出现 24 个加载失败；保留历史资料，后续用不含归档资料的源码验证副本执行原有检查，不修改测试入口或发现配置。验证副本的 @qintopia workspace 依赖独立指向副本内源码；曾因指向主目录导致测试时钟双模块，已修正并通过原失败日期用例复验。

## 1. 日期规则与公开契约

- [x] 将期限类型由固定 `P1Y` 扩为正整数月／年，建立单一日历计算函数和测试；覆盖规格例表、直接加 N 月、非法期限、溢出、包含到期日。保留旧 `P1Y` 结果。
- [x] 参考 `packages/contracts/src/room-catalog.ts` 新增会员目录输入／输出契约；管理命令仅 CREATE、UPDATE、SET_SALE_STATUS 三种操作。复制复用 CREATE。
- [x] 在 `packages/contracts/src/index.ts` 注册命令并导出契约；统一当前目录、历史版本、期限和 revision 类型。
- [x] 同步 `apps/api/src/schemas.ts` 输入、Preview 效果及 Confirm 结果三个 union 和相关响应 schema；不能只改 TS 类型。

完成标志：契约可编译，非法月／年与客户端伪造业务字段被明确拒绝；无泛化规则引擎或无需求字段。

## 2. 数据库与迁移

- [x] 新迁移建立 `membership_product_catalog`，code 全局唯一；归属和 code 不可变、不可删除；current 指针同 code；新版本与首个头可同事务建立，提交时检查完整性。
- [x] 保留 `membership_products` append-only，不给旧产品增加可改归属或修改其业务字段。新版本、目录头、审计写入在受控函数／既有命令事务内完成。
- [x] 仅向 `membership_orders` 新增不可变期限快照，旧行为默认 `P1Y`；`historical_membership_backfills.validity_period` 已存在，只扩展原约束、写入和守卫。新订单 INSERT 必须与真实 product ID 的期限一致，UPDATE 不得改快照；不靠默认值掩盖漏写。不重算旧日期、成交额、余额，维持存量回执兼容。
- [x] 实现三种迁移结果：空库成功、唯一归属存量升级、歧义原子失败；owner-only 模板初始化放在 `packages/db/src/seed.ts` 创建门店后、创建会员订单前，幂等不重置销售状态。
- [x] 更新 `packages/db/src/schema.ts`、`packages/db/src/database.ts` 的命令 CHECK／角色权限／readiness 接入；参考 `room-catalog-readiness.ts` 校验实际数据库结构与受控函数权限。更新 `membership-scope-readiness.ts` 的相关预期，不能去掉原保护来过检。
- [x] 参照 061 迁移在同一事务登记 `command_catalog`、ADMIN 的 `staff_command_profile_catalog`（`token_default=false`），回填已有管理员的 `subject_command_grants` 并重算 `staff_profile_reconciliation_state.projection_hash`；不能只改 TS 权限而让存量管理员缺权限或投影校验失败。
- [x] 新增 `tests/integration/membership-catalog-migration.integration.test.ts`：全新 migrate→seed、旧业务升级、歧义失败无残留、旧事实保持、runtime 不能直接篡改或初始化。已有合成 seed 的特殊日期／数量不应被当成所有产品规则，也不借本次迁移重写存量事实。

完成标志：在隔离 PostgreSQL 上按真实迁移顺序验证，owner／runtime 分别通过正反例，旧产品和业务事实对比留证。

## 3. 管理命令、权限与并发

- [x] 参考 `packages/db/src/room-catalog.ts` 新建会员目录实现；Preview 计算完整前后差异，Confirm 持锁重新校验目录及房型版本。先约定统一锁序，再接入所有竞争路径，避免销售／房型管理锁序倒置。
- [x] 完成全部注册：`packages/domain/src/command-permissions.ts`、`packages/db/src/command-authorization.ts`、`packages/db/src/commands/service.ts`、`effects.ts`、`apply.ts`；覆盖 ADMIN SESSION 门禁、权限展示、Token 有效权限过滤和 Token 签发拒绝。
- [x] 新版本追加、头切换、revision 与审计原子提交；版本分配受锁保护。冲突、无效房型、越权不得留下半个版本；同 Confirm 重试不重复产生版本。
- [x] 新增 `tests/integration/membership-catalog.integration.test.ts`，验证新增／编辑／停售／恢复、并发编辑、跨店引用和指针伪造、普通员工／Token 拒绝、权限撤回、事务回滚与原回执恢复。

完成标志：受限运行角色通过全部正反例；管理成功不等于只写了一张表，审计、回执及重读一致。

## 4. 完整业务接入

- [x] 新售查询按 property + ON_SALE + 当前版本；历史查询按原产品或快照。查询入口注册在 `apps/api/src/server.ts`，参考 `apps/api/src/room-catalog.ts`，不要寻找不存在的 app.ts 入口。
- [x] 修改 `/api/v1/meta`、`packages/db/src/members.ts`，解决当前产品过滤与历史详情混用；所有结果遵循门店授权，不泄露别店目录。
- [x] 在 `packages/db/src/commands/effects.ts` 和 `apply.ts` 覆盖普通建单／收款／生效、在住升级。新售预览锁定产品 revision，Confirm 遇停售／编辑拒绝；已有 DRAFT 始终按原快照继续办理。
- [x] 在 `packages/db/src/commands/member-corrections.ts` 及实际相关 SQL 函数中覆盖历史补录、日期更正、作废重建，期限来自对应快照；历史版本查询独立于新售查询。
- [x] 复核报价、预订、入住、续住、换房、取消、释放和核销各入口的房型范围／总夜数／期限；使用现有账本，不制造新的扣夜或退费协议。
- [x] 复核 `packages/db/src/room-catalog.ts` 及数据库房源守卫：当前房型删除的全局会员产品查询须经 code 关联目录头限定本店，保留本店历史版本保护；补两门店相同房型 code 不互相阻断的回归。停售后仍有历史权益时，房型删除／最后可用房源移除等原有保护不失效。多 BED 房型共享额度不扩大跨房型换床能力。

完成标志：20 夜／6 个月产品至少走通普通办理、在住升级、历史补录；旧 DRAFT／ACTIVE 在编辑和停售后仍正确，余额与有效期不追随最新商品。

## 5. 页面和同版本助手知识

- [x] 新增会员产品管理页，接入 `apps/web/src/pages/SettingsPage.tsx` 及现有路由；复用 `RoomCatalogPage.tsx` 的表单、核对、回执与恢复模式。
- [x] 同步 `apps/web/src/types.ts`、API 读写封装、`MembersPage.tsx`、`OrderDetailPage.tsx` 和相关管理员表单；显示动态产品、房型名、总夜数和月／年；可见权限与后端一致。
- [x] 在 `apps/web/src/command-shell/commandShellState.ts` 接入 U1 命令及成功／恢复文案；在 `apps/web/src/ui.tsx` 接入输入与 Preview 证据绑定、核对摘要、结果回执和变更原因区。浏览器覆盖缺失／伪造预览证据必须拒绝，以及丢回执按原身份恢复；新增页面本身不代表这些门禁已经接入。
- [x] 覆盖 loading／empty／error／conflict、停售价签、复制表单、历史查看、手机布局、键盘及返回修改；禁止结果未知时以清缓存或新键重做脱困。
- [x] 更新 `packages/contracts/src/assistant-knowledge.ts`、`assistant.ts` 及 `apps/api/src/assistant-prompt.ts` 的实际输入。管理命令纳入覆盖清单；当前产品数据来自本门店目录，规则知识不写死四种产品／30 夜／一年。
- [x] 新增相关普通知识测试、`tests/contract/membership-catalog.contract.test.ts` 和 `tests/e2e/membership-catalog.spec.ts`。未知产品或旧停售版本不显示为其他房型；普通员工无管理入口且直接请求也被拒绝。

完成标志：桌面／手机能完整新增、编辑、停售、办理、查看旧会员；自动知识检查与真实模型问答状态分开。

## 6. 验证矩阵与执行方式

| 验证面 | 必须证明 |
| --- | --- |
| 旧产品 | 四种原产品的售价、单位、30 夜、P1Y、房型集合和历史余额不变；2800 元是共享一份 30 间夜 |
| 配置与销售 | 20 夜／6 个月产品默认价格和期限正确；标间 5 晚 + 大床 3 晚剩 12，共一份合同／Lot；同类 BED 范围独立验证 |
| 修改与停售 | 已建 DRAFT、ACTIVE 均保留原五字段；新单用新版本，旧销售预览确认失败；停售后旧会员详情和履约可用 |
| 日期 | 月末、跨年、闰日、N 月直接相加、到期日可用／次日不可用；普通／升级／补录／更正与 SQL 一致 |
| 事务与权限 | 并发编辑／销售停售竞争确定排序；跨店、混合 ROOM/BED、无效房型、Token／普通员工拒绝；幂等／丢回执恢复无重复版本或权益 |
| 迁移与运行 | 空库→seed、存量升级、异常归属原子失败；runtime 权限及 readiness、旧事实保持、房源保护 |
| 前端及助手 | 当前目录与历史读取分开，手机／桌面一致；助手解释权限、共享额度和旧会员规则，未知实时事实不编造 |

优先运行受影响的现有回归：`membership-orders`、`admin-membership-corrections` 及其 migration、`stay-collection-membership-conversion`、`cancel-membership-order`、`room-catalog`、权限、通用会员 API、跨房型升级。按实际修改依赖选择，不将无关已有失败冒充本次通过。

定向数据库测试使用现有锁 runner；以下为本清单约定新增文件建好后的命令：

```bash
node --import tsx tests/helpers/run-database-test-suite.ts -- npx --no-install vitest run tests/integration/membership-catalog-migration.integration.test.ts tests/integration/membership-catalog.integration.test.ts
npm run build
node --import tsx tests/helpers/run-database-test-suite.ts -- npx --no-install vitest run tests/contract/membership-catalog.contract.test.ts
```

不要把文件参数追加到 `npm run test:integration -- ...` 来冒充定向运行：脚本已包含整个目录，会扩大范围。不要绕过锁 runner 或手工设置 lock-held 标记；不要同时跑共享测试库的多个命令。

提交前执行适用的完整检查并记录结果：

```bash
npm run release:check
npm run typecheck
npm test
npm run test:integration
npm run test:contract
npm run test:e2e
npm run build
node --test scripts/check-pr-tests.mjs
```

`test:contract`／`test:e2e` 已包含其必要构建；前面已有同提交有效构建结果时不为清单重复构建。测试使用隔离合成数据库；E2E 的现有 setup 会准备／改写测试数据，执行前核对连接目标。新增用例遵循现有 `*.test.ts`、`*.integration.test.ts`、`*.contract.test.ts`、`tests/e2e/*.spec.ts` 命名，直接被既有入口发现；不改工作流、package scripts、发现范围或保护要求。`test:catalog-management` 只发现既有房型用例，不能替代新会员验证。

当前 CI 不运行 PostgreSQL integration、contract 和浏览器 E2E；这些本地证据必须单列。环境阻塞、基线已有失败和本次引入失败分开记录；适用必要检查通过后不无故反复扩大验证。

## 7. 人工验收与 PR 交付

- [x] 在主计划填写工程状态，提供本功能三组具体人工验收步骤、合成账号／可访问环境、操作、预期结果与尚未验证项；用户未反馈前保持“待人工验收”。真实助手问答单列，不以模拟模型代替。
- [x] 复核最终 diff 和业务不变量，尤其迁移、旧 DRAFT、停售、门店边界及 SQL／TS 日期一致性。low effort 不降低验证要求；复杂失败要重新定位原因，不能删测试、弱化门禁或扩改 CI。
- [x] 按 `docs/repository-contributing.md` 和 `.github/PULL_REQUEST_TEMPLATE.md` 提交并创建 PR；概述功能结果、同版本知识、实际验证和回退限制。将本规格与清单随功能一并提交。
- [x] 创建成功后在**新开发对话**调用 `attach_artifact` 关联 PR，并用 `list_artifacts` 回读仓库与 URL；工具受阻明确标记关联未完成，不以回复链接代替。
- [x] 检查实际 PR／CI 状态，交付 PR 链接、提交、验证结果和人工验收步骤；**保持未合并、未发布**。如果没有生产写入或真实人工反馈，必须如实报告。

本清单的完成范围止于可审阅 PR 与验收交付，后续合并／生产发布需要对应授权；不增设后台监控任务。

## 2026-11-17 工程验证记录

已实现迁移083、管理员命令、当前／历史目录、不可变订单期限、完整销售与纠错接入、手机／桌面页面和同版本助手知识（2026-11-17.1）。没有修改 CI、测试发现入口、package scripts 或保护要求。

- 最终Typecheck、构建／release:check、PR格式8项通过；普通测试141文件2261项全部通过，包含最终知识措辞、提示词长度及既有历史统计知识门禁。
- 最终新增目录迁移／事务／并发与HTTP／OpenAPI定向检查4文件43项通过；新旧会员浏览器检查桌面／手机7项通过、1项重复协议检查按设计跳过。覆盖新增20夜半年产品、编辑、停售、复制、旧DRAFT继续收款生效、伪造预览拒绝和原身份恢复。
- 完整集成首轮967通过41失败；修正本次权限矩阵和本地清理外键闭包、为企微支付套件使用要求的合成库名后，剩余7项在main `02c81a7`全部复现（旧迁移夹具、历史统计预期、临时安置并发等待）。完整契约首轮252通过4失败，OpenAPI分支断言修正并复验；其余3项在main复现（旧迁移计数、旧Receipt缺commandType）。不宣称全量通过。
- 全量E2E出现连续失败后停止：34通过、12失败、1中断、2跳过、451未运行。员工停用及房型变更后旧报价夹具4项在main复现，其余失败未全部归因；完整浏览器回归仍有缺口，不以定向成功替代全量成功。
- 人工环境：[会员产品页](http://127.0.0.1:4181/settings/memberships)，本机合成账号admin／operator，密码均为demo-pass-2026。API4111，独立合成库，不随测试reset清空。已备1800元20间夜6个月双房型样例；桌面及390px手机截图已检查。
- 日志、main对照源码、截图及本地交付记录保留于已忽略的`.local-workspace/membership-product-management/`。人工业务验收与真实付费模型问答未执行，生产未连接／未写入。

交付：已创建[Draft PR #153](https://github.com/qintopia-agent-studio/GreenPMS/pull/153)，已在开发对话关联并回读确认仓库与URL；保留Draft供审阅。在线检查的最终状态与提交记录在本地交付记录及对话，不代表人工验收通过。

### 2026-11-17 UI反馈修订

按用户反馈使用 finesse-ui 审阅并调整本页：修复房型勾选框被通用输入样式撑大的问题；沿用系统颜色、字体、弹窗和InfoHint；补充说明移入悬浮提示；产品卡突出售价和销售状态，去除重复名称；历史默认折叠，与上方留32px（手机24px）间隔，展开后标明产品名称。刷新／新增置右，导航顺序为房型与价格→会员产品。取消编辑清空原因，返回修改仍保留。

本轮样式仅位于会员页专用CSS，未改全局样式、共享控件、后端业务、数据库迁移或CI。已核对运行时知识：功能入口、权限和业务语义未变，沿用同PR的2026-11-17.1知识；无需新增操作规则。

验证：8个集成文件250项通过（原会员办理、纠错、升级、取消、房型与权限及目录迁移）；通用核对／恢复／助手4文件255项通过；桌面手机浏览器9通过1设计跳过，含取消草稿后原因不串用。构建、类型检查通过。实页检查320／375／414／768无水平溢出，复选框18px且整行可点，提示完整可见；历史默认折叠、间距及导航顺序已读回。finesse静态检测无P0；TSX文件无内联CSS的stamp提示不适用，stamp在独立CSS中。

本轮UI状态为“已实现，待用户反馈”；原人工业务验收、真实助手问答、完整E2E历史缺口维持原状态，不因此标记通过。以上数据库证据来自本机PostgreSQL18，发布前仍需按发布流程验证目标环境兼容性。
