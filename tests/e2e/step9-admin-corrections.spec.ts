import { expect, test, type Locator, type Page } from "@playwright/test";
import { todayInTimeZone } from "@qintopia/domain";

test.skip(process.env.STEP9_ACCEPTANCE_E2E !== "true", "Step 9 acceptance fixtures are prepared separately");

const propertyToday = todayInTimeZone("Asia/Shanghai");
const propertyId = "prop_qintopia_demo";

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page, username: "operator" | "admin" = "admin") {
  await page.goto("/");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: /房间与床位逐日房态|今日运营任务/ })).toBeVisible({ timeout: 30_000 });
}

async function confirmAndClose(page: Page, expectedTexts: string[]) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const expected of expectedTexts) await expect(effect).toContainText(expected);
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toHaveClass(/receipt-success/);
  const receiptHeading = receipt.getByRole("heading", { level: 3 });
  await expect(receiptHeading).toHaveText(/已完成$/);
  await expect(receiptHeading).not.toContainText("未完成");
  await expect(receipt).not.toContainText("本次纠错没有写入");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(receipt).toBeHidden();
}

async function confirmBusinessCommand(page: Page, expectedTexts: string[], successMessage: string) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const expected of expectedTexts) await expect(effect).toContainText(expected);
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  await page.getByTestId("confirm-command").click();
  await expect(page.getByText(successMessage, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(effect).toBeHidden();
}

async function selectMember(page: Page, name: string): Promise<string> {
  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "会员档案", exact: true })).toBeVisible();
  await page.getByTestId("member-search-query").fill(name);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const result = page.getByTestId("member-list-item").filter({ hasText: name });
  await expect(result).toHaveCount(1, { timeout: 15_000 });
  await result.click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const memberId = new URL(page.url()).searchParams.get("memberId");
  if (!memberId) throw new Error(`Missing selected member id for ${name}`);
  return memberId;
}

async function openMember(page: Page, name: string): Promise<string> {
  const memberId = await selectMember(page, name);
  await page.getByTestId("open-member-corrections").click();
  await expect(page.getByRole("dialog", { name: "修改会员记录" })).toBeVisible();
  return memberId;
}

async function selectedOptionValue(select: Locator, text: string): Promise<string> {
  await expect(select).toBeVisible({ timeout: 15_000 });
  await expect(select).toBeEnabled({ timeout: 15_000 });
  const option = select.locator("option").filter({ hasText: text });
  await expect(option).toHaveCount(1, { timeout: 15_000 });
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`Missing option value for ${text}`);
  return value;
}

async function selectedControlValue(control: Locator, label: string): Promise<string> {
  await expect(control).toBeVisible({ timeout: 15_000 });
  await expect(control).toBeEnabled({ timeout: 15_000 });
  await expect(control).not.toHaveValue("", { timeout: 15_000 });
  const value = await control.inputValue();
  if (!value) throw new Error(`Missing selected value for ${label}`);
  return value;
}

test("administrator corrects one historical stay and atomically swaps two completed stays", async ({ page }) => {
  await login(page);
  await page.goto("/orders");
  await page.getByRole("button", { name: "修改历史安排", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "修改历史住宿安排" });
  let candidateSelect = dialog.getByLabel("加入已完成订单");
  const singleOrderId = await selectedOptionValue(candidateSelect, "历史单笔待修改");
  await candidateSelect.selectOption(singleOrderId);
  await dialog.getByRole("button", { name: "加入修改清单", exact: true }).click();
  const single = dialog.locator(".historical-correction-item").filter({ hasText: "历史单笔待修改" });
  await single.getByLabel("真实入住日期").fill(addDays(propertyToday, -15));
  await single.getByLabel("真实退房日期").fill(addDays(propertyToday, -13));
  await dialog.getByLabel("证据说明").fill("纸质入住记录与企业微信沟通已核对");
  await dialog.getByRole("button", { name: "生成整组核对", exact: true }).click();
  await confirmAndClose(page, ["历史单笔待修改", addDays(propertyToday, -15), addDays(propertyToday, -13)]);
  const singleResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(singleOrderId)}`);
  expect(singleResponse.status()).toBe(200);
  expect((await singleResponse.json()).amendments).toEqual(expect.arrayContaining([
    expect.objectContaining({ amendment_type: "CORRECT_HISTORICAL_STAY_ARRANGEMENT" })
  ]));
  await page.goto(`/orders/${encodeURIComponent(singleOrderId)}`);
  await expect(page.getByTestId("order-arrangements")
    .getByText(`${addDays(propertyToday, -15)} 至 ${addDays(propertyToday, -13)}`, { exact: true })).toBeVisible();
  await page.goto("/orders");

  await page.getByRole("button", { name: "修改历史安排", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "修改历史住宿安排" });
  candidateSelect = dialog.getByLabel("加入已完成订单");
  const pengOrderId = await selectedOptionValue(candidateSelect, "鹏哥");
  await candidateSelect.selectOption(pengOrderId);
  await dialog.getByRole("button", { name: "加入修改清单", exact: true }).click();
  await candidateSelect.selectOption(await selectedOptionValue(candidateSelect, "小尚"));
  await dialog.getByRole("button", { name: "加入修改清单", exact: true }).click();
  const peng = dialog.locator(".historical-correction-item").filter({ hasText: "鹏哥" });
  const shang = dialog.locator(".historical-correction-item").filter({ hasText: "小尚" });
  const pengUnit = await peng.getByLabel("真实房源").inputValue();
  const shangUnit = await shang.getByLabel("真实房源").inputValue();
  await peng.getByLabel("真实房源").selectOption(shangUnit);
  await shang.getByLabel("真实房源").selectOption(pengUnit);
  await dialog.getByLabel("证据说明").fill("纸质房号记录证明鹏哥与小尚房间登记互换");
  await dialog.getByRole("button", { name: "生成整组核对", exact: true }).click();
  await confirmAndClose(page, ["鹏哥", "小尚", "保持不变"]);
  const swapResponse = await page.request.get(`/api/v1/orders/${encodeURIComponent(pengOrderId)}`);
  expect(swapResponse.status()).toBe(200);
});

test("administrator corrects member profile and an active membership effective date", async ({ page }) => {
  await login(page);
  const profileMemberId = await openMember(page, "会员资料待修改");
  let dialog = page.getByRole("dialog", { name: "修改会员记录" });
  await dialog.getByTestId("correct-member-full-name").fill("会员资料已核实");
  await dialog.getByTestId("correct-member-nickname").fill("资料已核");
  await dialog.getByTestId("correct-member-wechat").fill("step9-profile-verified");
  await dialog.getByTestId("member-correction-evidence").fill("会员本人资料与企微联系方式已核实");
  await dialog.getByRole("button", { name: "生成只读核对", exact: true }).click();
  await confirmAndClose(page, ["会员资料已核实", "资料已核", "step9-profile-verified"]);
  await page.reload();
  await expect(page.getByTestId("member-correction-history")).toContainText("会员资料修改");
  expect((await page.request.get(`/api/v1/members/${encodeURIComponent(profileMemberId)}?propertyId=${encodeURIComponent(propertyId)}`)).status()).toBe(200);

  const effectiveDateMemberId = await openMember(page, "办卡日期待修改");
  dialog = page.getByRole("dialog", { name: "修改会员记录" });
  await dialog.getByTestId("member-correction-mode").selectOption("CORRECT_MEMBERSHIP_EFFECTIVE_DATE");
  await dialog.getByTestId("actual-membership-date").fill(addDays(propertyToday, -30));
  await dialog.getByTestId("member-correction-evidence").fill("真实办卡付款日期与会员确认记录已核实");
  await dialog.getByRole("button", { name: "生成只读核对", exact: true }).click();
  await confirmAndClose(page, [addDays(propertyToday, -30), "系统重新计算", "保持不变"]);
  await page.reload();
  await expect(page.getByTestId("member-correction-history")).toContainText("会员生效日修改");
  expect((await page.request.get(`/api/v1/members/${encodeURIComponent(effectiveDateMemberId)}?propertyId=${encodeURIComponent(propertyId)}`)).status()).toBe(200);
});

test("administrator backfills a historical membership with independent membership and payment dates", async ({ page }) => {
  await login(page);
  const memberId = await openMember(page, "历史办卡待补录");
  const dialog = page.getByRole("dialog", { name: "修改会员记录" });
  await dialog.getByTestId("member-correction-mode").selectOption("BACKFILL_HISTORICAL_MEMBERSHIP");
  const productSelect = dialog.getByTestId("backfill-membership-product");
  await productSelect.selectOption(await selectedOptionValue(productSelect, "公卫单人间会员"));
  const membershipStartDateHint = dialog.getByLabel(/^会员开始日期说明：/);
  await membershipStartDateHint.hover();
  await expect(dialog.getByRole("tooltip").filter({ hasText: "会员合同和权益从该日期开始计算" })).toBeVisible();
  await dialog.getByTestId("actual-membership-date").fill(addDays(propertyToday, -20));
  await dialog.getByTestId("historical-membership-payment-yuan").fill("1620");
  const paymentDateHint = dialog.getByLabel(/^企业微信收款日期说明：/);
  await paymentDateHint.hover();
  await expect(dialog.getByRole("tooltip").filter({ hasText: "该日期仅用于核对收款" })).toBeVisible();
  await dialog.getByTestId("historical-membership-payment-date").fill(addDays(propertyToday, -22));
  await dialog.getByTestId("historical-membership-payment-reference").fill("WX-STEP9-HISTORICAL-BACKFILL");
  await dialog.getByTestId("member-correction-evidence").fill("历史办卡付款截图与会员确认记录已核实");
  await dialog.getByRole("button", { name: "生成只读核对", exact: true }).click();
  await confirmAndClose(page, ["公卫单人间会员", "¥1,620.00", addDays(propertyToday, -20), addDays(propertyToday, -22), "WX-STEP9-HISTORICAL-BACKFILL", "有效期规则", "1 年", "30"]);
  await page.reload();
  await expect(page.getByTestId("member-correction-history")).toContainText("历史办卡补录");
  await expect(page.getByTestId("member-correction-history")).toContainText("企业微信收款日期");
  expect((await page.request.get(`/api/v1/members/${encodeURIComponent(memberId)}?propertyId=${encodeURIComponent(propertyId)}`)).status()).toBe(200);
});

for (const memberName of ["Cathy", "晶晶"]) {
  test(`administrator voids ${memberName}'s erroneous membership and reconverts the historical stay`, async ({ page }) => {
    await login(page);
    const memberId = await openMember(page, memberName);
    const dialog = page.getByRole("dialog", { name: "修改会员记录" });
    await dialog.getByTestId("member-correction-mode").selectOption("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY");
    const erroneousMembershipOrderId = await selectedControlValue(dialog.getByTestId("erroneous-membership-order"), "错误会员订单");
    const sourceStayOrderId = await selectedControlValue(dialog.getByTestId("membership-reconversion-source-stay"), "对应历史住宿");
    await dialog.getByTestId("actual-membership-date").fill(addDays(propertyToday, -5));
    await dialog.getByTestId("has-replacement-direct-payment").check();
    await dialog.getByTestId("replacement-payment-date").fill(addDays(propertyToday, -6));
    const replacementReference = `WX-STEP9-${memberName === "Cathy" ? "CATHY" : "JINGJING"}-TRUE-DIFFERENCE`;
    await dialog.getByTestId("replacement-payment-reference").fill(replacementReference);
    await dialog.getByTestId("member-correction-evidence").fill("错误办卡、真实住宿收款与差额付款凭证已逐笔核实");
    await dialog.getByRole("button", { name: "生成只读核对", exact: true }).click();
    await confirmAndClose(page, [memberName, "¥936.00", "¥130.00", "¥806.00", addDays(propertyToday, -5), addDays(propertyToday, -6), replacementReference, "29"]);
    await page.reload();
    await expect(page.getByTestId("member-correction-history")).toContainText("撤销错误办卡并重新升级");
    await expect(page.locator(`[data-membership-order-id="${erroneousMembershipOrderId}"]`)).toContainText("已作废");
    const memberResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(memberId)}?propertyId=${encodeURIComponent(propertyId)}`);
    expect(memberResponse.status()).toBe(200);
    const memberView = await memberResponse.json();
    expect(memberView.membershipOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ order: expect.objectContaining({ id: erroneousMembershipOrderId, status: "VOIDED" }) })
    ]));
    expect(memberView.lots).toEqual(expect.arrayContaining([expect.objectContaining({ status: "VOIDED" })]));
    expect((await page.request.get("/api/v1/meta")).status()).toBe(200);
    expect((await page.request.get(`/api/v1/orders/${encodeURIComponent(sourceStayOrderId)}`)).status()).toBe(200);
  });
}

for (const fixture of [
  { username: "operator", memberName: "在职欠款会员-普通员工", reference: "WX-STEP9-ACTIVE-UNDERPAID-OPERATOR-FINAL" },
  { username: "admin", memberName: "在职欠款会员-管理员", reference: "WX-STEP9-ACTIVE-UNDERPAID-ADMIN-FINAL" }
] as const) {
  test(`${fixture.username} records the outstanding payment without changing an active membership`, async ({ page }) => {
    await login(page, fixture.username);
    const memberId = await selectMember(page, fixture.memberName);
    const beforeResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(memberId)}?propertyId=${encodeURIComponent(propertyId)}`);
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json();
    const beforeOrder = before.membershipOrders[0];
    expect(beforeOrder.order.status).toBe("ACTIVE");
    expect(beforeOrder.paymentTotalMinor).toBe(60_000);
    expect(beforeOrder.paymentDifferenceMinor).toBe(-33_600);

    const membershipOrder = page.locator(
      `[data-testid="membership-order-item"][data-membership-order-id="${beforeOrder.order.id}"]`
    );
    await expect(membershipOrder).toContainText("已生效");
    await expect(membershipOrder.getByTestId("membership-payment-difference")).toContainText("收款比成交价少 ¥336.00");
    const paymentButton = membershipOrder.getByTestId("record-membership-payment");
    await expect(paymentButton).toHaveText("收款");
    await paymentButton.click();
    await expect(page.getByRole("dialog", { name: "收款", exact: true })).toBeVisible();
    await expect(page.getByTestId("membership-payment-yuan")).toHaveValue("336");
    await page.getByTestId("membership-payment-reference").fill(fixture.reference);
    await page.getByRole("button", { name: "核对收款信息", exact: true }).click();
    await confirmBusinessCommand(
      page,
      ["成交价", "¥936.00", "此前实收", "¥600.00", "本次收款", "¥336.00", "收款后差额", "已收足"],
      "企微收款已登记，会员订单已刷新。"
    );

    const afterResponse = await page.request.get(`/api/v1/members/${encodeURIComponent(memberId)}?propertyId=${encodeURIComponent(propertyId)}`);
    expect(afterResponse.status()).toBe(200);
    const after = await afterResponse.json();
    const afterOrder = after.membershipOrders[0];
    expect(afterOrder.order.status).toBe("ACTIVE");
    expect(afterOrder.paymentTotalMinor).toBe(93_600);
    expect(afterOrder.paymentDifferenceMinor).toBe(0);
    expect(afterOrder.order).toMatchObject({
      id: beforeOrder.order.id,
      activated_at: beforeOrder.order.activated_at,
      valid_from: beforeOrder.order.valid_from,
      valid_until: beforeOrder.order.valid_until,
      contract_id: beforeOrder.order.contract_id,
      entitlement_lot_id: beforeOrder.order.entitlement_lot_id,
      entitlement_units: beforeOrder.order.entitlement_units,
      version: beforeOrder.order.version
    });
    expect(after.contracts).toEqual(before.contracts);
    expect(after.lots).toEqual(before.lots);
    expect(after.ledger).toEqual(before.ledger);
    expect(afterOrder.paymentFacts).toHaveLength(beforeOrder.paymentFacts.length + 1);

    await page.reload();
    await expect(membershipOrder.getByTestId("membership-payment-difference")).toContainText("收款合计与成交价一致");
    await expect(membershipOrder.getByTestId("record-membership-payment")).toHaveCount(0);
  });
}
