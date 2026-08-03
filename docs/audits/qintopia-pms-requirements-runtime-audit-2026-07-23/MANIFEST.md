---
title: QinTopia PMS 审计包清单
audit_date: 2026-07-23
status: ready-for-independent-review
---

# QinTopia PMS 审计包清单

## 1. 包内容

| 文件 | 用途 | SHA-256 |
|---|---|---|
| [AUDIT-REPORT.md](./AUDIT-REPORT.md) | 主审计结论、风险、Gate、范围分层和建议路线 | `77d462d25bc2a79bc1b1e579aadd62276376aa6da8c640d02e08a4b79688c917` |
| [EVIDENCE-MAP.md](./EVIDENCE-MAP.md) | 需求与代码证据映射，供逐项复核 | `4b9f27ae524f6777cbcf9136b6659043b6b16702ab55eb5ed4f00b4ce91f52b1` |
| [EXTERNAL-AUDITOR-PROMPT.md](./EXTERNAL-AUDITOR-PROMPT.md) | 可直接交给第二智能体的只读对抗审计提示词 | `909d8d2dd4799b015d5d5c6abdd93ab77077542780885946557bb950dadf7f9d` |
| `MANIFEST.md` | 本清单、边界、工作树和验证记录 | 不自校验 |

若任一文件被编辑，应重新计算对应 SHA-256：

```bash
shasum -a 256 docs/audits/qintopia-pms-requirements-runtime-audit-2026-07-23/*.md
```

## 2. 审计边界

- 唯一审计根目录：`/Users/feather/Documents/Codex project/Green PMS`
- 未读取 Git 历史。
- 未读取或复制旧 PMS、FewohBee 或其他仓库。
- 未访问或修改真实外部支付、银行、Feishu 工作流或其他生产系统。
- 未修改业务代码、数据库、API、测试或 UI。
- 初审后根据用户新增确认，仅同步更新了核心规格、分步开发计划和 90 天 companion 的业务追溯与实施门禁文字；这些文档修改不构成业务实现。
- 本包不是实施授权；用户说“开始实施”之前应保持只读讨论。

## 3. 工作树基线

审计开始时：

```text
branch: main
tracking: origin/main
ahead: 1 commit
modified:
  docs/implementation/spec-guest-nickname-bed-occupancy.md
  docs/implementation/spec-qintopia-pms-core-operations-mvp.md
untracked:
  待开发项/
```

这些既有修改视为用户或前序任务内容，本审计没有覆盖或还原它们。初审完成后，为记录用户新增确认，本轮在现有改动基础上精确更新了核心规格，以及 `待开发项/` 下的分步计划和 90 天规格；审计包本身额外出现在 `docs/audits/` 下。

## 4. 审计输入

主要需求输入：

- `待开发项/房态与订单运营流程分步开发计划.md`
- `待开发项/房态90天连续时间轴与超长住宿开发规格.md`
- `docs/implementation/spec-qintopia-pms-core-operations-mvp.md`
- `docs/implementation/room-status-ui-development-goal.md`
- `docs/implementation/room-status-grid-implementation-spec.md`
- `docs/implementation/spec-guest-nickname-bed-occupancy.md`
- `docs/architecture/invariants-and-decisions.md`
- `docs/pricing-facts/qintopia-2026-building-room-bed-price-catalog.md`
- `design-system/qintopia-pms/MASTER.md`
- `README.md`

主要实现输入：

- `packages/contracts/src/index.ts`
- `packages/domain/src/`
- `packages/db/src/`
- `packages/db/src/migrations/`
- `apps/api/src/`
- `apps/web/src/`
- `tests/`
- `scripts/`
- `Dockerfile`
- `compose.yaml`
- `package.json`

## 5. 审计分工

主审计交叉验证了三条独立只读审计线：

| 审计线 | 重点 |
|---|---|
| 产品与范围 | 核心主线、范围膨胀、文档权威、阶段依赖和可延期项 |
| 领域与状态 | 计价、会员、Stay、变更、履约、资金和数据库事实 |
| 架构与测试 | API、权限、PII、房态投影、运行脚本、测试证据和部署边界 |

所有发现由主审计重新对照当前工作树，不把子审计意见自动视为事实。

## 6. 本次执行的验证

```text
npm run verify
  PASS: TypeScript typecheck
  PASS: 16 test files
  PASS: 201 tests

npm run test:pricing-facts
  PASS: 7 real pricing fact cases
```

本次未重新执行 PostgreSQL integration、OpenAPI contract、Playwright E2E、冷启动、Compose 和备份恢复。历史文档中的通过记录只代表对应历史基线。

## 7. 阅读顺序

给用户：

1. `AUDIT-REPORT.md` 的第 1、4、9、10 节；
2. 对 Gate 给出意见；
3. 把 `EXTERNAL-AUDITOR-PROMPT.md` 交给第二智能体。

给第二智能体（唯一入口）：

1. 只需先接收并完整读取 `EXTERNAL-AUDITOR-PROMPT.md`；该文件会要求继续读取本清单和其他证据；
2. 把主报告视为待反驳的初审；
3. 独立抽查 `EVIDENCE-MAP.md` 的需求和代码引用；
4. 按提示词输出异议、遗漏、范围建议和用户问题；
5. 不修改项目。

给后续实施者：

1. 先确认用户已经明确授权实施；
2. 先解决报告第 9 节 Gate；
3. 不把本审计建议当作用户已确认事实；
4. 使用最新 Current Requirements Index，而不是任意一个历史 `done` 文件；
5. 每个里程碑完成后交给用户人工验收，再进入下一项。
