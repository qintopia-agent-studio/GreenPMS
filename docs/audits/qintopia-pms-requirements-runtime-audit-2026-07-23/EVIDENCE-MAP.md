---
title: QinTopia PMS 审计证据地图
audit_date: 2026-07-23
status: ready-for-independent-review
---

# QinTopia PMS 审计证据地图

## 1. 使用说明

本文件把审计结论映射到当前工作树的需求和代码。行号是 2026-07-23 审计时的工作树位置，后续编辑可能使行号漂移；独立审计者应同时按符号、字段名和标题复核。

证据强度：

- **直接：** 需求或代码明确表达该行为。
- **交叉：** 需要结合两处以上文件才能证明冲突。
- **推论：** 从已确认行为推导出的运行风险，需通过测试或业务确认进一步验证。

## 2. 需求权威与范围

| ID | 证据 | 观察 | 强度 |
|---|---|---|---|
| GOV-01-A | [分步计划:4](../../../待开发项/房态与订单运营流程分步开发计划.md#L4)、[分步计划:24](../../../待开发项/房态与订单运营流程分步开发计划.md#L24) | 审计收口后已改为 `awaiting-review`、`implementation_authorized: false`，正文明确等待用户说“开始实施” | 直接 |
| GOV-01-B | [90 天规格:4](../../../待开发项/房态90天连续时间轴与超长住宿开发规格.md#L4)、[90 天规格:21](../../../待开发项/房态90天连续时间轴与超长住宿开发规格.md#L21) | companion 已使用相同门禁，不再要求收到文件后直接实现 | 直接 |
| GOV-01-C | 当前任务用户指令 | 用户最新要求完整讨论、审阅计划后，只有明确说“开始实施”才实施；当前文档已与之对齐 | 直接，来自审计委托上下文 |
| GOV-02-A | [核心规格:5](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L5)、[核心规格:71](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L71) | 文件为 `done`，同一文件又声明三项最新增量未实施 | 直接 |
| GOV-02-B | [旧房态目标:4](../../implementation/room-status-ui-development-goal.md#L4)、[旧房态目标:336](../../implementation/room-status-ui-development-goal.md#L336) | 历史目标为 `done`，Definition of Done 全部勾选 | 直接 |
| GOV-02-C | [分步计划:667](../../../待开发项/房态与订单运营流程分步开发计划.md#L667) | 最新 15 阶段状态表均为 pending | 直接 |
| GOV-03 | [分步计划:28](../../../待开发项/房态与订单运营流程分步开发计划.md#L28)、[分步计划:37](../../../待开发项/房态与订单运营流程分步开发计划.md#L37) | 每阶段默认要求所有层和四类测试，即使阶段不一定影响所有层 | 直接 |
| GOV-04 | [分步计划:599](../../../待开发项/房态与订单运营流程分步开发计划.md#L599)、[90 天规格:310](../../../待开发项/房态90天连续时间轴与超长住宿开发规格.md#L310) | 90 天时间轴排在阶段 14，但会改写选区、虚拟化、恢复和行高 | 交叉 |

## 3. 计价与订单创建

| ID | 需求证据 | 当前实现证据 | 观察 | 强度 |
|---|---|---|---|---|
| PRC-01 | [价格事实:49](../../pricing-facts/qintopia-2026-building-room-bed-price-catalog.md#L49)、[价格事实:65](../../pricing-facts/qintopia-2026-building-room-bed-price-catalog.md#L65) | [contracts:8](../../../packages/contracts/src/index.ts#L8)、[Quote input:259](../../../packages/contracts/src/index.ts#L259)、[pricing service:125](../../../packages/db/src/pricing-service.ts#L125)、[InventoryPage:724](../../../apps/web/src/pages/InventoryPage.tsx#L724) | 日期应决定档位，但 API/Web 仍要求 stayType，TRANSIENT 7 夜以上被拒绝 | 直接 |
| PRC-02 | [分步计划:165](../../../待开发项/房态与订单运营流程分步开发计划.md#L165)、[分步计划:174](../../../待开发项/房态与订单运营流程分步开发计划.md#L174) | [README:68](../../../README.md#L68)、[quote endpoint:344](../../../apps/api/src/server.ts#L344)、[pricing service:97](../../../packages/db/src/pricing-service.ts#L97) | API 有请求速率和活跃 Quote 配额，但过期 Quote/Receipt 仍永久保留；自动编辑会持续累积永久记录 | 交叉 |
| PRC-03 | [价格事实:60](../../pricing-facts/qintopia-2026-building-room-bed-price-catalog.md#L60) | [pricing tests](../../../packages/domain/src/pricing-2026.test.ts)、[pricing-facts](../../../docs/pricing-facts/cases/README.md) | 6/7、13/14、29/30 和 half-up 已有真实金标，不属于待发明规则 | 直接 |
| ORD-01 | [核心规格:59](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L59)、[分步计划:273](../../../待开发项/房态与订单运营流程分步开发计划.md#L273) | [CREATE_ORDER schema:181](../../../apps/api/src/schemas.ts#L181)、[channel domain:20](../../../packages/domain/src/operational-facts.ts#L20)、[migration 009:21](../../../packages/db/src/migrations/009_booking_channels_and_transaction_references.sql#L21)、[InventoryPage:681](../../../apps/web/src/pages/InventoryPage.tsx#L681) | 免费入住应无渠道且有义工/接待分类，当前全链路相反 | 直接 |
| ORD-02 | [分步计划:207](../../../待开发项/房态与订单运营流程分步开发计划.md#L207)、[分步计划:211](../../../待开发项/房态与订单运营流程分步开发计划.md#L211) | [CREATE_ORDER schema:181](../../../apps/api/src/schemas.ts#L181)、[REPRICE schema:192](../../../apps/api/src/schemas.ts#L192) | 首次创建不能同时保存人工目标总价，只能后续 REPRICE | 直接 |
| ORD-03 | [分步计划:134](../../../待开发项/房态与订单运营流程分步开发计划.md#L134)、[分步计划:210](../../../待开发项/房态与订单运营流程分步开发计划.md#L210) | [reason schema:95](../../../apps/api/src/schemas.ts#L95)、[confirm validation:664](../../../packages/db/src/commands/service.ts#L664)、[CommandDialog:719](../../../apps/web/src/ui.tsx#L719) | 最新正常创建不要求工作人员原因，当前所有 Confirm 强制 code 和 note 非空 | 直接 |
| ORD-06 | [README:79](../../../README.md#L79) | [核心规格:59](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L59) | README 仍说每个 CREATE_ORDER 必须四选一渠道，未写免费例外 | 直接 |

## 4. Stay、变更和生命周期

| ID | 需求证据 | 当前实现证据 | 观察 | 强度 |
|---|---|---|---|---|
| DOM-01 | [分步计划:378](../../../待开发项/房态与订单运营流程分步开发计划.md#L378)、[分步计划:383](../../../待开发项/房态与订单运营流程分步开发计划.md#L383)、[核心规格:67](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L67) | [RoomStatusGrid](../../../apps/web/src/room-status/RoomStatusGrid.tsx)、[InventoryPage selection](../../../apps/web/src/pages/InventoryPage.tsx#L951) | 用户已确认完整 Stay 为选择容器且内部保留 amendment/segment 边界；当前选择仍以可见 interval 为中心 | 交叉 |
| DOM-02 | [分步计划:384](../../../待开发项/房态与订单运营流程分步开发计划.md#L384)、[分步计划:478](../../../待开发项/房态与订单运营流程分步开发计划.md#L478) | [CHECK_OUT apply:822](../../../packages/db/src/commands/apply.ts#L822) | 当前 CHECK_OUT 释放未来 Claims 但不重价、不改 departure，提前退房语义冲突 | 直接 |
| DOM-03-A | [分步计划:418](../../../待开发项/房态与订单运营流程分步开发计划.md#L418) | [CHECK_IN effect:857](../../../packages/db/src/commands/effects.ts#L857)、[expired CHECK_IN apply:809](../../../packages/db/src/commands/apply.ts#L809) | 只检查 RESERVED，且显式允许过期预订入住 | 直接 |
| DOM-03-B | [分步计划:478](../../../待开发项/房态与订单运营流程分步开发计划.md#L478)、[分步计划:509](../../../待开发项/房态与订单运营流程分步开发计划.md#L509) | [mutable states:103](../../../packages/db/src/commands/effects.ts#L103)、[SHORTEN:696](../../../packages/db/src/commands/effects.ts#L696)、[MOVE:741](../../../packages/db/src/commands/effects.ts#L741) | CHECKED_IN 可变更，但没有相对营业日的追溯限制 | 直接 |
| ORD-04-A | [分步计划:383](../../../待开发项/房态与订单运营流程分步开发计划.md#L383) | [change apply:627](../../../packages/db/src/commands/apply.ts#L627)、[order query:109](../../../packages/db/src/orders.ts#L109) | Query 返回不可变 segment 快照链，未提供单独的当前有效行程 | 直接 |
| ORD-04-B | [分步计划:154](../../../待开发项/房态与订单运营流程分步开发计划.md#L154)、[分步计划:214](../../../待开发项/房态与订单运营流程分步开发计划.md#L214)、[分步计划:376](../../../待开发项/房态与订单运营流程分步开发计划.md#L376) | [amendment schema:1002](../../../apps/api/src/schemas.ts#L1002)、[order query:111](../../../packages/db/src/orders.ts#L111) | 同一个 amendment payload/详情问题被阶段 2 和阶段 7 重复认领 | 交叉 |
| STA-01 | [分步计划:112](../../../待开发项/房态与订单运营流程分步开发计划.md#L112) | [room-status:1262](../../../packages/db/src/room-status.ts#L1262)、[room-status:1272](../../../packages/db/src/room-status.ts#L1272) | 历史 completed Claim 被映射为 IN_HOUSE | 直接 |
| STA-02 | [分步计划:112](../../../待开发项/房态与订单运营流程分步开发计划.md#L112) | [overdue projection:853](../../../packages/db/src/room-status.ts#L853)、[overdue blocker:905](../../../packages/db/src/room-status.ts#L905) | 新简化生命周期未明确保留“逾期未退”异常 | 交叉 |
| DOM-04 | [旧房态规格:24](../../implementation/room-status-grid-implementation-spec.md#L24)、[旧房态规格:74](../../implementation/room-status-grid-implementation-spec.md#L74) | [分步计划:426](../../../待开发项/房态与订单运营流程分步开发计划.md#L426)、[cleaning projection](../../../packages/db/src/room-status.ts#L1409) | 旧规则说清洁不改变夜间 Claim，新计划暗示完成清洁后才恢复可售 | 交叉 |
| DOM-05 | 当前任务用户指令、[分步计划:66](../../../待开发项/房态与订单运营流程分步开发计划.md#L66) | [旧房态目标:130](../../implementation/room-status-ui-development-goal.md#L130) | 免费入住已有真实住客和零金额事实，但免费与内部占用的完整分类表仍处于用户审阅状态 | 交叉 |

## 5. 会员权益

| ID | 需求证据 | 当前实现证据 | 观察 | 强度 |
|---|---|---|---|---|
| MEM-01-A | [分步计划:243](../../../待开发项/房态与订单运营流程分步开发计划.md#L243)、[分步计划:260](../../../待开发项/房态与订单运营流程分步开发计划.md#L260) | [Quote input:259](../../../packages/contracts/src/index.ts#L259)、[pricing allocation:45](../../../packages/db/src/pricing-service.ts#L45) | 新流程选 memberId，当前服务只接受单一 memberContractId | 直接 |
| MEM-01-B | [分步计划:247](../../../待开发项/房态与订单运营流程分步开发计划.md#L247) | [orders schema](../../../packages/db/src/schema.ts#L29)、[coverage hold:178](../../../packages/db/src/orders.ts#L178)、[create apply:393](../../../packages/db/src/commands/apply.ts#L393) | Order 和 holdCoverage 把整单 coverage 固定到一个合同，不能跨合同真实归属 | 直接 |
| MEM-02 | [核心规格:129](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L129)、[分步计划:427](../../../待开发项/房态与订单运营流程分步开发计划.md#L427)、[分步计划:488](../../../待开发项/房态与订单运营流程分步开发计划.md#L488) | [CHECK_IN consume:820](../../../packages/db/src/commands/apply.ts#L820)、[in-house change consume:682](../../../packages/db/src/commands/apply.ts#L682) | 最新已确认规则及当前实现均为入住即消耗全部 HELD，后续普通缩短不恢复；该后果不再作为待决策 Gate | 直接 |
| MEM-03 | [价格事实:96](../../pricing-facts/qintopia-2026-building-room-bed-price-catalog.md#L96) | [pricing service:78](../../../packages/db/src/pricing-service.ts#L78) | 当前单合同内按 expires_on、id 选 Lot，但这不是已确认的跨合同业务规则 | 直接 |

## 6. 房态、交互和工作人员语言

| ID | 需求证据 | 当前实现证据 | 观察 | 强度 |
|---|---|---|---|---|
| ORD-05 | [分步计划:384](../../../待开发项/房态与订单运营流程分步开发计划.md#L384) | [action codes:296](../../../packages/contracts/src/index.ts#L296)、[event actions:198](../../../packages/db/src/room-status.ts#L198) | 房态占用订单只返回 OPEN_ORDER，缺生命周期与资金动作策略 | 直接 |
| UX-01-A | [分步计划:100](../../../待开发项/房态与订单运营流程分步开发计划.md#L100) | [InventoryPage:704](../../../apps/web/src/pages/InventoryPage.tsx#L704)、[InventoryPage:751](../../../apps/web/src/pages/InventoryPage.tsx#L751)、[OrderDetailPage:331](../../../apps/web/src/pages/OrderDetailPage.tsx#L331) | 工作人员主流程仍显示 Quote、policy、coverageSet、Preview/Confirm 等协议语言 | 直接 |
| UX-01-B | [分步计划:114](../../../待开发项/房态与订单运营流程分步开发计划.md#L114) | [room-status conflicts](../../../packages/contracts/src/index.ts#L349)、[旧目标:144](../../implementation/room-status-ui-development-goal.md#L144) | 底层 blocking/conflict 必须保留，但不应成为正常占用的人员文案 | 交叉 |
| UX-02-A | [核心规格:65](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L65)、[分步计划:304](../../../待开发项/房态与订单运营流程分步开发计划.md#L304) | [领域决策:27](../../architecture/invariants-and-decisions.md#L27)、[昵称旧规格:44](../../implementation/spec-guest-nickname-bed-occupancy.md#L44) | 最新要求全部昵称直接显示，旧决策仍允许紧凑截断 | 直接 |
| UX-02-B | [分步计划:314](../../../待开发项/房态与订单运营流程分步开发计划.md#L314)、[90 天规格:113](../../../待开发项/房态90天连续时间轴与超长住宿开发规格.md#L113) | [旧性能目标:69](../../implementation/room-status-grid-implementation-spec.md#L69) | 可变行高、90 天虚拟化、200 单元性能和全端布局需要一体设计 | 交叉 |
| UX-03 | [昵称规格:28](../../implementation/spec-guest-nickname-bed-occupancy.md#L28)、[领域不变量:8](../../architecture/invariants-and-decisions.md#L8) | [bed occupancy DTO:401](../../../packages/contracts/src/index.ts#L401) | 当前每张床展示订单主要居住人，不等于支持整房多同行人档案 | 直接 |
| UX-04 | [分步计划:378](../../../待开发项/房态与订单运营流程分步开发计划.md#L378) | [RoomStatusGrid](../../../apps/web/src/room-status/RoomStatusGrid.tsx)、[InventoryPage selection](../../../apps/web/src/pages/InventoryPage.tsx#L951) | 当前选择以可见 interval/日期为中心，完整 Stay 选择仍待实现 | 交叉 |

## 7. 资金、隐私、数据库和运行

| ID | 需求证据 | 当前实现证据 | 观察 | 强度 |
|---|---|---|---|---|
| FIN-01 | [分步计划:571](../../../待开发项/房态与订单运营流程分步开发计划.md#L571) | [fund command schema:200](../../../apps/api/src/schemas.ts#L200)、[fund effect:809](../../../packages/db/src/commands/effects.ts#L809) | transactionReference 已确认，`method` 仍自由文本且必填，业务意义未明确 | 直接 |
| FIN-02 | [领域不变量:8](../../architecture/invariants-and-decisions.md#L8)、[核心规格:29](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L29) | [migration 011:1](../../../packages/db/src/migrations/011_core_fact_shape_guards.sql#L1) | 同订单退款引用和 reversal 约束是核心正确性，不应删除 | 直接 |
| FIN-03 | [核心规格:55](../../implementation/spec-qintopia-pms-core-operations-mvp.md#L55)、[分步计划:577](../../../待开发项/房态与订单运营流程分步开发计划.md#L577)、[分步计划:585](../../../待开发项/房态与订单运营流程分步开发计划.md#L585) | [collection_facts schema:42](../../../packages/db/src/schema.ts#L42)、[fund command schema:200](../../../apps/api/src/schemas.ts#L200)、[fund effect:809](../../../packages/db/src/commands/effects.ts#L809) | 用户已确认新 COLLECTION/REFUND 自动绑定本次依据的 pricing revision，退款另引用原收款；当前事实和命令没有 revision 关联 | 直接 |
| SEC-01-A | 原始权限仅确认 READ 小于 WRITE | [meta endpoint:250](../../../apps/api/src/server.ts#L250)、[members endpoint:382](../../../apps/api/src/server.ts#L382)、[member schema:833](../../../apps/api/src/schemas.ts#L833) | READ 可列出完整身份证、电话和微信 | 直接 |
| SEC-01-B | [分步计划:402](../../../待开发项/房态与订单运营流程分步开发计划.md#L402) | [bed occupant DTO:401](../../../packages/contracts/src/index.ts#L401)、[room-status projection:560](../../../packages/db/src/room-status.ts#L560) | 房态昵称的“有权查看”范围尚没有比物业 READ 更细的规则 | 交叉 |
| SEC-02 | 部署前安全边界未在当前需求中明确 | [auth cookie:96](../../../apps/api/src/auth.ts#L96)、[server setup](../../../apps/api/src/server.ts)、[package.json](../../../package.json) | 未发现统一 CSP、HSTS、frame/referrer 或敏感响应 no-store 策略 | 直接查无，需要独立复核 |
| DB-01 | [领域不变量:14](../../architecture/invariants-and-decisions.md#L14) | [initial schema:151](../../../packages/db/src/migrations/001_initial.sql#L151)、[current revision guard:112](../../../packages/db/src/migrations/011_core_fact_shape_guards.sql#L112) | 已有部分父子约束，但 amendment/revision/segment/coverage 的跨父归属仍不完整 | 交叉 |
| TST-01 | 核心验收只要求测试可靠，不要求自建进程监管平台 | [test runner](../../../tests/helpers/run-database-test-suite.ts)、[README:148](../../../README.md#L148) | 运行器依赖 POSIX 进程树追踪，维护成本较高且 Windows 不支持 | 直接 |
| OPS-01 | 迁移和 readiness 应共享单一权威 | [database migration gate](../../../packages/db/src/database.ts#L19)、[restore script](../../../scripts/restore.sh#L68)、[compose verify](../../../scripts/verify-compose-cold-start.sh#L74) | 多处硬编码迁移版本可能漏同步 | 交叉 |
| OPS-02 | 当前目标是可运行 MVP，不等于生产镜像加固 | [Dockerfile](../../../Dockerfile)、[API package](../../../apps/api/package.json) | 镜像包含开发式 `tsx` 运行路径，未见非 root 运行声明 | 直接 |

## 8. 验证证据

本次主审计执行：

| 命令 | 结果 | 证明范围 |
|---|---|---|
| `npm run verify` | 通过，16 files、201 tests | 当前 TypeScript、领域和 Web 单元基线 |
| `npm run test:pricing-facts` | 通过，7 cases | 已确认真实计价事实仍可复算 |

没有在本次审计中重新执行：

- `npm run test:integration`
- `npm run test:contract`
- `npm run test:e2e`
- 冷启动、Compose、备份恢复

这些套件在历史规格中有通过记录，但历史记录不能证明 pending 增量已经实现。

## 9. 独立审计者应抽样复核的路径

优先级从高到低：

1. `待开发项/房态与订单运营流程分步开发计划.md`
2. `docs/implementation/spec-qintopia-pms-core-operations-mvp.md`
3. `packages/contracts/src/index.ts`
4. `apps/api/src/schemas.ts`
5. `packages/db/src/commands/effects.ts`
6. `packages/db/src/commands/apply.ts`
7. `packages/db/src/pricing-service.ts`
8. `packages/db/src/orders.ts`
9. `packages/db/src/room-status.ts`
10. `apps/web/src/pages/InventoryPage.tsx`
11. `apps/web/src/pages/OrderDetailPage.tsx`
12. `apps/api/src/server.ts`
13. `packages/db/src/migrations/001_initial.sql`
14. `packages/db/src/migrations/009_booking_channels_and_transaction_references.sql`
15. `packages/db/src/migrations/011_core_fact_shape_guards.sql`
