---
title: QinTopia PMS Room Status UI Development Goal
type: ui-development-goal
status: done
created: 2026-07-19
target_project: QinTopia PMS greenfield
scope: desktop room status board, responsive alternatives, and supporting UI/API contracts
companions:
  - spec-qintopia-pms-core-operations-mvp.md
  - ../../design-system/qintopia-pms/MASTER.md
---

# QinTopia PMS 房态 UI 开发目标

## 1. Goal

将当前 `apps/web/src/pages/InventoryPage.tsx` 从基础的“逐日可售/占用表格”升级为可投入日常运营的 `RoomStatusGrid`：运营人员应能在同一个空间 x 时间工作面中，准确识别房间与床位的可售、订单、实际住宿、清洁、维修和内部占用来源，安全选择日期区间并进入对应业务动作，同时始终看见数据新鲜度、阻断原因和持久结果。

本目标不是视觉换肤。完成结果必须使用真实 API 数据，保持 Web 与外围智能体 API 的领域规则、授权、事务、Preview/Confirm、幂等和 Receipt 语义一致。

接收本文件的开发任务必须持续完成实现、测试和浏览器验证，不得在输出方案、线框图或静态原型后停止。

## 2. Authority And Boundaries

- 产品领域不变量以 `spec-qintopia-pms-core-operations-mvp.md` 为准。
- 颜色、字体、间距、控件、响应式和无障碍基线以 `design-system/qintopia-pms/MASTER.md` 为准。
- 本文件是房态 UI 行为、页面状态和验收要求的权威。
- 保留现有 PostgreSQL、共享命令协议、稳定 ID、OpenAPI 和外围智能体行为。
- UI 所需字段缺失时，可以增量扩展 `packages/contracts`、查询 API 和 OpenAPI，但不得在浏览器中推断权威可售、冲突、来源或金额。
- 不得用静态 fixture、硬编码条带或只改 CSS 的方式伪造完成。
- 不做旧系统兼容、数据迁移或任何既有 PMS 的视觉复制。

## 3. Current Baseline

当前页面已经具备以下可复用能力：

- 物业、日期范围和 ROOM/BED 筛选；
- 房间与床位逐日 availability 表格；
- 固定库存列和日期列；
- 选择库存后报价、会员覆盖、创建订单；
- 维修锁房的 Preview/Confirm/Receipt；
- React、Lucide、现有 design tokens 和响应式外壳。

当前差距包括：

- 状态主要只有“可售/占用”，不能解释占用来源；
- 缺少连续订单/住宿/Block 条带；
- 缺少 Order、Stay、Operations、typed source 和稳定对象链接；
- 缺少 `asOf`、freshness、stale、unknown 和跨工作台 revision 语义；
- 房间父行与床位子行的展开、销售模式和父子冲突表达不足；
- 选区、上下文详情、返回恢复和完整键盘网格交互不足；
- 移动端仍需要明确转向任务式体验，而不是缩小桌面矩阵。

## 4. Target Experience

房态是一个安静、高密度、可扫描的运营工作面，不是仪表盘或营销页面。用户进入系统后，应可以完成以下认知闭环：

1. 找到目标物业、房型、房间或床位和日期；
2. 判断该库存是否可售、是否陈旧，以及结论来自哪些事实；
3. 打开订单、住宿、Block 或任务详情；
4. 选择空白区间并进入正确的订单或 Block 动作；
5. 在执行前看到精确冲突和服务端 Preview；
6. 确认一次并获得持久 Receipt；
7. 返回时恢复原来的日期、筛选、展开、滚动、选区和焦点。

## 5. Desktop Layout Contract

```text
+--------------------------------------------------------------------------------+
| 当前物业 | 日期范围 | 今天 | 搜索 | 数据时点 / freshness | 当前身份             |
+--------------------------------------------------------------------------------+
| 房型 | 销售模式 | 状态 | ROOM/BED | 人数 | 清除筛选 | 刷新                   |
+----------------------+---------------------------------------------------------+
| 固定房源轴           | sticky 日期轴                                           |
|                      | 07-19 | 07-20 | 07-21 | 07-22 | 07-23 | ...             |
+----------------------+---------------------------------------------------------+
| A203 · 整房销售      | 可售  |----- 订单 QT-1042 / 已预订 -----| 待清洁          |
| A204 · 拆床销售  v   | 可售  | 可售  | 维修锁房 | 维修锁房 | 可售              |
|   Bed 1              | 可售  |----- FREE_STAY / 在住 -----| 可售               |
|   Bed 2              | 可售  | 可售  | 可售     | 可售     | 可售              |
| A205 · 不可售        | 不可售| 不可售| unknown  | unknown  | unknown           |
+----------------------+---------------------------------------------------------+
| 选中对象上下文：单元、半开日期、来源、订单/Stay、冲突、历史和可用动作          |
+--------------------------------------------------------------------------------+
```

在 `>=1200px` 时，矩阵与上下文详情可以左右并列。在 `992-1199px` 时保留完整矩阵，上下文使用抽屉、对话框或矩阵下方详情，但不得遮挡焦点或导致页面主体横向溢出。

## 6. Requirements

### RS-UI-001: Entry, Header And Filters

**Requirement:** 桌面默认运营入口是“住宿 -> 房态”。页面持续显示当前物业、日期范围、`asOf`/freshness 和当前身份。支持前后日期范围、“今天”、搜索，以及物业、房型、销售模式、状态、人数和 ROOM/BED 粒度筛选。

**Acceptance:** 筛选不会触发业务写入；过滤后无结果显示独立的 `filtered-empty` 状态和“清除筛选”动作；改变范围时尽量保持垂直房源锚点。

### RS-UI-002: Room And Bed Hierarchy

**Requirement:** 房间父行始终存在。整房销售期间不显示可选择床位；拆床销售期间可展开具有稳定 ID 的床位子行。父行明确显示整房、拆床、不可售或锁定销售模式。拆床销售房间的逐日父格显示由服务端提供的 `已占床位数/实体床位总数`；分子是当天被有效正常订单或 `FREE_STAY` 住宿事实占用的不同子床，不包含维修/锁房、`INTERNAL_USE`、清洁或其他无居住人来源。

**Acceptance:** 整房占用与所有子床位双向互斥；单个床位占用只占用该床位，但会阻断父房间的整房销售；不同兄弟床位可以同时占用。四人间三个子床存在有效住宿事实时父格显示 `3/4`，其中分子统一表示“已占”；维修或内部占用不得把比例增加为住客占用。UI 仅渲染服务端 availability/conflict 和 occupancy aggregation 结果。

### RS-UI-003: Read-Only Composite Projection

**Requirement:** 房态由以下来源事实组成，而不是一个可编辑的 `roomStatus`：

- `Claim`：库存单元和阻断区间；
- `Order`：商业订单和计划占用；
- `Stay`：实际入住、退房和住宿分段；
- `Operations`：清洁、维修和最小履约任务。

**Acceptance:** 每个连续条带或格子保留 typed source、稳定对象引用和数据时点；改变状态只能进入来源拥有的命令，不能直接编辑颜色、Badge 或综合状态。

### RS-UI-004: Status Vocabulary

**Requirement:** 至少覆盖以下显示状态：

- 可售；
- 已预订；
- 在住；
- 待清洁；
- 维修/锁房；
- 内部占用；
- 不可售；
- `stale`；
- `unknown`。

**Acceptance:** 状态使用文字加图标或纹理，并可辅以颜色。`unknown` 或 `stale` 绝不能表现为空白可售；周末和“今天”只用于日期定位，不表达业务状态。

### RS-UI-005: Source Separation

**Requirement:** 正常订单、`FREE_STAY`、`INTERNAL_USE` 和维修/锁房必须使用不同来源标签和动作入口。

**Acceptance:** `FREE_STAY` 显示为有主要居住人、Order、Stay、正常 Claim 和免费计价的住宿订单；`INTERNAL_USE` 显示为无居住人、无 Order/Stay 的库存 Block；维修/锁房保留独立类型和原因。任何一种都不能被统一成含糊的“占用”。

### RS-UI-006: Range Selection

**Requirement:** 用户可通过鼠标、触控或键盘选择一个房间/床位的半开区间 `[arrivalDate, departureDate)`。

**Acceptance:** 选区只存在于当前客户端未提交状态，不产生 Claim、Block、Order、`orderId` 或持久 Draft。必须提供等价的房源选择器与开始/结束日期输入，不能强迫用户拖选。

### RS-UI-007: Context Detail

**Requirement:** 打开单元、条带或选区后，显示目标单元、半开日期、availability、typed source、Order/Stay 引用、`asOf`、freshness、精确冲突、历史、actor/source/time 和 Receipt 链接。

**Acceptance:** 无权读取的来源使用安全 redaction，不泄露对象存在性或个人信息；页面不得根据当前可见条带自行补算冲突或可售。

父房格空间允许时优先直接显示主要居住人快照昵称；空间不足时至少保留 `已占/总床数`。鼠标悬停和键盘聚焦必须以 Tooltip 或等价可访问详情展示该格全部有权查看的居住人昵称，不能只依赖视觉截断文本或鼠标。

### RS-UI-008: Action Routing

**Requirement:** 空白选区的动作菜单必须明确区分：

- 创建正常住宿订单；
- 创建 `FREE_STAY`；
- 放置 `INTERNAL_USE`；
- 放置维修/锁房。

**Acceptance:** 订单动作进入完整报价和 CreateOrder 流程；Block 动作进入相应的高风险 Preview/Confirm 流程。拖选或打开菜单本身不写业务事实。READ 主体不显示写动作。

### RS-UI-009: Conflict Safety

**Requirement:** blocking conflict 显示精确房间/床位、重叠半开日期、Claim 类型和冲突对象。

**Acceptance:** 冲突、权限失效、DTO 缺失、`stale/unknown` 或 Preview 过期时禁用确认。不得自动换房、静默缩短区间或把 blocking conflict 降级成普通 warning。

### RS-UI-010: Safe Command And Receipt

**Requirement:** 高风险动作遵循：

```text
Draft + Reason
  -> Server Preview
  -> Ready / Blocked
  -> Explicit Confirm
  -> Server Revalidation
  -> Atomic Execution
  -> Persistent Receipt
```

**Acceptance:** 确认按钮描述具体结果，不使用泛化的“确定”。成功后立即使用 committed DTO/Receipt 更新当前页面；超时显示 `state-unknown` 并按原幂等键查询，不得盲目重试或只显示 Toast。

### RS-UI-011: Release Rules

**Requirement:** Block 释放动作只对一个完整、当前有效的 typed Block 可用。

**Acceptance:** 选区必须精确匹配该 Block 的完整 `[startDate, endDate)`；部分选区只能查看，不得在 UI 中伪造部分释放或原地缩短。

### RS-UI-012: Return Restoration

**Requirement:** 用户从订单、Stay、Block、Receipt 或其他详情返回房态时，恢复物业、日期、筛选、房间/床位展开、滚动锚点、选区和合理焦点。

**Acceptance:** 若服务端 revision 变化，先刷新并重新校验；原触发格失效时将焦点放回选区起点，绝不继续使用旧 Preview 或旧可售结论。按用户 2026-11-06 确认，进入页面恢复浏览位置时不显示选区事实变化提示，不要求用户手动刷新或笼统地“重新核对”；自动更新、安全校验和旧核对失效机制继续执行。确实影响操作时，在操作处说明已知原因和可执行的下一步。原位置无法恢复时保留位置回退说明。

### RS-UI-013: Query And Command States

**Requirement:** 房态查询至少覆盖：

`loading`、`range-loading`、`empty`、`filtered-empty`、`permission-denied`、`stale`、`unknown`、`recoverable-error`、`blocking-conflict`、`ready`、`return-restored`。

命令至少覆盖：

`submitting`、`success`、`failed-not-executed`、`state-unknown`、`duplicate-returned-original-receipt`、`previewing`、`ready-to-confirm`、`blocked`、`preview-stale`。

**Acceptance:** 每种状态具有明确文案和下一项有效动作；零值、空白格和含糊错误不得代替缺失 DTO。

### RS-UI-014: Copy

**Requirement:** 文案冷静、具体，指出对象、日期、事实、未改变内容和下一步。

推荐示例：

- “A203 在 7 月 18 日至 20 日被订单 QT-1042 阻断。”
- “Preview 已过期。库存发生变化，请核对更新后的日期。”
- “状态未知，正在查询原命令结果。”

**Acceptance:** 禁止使用“出了点问题”“AI 推荐”“同步完成”或只有“已确认”而不说明对象的文案。

## 7. Responsive Contract

### Desktop

- `>=1200px`：矩阵和上下文详情并列；
- `992-1199px`：完整矩阵，详情使用不遮挡矩阵导航的单独 Surface；
- 固定房源轴和 sticky 日期轴；
- 只有矩阵容器可以横向滚动，页面主体不能产生二维溢出。

### Tablet

- `576-991px`：紧凑触控布局；
- 表单、订单详情和上下文详情为单列；
- 不要求在窄宽度保持完整桌面矩阵的全部操作密度。

### Mobile

- `<576px` 不缩小或压扁完整二维矩阵；
- 移动首页使用“今日到店、在住、今日离店、异常”等任务入口；
- 任务进入全屏详情，只保留一个主要下一动作；
- 输入字号至少 `16px`，触控目标至少 `44x44px`；
- sticky action 必须预留 safe area，不能遮挡字段错误或虚拟键盘；
- 可以保存本地表单输入，但不能离线排队业务写入，恢复网络后必须重新校验。

## 8. Visual Contract

- 使用 `design-system/qintopia-pms/MASTER.md` 中的 token，不创建第二套颜色和组件语言；
- 使用系统无衬线字体，`letter-spacing: 0`；
- 房态是高密度工作工具，标题保持紧凑，不使用 Hero；
- 使用分隔线、表格和网格建立层级，不使用卡片套卡片；
- 圆角限制在 `4-8px`，阴影只用于抽屉、菜单和对话框；
- 日期、数量、ID 和金额使用 tabular numerals；
- 使用 Lucide 图标；不熟悉的图标提供 Tooltip；
- 行高、列宽、工具栏、日期格和按钮尺寸稳定；Hover、加载和状态变化不能造成布局跳动；
- 禁止装饰性渐变、玻璃效果、Bokeh、营销插画、超大标题和 Emoji 图标。

## 9. Accessibility Contract

最低验收标准为 WCAG 2.2 AA：

- 页面有唯一 H1、landmark、skip link 和逻辑标题层级；
- 房态、筛选、选区、详情、Preview、Confirm 和 Receipt 可以只用键盘完成；
- `focus-visible` 不被 sticky、overflow、抽屉或固定栏裁切；
- 房态格 accessible name 包含房间/床位、日期、状态和获权对象；拆床父房格还包含 `已占/总床数` 及全部有权查看的居住人昵称；
- 行、列和父子层级具有正确的语义或等价说明；
- 拖选有房源和日期输入替代；
- 表单 Label、错误摘要和字段错误正确关联；
- loading、stale、unknown、blocked 和 Receipt 更新使用克制的 live region，避免重复播报；
- 200% zoom 和 320 CSS px reflow 无文字、焦点、错误或动作重叠；
- 支持 `prefers-reduced-motion`；
- 对话框能够 Escape 关闭、约束焦点并在关闭后返回触发元素。

## 10. Performance And Freshness

- 已认证核心页面 LCP P75 `<=2.5s`；
- 200 个库存单元 x 90 天房态在 `<=2s` 内呈现可交互首屏；
- 正常 90 天房态 Query P95 `<=500ms`；
- 超出可视范围的数据使用窗口化、虚拟化或有界分页，不能删除父子行、来源或状态语义换取性能；
- 当前会话使用命令返回的 committed DTO/Receipt 立即更新；
- 其他可见工作台在 `<=5s` 内看到新 revision，或收到明确的 stale/刷新提示；
- revision 无法确定、刷新失败或页面后台超过 freshness 阈值时显示 `stale/unknown`，并阻断依赖新鲜度的写入；
- 缓存只能提升性能，不能成为事实权威。

## 11. Implementation Touchpoints

优先检查并按需修改：

- `apps/web/src/pages/InventoryPage.tsx`；
- `apps/web/src/styles.css`；
- `apps/web/src/types.ts`；
- `apps/web/src/api.ts`；
- `packages/contracts/` 中的 room-status Query DTO 与 OpenAPI schema；
- `apps/api/` 中对应的只读 Query endpoint；
- `tests/e2e/core-journey.spec.ts`；
- 与新增 DTO、状态和交互直接相关的单元、Integration 和 Contract tests。

不要顺带重写订单、会员、Token 或命令基础设施。任何后端修改只服务于目标房态 DTO、允许动作、新鲜度和稳定引用。

## 12. Delivery Sequence

1. 盘点当前 `InventoryPage`、API DTO 和 E2E，建立 `RS-UI-*` 到代码与测试的追踪表；
2. 增量补齐 typed source、连续区间、`asOf`、freshness、allowed actions 和稳定引用 DTO；
3. 实现房间父行、可展开床位、sticky 日期轴、连续条带、筛选和详情；
4. 实现选区、动作分流、冲突阻断、Preview/Confirm/Receipt 和返回恢复；
5. 完成移动任务替代路径、键盘、屏读、缩放与 reduced-motion；
6. 完成性能、Contract、Integration、E2E 和真实浏览器视觉验证；
7. 启动应用并交付访问 URL、测试结果、截图和非阻断风险。

## 13. Required Verification

至少执行并通过：

```bash
npm run verify
npm run test:integration
npm run test:contract
npm run build
npm run test:e2e
```

浏览器证据至少覆盖：

- `1440x900` 桌面矩阵与并列详情；
- `1024x768` 桌面矩阵与详情切换；
- `768x1024` 紧凑触控布局；
- `375x812` 移动任务入口；
- `320 CSS px` reflow；
- 200% zoom；
- 键盘完成筛选、选区、详情和一个受支持的高风险动作；
- 屏幕阅读器/可访问名称和 Axe 扫描；
- loading、filtered-empty、stale、unknown、blocking-conflict、preview-stale、state-unknown 和 Receipt 状态；
- 房间整房占用阻断子床、床位占用阻断整房、兄弟床位可并存。

截图必须确认矩阵非空、条带和来源可辨、sticky 区不遮挡、文本不溢出、焦点可见、移动界面没有缩小的完整二维矩阵。

## 14. Definition Of Done

- [x] `InventoryPage` 已成为真实数据驱动的 `RoomStatusGrid`，不是静态演示；
- [x] 房间、床位、销售模式和父子互斥被准确表达；
- [x] Order、Stay、Operations 和 Block 来源可区分并可导航；
- [x] `asOf`、freshness、stale 和 unknown 语义完整；
- [x] 空白选区不写事实，动作入口正确分流；
- [x] blocking conflict 禁用确认并给出精确原因；
- [x] READ/WRITE 的可见动作正确；
- [x] Preview、Confirm、Receipt 和 state-unknown 行为保持现有命令合同；
- [x] 返回房态恢复日期、筛选、展开、滚动、选区和焦点；
- [x] 移动端使用任务流，不缩放桌面矩阵；
- [x] WCAG 2.2 AA、键盘、屏读、320px reflow 和 200% zoom 通过；
- [x] 性能与 5 秒 freshness 指标有可重复证据；
- [x] OpenAPI、Web、外围智能体和数据库事实没有行为分叉；
- [x] 既有核心旅程和测试无回归；
- [x] 应用已启动并提供最终 URL、测试摘要、截图和剩余非阻断风险。

## 15. Non-Goals

- 不建设营销首页、Hero、运营大屏或报表仪表盘；
- 不在移动端塞入缩小的完整二维矩阵；
- 不提供可直接编辑的通用 `roomStatus`；
- 不在客户端计算可售、冲突、会员覆盖或金额；
- 不做智能排房、性别/关系分配、自动换房或经济最优推荐；
- 不把 warning 当 blocking conflict，也不把 unknown/stale 当可售；
- 不新增第二套设计系统、图标库或无关 UI 框架；
- 不以 Mock、占位数据、截图或文档代替可运行实现。
