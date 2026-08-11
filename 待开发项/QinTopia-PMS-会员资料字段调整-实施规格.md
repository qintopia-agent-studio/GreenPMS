---
title: QinTopia PMS 会员资料字段调整实施规格：证件号选填化、手机号唯一、新增昵称
status: accepted
stage: 16
classification: A
created: 2026-08-10
depends_on:
  - QinTopia-PMS-分步开发与人工验收计划.md
  - QinTopia-PMS-第4步-4.7-实施规格.md
---

# 会员资料字段调整：证件号选填化、手机号唯一、新增昵称

## 目标

酒店实际经营中不采集客人证件号码。本切片把"身份证号/证件号码"从必填降为全系统选填，把会员档案的唯一标识从身份证号切换为手机号，并给会员资料新增"昵称"字段。所有改动遵循"保留列、选填化"原则：不物理删除任何数据库列，不改写历史事实、回放兼容层和审计快照。

## 已确认决策（2026-08-10 与业务方逐条确认）

1. 会员唯一标识用**手机号唯一**（单字段 UNIQUE），不用"姓名+手机号"组合。
2. 住宿人证件号码保留，仅 UI 标注"（选填）"；API 与数据库本来就是 Optional/nullable，**后端零改动**。
3. 会员新增**昵称**字段，创建会员时必填（与住宿人昵称必填口径一致）。
4. "住宿收款转会员"的会员匹配依据从身份证号改为**手机号**。
5. 会员身份证号列保留，放宽为 nullable 并去掉 UNIQUE；系统重新初始化，无历史数据包袱。
6. 去重报错文案从"该身份证号已登记"改为"该手机号已登记，不能重复创建会员档案"。

## 已确认范围

### A. 住宿人证件号码选填化（仅 UI 文案）

1. 创建订单表单（正常入住与免费入住共用）的主要入住人、各同行人的"证件号码"标签改为"证件号码（选填）"。
2. 住宿人信息纠错对话框的"证件号码"标签同样标注"（选填）"。
3. 订单详情页、住宿人快照展示维持现状（有值显示、无值显示 `-`），不删展示位。
4. API schema、数据库列、命令回放兼容 schema、审计快照**一律不动**。

### B. 会员身份证号选填化 + 手机号唯一

5. 新迁移 `037_member_phone_identity_and_nickname.sql`：
   - `members.identity_card_number` 放宽为 nullable，删除 UNIQUE 约束；非空 CHECK 改为"允许 NULL，非 NULL 时不得为全空白"。
   - 规范化触发器 `qintopia_normalize_new_member_identity` 改为对 NULL 安全（NULL 直传，非 NULL 仍 `upper(btrim(...))`），并统一删除手机号全部空白、对昵称执行 `btrim`；触发范围覆盖新增及身份证号/手机号/昵称更新，防止直接更新绕过规范化唯一约束。
   - 不可变触发器 `qintopia_protect_member_identity` 保持不变（`identity_card_number` 录入后仍不可改）。
   - `members.phone` 新增 UNIQUE 约束（members 表是跨门店全局表，手机号全局唯一，与原身份证号全局唯一口径一致）。
6. 领域层（`packages/db`）：
   - `buildCommandEffect` 的 `CREATE_MEMBER`：`identityCardNumber` 改为选填（空白一律归一为 `null`）；去重检查改为按规范化后 `phone` 查询，冲突时报 `该手机号已登记，不能重复创建会员档案`（409）。
   - `lockCommandResources` 的 `CREATE_MEMBER`：咨询锁键从身份证号改为手机号，行锁查询同步改按手机号。
   - `applyCommandEffect` 的会员落库：写入 nullable `identity_card_number` 与新列 `nickname`。
   - 命令输入规范化（`service.ts`）：`identityCardNumber` 仅在提供时 trim+uppercase；`nickname` trim。
   - `members.ts` 会员搜索：去掉按身份证号 ILIKE，改为按昵称、姓名、手机号、微信号模糊查。
7. API 与契约：
   - `CREATE_MEMBER` 输入 schema：`identityCardNumber` 改 `Type.Optional(nullable(ShortText))`，新增 `nickname: Nickname`（必填、非空白、≤200 字符，复用现有 `Nickname` 定义）。
   - 会员行/视图 schema（`MemberRowSchema`、`CREATE_MEMBER_PROFILE` 效果 schema 等）：`identity_card_number` 改 nullable，新增 `nickname`。
   - `packages/contracts` 的 `CreateMemberInput` 等类型同步。
8. Web 端：
   - 新建会员表单：身份证号去掉 `required`、标签改"身份证号（选填）"；新增"昵称"必填输入框。
   - 会员详情档案区：新增"昵称"行；身份证号无值时显示 `-`。
   - 会员搜索框提示文案改为"昵称、姓名、手机号或微信号"（会员页与库存页会员搜索两处）。
   - `ui.tsx` 中会员档案动作展示（"会员姓名 / 身份证"）与核对文案（"系统会先检查身份证号是否已登记"）同步改为手机号口径。
9. 种子数据：`seed.ts` 演示会员补 `nickname`，证件号可置 NULL。

### C. 住宿收款转会员改按手机号匹配

10. `buildCommandEffect`（`effects.ts` 转换校验段）：主要住宿人匹配字段从 `document_number` 改为 `phone`（取最新纠错后的 `corrected_phone`，无纠错取原始 `phone`）；主要住宿人无手机号时报 `主要住宿人缺少手机号，不能升级会员`；与目标会员手机号不一致时报 `目标会员手机号必须与主要住宿人一致`。本切片**取代** 4.7 规格"已确认范围第 4 条"中的身份证号匹配口径。
11. SQL 守卫：新迁移中 `CREATE OR REPLACE FUNCTION qintopia_assert_stage13_stay_conversion_command_v033`，把主要住宿人证件号比对段改写为手机号比对（两侧去除空白，空串按不匹配处理）；其余资金、产品、权益守卫逻辑原样保留。035 迁移 renamed 后的函数名与调用链不变。
12. `CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP` 效果 schema：`primaryOccupant.identityCardNumber` 改为 `phone: nullable(ShortText)`，`member.identityCardNumber` 改为 `phone: ShortText`。
13. `OrderDetailPage.tsx` 转会员对话框：匹配逻辑改按手机号（`btrim` 后比较）；禁用原因与校验文案改为手机号口径（"主要住宿人缺少手机号，不能升级会员。""没有找到手机号一致的会员，请先创建或核对会员档案。""请选择手机号一致的会员"）；会员下拉选项标签从"姓名 · 身份证号"改为"姓名 · 手机号"。
14. 行为说明（写入验收指引）：住宿人手机号本来就是选填，主要住宿人未留手机号时升级会员入口被拦下，需先通过住宿人信息纠错补录手机号，再发起转会员。

### D. 测试同步

15. 契约测试：CREATE_MEMBER 入参/会员行 schema、重复手机号报错、转会员效果 schema。
16. 集成测试：`member-profile-lifecycle` 的重复建档用例改按手机号；新增"无身份证号可建档""昵称必填"用例；`stay-collection-membership-conversion` 的匹配/拒绝用例改按手机号（含无手机号拒绝）。
17. E2E：`core-journey.spec.ts` 的"重复身份证会员"用例改为重复手机号；会员建档辅助函数与断言去掉身份证必填；`member-stays-step2c.spec.ts` 证件号码标签断言适配"（选填）"。
18. Web 单测：`OrderDetailPage.test.ts` 等涉及"证件号码"/身份证文案的断言同步。

## 不在本切片

- 物理删除 `identity_card_number`、`document_number` 列或清理历史快照中的证件号数据。
- 住宿人证件号码的 API、数据库、回放兼容层改动。
- 会员资料编辑（改名/改手机号）新旅程；会员退款、权益、计价逻辑。
- 住宿人昵称、整房多人、房态展示等既有功能的行为变更。

## 数据模型变更摘要

```sql
-- 037_member_phone_identity_and_nickname.sql（要点）
ALTER TABLE members ALTER COLUMN identity_card_number DROP NOT NULL;
ALTER TABLE members DROP CONSTRAINT members_identity_card_number_key;  -- UNIQUE
ALTER TABLE members DROP CONSTRAINT members_identity_card_number_nonblank;
ALTER TABLE members ADD CONSTRAINT members_identity_card_number_nonblank
  CHECK (identity_card_number IS NULL OR identity_card_number !~ '^[[:space:]]*$');
ALTER TABLE members ADD COLUMN nickname text;
UPDATE members SET nickname = full_name WHERE nickname IS NULL;
ALTER TABLE members ALTER COLUMN nickname SET NOT NULL;
ALTER TABLE members ADD CONSTRAINT members_nickname_nonblank CHECK (nickname !~ '^[[:space:]]*$');
ALTER TABLE members ADD CONSTRAINT members_phone_unique UNIQUE (phone);
-- 重写 qintopia_normalize_new_member_identity（NULL 安全 + phone 删除全部空白 + nickname btrim）
-- 重写 qintopia_assert_stage13_stay_conversion_command_v033（证件号比对段改手机号比对）
```

## 系统自动检查

- `npm run typecheck`、`npm run build`。
- Unit、Integration、Contract/OpenAPI 全量。
- 会员建档/转会员相关 E2E（core-journey、member-stays-step2c、调价与会员备注）。
- readiness 必须校验 037 的会员列空值口径、手机号唯一、非空白约束、规范化函数体与触发器绑定。

## 人工验收指引（A 级，三项可合并为一次验收）

1. **会员建档**：新建会员只填昵称、姓名、手机号、微信号（身份证留空）可成功；用同一手机号再次建档，提示"该手机号已登记，不能重复创建会员档案"；会员详情可见昵称；搜索昵称/手机号能找到会员。
2. **开单**：正常入住与免费入住表单的证件号码均标注"（选填）"，留空可正常开单；住宿人纠错对话框同样标注选填。
3. **转会员**：对一笔有企微收款的住宿订单发起转会员，系统按主要住宿人手机号匹配会员；主要住宿人无手机号时被拦下并提示补录，补录后可完成转入。

## 通过标准

- 三项人工验收全部通过；自动检查全绿；任一检查点不通过只返工该检查点。
