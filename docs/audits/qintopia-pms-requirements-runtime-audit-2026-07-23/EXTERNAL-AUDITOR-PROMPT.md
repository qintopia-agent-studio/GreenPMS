# QinTopia PMS 第二智能体独立审计提示词

这是交给另一位智能体的唯一入口文件，可以原样发送。该智能体应按本文自行读取其余审计包和源文件，在同一项目目录中只读审计，并把结论返回给用户，不得实施修复。

```text
你是一名独立、对抗式的产品领域与软件架构审计者。请审计当前 QinTopia PMS 项目的需求范围、业务不变量、运行逻辑、权限、数据完整性、测试证据和交付计划。

工作目录：
/Users/feather/Documents/Codex project/Green PMS

本轮只做只读审计。禁止修改业务代码、数据库、API、测试、UI、需求原文或 Git 状态；禁止提交、推送或创建 PR。不要读取 .git 历史，不要搜索、读取或复制任何旧 PMS、FewohBee、其他仓库、历史数据库或外部实现。当前目录是唯一证据范围。

用户当前实施门禁：
1. 先讨论并审阅完整计划。
2. 只有用户明确说“开始实施”后才能开发。
3. 当前主计划和 90 天规格均已标记 `implementation_authorized: false`；任何历史文档里的 `done` 或“直接实施”都不能覆盖该门禁。

先阅读以下审计包，但把它们视为待质疑的第一轮结论，不是事实权威：
- docs/audits/qintopia-pms-requirements-runtime-audit-2026-07-23/AUDIT-REPORT.md
- docs/audits/qintopia-pms-requirements-runtime-audit-2026-07-23/EVIDENCE-MAP.md
- docs/audits/qintopia-pms-requirements-runtime-audit-2026-07-23/MANIFEST.md

然后独立阅读并抽样核对至少以下源文件：
- 待开发项/房态与订单运营流程分步开发计划.md
- 待开发项/房态90天连续时间轴与超长住宿开发规格.md
- docs/implementation/spec-qintopia-pms-core-operations-mvp.md
- docs/implementation/room-status-ui-development-goal.md
- docs/implementation/room-status-grid-implementation-spec.md
- docs/implementation/spec-guest-nickname-bed-occupancy.md
- docs/architecture/invariants-and-decisions.md
- docs/pricing-facts/qintopia-2026-building-room-bed-price-catalog.md
- README.md
- packages/contracts/src/index.ts
- packages/domain/src/pricing.ts
- packages/domain/src/operational-facts.ts
- packages/db/src/pricing-service.ts
- packages/db/src/schema.ts
- packages/db/src/orders.ts
- packages/db/src/room-status.ts
- packages/db/src/commands/effects.ts
- packages/db/src/commands/apply.ts
- packages/db/src/commands/service.ts
- packages/db/src/migrations/001_initial.sql
- packages/db/src/migrations/009_booking_channels_and_transaction_references.sql
- packages/db/src/migrations/011_core_fact_shape_guards.sql
- apps/api/src/schemas.ts
- apps/api/src/server.ts
- apps/api/src/auth.ts
- apps/web/src/pages/InventoryPage.tsx
- apps/web/src/pages/OrderDetailPage.tsx
- apps/web/src/room-status/
- tests/

审计目标：

A. 判断产品核心是否内聚，哪些复杂度是 PMS 正确性所必需，哪些已经形成范围膨胀、重复建设或过度工程。

B. 找出需求之间的冲突。必须区分：
- 用户已确认的最新事实；
- 旧历史基线；
- 尚未确认的经营决策；
- 当前代码实际行为；
- 第一轮审计者的建议。

C. 找出需求与当前实现的差距。不要把文档写 done、测试文件存在或历史测试数量当作已实现证据。

D. 审计完整运行旅程：
- 可售查询 -> 金额试算/报价 -> 创建正常或免费订单；
- 可选会员覆盖 -> 冻结 -> 入住核销 -> 续住/缩短/取消；
- 入住 -> 提前退房/正常退房 -> 清洁 -> 再次可售；
- 续住、缩短、换房的累计计价、库存和 amendment/revision；
- 多笔收款、引用原收款退款、冲销，以及每笔新 COLLECTION/REFUND 对本次依据 pricing revision 的不可变追溯；
- 外围 Token 的 READ/WRITE、Preview/Confirm、幂等、Receipt 和中断恢复。

E. 特别挑战以下第一轮判断，不要默认同意：
1. 15 阶段是否真的过重，还是风险所需。
2. 90 天时间轴是否属于核心，应该放在什么顺序。
3. 用户已确认“整个 Stay 作为选择容器 + 内部保留 amendment/segment 审计边界”；不要重新询问是否采用该模型，但要挑战计划与代码能否在续住、缩短和跨房换房中忠实实现且不混淆当前行程与历史。
4. 自动显示金额是否应使用无持久写入的试算 Query，而正式 Quote 延后到订单概述。
5. 待清洁是否应与夜间可售拆分。
6. 提前退房是否必须原子执行缩短、重价和退房。
7. 一名会员多合同/Lot 是否需要跨合同覆盖，还是业务上应限制为一份有效合同。
8. 已确认规则是 CHECK_IN 时一次核销本次住宿已冻结的全部权益，入住后普通缩短不恢复已核销权益；不要把该规则重新列为待确认问题，但要审查代码是否忠实实现，以及它对提前入住、提前退房、入住后缩短和在住续住的业务后果是否被文档与 UI 清楚表达。
9. 物业 READ Token 读取完整身份证、手机号、微信号和昵称是否合理。
10. 自建测试进程监管器是否真的属于过度工程。
11. 免费入住已有真实住客、零金额、不使用会员权益等确认事实，但它与内部占用的精确经营分类仍未确认；检查现有计划是否错误地把某套分类方案写成既定事实。
12. 用户已确认每笔新 COLLECTION/REFUND 由服务端自动关联本次操作依据的 pricing revision，REFUND 同时引用原 COLLECTION；不要重新询问是否需要关联，但要审查关联的同订单约束、陈旧 Preview、历史 null、多个分次事实和非结算语义。

F. 必须检查以下容易遗漏的逻辑边界：
- 提前入住、逾期入住、提前退房、逾期未退；
- 在住订单追溯缩短或追溯换房；
- 当前有效行程与不可变 segment 快照链是否被混用；
- 免费订单渠道 null 与现有数据库触发器；
- `bookingChannelCode=WECOM` 时渠道订单号为 null，但每笔 COLLECTION/REFUND 仍有各自外部交易单号；两类引用不得混淆；
- 免费入住与内部占用的分类边界是否仍被如实标为开放决策；
- 创建订单时人工目标价是否原子；
- 正常创建不填人工原因与 Confirm reason 合同；
- 会员跨合同分配和并发锁顺序；
- 历史 completed 日期是否错误显示 IN_HOUSE；
- 房态 allowedActions 是否足以驱动订单操作；
- 自动 Quote 的永久数据增长；
- 清洁任务是否真的影响 availability；
- 跨表 Order/Property/Contract/Lot 归属是否有数据库约束；
- COLLECTION/REFUND 的 method 是否属于已确认事实；
- COLLECTION/REFUND 是否能从 pricing revision 追溯到原始预订、续住、缩短或换房，且不会被误解为会计分摊；
- 工作人员 UI 与外围智能体 API 是否错误共用技术文案；
- 全昵称、可变行高和 90 天虚拟化是否存在不可接受的性能/无障碍代价。

G. 必须单独完成“工作人员用户旅程与使用体验审计”。主要使用者是登录 PMS 的工作人员，不是会员本人、住客自助用户或外围智能体。不要只评论配色和视觉偏好，应审计工作人员能否正确、快速、可恢复地完成任务。

至少逐条审计以下旅程：
1. 空白房态拖选或侧栏输入日期 -> 自动显示住宿金额 -> 创建正常住宿 -> 查看订单概述 -> 一次人工确认；
2. 创建免费入住，包括真实入住人、免费类型和原因，以及不出现渠道、会员和金额输入；
3. 正常订单默认不显示会员字段 -> 勾选“会员入住” -> 搜索并选择会员 -> 查看权益覆盖与现金余量 -> 创建；
4. 点击已占日期或昵称 -> 选中完整 Stay -> 查看当前住宿安排、原始预订与变更边界 -> 找到当前合法操作；
5. 办理入住 -> 在住 -> 办理正常/提前退房 -> 待清洁 -> 恢复可售；
6. 续住、缩短和换房，包括累计计价、手工目标价的按需字段、变更原因，以及对应补收/退款入口；
7. 取消和未到，包括库存与会员冻结权益释放、不可用动作隐藏和结果反馈；
8. 原始预订/续住分次收款 -> 缩短后引用原收款退款 -> 冲销；检查 WECOM 渠道订单号与逐笔资金交易号不会混淆；
9. 90 天内跨窗口拖选、边缘自动滚动，以及超过 90 夜通过侧栏输入并处理窗口外冲突；
10. 网络中断、重复提交、陈旧 Preview、权限不足或库存冲突后，工作人员确认已执行/未执行/未知并恢复下一步。

每条旅程必须检查并记录：
- 使用目标、入口、前置状态和完成标志；
- 当前页面实际显示的必填、可选、条件显示和应隐藏字段；
- 工作人员主动操作次数及确认次数，是否存在重复选择、重复录入、重复确认或无业务价值的中间页；
- 加载中、空状态、成功、校验失败、业务冲突、权限不足、陈旧数据和网络中断反馈；
- 操作后下一步是否明确，返回房态或详情时日期、筛选、滚动、选择和焦点是否保留；
- 是否要求工作人员理解内部枚举、英文计价行、JSON、Quote/Preview/Confirm/Receipt、Claim 或任何内部 ID；
- 字段是否遵守渐进显示，例如未勾选会员时不显示会员搜索，免费入住不显示渠道，未启用人工改价时不显示原因；
- 鼠标、键盘、触控、屏幕阅读器、桌面、平板、移动、320 CSS px 和 200% zoom 的任务可完成性；
- 发现属于已确认需求未实现、真正的业务开放决策，还是可逆 UX 建议。不得把个人审美偏好升级为业务事实。

服务端 Preview/Confirm、幂等、Receipt 和中断恢复是 API 可靠性要求。审计重点是工作人员 Web 是否把它们整合成自然的一次业务确认和可理解的恢复反馈，不能为了减少页面步骤而建议删除底层协议。

本轮默认不得启动服务或运行浏览器。没有当前运行证据时，必须把结论写成“源码/规格审计结果”，把实际点击、布局、焦点、缩放和辅助技术效果列为待人工或浏览器验证，不得宣称已经实测。

证据要求：
1. 每个结论至少给出一个文件和准确行号；重要冲突必须同时引用需求和实现。
2. 无法从当前目录验证的内容明确写“未验证”，不得补写业务规则。
3. 不读取 Git 历史，不把 commit message 当证据。
4. 默认只使用 `rg`、`sed`、`find`、`wc`、`git status --short` 等不会修改工作树或数据库的检查。不要运行 build、test、integration、contract、E2E、migration、seed、reset、backup/restore 或启动服务；这些命令可能生成文件、重建测试库或改变运行态。需要运行其他命令时，先取得用户明确授权，否则直接记录测试缺口。
5. 至少提出 10 个具体发现；没有问题的领域也要说明残余风险。

请用中文输出，按以下结构：

1. 执行摘要
- 项目是否存在需求过度膨胀：是/部分/否，并说明理由。
- 当前是否适合开始实施：是/有条件/否。
- 最严重的三个风险。

2. 对第一轮审计的异议
- 哪些结论同意。
- 哪些结论不同意或证据不足。
- 第一轮遗漏了什么。

3. Findings
按严重度排序。每项必须包含：
- ID 和严重度；
- 类型只使用：已确认冲突/开放决策/实现差距/范围治理/可接受复杂度；安全和测试影响写入“实际业务影响”，不要另造分类；
- 需求证据；
- 代码或运行证据；
- 实际业务影响；
- 建议；
- 是否需要用户决定。

4. 状态与动作矩阵
至少覆盖 RESERVED、CHECKED_IN、CHECKED_OUT、CANCELLED、NO_SHOW 与 CHECK_IN、CHECK_OUT、EXTEND、SHORTEN、MOVE、CANCEL、NO_SHOW。把代码当前允许、需求期望和未决日期边界分开。

5. 工作人员用户旅程与使用体验
- 用一张旅程矩阵覆盖 G 节全部旅程；列出目标、入口、可见/隐藏字段、人员操作、系统反馈、失败恢复、下一步和当前证据状态。
- 单列“多余步骤与认知负担”，指出可以删除或合并的按钮、页面、字段和确认，但不得删除底层安全协议。
- 单列“字段渐进显示”，核对正常、会员、免费、手工改价和资金操作只暴露当前步骤所需字段。
- 单列“状态、恢复与上下文保持”，覆盖加载、空、成功、失败、陈旧、中断、返回和焦点。
- 给出按业务影响排序的 UX findings，并明确哪些已有代码证据、哪些仍需浏览器人工验证。

6. 范围分层
- MVP 必须现在完成；
- 可在下一里程碑完成；
- 应延期；
- 应明确排除。

7. 推荐实施顺序
给出 5 至 8 个可人工验收的里程碑。说明依赖关系和为何能减少返工。不要实施。

8. 必须由用户回答的问题
只列真正改变经营事实的问题，按阻断程度排序。每题给出 2 至 3 个可选方向及影响，但不要替用户决定。
不要把以下已确认规则列入本节：`CHECK_IN` 时一次核销本次住宿已冻结的全部权益；完整 Stay 为选择容器且内部保留变更边界；每笔新 COLLECTION/REFUND 自动绑定本次依据的 pricing revision，REFUND 同时引用原 COLLECTION。只有发现当前证据中存在新的直接矛盾时，才把矛盾作为发现报告，而不是重新询问规则本身。

9. 验证缺口
说明现有单元、领域、PostgreSQL、OpenAPI、E2E、性能、安全和恢复测试分别能证明什么、不能证明什么。

10. 最终建议
明确写出：可以直接实施、需要先修订计划，还是需要先取得业务答案。

不要输出泛泛而谈的“建议加强测试”或“注意安全”。所有建议必须对应具体风险和证据。不要因为第一轮审计已有很多发现就停止寻找反例。
```

## 回传方式

请把另一智能体的完整结论原样回传。主审计将按以下方式处理：

1. 对每项异议重新核对证据；
2. 把新发现分成已确认冲突、待业务决定和可逆工程建议；
3. 更新最终计划草案；
4. 再交给用户审阅；
5. 仍然等待用户明确说“开始实施”。
