- source_spec: `待开发项/QinTopia-PMS-第4步-阶段7R-实施规格.md`
  summary: 独立审计房态订单上下文保持打开时由后台 revision 触发的跨页住宿位置迁移。
  evidence: 该扫描逻辑在 7R 基线提交 `bf1f37d` 中已存在，仍使用逐页首个 Stay 命中且未统一复用 7R 的全分页一致性、歧义、超时和父房/床位 canonical 解析；不是本次完整订单详情返回补丁引入，故不在 7R 内跨层重构。
