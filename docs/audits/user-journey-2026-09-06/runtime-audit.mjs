import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const baseURL = "http://127.0.0.1:4207";
const output = new URL("./evidence/", import.meta.url);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const results = { probes: {}, pages: [] };
const propertyId = "prop_qintopia_demo";
const apiPath = `/api/v1/orders?propertyId=${propertyId}`;

async function json(path, body) {
  const response = body ? await context.request.post(`${baseURL}${path}`, {
    headers: { "Idempotency-Key": `journey-audit-${crypto.randomUUID()}`, "X-Correlation-ID": `audit-${crypto.randomUUID()}` }, data: body
  }) : await context.request.get(`${baseURL}${path}`);
  const value = await response.json();
  if (!response.ok()) throw new Error(JSON.stringify({ status: response.status(), value }));
  return value;
}

async function shot(name) {
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
  const layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) }));
  results.pages.push({ name, layout, violations });
  return page.locator("body").innerText();
}

try {
  await json("/api/v1/auth/login", { username: "admin", password: "demo-pass-2026" });
  const { orders, businessDate } = await json(apiPath);
  const order = orders.find((item) => item.status === "RESERVED" && item.stay_type !== "FREE");
  if (!order) throw new Error("The isolated audit fixture must contain a reserved order");
  const detail = await json(`/api/v1/orders/${order.id}`);
  const occupant = detail.occupants.find((item) => item.role === "PRIMARY");
  const envelope = { commandType: "CORRECT_ORDER_OCCUPANT", input: {
    propertyId, orderId: order.id, occupantId: occupant.id,
    expectedPriorSnapshot: { fullName: occupant.fullName, nickname: occupant.nickname, phone: occupant.phone, documentNumber: occupant.documentNumber },
    correctedSnapshot: { fullName: "审查更正后的姓名", nickname: "审查更正后的昵称", phone: "19900001099", documentNumber: occupant.documentNumber }
  } };
  const preview = await json("/api/v1/command-previews", envelope);
  const receipt = await json(`/api/v1/command-previews/${preview.preview.previewId}/confirm`, {
    propertyId, commandType: envelope.commandType, confirmation: true, expectedEffectHash: preview.preview.effectHash,
    reason: { code: "JOURNEY_AUDIT_SYNTHETIC", note: "仅修改本次独立测试库的合成资料，用于核对纠正后列表搜索一致性。" }
  });
  const correctedDetail = await json(`/api/v1/orders/${order.id}`);
  const listAfter = (await json(apiPath)).orders.find((item) => item.id === order.id);
  results.probes.correctedIdentity = { businessCommitted: receipt.businessCommitted, orderId: order.id, original: occupant.nickname, listSnapshot: listAfter.primary_guest_snapshot, detailPrimary: correctedDetail.occupants.find((item) => item.role === "PRIMARY") };

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
    await page.goto(`${baseURL}/orders/${order.id}`);
    await page.getByRole("heading", { name: "审查更正后的昵称", exact: true }).waitFor();
    await shot(`populated-order-${width}`);
    await page.goto(`${baseURL}/orders`);
    await page.getByTestId("orders-table").waitFor();
    await shot(`populated-orders-${width}`);
  }
  await page.getByRole("searchbox", { name: "搜索订单" }).fill("审查更正后的昵称");
  results.probes.correctedIdentity.search = await shot("corrected-name-search-empty");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await page.locator("[data-room-status-cell]").first().waitFor();
  await page.evaluate(() => performance.clearResourceTimings());
  const idleStart = Date.now();
  await page.waitForTimeout(12000);
  results.probes.idleRoomStatus = { elapsedMs: Date.now() - idleStart, resources: await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/room-status?")).map((entry) => ({ durationMs: Math.round(entry.duration), encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, transferSize: entry.transferSize }))) };

  let slowBoardRequests = 0;
  await page.route("**/room-status?*", async (route) => {
    slowBoardRequests += 1;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    try { await route.fulfill({ response }); } catch {}
  });
  await page.goto(baseURL);
  await page.waitForTimeout(14000);
  results.probes.slowBoard = { addedDelayMs: 2100, requests: slowBoardRequests, cells: await page.locator("[data-room-status-cell]").count(), text: await shot("room-status-2100ms-blocked") };
  await page.unroute("**/room-status?*");

  let slowDetailRequests = 0;
  await page.route(`**/api/v1/orders/${order.id}`, async (route) => {
    slowDetailRequests += 1;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 4500));
    try { await route.fulfill({ response }); } catch {}
  });
  await page.goto(`${baseURL}/orders/${order.id}`);
  await page.waitForTimeout(14000);
  results.probes.slowOrderDetail = { addedDelayMs: 4500, waitedMs: 14000, requests: slowDetailRequests, detailVisible: await page.getByRole("heading", { name: "审查更正后的昵称", exact: true }).count(), text: await shot("order-detail-4500ms-loading") };
  await page.unroute(`**/api/v1/orders/${order.id}`);
} finally {
  await browser.close();
  await writeFile(new URL("runtime-results.json", output), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}
