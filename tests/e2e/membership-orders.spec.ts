import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { todayInTimeZone } from "@qintopia/domain";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态" })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible();
}

async function confirmMembershipCommand(page: Page, expectedEffect: string[], expectedReceipt: string) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible({ timeout: 15_000 });
  for (const expected of expectedEffect) await expect(effect).toContainText(expected);
  const confirm = page.getByTestId("confirm-command");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText(expectedReceipt);
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(page.getByText("正在载入会员列表", { exact: true })).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText("正在载入会员档案", { exact: true })).toBeHidden({ timeout: 15_000 });
}

async function recordPayment(page: Page, amountYuan: string, reference: string) {
  await page.getByTestId("record-membership-payment").click();
  await page.getByTestId("membership-payment-yuan").fill(amountYuan);
  await page.getByTestId("membership-payment-reference").fill(reference);
  await page.getByRole("button", { name: "核对收款信息", exact: true }).click();
  await confirmMembershipCommand(page, [reference, `¥${Number(amountYuan).toLocaleString("en-US", { minimumFractionDigits: 2 })}`], "企微收款已登记");
}

function nextYear(date: string): string {
  const year = Number(date.slice(0, 4)) + 1;
  return `${year}${date.slice(4)}`;
}

test("2B sells a fixed membership product with append-only WeCom payment correction and explicit activation", async ({ page }, testInfo: TestInfo) => {
  await login(page);
  await page.getByRole("link", { name: "会员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员档案" })).toBeVisible();

  const suffix = testInfo.project.name;
  const memberName = `2B验收会员-${suffix}`;
  await page.getByTestId("create-member").click();
  await page.getByTestId("member-full-name").fill(memberName);
  await page.getByTestId("member-nickname").fill(memberName);
  await page.getByTestId("member-identity-card").fill(`E2E-2B-${suffix}-001`);
  await page.getByTestId("member-phone").fill(suffix === "desktop" ? "13922000001" : "13922000002");
  await page.getByTestId("member-wechat").fill(`qintopia-2b-${suffix}`);
  await page.getByRole("button", { name: "核对并创建", exact: true }).click();
  await confirmMembershipCommand(page, [memberName, `E2E-2B-${suffix.toUpperCase()}-001`], "会员档案已创建");
  await expect(page.getByRole("heading", { name: memberName, exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("create-membership-order").click();
  const product = page.getByTestId("membership-product");
  await expect(product.locator("option")).toHaveCount(3);
  await expect(product.locator("option", { hasText: "公卫单人间会员 · ¥1,620.00" })).toHaveCount(1);
  await expect(product.locator("option", { hasText: "独卫单人间会员 · ¥2,160.00" })).toHaveCount(1);
  await expect(product.locator("option", { hasText: "公卫四人间会员 · ¥936.00" })).toHaveCount(1);

  const productSummary = page.getByLabel("会员产品信息");
  await product.selectOption("membership_product_shared_bath_single_v1");
  await expect(productSummary).toContainText("¥1,620.00");
  await expect(productSummary).toContainText("30 间夜");
  await expect(productSummary).toContainText("公卫单人间");
  await expect(productSummary).toContainText("生效日起一年");

  await product.selectOption("membership_product_private_bath_single_v1");
  await expect(productSummary).toContainText("¥2,160.00");
  await expect(productSummary).toContainText("30 间夜");
  await expect(productSummary).toContainText("独卫单人间");

  await product.selectOption("membership_product_shared_bath_quad_v1");
  await expect(productSummary).toContainText("¥936.00");
  await expect(productSummary).toContainText("30 床夜");
  await expect(productSummary).toContainText("公卫四人间单床");

  await product.selectOption("membership_product_shared_bath_single_v1");
  await page.getByTestId("membership-agreed-price-yuan").fill("1600");
  const adjustmentReason = page.getByTestId("membership-price-adjustment-reason");
  await expect(adjustmentReason).toBeVisible();
  await expect(adjustmentReason).toHaveAttribute("required", "");
  await page.getByRole("button", { name: "核对会员订单", exact: true }).click();
  await expect(adjustmentReason).toBeFocused();
  await adjustmentReason.fill("2B 自动化验收调价");
  await page.getByRole("button", { name: "核对会员订单", exact: true }).click();
  await confirmMembershipCommand(page, ["公卫单人间会员", "¥1,620.00", "¥1,600.00", "2B 自动化验收调价"], "会员订单已创建");

  const order = page.getByTestId("membership-order-item").filter({ hasText: "2B 自动化验收调价" });
  await expect(order).toContainText("待生效");
  await expect(order).toContainText("标价¥1,620.00");
  await expect(order).toContainText("成交价¥1,600.00");
  await expect(order).toContainText("调价差额-¥20.00");
  await expect(order.getByTestId("membership-payment-difference")).toContainText("收款比成交价少 ¥1,600.00");

  await order.getByTestId("activate-membership-order").click();
  const activationDialog = page.getByRole("dialog", { name: "生效会员订单" });
  await expect(activationDialog.getByRole("alert")).toContainText("会员订单至少登记一笔有效企微收款后才能生效", { timeout: 15_000 });
  await activationDialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect(order).toContainText("待生效");
  await expect(order.getByTestId("membership-activation-summary")).toHaveCount(0);

  const firstReference = `WX-2B-${suffix}-001`;
  const secondReference = `WX-2B-${suffix}-002`;
  const correctedReference = `WX-2B-${suffix}-001-CORRECTED`;
  await recordPayment(page, "600", firstReference);
  await expect(order).toContainText(firstReference);
  await recordPayment(page, "500", secondReference);
  await expect(order).toContainText(secondReference);
  await expect(order.getByTestId("membership-payment-difference")).toContainText("收款比成交价少 ¥500.00");

  await order.getByRole("button", { name: "更正", exact: true }).first().click();
  await expect(page.getByTestId("membership-payment-yuan")).toHaveValue("600");
  await expect(page.getByTestId("membership-payment-reference")).toHaveValue(firstReference);
  await page.getByTestId("membership-payment-yuan").fill("700");
  await page.getByTestId("membership-payment-reference").fill(correctedReference);
  await page.getByRole("button", { name: "核对更正内容", exact: true }).click();
  await confirmMembershipCommand(page, [firstReference, correctedReference, "¥600.00", "¥700.00"], "企微收款已更正");

  await expect(order).toContainText("冲销原收款");
  await expect(order).toContainText("更正后收款");
  await expect(order).toContainText(correctedReference);
  await expect(order).toContainText("2 笔有效收款");
  await expect(order.getByTestId("membership-payment-difference")).toContainText("收款比成交价少 ¥400.00");

  await order.getByTestId("activate-membership-order").click();
  const activationEffect = page.getByTestId("command-effect");
  await expect(activationEffect).toContainText("有效企微收款合计¥1,200.00", { timeout: 15_000 });
  await expect(activationEffect).toContainText("收款与成交价差额-¥400.00");
  await expect(activationEffect).toContainText("生效发放30 间夜");
  await confirmMembershipCommand(page, ["收款差额只作提示", "30 间夜"], "会员订单已生效");

  const validFrom = todayInTimeZone("Asia/Shanghai");
  const activationSummary = order.getByTestId("membership-activation-summary");
  await expect(order).toContainText("已生效");
  await expect(activationSummary).toContainText(`${validFrom} 至 ${nextYear(validFrom)}`);
  await expect(activationSummary).toContainText("已发放 30 间夜");
  await expect(order.getByTestId("record-membership-payment")).toHaveText("收款");
  await expect(order.getByTestId("activate-membership-order")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("membership-orders-2b.png"), fullPage: true });
});
