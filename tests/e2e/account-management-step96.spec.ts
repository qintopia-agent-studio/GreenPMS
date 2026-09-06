import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
const demo = { propertyId: "prop_qintopia_demo", memberId: "member_demo_profile" };

async function login(page: Page, username = "admin", password = "demo-pass-2026") {
  await page.goto("/accounts");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "我的账号" })).toBeVisible();
}
async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const overflow = await page.locator("button").evaluateAll((buttons) => buttons.filter((button) => {
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && button.scrollWidth > button.clientWidth + 2;
  }).map((button) => button.textContent));
  expect(overflow).toEqual([]);
}

async function businessCommand(request: APIRequestContext, commandType: string, input: Record<string, unknown>) {
  const key = crypto.randomUUID();
  const previewResponse = await request.post("/api/v1/command-previews", { headers: { "idempotency-key": `preview-${key}`, "x-correlation-id": key }, data: { commandType, input: { propertyId: demo.propertyId, ...input } } });
  expect(previewResponse.status(), await previewResponse.text()).toBe(200);
  const preview = (await previewResponse.json()).preview;
  const response = await request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, { headers: { "idempotency-key": `confirm-${key}`, "x-correlation-id": key }, data: { propertyId: demo.propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: commandType, note: "9.6 浏览器验收" } } });
  const result = await response.json();
  expect(result.businessCommitted, JSON.stringify(result)).toBe(true);
  return result.result as Record<string, unknown>;
}

test("administrator creates, confirms and deletes an empty employee", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const username = `e2e96_${testInfo.project.name}_${Date.now()}`;
  await login(page);
  await page.getByRole("button", { name: "创建员工", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("账号", { exact: true }).fill(username);
  await dialog.getByLabel("姓名", { exact: true }).fill("9.6 误建员工");
  await dialog.getByLabel("初始密码", { exact: true }).fill("e2e-password-2026");
  await dialog.getByLabel("再次输入密码", { exact: true }).fill("e2e-password-2026");
  await dialog.getByLabel("操作原因").fill("验收创建员工");
  await dialog.getByRole("button", { name: "核对信息" }).click();
  await expect(dialog.getByText(username, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("row").filter({ hasText: username })).toBeVisible();
  await checkLayout(page);
  await page.screenshot({ path: testInfo.outputPath("accounts.png"), fullPage: true });
  await page.getByRole("button", { name: `删除 ${username}`, exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("操作原因").fill("录入错误");
  await dialog.getByRole("button", { name: "核对信息" }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: username })).toBeVisible();
  await page.getByRole("button", { name: `删除 ${username}`, exact: true }).click();
  await page.getByRole("dialog").getByLabel("操作原因").fill("录入错误");
  await page.getByRole("dialog").getByRole("button", { name: "核对信息" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("row").filter({ hasText: username })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("resetting a disabled employee explains that enablement is still required", async ({ page, browser }, testInfo) => {
  await login(page);
  const username = `disabled96_${testInfo.project.name}_${Date.now()}`;
  const created = await page.request.post("/api/v1/account-management", { data: {
    propertyId: demo.propertyId, requestId: crypto.randomUUID(), action: "CREATE_STAFF", username,
    displayName: "停用后重设密码验收", newPassword: "old-password-2026", confirmation: true, reason: "停用账号改密验收"
  } });
  expect(created.status(), await created.text()).toBe(200);
  const targetId = (await created.json()).targetId;
  const staffContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const staffPage = await staffContext.newPage();
    await login(staffPage, username, "old-password-2026");
    const disabled = await page.request.post("/api/v1/account-management", { data: {
      propertyId: demo.propertyId, requestId: crypto.randomUUID(), action: "DISABLE_STAFF", targetId,
      expectedVersion: "1", confirmation: true, reason: "停用后重设密码"
    } });
    expect(disabled.status(), await disabled.text()).toBe(200);
    await page.reload();
    const activeStaff = page.getByRole("region", { name: "在用员工", exact: true });
    const disabledStaff = page.getByRole("region", { name: "已停用员工", exact: true });
    await expect(disabledStaff.getByRole("row").filter({ hasText: username })).toBeVisible();
    await expect(activeStaff.getByRole("row").filter({ hasText: username })).toHaveCount(0);
    await checkLayout(page);
    await page.screenshot({ path: testInfo.outputPath("employee-sections.png"), fullPage: true });
    await page.getByRole("button", { name: `重设 ${username} 的密码`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("启用账号后才能使用新密码登录");
    await dialog.getByLabel("新密码", { exact: true }).fill("new-password-2026");
    await dialog.getByLabel("再次输入密码", { exact: true }).fill("new-password-2026");
    await dialog.getByLabel("操作原因").fill("重设密码，暂不启用");
    await dialog.getByRole("button", { name: "核对信息", exact: true }).click();
    await expect(dialog.getByText("已停用", { exact: true })).toBeVisible();
    await expect(dialog).toContainText("启用账号后才能使用新密码登录");
    await checkLayout(page);
    await page.screenshot({ path: testInfo.outputPath("disabled-password-reset-confirmation.png") });
    await dialog.getByRole("button", { name: "确认执行", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "密码已重设，账号仍为停用状态" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: username })).toContainText("已停用");
    expect((await staffPage.request.get("/api/v1/me")).status()).toBe(401);
    expect((await staffPage.request.post("/api/v1/auth/login", { data: { username, password: "new-password-2026" } })).status()).toBe(401);
    await page.getByRole("button", { name: `启用 ${username}`, exact: true }).click();
    await page.getByRole("dialog").getByLabel("操作原因").fill("允许该员工重新登录");
    await page.getByRole("dialog").getByRole("button", { name: "核对信息", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认执行", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: username })).toContainText("已启用");
    await expect(activeStaff.getByRole("row").filter({ hasText: username })).toBeVisible();
    await expect(disabledStaff.getByRole("row").filter({ hasText: username })).toHaveCount(0);
    expect((await staffPage.request.post("/api/v1/auth/login", { data: { username, password: "old-password-2026" } })).status()).toBe(401);
    await login(staffPage, username, "new-password-2026");
  } finally { await staffContext.close(); }
});

test("unused purchased member deletion requires erroneous-payment confirmation", async ({ page }, testInfo) => {
  await login(page);
  const nonce = `${testInfo.project.name}-${Date.now()}`;
  const phone = `195${String(Date.now()).slice(-8)}`;
  const previewResponse = await page.request.post("/api/v1/command-previews", { headers: { "idempotency-key": `preview-${nonce}`, "x-correlation-id": nonce }, data: { commandType: "CREATE_MEMBER", input: { propertyId: demo.propertyId, fullName: `会员删除验收 ${nonce}`, nickname: "误建", phone, wechat: "e2e" } } });
  expect(previewResponse.ok()).toBe(true);
  const preview = (await previewResponse.json()).preview;
  const resultResponse = await page.request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, { headers: { "idempotency-key": `confirm-${nonce}`, "x-correlation-id": nonce }, data: { propertyId: demo.propertyId, commandType: "CREATE_MEMBER", confirmation: true, expectedEffectHash: preview.effectHash, reason: { code: "CREATE_MEMBER_PROFILE", note: "9.6 浏览器验收" } } });
  const result = await resultResponse.json();
  expect(result.businessCommitted, JSON.stringify(result)).toBe(true);
  const id = result.result.memberId;
  const demoView = await (await page.request.get(`/api/v1/members/${demo.memberId}?propertyId=${demo.propertyId}`)).json();
  const product = demoView.membershipOrders[0].order;
  const purchase = await businessCommand(page.request, "CREATE_MEMBERSHIP_ORDER", { memberId: id, membershipProductId: product.product_id, agreedPriceMinor: product.listed_price_minor });
  await businessCommand(page.request, "RECORD_MEMBERSHIP_PAYMENT", { membershipOrderId: purchase.membershipOrderId, amountMinor: 1000, transactionReference: `E2E-DELETE-${nonce}` });
  await businessCommand(page.request, "ACTIVATE_MEMBERSHIP_ORDER", { membershipOrderId: purchase.membershipOrderId });
  await page.goto(`/members?memberId=${id}`);
  await page.getByRole("button", { name: "删除误建会员", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(phone, { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  expect((await page.request.get(`/api/v1/members/${id}?propertyId=${demo.propertyId}`)).status()).toBe(200);
  await page.getByRole("button", { name: "删除误建会员", exact: true }).click();
  await page.getByRole("dialog").getByLabel("删除原因").fill("误录手机号，删除后重新建档");
  await expect(page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await checkLayout(page);
  await page.screenshot({ path: testInfo.outputPath("member-deletion-confirmation.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await page.request.get(`/api/v1/members/${id}?propertyId=${demo.propertyId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/members/${demo.memberId}?propertyId=${demo.propertyId}`)).status()).toBe(200);
});

test("ordinary employee changes their own password without management privileges", async ({ page, browser }, testInfo) => {
  await login(page);
  const username = `self96_${testInfo.project.name}_${Date.now()}`;
  const created = await page.request.post("/api/v1/account-management", { data: { propertyId: demo.propertyId, requestId: crypto.randomUUID(), action: "CREATE_STAFF", username, displayName: "自助改密验收", newPassword: "old-password-2026", confirmation: true, reason: "自助改密验收" } });
  expect(created.status(), await created.text()).toBe(200);
  const staffContext = await browser.newContext({ baseURL: new URL(page.url()).origin,
    viewport: page.viewportSize() ?? { width: 1280, height: 720 },
    isMobile: testInfo.project.name === "mobile", hasTouch: testInfo.project.name === "mobile"
  });
  const staffPage = await staffContext.newPage();
  try {
    await login(staffPage, username, "old-password-2026");
    await expect(staffPage.getByRole("button", { name: "创建员工", exact: true })).toHaveCount(0);
    await staffPage.getByRole("button", { name: "修改密码", exact: true }).click();
    const dialog = staffPage.getByRole("dialog");
    await dialog.getByLabel("当前密码", { exact: true }).fill("old-password-2026");
    await dialog.getByLabel("新密码", { exact: true }).fill("new-password-2026");
    await dialog.getByLabel("再次输入密码", { exact: true }).fill("new-password-2026");
    await dialog.getByRole("button", { name: "核对信息" }).click();
    await dialog.getByRole("button", { name: "确认执行" }).click();
    await expect(staffPage.getByRole("button", { name: "重新登录", exact: true })).toBeVisible();
    await staffPage.getByRole("button", { name: "重新登录", exact: true }).click();
    await expect(staffPage.getByTestId("login-username")).toBeVisible();
    await login(staffPage, username, "new-password-2026");
    await checkLayout(staffPage);
    await staffPage.screenshot({ path: testInfo.outputPath("staff-self-service.png"), fullPage: true });
  } finally { await staffContext.close(); }
});
