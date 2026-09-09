import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseURL = "http://127.0.0.1:4207";
const output = new URL("./evidence/", import.meta.url);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const results = {};
const page = await context.newPage();
async function snapshot(name) {
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
  return page.locator("body").innerText();
}
try {
  await context.request.post(`${baseURL}/api/v1/auth/login`, { data: { username: "admin", password: "demo-pass-2026" } });
  const orders = await (await context.request.get(`${baseURL}/api/v1/orders?propertyId=prop_qintopia_demo`)).json();
  const order = orders.orders.find((item) => item.status === "RESERVED" && item.stay_type !== "FREE");
  await page.goto(`${baseURL}/orders/${order.id}`);
  await page.getByTestId("record-collection").click();
  await page.getByTestId("fact-amount-yuan").fill("123.45");
  await page.getByTestId("transaction-reference").fill("AUDIT-UNSAVED-ONLY");
  results.formBeforeRefreshFailure = { amount: await page.getByTestId("fact-amount-yuan").inputValue(), reference: await page.getByTestId("transaction-reference").inputValue() };
  let failures = 0;
  await page.route(`**/api/v1/orders/${order.id}`, async (route) => {
    if (failures++ === 0) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "Temporary audit failure", retryable: true }) });
    else await route.continue();
  });
  await page.getByText("无法载入订单", { exact: true }).waitFor({ timeout: 10000 });
  results.formDuringRefreshFailure = await snapshot("edit-form-refresh-failure");
  await page.getByTestId("fact-amount-yuan").waitFor({ timeout: 10000 });
  results.formAfterRecovery = { amount: await page.getByTestId("fact-amount-yuan").inputValue(), reference: await page.getByTestId("transaction-reference").inputValue(), text: await snapshot("edit-form-values-lost") };
  await page.unroute(`**/api/v1/orders/${order.id}`);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto(baseURL);
  await page.locator("[data-room-status-cell]").first().click();
  await page.getByRole("button", { name: "创建订单", exact: true }).click();
  await page.getByTestId("create-order").waitFor();
  results.emptyCreateOrder = {
    disabled: await page.getByTestId("create-order").isDisabled(),
    describedBy: await page.getByTestId("create-order").getAttribute("aria-describedby"),
    title: await page.getByTestId("create-order").getAttribute("title"),
    text: await snapshot("create-order-disabled-no-reason")
  };
} finally {
  await browser.close();
  await writeFile(new URL("form-results.json", output), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}
