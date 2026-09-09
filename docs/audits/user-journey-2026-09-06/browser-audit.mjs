import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const baseURL = "http://127.0.0.1:4197";
const output = new URL("./evidence/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const results = { pages: [], probes: {}, requests: [], pageErrors: [] };
page.on("pageerror", (error) => results.pageErrors.push(error.message));
page.on("response", async (response) => {
  if (!response.url().includes("/api/v1/")) return;
  try {
    await response.finished();
    results.requests.push({
      path: new URL(response.url()).pathname,
      method: response.request().method(),
      status: response.status(),
      duration: Math.round(response.request().timing().responseEnd),
      bytes: (await response.body()).length
    });
  } catch {}
});

async function login() {
  await page.goto(baseURL);
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await page.locator(".app-shell").waitFor();
  await page.waitForLoadState("networkidle");
}

async function snapshot(name, runAxe = true) {
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
  const layout = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    visibleButtons: [...document.querySelectorAll("button, a")]
      .filter((node) => node.getBoundingClientRect().width && node.getBoundingClientRect().height)
      .map((node) => ({
        text: node.getAttribute("aria-label") || node.textContent.trim(),
        width: Math.round(node.getBoundingClientRect().width),
        height: Math.round(node.getBoundingClientRect().height),
        disabled: node.disabled ?? false
      }))
  }));
  const violations = runAxe ? (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map((item) => ({
    id: item.id, impact: item.impact, description: item.description,
    nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
  })) : [];
  results.pages.push({ name, url: page.url(), layout, violations });
  return page.locator("body").innerText();
}

try {
  await page.goto(baseURL);
  await page.getByTestId("login-username").fill("invalid-audit-user");
  await page.getByTestId("login-password").fill("invalid-audit-password");
  await page.getByTestId("login-submit").click();
  await page.getByRole("alert").waitFor();
  results.probes.loginFailure = await snapshot("login-failure");
  await login();

  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 812 });
    for (const [name, path] of [["inventory", "/"], ["orders", "/orders"], ["members", "/members"], ["today", "/today"], ["tokens", "/tokens"], ["accounts", "/accounts"]]) {
      await page.goto(`${baseURL}${path}`);
      await page.locator(".app-shell").waitFor();
      await page.waitForLoadState("networkidle");
      await snapshot(`${name}-${width}`);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/members`);
  await page.waitForLoadState("networkidle");
  await page.getByTestId("create-member").click();
  results.probes.newMember = await snapshot("new-member-desktop");
  await page.getByRole("button", { name: "取消", exact: true }).click();

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const today = date.split("/").length === 3 ? date.split("/").reverse().join("-") : date;
  const futureDate = new Date(`${today}T00:00:00Z`);
  futureDate.setUTCDate(futureDate.getUTCDate() + 3);
  const future = futureDate.toISOString().slice(0, 10);
  const endDate = new Date(futureDate);
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const end = endDate.toISOString().slice(0, 10);
  const common = {
    property_id: "prop_qintopia_demo", stay_type: "TRANSIENT", booking_channel_code: "WECOM",
    member_id: null, member_contract_id: null, channel_order_reference: null,
    current_contract_amount_minor: 26000, currency: "CNY", version: 1,
    current_unit_code: "201", current_unit_name: "201 · 单人间（公卫）", created_at: new Date().toISOString()
  };
  const rows = [
    { ...common, id: "audit-cancelled-2020", primary_guest_snapshot: { fullName: "已处理取消样例", nickname: "六年前已取消", phone: "19900001001" }, status: "CANCELLED", stay_status: "CANCELLED", arrival_date: "2020-01-01", departure_date: "2020-01-02" },
    { ...common, id: "audit-future-arrival", primary_guest_snapshot: { fullName: "未来入住样例", nickname: "三天后才到店", phone: "19900001002" }, status: "RESERVED", stay_status: "PLANNED", arrival_date: future, departure_date: end }
  ];
  await page.route("**/api/v1/orders?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ businessDate: today, orders: rows }) }));
  await page.goto(`${baseURL}/today`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: /异常/ }).click();
  results.probes.resolvedException = await snapshot("resolved-order-still-exception");
  await page.getByLabel("营业日期").fill(future);
  await page.getByRole("tab", { name: /今日到店/ }).click();
  results.probes.futureArrivalAction = {
    today, future, enabled: await page.getByRole("button", { name: "入住", exact: true }).isEnabled(),
    text: await snapshot("future-arrival-enabled")
  };
  await page.unroute("**/api/v1/orders?*");

  await page.goto(`${baseURL}/orders`);
  await page.waitForLoadState("networkidle");
  await context.clearCookies();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").waitFor();
  results.probes.expiredSession = {
    text: await snapshot("session-expired-orders"),
    loginFormVisible: await page.getByTestId("login-submit").count(),
    reloginLinks: await page.getByRole("button", { name: /重新登录/ }).count()
  };
  await login();
  await page.route("**/api/v1/meta", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.properties = [];
    await route.fulfill({ response, json: data });
  });
  await page.goto(baseURL);
  await page.getByRole("status").waitFor();
  await page.waitForTimeout(1200);
  results.probes.noProperty = await snapshot("no-property-endless-loading");
  await page.unroute("**/api/v1/meta");
} finally {
  await browser.close();
  await writeFile(new URL("browser-results.json", output), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ pages: results.pages.length, violations: results.pages.filter((item) => item.violations.length).map((item) => ({ name: item.name, violations: item.violations.map((v) => ({ id: v.id, count: v.nodes.length })) })), pageErrors: results.pageErrors, probes: Object.keys(results.probes) }, null, 2));
}
