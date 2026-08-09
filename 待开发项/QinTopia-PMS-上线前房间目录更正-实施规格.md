---
title: 'QinTopia PMS 上线前房间目录更正'
type: 'bugfix'
created: '2026-08-08'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f4757bce0a703df96594fa105d716e724bc1f32a'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 上线前同事复核发现 QinTopia 西安部分房号的房型归属写反，且房态页目录中一栋 101、102 仍显示旧的 `Room 101` / `Room 102` 风格，无法体现“四人间/两人间、独卫/公卫”等运营语义。

**Approach:** 更正 2026 参考目录、既有 demo/本地库存单元和前端房态目录显示兜底。该变更只调整房号与房型/床位明细的对应关系，不改变门店、价格锚点、会员政策、总房间数或总物理床位数。

## Boundaries & Constraints

**Always:** 总房间数保持 44，总物理床位数保持 91；目录分类总量保持不变：四人间（公卫）10 间/40 床，两人间（公卫）3 间/6 床，标间（公卫）8 间/16 床，单人间（公卫）8 间/8 床。需将 catalog importId 升级为新的上线前确认版本，并让迁移后的 `inventory_units.catalog_version` 对齐。房态页显示应优先呈现中文业务房型，不能把旧英文 legacy 名称露出给用户。

**Ask First:** 如果迁移检测到即将下线的床位上存在 active 订单/维修/内部占用 Claim 或 HELD 会员权益覆盖，则停止迁移并要求人工处理，不得静默隐藏仍在使用的库存。

**Never:** 不改价格金额、价格产品公式、门店 code/name、订单生命周期规则、会员产品价格/配额、日期栏冻结逻辑；不删除库存单元历史身份，不用 destructive delete 清理床位。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 更正目录 | 104/106/204 为两人间、105/108/206 为四人间等旧归属 | 104/106/204 变四人间；105/108/206 变两人间；301/303/D02 变公卫标间；305/308/D04 变公卫单人间 | 若快照与 canonical tuple 不一致，校验失败 |
| 既有库存同步 | 本地 DB 已有旧 catalog_version/旧房型 | 房间 name、room_type_code、pricing_product_code、physical_bed_count、occupancy_capacity 同步为新版；扩容房间补 C/D 床，缩容房间 C/D 置 inactive | 如被下线床位仍有 active Claim 或 HELD coverage，迁移抛错停止 |
| legacy 显示 | 一栋 101/102 名称仍是 `Room 101` / `Room 102` | 房态目录显示“四人间（公卫）”，不显示 `Room 101` | 若 roomTypeCode 缺失，保留现有兜底“房间” |

</frozen-after-approval>

## Code Map

- `packages/db/src/reference-catalog.ts` -- authoritative revision 561 catalog tuples and canonical validation seal.
- `packages/db/catalog/qintopia-2026-reference-catalog.json` -- bundled JSON mirror loaded by seed/build/test.
- `packages/db/src/migrations/036_qintopia_prelaunch_room_catalog_corrections.sql` -- synchronizes existing DB inventory units without deleting identities.
- `packages/db/src/seed.ts` -- confirms generated room/bed names and products used for fresh DBs.
- `apps/web/src/room-status/roomStatusPresentation.tsx` -- room list label/description logic used by room-status grid.
- `apps/web/src/room-status/roomStatusPresentation.test.ts` and `packages/db/src/reference-catalog.test.ts` -- focused regression coverage.
- `docs/architecture/qintopia-asset-catalog.md`, `tests/integration/operational-references.integration.test.ts`, `scripts/verify-backup-restore.sh` -- catalogVersion references that must follow the new importId.

## Tasks & Acceptance

**Execution:**
- [x] `packages/db/src/reference-catalog.ts` -- update the twelve corrected room tuples and importId -- make canonical TS snapshot match the confirmed room plan.
- [x] `packages/db/catalog/qintopia-2026-reference-catalog.json` -- mirror the same room corrections and importId -- keep bundled runtime data consistent.
- [x] `packages/db/src/migrations/036_qintopia_prelaunch_room_catalog_corrections.sql` -- update existing rooms/beds, insert/reactivate expanded C/D beds, deactivate obsolete C/D beds with guards -- make already-created local/demo DBs match fresh seed behavior safely.
- [x] `apps/web/src/room-status/roomStatusPresentation.tsx` -- fallback from generic/legacy names to `roomTypeCode` labels -- prevent `Room 101` style labels from leaking.
- [x] Tests/docs/reference files -- update expectations and add regression assertions -- prove totals are unchanged and display is corrected.

**Acceptance Criteria:**
- Given the corrected catalog, when reference catalog summary is computed, then it still reports 44 physical rooms and 91 physical beds.
- Given 101 or 102 has legacy name `Room 101`/`Room 102` but `roomTypeCode=shared_bath_quad`, when the房态目录 renders, then the description is “四人间（公卫）”.
- Given an existing DB before migration 036, when migration runs with no active usage on removed beds, then corrected rooms and active bed sets match the bundled catalog.
- Given removed bed units have active Claims or HELD coverage, when migration 036 runs, then it aborts instead of silently hiding occupied/held beds.

## Spec Change Log

## Verification

**Commands:**
- `npm run typecheck` -- expected: no TypeScript errors.
- `npm run test -- packages/db/src/reference-catalog.test.ts apps/web/src/room-status/roomStatusPresentation.test.ts` -- expected: focused regressions pass.
- `npm run test` -- expected: default Vitest suite passes.
- `npm run build` -- expected: production build succeeds.
- `npx vitest run tests/integration/migration-concurrency.integration.test.ts` -- expected: targeted migration regression passes.
- `git diff --check` and `bash -n scripts/verify-backup-restore.sh scripts/verify-compose-cold-start.sh` -- expected: whitespace and shell syntax pass.

**Gate Results:**
- TypeScript、production build 与 `git diff --check` 通过。
- Focused catalog/display regressions：`28/28` 通过。
- Default Vitest suite：`710/710` 通过。
- Targeted migration-concurrency integration：`6/6` 通过，覆盖旧 v4 升级与 active claim fail-closed guard。
- Shell syntax checks：`scripts/verify-backup-restore.sh`、`scripts/verify-compose-cold-start.sh` 通过 `bash -n`。
- 本地 demo DB 已应用 036 并复核：44 间房、91 张物理床、46 个 active sellable bed units；核心更正房间与床位集匹配 v5 catalog。

## Suggested Review Order

**权威目录与总量不变**

- Catalog 版本升到 v5，房间 tuple 是本轮房型更正的源头。
  [`reference-catalog.ts:101`](../packages/db/src/reference-catalog.ts#L101)

- 1栋 104/105/106/108 与 2栋 204/206 的四人间/两人间更正。
  [`reference-catalog.ts:129`](../packages/db/src/reference-catalog.ts#L129)

- 3栋 301/303/305/308 与 D栋 D02/D04 的标间/单人间更正。
  [`reference-catalog.ts:141`](../packages/db/src/reference-catalog.ts#L141)

- Catalog regression 证明修正后仍是 44 间房、91 张物理床。
  [`reference-catalog.test.ts:68`](../packages/db/src/reference-catalog.test.ts#L68)

**既有数据库安全迁移**

- 036 开头先锁 `inventory_units`、`inventory_claims`、`coverage_items`，再做 active usage guard。
  [`036_qintopia_prelaunch_room_catalog_corrections.sql:1`](../packages/db/src/migrations/036_qintopia_prelaunch_room_catalog_corrections.sql#L1)

- 父房间的 room type、pricing product、床位数、显示名同步为 v5。
  [`036_qintopia_prelaunch_room_catalog_corrections.sql:74`](../packages/db/src/migrations/036_qintopia_prelaunch_room_catalog_corrections.sql#L74)

- 扩容房间补/恢复 C-D 床，缩容房间把旧 C-D 床置为 inactive，而不是删除身份。
  [`036_qintopia_prelaunch_room_catalog_corrections.sql:108`](../packages/db/src/migrations/036_qintopia_prelaunch_room_catalog_corrections.sql#L108)

- 旧 v4 升级测试模拟错误目录，再断言修正后的房间与 active bed set。
  [`migration-concurrency.integration.test.ts:249`](../tests/integration/migration-concurrency.integration.test.ts#L249)

- active claim guard 测试证明使用中的重分类库存会拒绝迁移。
  [`migration-concurrency.integration.test.ts:569`](../tests/integration/migration-concurrency.integration.test.ts#L569)

**房态目录显示**

- `Room 101` / `Room 102` 这类 legacy 名称优先回退到中文房型；缺少 roomTypeCode 时显示“房间”。
  [`roomStatusPresentation.tsx:147`](../apps/web/src/room-status/roomStatusPresentation.tsx#L147)

- 前端 regression 覆盖 101 房间和床位 legacy 英文名，不再露出 `Room 101`。
  [`roomStatusPresentation.test.ts:196`](../apps/web/src/room-status/roomStatusPresentation.test.ts#L196)
