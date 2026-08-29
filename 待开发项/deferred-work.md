- source_spec: `待开发项/QinTopia-PMS-第4步-阶段7R-实施规格.md`
  summary: 独立审计房态订单上下文保持打开时由后台 revision 触发的跨页住宿位置迁移。
  evidence: 该扫描逻辑在 7R 基线提交 `bf1f37d` 中已存在，仍使用逐页首个 Stay 命中且未统一复用 7R 的全分页一致性、歧义、超时和父房/床位 canonical 解析；不是本次完整订单详情返回补丁引入，故不在 7R 内跨层重构。
- source_spec: `待开发项/QinTopia-PMS-第4步-U2-当前页面信息减负-实施规格.md`
  summary: 单独审计后台打开的第二房态工作台收到新投影响应后未自动重绘的问题。
  evidence: U2 最终审查证明观察页能够在 5 秒内收到包含新维修事实的响应，但后台页在显式刷新前不渲染该区间；这不是本轮单击、拖选与快捷操作框返工引入，当前回归保留显式刷新后的真实 DOM 门禁。
- source_spec: `待开发项/QinTopia-PMS-第4步-U2-当前页面信息减负-实施规格.md`
  summary: 2026-08-08 上线前轻量 UI 调整：主内容区移除常驻门店栏，门店选择收纳到左侧栏底部；房态日期范围控制移入房态表格左上角，筛选行保持原布局，并在上下滚动房态日历时冻结筛选行与日期表头。
  evidence: B 级界面信息减负切片，不改变计价、资金、库存、权限或订单生命周期业务规则；已通过 Web 构建、本地页面视觉检查、上下滚动冻结检查和横向滚动同步检查。
- source_spec: `待开发项/spec-room-status-active-inventory-actions.md`
  summary: 独立审计“父房已下线但子床仍为 active”时，报价与库存接口是否仍将该子床视为可售的跨模块不变量。
  evidence: 房态展示树会随 inactive 父房隐藏子床，但 `packages/db/src/inventory.ts` 和 `packages/db/src/pricing-service.ts` 的现有可售链路只检查子床自身 `active`；修复需要重新确认库存/报价业务语义，不在本次展示树补丁中擅自扩大。
- source_spec: `待开发项/QinTopia-PMS-第4步-U2-当前页面信息减负-实施规格.md`
  summary: 2026-08-09 上线前房态体验修正：刷新跨过新鲜度窗口时保留上一版真实房态视觉、仅暂停写操作；同时提高冻结房间列层级，避免锁房区间横向滚动后覆盖房号侧栏。
  evidence: B 级 UI 纠偏，不改变库存和订单业务规则；默认 Vitest 710 项、相关单元测试 65 项、刷新状态与冻结列遮挡 E2E、类型检查、Web 生产构建及本地真实页面几何遮挡检查均通过。
- source_spec: `待开发项/spec-complete-overdue-reserved-stay.md`
  summary: 修复撤销入住后存在原收款却无法登记真实退款的动作入口。
  evidence: `REVOKE_CHECK_IN` 会把合同金额归零并保留退款参考，但 `RECORD_REFUND` 的允许状态遗漏 `CHECK_IN_REVOKED`；退款领域实现本身支持引用原收款，需独立补齐投影、契约与回归测试。
- source_spec: `待开发项/spec-complete-overdue-reserved-stay.md`
  summary: 定义逾期预订但客人事实上仍在住时的“恢复在住并续住”流程。
  evidence: 普通入住在计划离店日后被拒绝，而续住只允许 `CHECKED_IN`，当前没有能同时如实补记入住并迁移未来库存的合法出口。
- source_spec: `待开发项/spec-complete-overdue-reserved-stay.md`
  summary: 定义逾期在住订单实际续住若干晚且现已离店时的历史续住闭环。
  evidence: 迟录退房只能按原计划离店日结束，普通续住又要求新离店日晚于当前营业日，无法记录真实的历史延长区间后再完成住宿。
- source_spec: `待开发项/spec-complete-overdue-reserved-stay.md`
  summary: 统一设计已取消、未到、撤销入住及已退房订单的受控事实纠错入口。
  evidence: 这些终态不可重开，已退房也不能重价；误操作、旧渠道资料缺失或终态金额录错时目前只能停留在错误事实，需另行定义审计、资金和库存补偿规则。
- source_spec: `待开发项/spec-complete-overdue-reserved-stay.md`
  summary: 为历史回执结果增加命令级 discriminator，消除通用 Receipt schema 的结构重叠。
  evidence: `COMPLETE_STAY` 已强制 64 位效果哈希，但历史 `BACKFILL_COMPLETED_STAY` 仍需兼容读取无 hash 结果；若要由通用 Receipt schema 绝对区分，需要新增持久 metadata 并迁移历史读取契约。
- source_spec: `待开发项/QinTopia-PMS-在住升级会员与历史补录-实施规格.md`
  summary: 启用多门店前单独设计全局手机号会员的跨门店资料关联、可见性和权益适用规则。
  evidence: 2026-08-26 业务方确认 8.6 仅交付当前单门店旅程，不自动关联另一门店会员，也不共享会员资料或权益；未来若出现手机号已存在但未关联当前门店的场景，必须先失败关闭并重新确认跨门店语义。
