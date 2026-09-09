import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseURL = "http://127.0.0.1:4207";
const output = new URL("./evidence/", import.meta.url);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const results = {};
try {
  await context.request.post(`${baseURL}/api/v1/auth/login`, { data: { username: "admin", password: "demo-pass-2026" } });
  const orders = await (await context.request.get(`${baseURL}/api/v1/orders?propertyId=prop_qintopia_demo`)).json();
  const order = orders.orders.find((item) => item.status === "RESERVED");
  for (const [name, path, pattern, delay] of [
    ["room-status", "/", "**/room-status?*", 2100],
    ["order-detail", `/orders/${order.id}`, `**/api/v1/orders/${order.id}`, 4500]
  ]) {
    const page = await context.newPage();
    const requests = [];
    const responses = [];
    let delayedResponses = 0;
    page.on("request", (request) => { if (request.url().includes("/api/v1/")) requests.push({ url: request.url(), time: Date.now() }); });
    page.on("response", (response) => { if (response.url().includes("/api/v1/")) responses.push({ url: response.url(), status: response.status(), time: Date.now() }); });
    await page.route(pattern, async (route) => {
      delayedResponses += 1;
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, delay));
      try { await route.fulfill({ response }); } catch {}
    });
    await page.goto(`${baseURL}${path}`);
    await page.waitForTimeout(14000);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-slow-response.png`, output)) });
    results[name] = { delay, delayedResponses, requests, responses,
      cells: await page.locator("[data-room-status-cell]").count(),
      body: await page.locator("body").innerText()
    };
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(new URL("latency-results.json", output), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}
