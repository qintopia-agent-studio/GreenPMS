import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态" })
    .or(page.getByRole("heading", { name: "房态任务", exact: true }))).toBeVisible();
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

test("取消空白重复会员订单保留正常已生效订单", async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole("link", { name: "会员", exact: true }).click();
  const mobile = testInfo.project.name === "mobile";
  const name = `取消重复单验收-${testInfo.project.name}`;
  await page.getByTestId("create-member").click();
  await page.getByTestId("member-full-name").fill(name);
  await page.getByTestId("member-nickname").fill(name);
  await page.getByTestId("member-phone").fill(mobile ? "13922000992" : "13922000991");
  await page.getByTestId("member-wechat").fill(`cancel-member-${testInfo.project.name}`);
  await page.getByRole("button", { name: "核对并创建", exact: true }).click();
  await confirmMembershipCommand(page, [name], "会员档案已创建");
  const createPurchase = async () => {
    await page.getByTestId("create-membership-order").click();
    await page.getByTestId("membership-product").selectOption("membership_product_shared_bath_quad_v1");
    await page.getByRole("button", { name: "核对会员订单", exact: true }).click();
    await confirmMembershipCommand(page, ["公卫四人间会员", "¥936.00"], "会员订单已创建");
  };
  await createPurchase();
  await page.getByTestId("record-membership-payment").click();
  await page.getByTestId("membership-payment-yuan").fill("936");
  await page.getByTestId("membership-payment-reference").fill(`cancel-normal-payment-${testInfo.project.name}`);
  await page.getByRole("button", { name: "核对收款信息", exact: true }).click();
  await confirmMembershipCommand(page, ["¥936.00"], "企微收款已登记");
  await expect(page.getByTestId("cancel-membership-order")).toHaveCount(0);
  await page.getByTestId("activate-membership-order").click();
  await confirmMembershipCommand(page, ["30 床夜"], "会员订单已生效");
  const normalId = await page.getByTestId("membership-order-item").getAttribute("data-membership-order-id");
  const normal = page.locator(`[data-membership-order-id="${normalId}"]`);
  const normalBefore = await normal.innerText();
  await createPurchase();
  await expect(page.getByTestId("membership-order-item")).toHaveCount(2);
  await expect(page.getByTestId("cancel-membership-order")).toHaveCount(1);
  await page.getByTestId("cancel-membership-order").click();
  await expect(page.getByRole("button", {name:"核对取消订单",exact:true})).toBeDisabled();
  await page.getByTestId("membership-cancel-reason").fill("重复办理");
  await page.getByRole("button", {name:"核对取消订单",exact:true}).click();
  await expect(page.getByTestId("command-effect")).toContainText("重复办理");
  await page.getByRole("button", {name:"返回修改", exact:true}).click();
  await expect(page.getByTestId("membership-cancel-reason")).toHaveValue("重复办理");
  await page.getByRole("button", {name:"核对取消订单",exact:true}).click();
  await confirmMembershipCommand(page, ["重复办理", "待生效 → 已取消"], "会员订单已取消");
  const cancelled = page.getByTestId("membership-order-item").filter({hasText:"取消原因："});
  await expect(cancelled).toContainText("已取消");
  await expect(cancelled).toContainText("重复办理");
  for (const id of ["membership-payment-difference", "record-membership-payment", "activate-membership-order", "cancel-membership-order"]) await expect(cancelled.getByTestId(id)).toHaveCount(0);
  expect(await normal.innerText()).toBe(normalBefore);
  await page.reload();
  await expect(page.getByTestId("membership-cancellation-summary")).toContainText("重复办理");
  await page.getByRole("heading", {name:"会员订单",exact:true}).scrollIntoViewIfNeeded();
  await mkdir(".local-workspace/cancel-membership-validation", {recursive:true});
  await page.locator(".membership-orders-panel").screenshot({ path: `.local-workspace/cancel-membership-validation/${testInfo.project.name}.png` });
});
