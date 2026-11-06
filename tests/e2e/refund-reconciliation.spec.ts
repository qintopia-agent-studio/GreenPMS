/** Dedicated local synthetic acceptance; fixture creation runs under Node/tsx
 * to preserve the application ESM loader, independently of Playwright transforms. */
import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

test.skip(process.env.REFUND_RECONCILIATION_E2E !== "true", "Dedicated synthetic acceptance requires explicit opt-in");
async function prepare(group: string): Promise<{ orderId: string; reference: string; refundReference: string; nickname: string }> {
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("tests/e2e/setup-refund-reconciliation-fixture.ts"), group], { env: process.env, timeout: 30_000 });
  return JSON.parse(stdout.trim());
}
async function chooseBill(page: Page, label: string, reference: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("button", { name: "查找完整清单", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByLabel("付款人昵称 / 单号") });
  await dialog.getByLabel("付款人昵称 / 单号").fill(reference);
  await dialog.getByRole("button").filter({ hasText: `编号：${reference}` }).click();
}

for (const loseResponse of [false, true]) test(`取消单收退补齐：${loseResponse ? "确认丢响应与错误回执恢复" : "跨日异常和返回修改"}`, async ({ page }, info) => {
  if (!info.project.use.baseURL || !["127.0.0.1", "localhost"].includes(new URL(info.project.use.baseURL).hostname)) throw new Error("Use local acceptance servers only");
  const fixture = await prepare(info.project.name);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const login = await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  expect(login.ok()).toBe(true);
  await page.goto("/today"); await page.getByRole("tab", { name: /异常/ }).click();
  await page.getByRole("button", { name: "财务异常", exact: true }).click();
  const queue = page.getByRole("region", { name: /企微收退款/ });
  await expect(queue.locator(".payment-reconciliation-row").filter({ hasText: fixture.reference })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("refund-reconciliation-open-exceptions.png"), fullPage: true });
  await page.getByLabel("营业日期").fill("2026-01-01");
  await expect(queue.locator(".payment-reconciliation-row").filter({ hasText: fixture.reference })).toHaveCount(2);
  await page.goto(`/orders/${fixture.orderId}`);
  const original = await (await page.request.get(`/api/v1/orders/${fixture.orderId}`)).json();
  expect(original.order.status).toBe("CANCELLED"); expect(original.refundReconciliationAvailable).toBe(true);
  await page.locator('[data-order-action="RECORD_REFUND"]').first().click();
  await page.getByRole("button", { name: "原收款尚未登记，一起补齐", exact: true }).click();
  await chooseBill(page, "选择需要补记的企业微信原收款", fixture.reference);
  await expect(page.getByTestId("reconciliation-source-amount")).toHaveValue("1000");
  await chooseBill(page, "选择第 1 笔企业微信退款", fixture.refundReference);
  await page.getByTestId("reconciliation-note").fill("合成验收：取消订单已收已退，补齐漏记");
  await page.screenshot({ path: info.outputPath("refund-reconciliation-filled-form.png"), fullPage: true });
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  await expect(page.getByTestId("command-effect")).toContainText(fixture.refundReference);
  await page.screenshot({ path: info.outputPath("refund-reconciliation-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect(page.getByTestId("reconciliation-source-amount")).toHaveValue("1000");
  await expect(page.getByTestId("reconciliation-refund-amount-0")).toHaveValue("1000");
  await expect(page.getByTestId("reconciliation-note")).toHaveValue("合成验收：取消订单已收已退，补齐漏记");
  // Rehydration resolves both bill IDs before the restored draft may proceed.
  await expect(page.getByTestId("reconciliation-source-picker").getByRole("button", { name: "选择需要补记的企业微信原收款", exact: true })).toContainText(fixture.nickname);
  await expect(page.getByTestId("reconciliation-refund-0-picker").getByRole("button", { name: "选择第 1 笔企业微信退款", exact: true })).toContainText(fixture.nickname);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  let confirmations = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/command-previews\/[^/]+\/confirm$/.test(new URL(request.url()).pathname)) confirmations += 1; });
  let invalidRecovery = true;
  if (loseResponse) {
    await page.route("**/api/v1/command-previews/*/confirm", async route => {
      const committed = await route.fetch();
      expect((await committed.json()).businessCommitted).toBe(true);
      await route.abort("failed");
    }, { times: 1 });
    await page.route("**/api/v1/command-results/resolve", async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (invalidRecovery && body.businessCommitted) body.factRefs = [body.result.sourceFactId];
      await route.fulfill({ response, json: body });
    });
  }
  await page.getByTestId("confirm-command").click();
  if (loseResponse) {
    await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
    await page.reload();
    const recovery = page.getByTestId("order-command-recovery");
    await expect(recovery).toBeVisible();
    const badResponse = page.waitForResponse(response => response.url().endsWith("/command-results/resolve"), { timeout: 15_000 });
    await recovery.getByRole("button").click();
    await page.getByRole("button", { name: "查询操作结果", exact: true }).click();
    await badResponse;
    await expect(page.getByText(/服务端返回的操作结果无法核对/)).toBeVisible();
    await expect(page.getByTestId("command-receipt")).toHaveCount(0);
    await expect(page.getByTestId("confirm-command")).toHaveCount(0);
    invalidRecovery = false;
    await page.getByRole("button", { name: "查询操作结果", exact: true }).click();
  }
  await expect(page.getByTestId("command-receipt")).toContainText("收款与退款已一起登记");
  expect(confirmations).toBe(1);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  const updated = await (await page.request.get(`/api/v1/orders/${fixture.orderId}`)).json();
  expect(updated.order.status).toBe("CANCELLED"); expect(updated.order.current_contract_amount_minor).toBe(original.order.current_contract_amount_minor);
  expect(updated.stay).toEqual(original.stay); expect(updated.effectiveArrangement).toEqual(original.effectiveArrangement);
  expect(updated.collectionFacts.filter((fact: { fact_type: string }) => fact.fact_type === "COLLECTION")).toHaveLength(1);
  expect(updated.collectionFacts.filter((fact: { fact_type: string }) => fact.fact_type === "REFUND")).toHaveLength(1);
  expect(updated.amounts.netRecordedCollection.minorUnits).toBe(0);
  await page.goto("/today"); await page.getByRole("tab", { name: /异常/ }).click();
  await page.getByRole("button", { name: "财务异常", exact: true }).click();
  await expect(queue.getByRole("heading", { name: /企微收退款/ })).toBeVisible();
  await expect(queue.locator(".payment-reconciliation-row").filter({ hasText: fixture.reference })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("refund-reconciliation-complete.png"), fullPage: true });
  expect(errors).toEqual([]);
});
