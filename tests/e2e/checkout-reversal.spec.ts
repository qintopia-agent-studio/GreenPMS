import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const propertyId = "prop_qintopia_demo";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
function shiftDate(days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function login(page: Page, username = "admin") {
  await page.goto("/accounts");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "我的账号" })).toBeVisible();
}
async function command(request: APIRequestContext, commandType: string, input: Record<string, unknown>) {
  const nonce = crypto.randomUUID();
  const prepared = await request.post("/api/v1/command-previews", { headers: { "idempotency-key": `preview-${nonce}`, "x-correlation-id": nonce },
    data: { commandType, input: { propertyId, ...input } } });
  expect(prepared.status(), await prepared.text()).toBe(200);
  const { preview } = await prepared.json();
  const response = await request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, {
    headers: { "idempotency-key": `confirm-${nonce}`, "x-correlation-id": nonce },
    data: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash,
      reason: { code: input.backfill ? "BACKFILL_STAY" : commandType,
        note: input.backfillReason ?? "客人决定继续原住宿" } }
  });
  const receipt = await response.json();
  expect(receipt.businessCommitted, JSON.stringify(receipt)).toBe(true);
  return receipt.result as Record<string, unknown>;
}
async function setupOrder(request: APIRequestContext, inventoryUnitId: string, conversionPhone?: string) {
  const response = await request.post("/api/v1/quotes", { headers: { "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() }, data: { propertyId, inventoryUnitId, stayType: "TRANSIENT",
    arrivalDate: shiftDate(-2), departureDate: shiftDate(4), pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1" } });
  expect(response.status(), await response.text()).toBe(200);
  const { quote } = await response.json();
  const created = await command(request, "CREATE_ORDER", { quoteId: quote.quoteId,
    primaryGuest: { fullName: "退房回退浏览器验收", nickname: "继续原住宿", ...(conversionPhone ? { phone: conversionPhone } : {}) },
    bookingChannelCode: "WECOM", channelOrderReference: null, backfill: true, backfillReason: "补录本次测试在住" });
  const orderId = created.orderId as string;
  if (conversionPhone) await command(request, "RECORD_COLLECTION", { orderId, amountMinor: 60000,
    method: "WECOM", transactionReference: `SYNTHETIC-REVERSAL-UPGRADE-${crypto.randomUUID()}` });
  await command(request, "SHORTEN_STAY", { orderId, newDepartureDate: today });
  return orderId;
}
async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("button").evaluateAll((buttons) => buttons
    .filter((button) => button.getBoundingClientRect().width > 0 && button.scrollWidth > button.clientWidth + 2)
    .map((button) => button.textContent))).toEqual([]);
}

test("administrator confirms complete early-checkout restoration, with cancellation and employee denial", async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const orderId = await setupOrder(page.request, testInfo.project.name === "mobile" ? "unit_room_102" : "unit_room_101");
  await page.goto(`/orders/${orderId}`);
  await page.getByTestId("revoke-check-out").click();
  await page.getByTestId("lifecycle-reason").fill("客人行程取消，继续住到原退房日");
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  await expect(page.getByTestId("command-effect")).toContainText("恢复住宿日期");
  await layout(page);
  await page.screenshot({ path: testInfo.outputPath("checkout-reversal-confirmation.png") });
  await page.getByTestId("command-return-to-edit").click();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  const unchanged = await (await page.request.get(`/api/v1/orders/${orderId}`)).json();
  expect(unchanged.order.status).toBe("CHECKED_OUT");

  const staffContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: page.viewportSize()! });
  try {
    const staffPage = await staffContext.newPage();
    await login(staffPage, "operator");
    await staffPage.goto(`/orders/${orderId}`);
    await expect(staffPage.getByTestId("revoke-check-out")).toHaveCount(0);
    const rejected = await staffPage.request.post("/api/v1/command-previews", {
      headers: { "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() },
      data: { commandType: "REVOKE_CHECK_OUT", input: { propertyId, orderId } }
    });
    expect(rejected.status()).toBe(403);
  } finally { await staffContext.close(); }

  await page.getByTestId("revoke-check-out").click();
  await page.getByTestId("lifecycle-reason").fill("客人行程取消，继续住到原退房日");
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  await page.getByTestId("confirm-command").click();
  await expect(page.getByRole("status").filter({ hasText: "退房已撤销，原住宿安排已恢复" })).toBeVisible();
  await layout(page);
  await page.screenshot({ path: testInfo.outputPath("checkout-reversal-result.png") });
  const restored = await (await page.request.get(`/api/v1/orders/${orderId}`)).json();
  expect(restored.order.status).toBe("CHECKED_IN");
  expect(restored.order.departure_date).toBe(shiftDate(4));
  await expect(page.getByTestId("revoke-check-out")).toHaveCount(0);
  await command(page.request, "SHORTEN_STAY", { orderId, newDepartureDate: today });
  expect(errors).toEqual([]);
});

test("restored in-house order can upgrade membership through the page", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const phone = testInfo.project.name === "mobile" ? "19900009702" : "19900009701";
  const member = await command(page.request, "CREATE_MEMBER", { fullName: "回退后升级会员验收", nickname: "恢复后升级", phone, wechat: "e2e-reversal" });
  const orderId = await setupOrder(page.request, testInfo.project.name === "mobile" ? "unit_room_302" : "unit_room_205", phone);
  await page.goto(`/orders/${orderId}`);
  await page.getByTestId("revoke-check-out").click();
  await page.getByTestId("lifecycle-reason").fill("误办提前退房，恢复后升级会员");
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  await page.getByTestId("confirm-command").click();
  await expect(page.getByRole("status").filter({ hasText: "退房已撤销，原住宿安排已恢复" })).toBeVisible();
  const convert = page.getByTestId("convert-stay-collections-to-membership");
  await expect(convert).toBeEnabled();
  await convert.click();
  const dialog = page.getByRole("dialog", { name: "升级会员", exact: true });
  await dialog.getByLabel("目标会员").selectOption(member.memberId as string);
  await dialog.getByLabel("会员产品").selectOption("membership_product_shared_bath_single_v1");
  await dialog.getByLabel("会员成交价（元）").fill("1620");
  await dialog.getByTestId("conversion-remaining-payment-reference").fill(`SYNTHETIC-UPGRADE-REMAINDER-${testInfo.project.name}`);
  await dialog.getByRole("button", { name: "下一步", exact: true }).click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toContainText(`${shiftDate(-2)} 至 ${shiftDate(4)}`);
  await expect(effect).toContainText("¥600.00");
  await expect(effect).toContainText("¥1,020.00");
  await expect(effect).toContainText("6 间夜");
  await layout(page);
  await page.screenshot({ path: testInfo.outputPath("restored-membership-upgrade.png") });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByTestId("convert-stay-collections-to-membership")).toHaveCount(0);
  await page.reload();
  const converted = await (await page.request.get(`/api/v1/orders/${orderId}`)).json();
  expect(converted.order.status).toBe("CHECKED_IN");
  expect(converted.order.departure_date).toBe(shiftDate(4));
  expect(converted.membershipConversion.memberId).toBe(member.memberId);
  expect(converted.coverageSet.filter((coverage: { status: string }) => coverage.status === "CONSUMED")).toHaveLength(6);
  expect(errors).toEqual([]);
});

test("incomplete restoration evidence cannot be confirmed", async ({ page }, testInfo) => {
  await login(page);
  const orderId = await setupOrder(page.request, testInfo.project.name === "mobile" ? "unit_room_d_gen_01" : "unit_room_109");
  await page.goto(`/orders/${orderId}`);
  await page.route("**/api/v1/command-previews", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.preview?.commandType === "REVOKE_CHECK_OUT") body.preview.effect.after.stayTimeline = [];
    await route.fulfill({ response, json: body });
  });
  await page.getByTestId("revoke-check-out").click();
  await page.getByTestId("lifecycle-reason").fill("信息不完整不得提交");
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  await expect(page.getByTestId("confirm-command")).toBeDisabled();
  expect((await (await page.request.get(`/api/v1/orders/${orderId}`)).json()).order.status).toBe("CHECKED_OUT");
});
