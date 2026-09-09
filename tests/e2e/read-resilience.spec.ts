import { expect, test, type Page } from "@playwright/test";
import { prepareStage13Acceptance, type Stage13AcceptanceFixture } from "./setup-stage13-acceptance";

let fixture: Stage13AcceptanceFixture;
test.beforeAll(async () => {
  fixture = await prepareStage13Acceptance(process.env.E2E_DATABASE_URL);
});

async function openOrder(page: Page) {
  await page.request.post("/api/v1/auth/login", { data: fixture.operator });
  await page.goto(`/orders/${fixture.conversion.orderId}`);
  await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
}

for (const delay of [2_000, 4_500, 8_000]) {
  test(`F01: ${delay}ms detail succeeds and polling never overlaps`, async ({ page }) => {
    let active = 0; let maximum = 0; let completed = 0;
    await page.route("**/api/v1/orders/*", async (route) => {
      active += 1; maximum = Math.max(maximum, active);
      try {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.fulfill({ response });
        completed += 1;
      } finally { active -= 1; }
    });
    await openOrder(page);
    await expect.poll(() => completed, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    expect(maximum).toBe(1);
    await page.getByRole("link", { name: "返回订单", exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toHaveCount(0);
  });
}

test("F03: 503, timeout and recovery keep collection draft and keyboard focus; version changes require a new review", async ({ page }) => {
  await openOrder(page);
  await page.locator('[data-order-action="RECORD_COLLECTION"]').first().click();
  const form = page.locator("dialog").filter({ has: page.getByTestId("transaction-reference") });
  await form.getByTestId("fact-amount-yuan").fill("123.45");
  await form.getByTestId("transaction-reference").fill("UNSUBMITTED-RESILIENCE");
  const path = `**/api/v1/orders/${fixture.conversion.orderId}`;
  let mode: "503" | "timeout" | "recovered" | "changed" = "503";
  let timeouts = 0;
  await page.route(path, async (route) => {
    if (mode === "503") return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "短暂读取失败" } });
    if (mode === "timeout") { timeouts += 1; return route.abort("timedout"); }
    const response = await route.fetch();
    const body = await response.json();
    if (mode === "changed") body.order.version += 1;
    return route.fulfill({ response, json: body });
  });
  await expect(page.getByText("订单刷新失败，草稿已保留；读取恢复前暂不能提交", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(form.getByTestId("fact-amount-yuan")).toHaveValue("123.45");
  await expect(form.getByTestId("transaction-reference")).toBeFocused();
  await expect(form.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  await expect(form.getByLabel("收款方式")).toBeEnabled();
  mode = "timeout";
  await expect.poll(() => timeouts, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(form.getByTestId("transaction-reference")).toHaveValue("UNSUBMITTED-RESILIENCE");
  mode = "recovered";
  await expect(page.getByText("订单刷新失败，草稿已保留；读取恢复前暂不能提交", { exact: true })).toBeHidden({ timeout: 10_000 });
  await expect(form.getByTestId("fact-amount-yuan")).toHaveValue("123.45");
  await expect(form.getByTestId("transaction-reference")).toBeFocused();
  mode = "changed";
  await expect(page.getByText(/原编辑表单已关闭/)).toBeVisible({ timeout: 10_000 });
  await expect(form).toHaveCount(0);
});

test("F05: expiry removes the writable workspace; relogin uses current permissions and drops drafts", async ({ page, context }) => {
  await openOrder(page);
  await page.locator('[data-order-action="RECORD_COLLECTION"]').first().click();
  await page.getByTestId("transaction-reference").fill("OLD-ACCOUNT-DRAFT");
  await context.clearCookies();
  await expect(page.getByTestId("session-expired")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "重新登录", exact: true })).toBeVisible();
  await expect(page.getByText("可写", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("login-username")).toBeFocused();
  await page.route("**/api/v1/me", async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.propertyAccess = { prop_qintopia_demo: "READ" };
    body.allowedActions = { prop_qintopia_demo: [] };
    body.propertyCommandGrants = { prop_qintopia_demo: [] };
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/v1/orders/${fixture.conversion.orderId}`, async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.allowedActions = [];
    await route.fulfill({ response, json: body });
  });
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toBeVisible();
  await expect(page.getByText("可写", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("transaction-reference")).toHaveCount(0);
  await expect(page.locator('[data-order-action="RECORD_COLLECTION"]')).toHaveCount(0);
});

for (const status of [403, 404]) {
  test(`F03: ${status} scope denial discards the old draft even if access later recovers`, async ({ page }) => {
    await openOrder(page);
    await page.locator('[data-order-action="RECORD_COLLECTION"]').first().click();
    await page.getByTestId("transaction-reference").fill("REVOKED-SCOPE-DRAFT");
    const path = `**/api/v1/orders/${fixture.conversion.orderId}`;
    await page.route(path, (route) => route.fulfill({ status, json: { code: "NOT_FOUND", message: "Resource unavailable" } }));
    await expect(page.getByText("无法载入订单", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("transaction-reference")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toHaveCount(0);
    await page.unroute(path);
    await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-order-action="RECORD_COLLECTION"]').first().click();
    await expect(page.getByTestId("transaction-reference")).toHaveValue("");
  });
}

test("F05: 403 and 503 are distinct from expiry and an empty list", async ({ page }) => {
  await openOrder(page);
  let status = 403;
  await page.route("**/api/v1/orders?*", (route) => route.fulfill({ status, json: { code: "READ_FAILED", message: "读取暂时失败" } }));
  await page.getByRole("link", { name: "返回订单", exact: true }).click();
  await expect(page.getByText("当前账号权限不足，无法访问此内容或执行此操作", { exact: true })).toBeVisible();
  await expect(page.getByText("没有匹配订单", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("login-submit")).toHaveCount(0);
  status = 503;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByText("读取暂时失败", { exact: true })).toBeVisible();
  await expect(page.getByText("READ_FAILED: 读取暂时失败", { exact: true })).toHaveCount(0);
  await expect(page.getByText("没有匹配订单", { exact: true })).toHaveCount(0);
});

test("F05: an unknown confirmation survives expiry and resolves its original key without resubmission", async ({ page, context }) => {
  await openOrder(page);
  await page.locator('[data-order-action="RECORD_COLLECTION"]').first().click();
  await page.getByTestId("fact-amount-yuan").fill("1.23");
  await page.getByTestId("transaction-reference").fill(`RESILIENCE-${test.info().project.name}`);
  await page.locator("dialog form").getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled({ timeout: 30_000 });
  let confirmationKey = ""; let confirms = 0;
  await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
    confirmationKey = route.request().headers()["idempotency-key"] ?? "";
    confirms += 1;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByRole("button", { name: /^查询(?:原)?操作结果$/ })).toBeEnabled();
  await context.clearCookies();
  await page.getByRole("button", { name: /^查询(?:原)?操作结果$/ }).click();
  await expect(page.getByTestId("session-expired")).toBeVisible();
  await page.getByTestId("login-submit").click();
  const recovery = page.getByTestId("order-command-recovery");
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button").click();
  const resolved = page.waitForResponse((response) => response.url().endsWith("/api/v1/command-results/resolve")
    && response.request().postDataJSON().idempotencyKey === confirmationKey && response.status() === 200);
  await page.getByRole("button", { name: /^查询(?:原)?操作结果$/ }).click();
  await resolved;
  expect(confirms).toBe(1);
  await expect(page.getByTestId("command-receipt")).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(recovery).toBeHidden();
});

test("F04: corrected nickname, name and phone find the same order across detail, list and today", async ({ page }) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: fixture.operator.password } });
  await page.goto(`/orders/${fixture.conversion.orderId}`);
  const original = await (await page.request.get(`/api/v1/orders/${fixture.conversion.orderId}`)).json();
  await page.getByRole("button", { name: "更正资料", exact: true }).first().click();
  await page.getByTestId("occupant-correction-nickname").fill("更正后的旅人");
  await page.getByTestId("occupant-correction-full-name").fill("当前住客姓名");
  await page.getByTestId("occupant-correction-phone").fill("13900000908");
  await page.getByTestId("occupant-correction-reason").fill("合成测试资料更正");
  await page.getByRole("button", { name: "继续核对更正", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByRole("heading", { name: "更正后的旅人", exact: true })).toBeVisible({ timeout: 30_000 });
  const updated = await (await page.request.get(`/api/v1/orders/${fixture.conversion.orderId}`)).json();
  expect(updated.order.primary_guest_snapshot).toEqual(original.order.primary_guest_snapshot);
  expect(updated.occupantCorrections).toHaveLength(original.occupantCorrections.length + 1);
  await page.goto("/orders");
  for (const search of ["更正后的旅人", "当前住客姓名", "13900000908"]) {
    await page.getByRole("searchbox").fill(search);
    const link = page.getByRole("link", { name: "更正后的旅人", exact: true });
    await expect(link).toHaveAttribute("href", `/orders/${fixture.conversion.orderId}`);
  }
  // The shared conversion fixture has checked out. Supply an in-house read-only
  // presentation sample for today's queue without changing lifecycle facts.
  await page.route("**/api/v1/orders?*", async (route) => {
    const response = await route.fetch(); const body = await response.json();
    // Daily reads now exclude checked-out history on the server. Inject the
    // presentation sample explicitly instead of assuming it appears in that query.
    body.orders = [{ ...updated.order, status: "CHECKED_IN", stay_status: "IN_HOUSE" }];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/today");
  await page.getByRole("tab", { name: /在住/ }).click();
  await expect(page.locator(".queue-row").filter({ hasText: "更正后的旅人" })).toHaveCount(1);
});

for (const delay of [2_100, 8_000]) {
  test(`F02: ${delay}ms room status remains visible with timestamp, bounded retries and closed writes, then recovers`, async ({ page }, testInfo) => {
    await page.request.post("/api/v1/auth/login", { data: fixture.operator });
    let slow = true; let calls = 0; let active = 0; let maximum = 0;
    await page.route("**/api/v1/properties/*/room-status?*", async (route) => {
      calls += 1; active += 1; maximum = Math.max(maximum, active);
      try {
        const response = await route.fetch();
        if (slow) await new Promise((resolve) => setTimeout(resolve, delay));
        await route.fulfill({ response });
      } finally { active -= 1; }
    });
    await page.goto("/");
    const notice = page.getByTestId("room-status-stale-notice");
    await expect(notice).toContainText("仅供查看", { timeout: 30_000 });
    await expect(notice.locator("time")).toHaveAttribute("datetime", /T/);
    if (testInfo.project.name === "mobile") await expect(page.locator(".room-status-mobile")).toBeVisible();
    else expect(await page.locator("[data-room-status-cell]").count()).toBeGreaterThan(0);
    if (testInfo.project.name === "mobile") await expect(page.getByRole("button", { name: "新建住宿或锁房" })).toHaveCount(0);
    await expect(notice.getByRole("button", { name: "重试刷新", exact: true })).toBeVisible({ timeout: 40_000 });
    expect(calls).toBe(3); expect(maximum).toBe(1);
    await page.waitForTimeout(4_500);
    expect(calls).toBe(3);
    slow = false;
    await notice.getByRole("button", { name: "重试刷新", exact: true }).click();
    await expect(notice).toBeHidden({ timeout: 15_000 });
    if (testInfo.project.name === "mobile") await expect(page.locator(".room-status-mobile")).toBeVisible();
    else expect(await page.locator("[data-room-status-cell]").count()).toBeGreaterThan(0);
    if (testInfo.project.name === "mobile") await expect(page.getByRole("button", { name: "新建住宿或锁房" })).toBeVisible();
  });
}

test("F02: repeated read failures preserve the board; recovery reopens writes and permission denial clears it", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: fixture.operator });
  await page.goto("/");
  const displayedBoard = page.locator(testInfo.project.name === "mobile" ? ".room-status-mobile" : "[data-room-status-cell]");
  await expect.poll(() => displayedBoard.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  let status = 503;
  await page.route("**/api/v1/properties/*/room-status?*", async (route) => {
    if (status === 200) return route.continue();
    return route.fulfill({ status, json: { code: "READ_FAILURE", message: "房态读取失败" } });
  });
  const notice = page.getByTestId("room-status-stale-notice");
  await expect(notice.getByRole("button", { name: "重试刷新", exact: true })).toBeVisible({ timeout: 10_000 });
  const cells = await displayedBoard.count();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = page.waitForResponse((response) => response.url().includes("/room-status?") && response.status() === 503);
    await notice.getByRole("button", { name: "重试刷新", exact: true }).click();
    await response;
    expect(await displayedBoard.count()).toBe(cells);
  }
  status = 200;
  await notice.getByRole("button", { name: "重试刷新", exact: true }).click();
  await expect(notice).toBeHidden({ timeout: 15_000 });
  status = 403;
  await expect(page.getByText("无权查看当前物业房态", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-room-status-cell]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建住宿或锁房" })).toHaveCount(0);
});
