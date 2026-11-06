---
title: 收退款与业务同步匹配及异常闭环
type: feature
created: 2026-11-06
status: done
route: dispatch
baseline_commit: 1b93a60c4b1845d5f083bcd05e5e4c7c1284eefe
review_loop_iteration: 1
context: [AGENTS.md]
---

<frozen-after-approval reason="2026-11-06 用户已确认业务规则并授权开始实施">

## Intent

员工按「打开订单→记录收款／退款→选择企微流水→核对金额和归属→一次确认」完成业务与资金登记，减少漏记、错配、重复和事后核对。退款关联成功退款流水、原企微收款及本单份额；收退款分别逐笔核对，不能只比较净额。

## Boundaries & Constraints

保留分次、多单份额、历史边界、同门店权限、原交易关联、不可变事实及 Preview/Confirm。原款及退款均漏记时允许同事务补齐，已取消、未到、撤销入住、已退房订单保持原住宿、金额与库存；已有收款只补退款。归属不明保留异常，不按昵称或同额推断。实际支付、订单应收、PMS登记分开；内部划转不新增现金。未解决差额跨日持续；未核实来源不能冒充已对平。

复用现有订单与工作台异常页面，支持返回修改及未知结果恢复。原始流水不改写；不自动发起外部退款、不自动记账、不修改历史金额、CI、生产配置或保护。交付代码、验证、PR与人工验收材料，不包含合并、部署或真实模型调用。

## I/O & Edge-Case Matrix

| 场景 | 预期 |
|---|---|
| 已匹配原款，部分／多次退款 | 每笔成功退款按本单可退份额登记，不重复收款 |
| 收1000退1000均漏记，订单取消 | 一次补齐两笔，净0；原单状态、计价和库存不变 |
| 同一已全退1000分A400/B600均漏记 | 各单按真实份额成组补齐，退走的钱不能再分配 |
| 退款处理中、来源异常或跨商户／跨单 | 展示明确原因，拒绝错误登记 |
| 重复、并发、陈旧预览及中途失败 | 最多一次成功，不留下半组事实或错误分配 |
| 只有退款权限却补原收款 | 拒绝；正常退款权保持原样 |
| 收退均漏记且净额0、跨日、业务无流水 | 分别显示差额，持续待处理，不能标对平 |
| 返回修改、自动刷新、结果未知 | 草稿保留，按既有恢复协议查询最终状态 |

</frozen-after-approval>

## Code Map

- `packages/db/src/commands/{effects,apply,service}.ts`：复用 RECORD_REFUND 分支、物业资金锁及事务；正常单笔契约不变。
- `packages/db/src/{payment-allocation,external-payments}.ts`、迁移069：原款冻结、份额及关联守卫；新增081定向成组证明，不改旧迁移。
- `packages/db/src/{dashboard-unclaimed-payments,dashboard-money}.ts`：复用来源证据和旧匹配去重，区分来源占用与有效业务；经营日期不变。
- `apps/web/src/components/{OrderFundsFormDialog,ExternalPaymentPicker}.tsx`、`ui.tsx`：复用表单、预览、回执及草稿；`TodayPage.tsx`承载持续核对。

## Tasks & Acceptance

- [x] 资金写入：新增成组模块及081迁移；修改 commands、orders、external-payments、payment-allocation、API schemas、domain/dashboard-metrics 和 dashboard-money；覆盖事务、权限、来源、统计与旧协议回归。
- [x] 持续核对：新增 contracts/payment-reconciliation、db/payment-reconciliation及payment-refund-context、API只读路由；扩展外部流水DTO与查询响应；覆盖双向逐笔核对、跨日、历史兼容及分页。
- [x] 员工操作：相关 apps/web/src 与专项E2E；既有表单内成组补登记、收款关联退款提示、工作台持续待处理，预览回执及恢复覆盖。
- [x] 整合交付：知识/问答、主验收计划与旧规格引用；独立合成库检查、集成审阅及 PR 材料。

Given 表中各场景，When 员工按主流程核对并确认，Then 得到所列结果；Given 未匹配及异常来源，When 跨日打开工作台，Then 收款与退款分别显示来源、业务及差额，已处理项移出；Given 同号／同名但归属不明，When 选择流水，Then 只提供核对线索不代替人工认定。

## Implementation Notes

- 2026-11-06：已核对最新 main，复用根目录功能分支；用户已完成业务确认及开始实施授权，无新增规格审批。
- 成组输入复用 RECORD_REFUND：`reconciliation:{source:{externalPaymentBillId,amountMinor},refunds:[{externalPaymentBillId,amountMinor}],note}`；仅补缺失原款，已有原款走旧退款。effect/result 的 operation 为 RECONCILE_WECOM_REFUNDS。缺失原款同时检查收款权限。
- 成组先写原款及退款事实，再绑定退款、原款。081仅允许已证明同组事实的原款分配例外：剩余原款足以保留剩余未归属成功退款，或本次原款被本次退款全额覆盖；普通分配、留存、释放继续冻结。延迟完整性校验阻止缺项、伪造或不完整提交。
- 查询独立只读模型，不把无订单流水伪造成订单异常。同来源、商户及原交易关联退款；v1/v2共享可选上下文。总额使用精确整数，分页不影响全量汇总。查询代理与后台代理各自拥有新模块，旧payment-allocation/external-payments由后台代理整合helper调用。

- 恢复记录保存原订单、所选原款与退款份额及说明、预览 hash 和原确认键；刷新后仅查询原命令。读写恢复存储均校验输入与 hash，缺失资金事实的回执保持 UNKNOWN；所有退款证据核对通过后才清除阻塞。

## Spec Change Log

业务范围与已确认决定未改变；以下是实现及验证补强。

## Review Triage Log

| 编号 | 判定与处理 | 核实证据 |
|---|---|---|
| blind-1 | high · patched / verified | 历史链接器只承接单笔等额；旧同号拆分可能有有效业务却无allocation。成组builder与081须共同阻止再次补记，保留异常人工核对。 |
| blind-2 | medium · patched / verified | billId解析失败被吞掉且enabled未变不会再次触发；补错误和重试，并取消过期解析。 |
| blind-3 | medium · patched / verified | 核对关联退款入口仅看整笔remaining会优先新增原款；改为优先本单有效可退原款，显式允许补其他缺失份额。 |
| blind-4 | medium · patched / verified | 服务端REVERSE_FACT已有终态资金纠错支持，但订单actions漏撤销入住状态；补入口且保留权限、依赖和冻结约束。 |
| blind-5 | medium · patched / verified | 查询有效业务过滤会遗失未释放占用的订单；保留明确占用线索，不把冲销事实计入有效金额，不把已释放旧归属当新归属。 |
| blind-6 | medium · patched / verified | 模式往返卸载组件丢本次编辑；保存各模式草稿，不只依赖已提交matchingDraft。 |
| blind-7 | medium · patched / verified | orphan行携带真实currency，但显示函数固定人民币；修正行币种，汇总继续不混币。 |
| blind-8 | medium · patched / verified | 当前每页完整快照保证全量汇总，已由Map避免平方扫描；停止隐藏/非异常tab的反复轮询。保留按门店完整核对语义，不增加未经验证的缓存。 |
| blind-9 | medium · patched / verified | 旧“竞争确认”实际串行；增加独立连接真实并发和同步门闩验证。 |
| blind-10 | medium · patched / verified | 正常E2E不能证明丢响应恢复；增加实际提交后丢响应、刷新、坏回执拒绝和原回执恢复，断言单次提交。 |
| edge-1 | medium · patched / verified | 实际代码basis直接保存SELECT b.*，同步updated_at变化会误失效（审阅返回的map片段并非当前实现）；仅冻结相关业务证据，验证无变化同步可确认。 |
| verification-1 | medium · patched / verified | 原测试只删Preview前的权限；补Preview后撤销收款ceiling，Confirm拒绝且三类资金证据不变。 |
| verification-2 | medium · patched / verified | helper直测未覆盖实际分派/恢复门禁；补receiptHasCommandEvidence与CommandDialog恢复坏回执。 |
| verification-3 | medium · patched / verified | 返回修改重新解析仅由opt-in真库E2E覆盖；补常规发现路径中的前端交互回归，不修改CI入口。 |
| recovery-1 | high · patched / verified | 真浏览器丢响应演练发现原恢复记录未保存成组输入/hash，刷新后无法验真。补严格持久往返及状态转换保护；桌面/手机均验证坏回执继续待核对、真实回执恢复、全程仅一次 Confirm。 |
| visual-1 | medium · patched / verified | 真机尺寸截图显示退款div包装导致effect-grid错列；改keyed Fragment，并明确确认同时补齐收退款。 |

## Verification

工程实现与自动验证已完成，人工业务验收及真实助手问答待执行。验证仅使用本机独立 PostgreSQL 合成库及假企微来源，不连接真实支付服务，不修改生产数据。

- Node 22：`npm test -- --exclude '**/.worktrees/**' --exclude '**/.local-workspace/**'`，137 个文件、2,113 项通过；本地排除历史工作目录，未更改 CI 或测试入口。
- PostgreSQL：成组收退款 25 项通过；持续核对、资金分配、数据库约束、同步竞争、支付事件、留存、外部流水和企微正金额约束共 86 项通过，合计 111 项。覆盖真实并发、权限撤销、原子回滚、历史同号、分单份额与同步无变化竞争。
- 浏览器：桌面/手机共 8 项通过，包括普通补齐、跨日异常、返回修改、流水读取失败重试、提交丢响应后刷新、坏回执拒绝和原回执恢复；确认请求均最多一次。人工查看手机预览截图，金额、凭据与按钮排列正常。
- `npm run typecheck`、`npm run build`（含 `release:check`）、PR 格式 8 项、`git diff --check` 通过。Python 3.11 发布 harness 194 项通过；系统自带 Python 3.9 不满足安装器最低版本，已使用本机现有 3.11 复验，未改检查。
- 三个独立审阅角度及恢复路径复审完成，确认问题均修复；无延期业务缺口。合成浏览器证据不代表人工验收，知识覆盖不代表真实模型问答。

本机日志、截图及合成环境保留在 `.local-workspace/refund-reconciliation-20261106/`；实现分支 `codex/refund-business-reconciliation`，通过 PR 交付，未合并、发布或部署。

## 发布与回退边界

本次新增迁移 `081_wecom_refund_reconciliation.sql`，需随正式发布运行；成组写入沿用 `PMS_PAYMENT_ALLOCATION_ENABLED`，另受来源启用、权限与服务器规则约束。不得把数据库证明表或不可变资金事实删除作为回退。旧镜像的 schema 指纹不接受本次数据库保护变更，不能假定只切回旧镜像即可恢复写入；回退需按现有正式发布/恢复流程验证数据库与镜像配套。关闭分配开关可暂时关闭成组写入口，不代表撤销已经登记的真实收退款。
