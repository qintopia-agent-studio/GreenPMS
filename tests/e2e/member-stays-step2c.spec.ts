import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { todayInTimeZone } from "@qintopia/domain";
import { createDatabase } from "../../packages/db/src/database.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const e2ePropertyId = "prop_qintopia_demo";

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedMember(testInfo: TestInfo) {
  const suffix = testInfo.project.name;
  const memberId = `member_step2c_e2e_${suffix}`;
  const contractId = `contract_step2c_e2e_${suffix}`;
  const lotId = `lot_step2c_e2e_${suffix}`;
  const membershipOrderId = `membership_order_step2c_e2e_${suffix}`;
  const identity = `E2E-2C-${suffix.toUpperCase()}-001`;
  const db = createDatabase(e2eDatabaseUrl);
  try {
    await db.insertInto("members").values({ id: memberId, identity_card_number: identity, full_name: `2C住宿会员-${suffix}`, phone: suffix === "desktop" ? "13923000001" : "13923000002", wechat: `qintopia-2c-${suffix}` }).execute();
    await db.insertInto("member_property_links").values({ member_id: memberId, property_id: e2ePropertyId }).execute();
    await db.insertInto("member_contracts").values({ id: contractId, property_id: e2ePropertyId, member_id: memberId, member_name: `2C住宿会员-${suffix}`, status: "ACTIVE", valid_from: "2026-07-24", valid_until: "2027-07-24", version: 1 }).execute();
    await db.insertInto("entitlement_lots").values({ id: lotId, contract_id: contractId, unit_kind: "ROOM_NIGHT", total_units: 3, expires_on: "2027-07-24", version: 1 }).execute();
    await db.insertInto("membership_orders").values({
      id: membershipOrderId,
      property_id: e2ePropertyId,
      member_id: memberId,
      product_id: "membership_product_shared_bath_single_v1",
      product_code: "SHARED_BATH_SINGLE_30",
      product_version: 1,
      product_name: "公卫单人间会员",
      listed_price_minor: 162_000,
      agreed_price_minor: 162_000,
      price_adjustment_minor: 0,
      price_adjustment_reason: null,
      currency: "CNY",
      entitlement_unit_kind: "ROOM_NIGHT",
      entitlement_units: 3,
      allowed_room_type_code: "shared_bath_single",
      allowed_inventory_kind: "ROOM",
      status: "ACTIVE",
      activated_at: new Date("2026-07-24T03:00:00.000Z"),
      valid_from: "2026-07-24",
      valid_until: "2027-07-24",
      contract_id: contractId,
      entitlement_lot_id: lotId,
      version: 1,
      created_by_command_id: `seed-step2c-${suffix}`,
      activated_by_command_id: `seed-step2c-${suffix}`
    }).execute();
    await db.updateTable("member_contracts").set({ membership_order_id: membershipOrderId }).where("id", "=", contractId).execute();
  } finally {
    await db.destroy();
  }
  return {
    memberId,
    identity,
    lotId,
    name: `2C住宿会员-${suffix}`,
    phone: suffix === "desktop" ? "13923000001" : "13923000002"
  };
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
}

async function chooseAvailableSharedBathSingle(page: Page, arrival: string, departure: string) {
  await page.getByTestId("arrival-date").fill(arrival);
  await page.getByTestId("departure-date").fill(departure);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  const availabilityResponse = await page.request.get(`/api/v1/properties/${e2ePropertyId}/availability?arrivalDate=${arrival}&departureDate=${departure}&unitKind=ROOM`);
  expect(availabilityResponse.ok()).toBe(true);
  const availability = await availabilityResponse.json() as {
    units: Array<{ id: string; code: string; roomTypeCode: string | null; available: boolean }>;
  };
  const eligibleUnits = availability.units.filter((unit) => unit.available && unit.roomTypeCode === "shared_bath_single");
  const availableUnit = eligibleUnits.find((unit) => unit.code === "205") ?? eligibleUnits[0];
  expect(availableUnit, "需要一间三晚连续可售的公卫单人间").toBeDefined();
  const isMobile = (page.viewportSize()?.width ?? 0) < 576;
  let drawer: Locator;
  if (isMobile) {
    await page.getByRole("button", { name: "新建住宿或锁房", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "新建住宿或锁房", exact: true });
    await expect(drawer).toBeVisible();
    const unitSelect = drawer.getByTestId("room-status-unit-select");
    await expect(unitSelect.locator(`option[value="${availableUnit!.id}"]`)).toContainText(availableUnit!.code);
    await unitSelect.selectOption(availableUnit!.id);
  } else {
    const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${availableUnit!.id}"][data-service-date="${arrival}"]`);
    await cell.scrollIntoViewIfNeeded();
    await expect(cell).toBeVisible();
    await cell.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("room-status-quick-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toHaveAttribute("data-unit-id", availableUnit!.id);
    await expect(popover).toHaveAttribute("data-selection-kind", "day");
    await popover.getByRole("button", { name: "创建住宿", exact: true }).click();
    drawer = page.locator("dialog.room-status-write-drawer");
  }
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("入住日期", { exact: true }).fill(arrival);
  await drawer.getByLabel("退房日期", { exact: true }).fill(departure);
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(page.getByRole("heading", { name: "住宿金额", exact: true })).toBeVisible();
}

test("2C shows ledger balance, corrects by target, and creates a partially covered member stay", async ({ page }, testInfo) => {
  const fixture = await seedMember(testInfo);
  const quoteBodies: Record<string, unknown>[] = [];
  const createOrderBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    try {
      const body = request.postDataJSON() as Record<string, unknown>;
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/quotes") quoteBodies.push(body);
      if (path === "/api/v1/command-previews" && body.commandType === "CREATE_ORDER") createOrderBodies.push(body);
    } catch {
      // A malformed request is rejected elsewhere; this observer only proves the ordinary path omits memberId.
    }
  });
  await login(page);
  await page.getByRole("link", { name: "会员", exact: true }).click();
  await page.getByTestId("member-search-query").fill(fixture.identity);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  const balance = page.getByTestId("member-balance-summary");
  await expect(balance).toContainText("3 间夜");
  const lot = page.getByTestId("member-entitlement-lot");
  await expect(lot).toContainText("公卫单人间会员");
  await expect(lot).toContainText("2026-07-24 至 2027-07-24");
  await expect(lot).toContainText("当前可用3 间夜");

  await lot.getByTestId("correct-entitlement-balance").click();
  await page.getByTestId("target-entitlement-balance").fill("1");
  await page.getByTestId("entitlement-adjustment-reason").fill("2C 浏览器验收调整为 1 间夜");
  await page.getByRole("button", { name: "核对余额更正", exact: true }).click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toContainText("当前可用余额3 间夜", { timeout: 30_000 });
  await expect(effect).toContainText("更正后可用余额1 间夜");
  await expect(effect).toContainText("本次变动-2");
  await expect(effect).not.toContainText("entitlementLotId");
  await page.getByTestId("confirm-command").click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText("会员余额已更正，权益记录已刷新");
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect(balance).toContainText("1 间夜");
  const ledger = page.getByTestId("member-ledger-history");
  await expect(ledger).toContainText("余额更正");
  await expect(ledger).toContainText("公卫单人间会员");
  await expect(ledger).toContainText("-2 间夜");
  await expect(ledger).toContainText("2C 浏览器验收调整为 1 间夜");

  await page.getByRole("link", { name: "房态", exact: true }).click();
  const arrival = todayInTimeZone("Asia/Shanghai");
  const departure = addDays(arrival, 3);
  await chooseAvailableSharedBathSingle(page, arrival, departure);
  await expect(page.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => quoteBodies.some((body) => body.arrivalDate === arrival
    && body.departureDate === departure
    && !Object.hasOwn(body, "memberId"))).toBe(true);
  await expect(page.getByTestId("member-search")).toHaveCount(0);
  await expect(page.getByText("覆盖晚数", { exact: true })).toHaveCount(0);
  await page.getByTestId("use-member-entitlement").check();
  await page.getByTestId("member-search").fill(fixture.identity);
  await page.getByTestId("member-profile-select").selectOption(fixture.memberId);
  await expect(page.getByTestId("booking-channel-code")).toHaveCount(0);
  const quote = page.getByTestId("quote-result");
  await expect(quote).toBeVisible({ timeout: 15_000 });
  await expect(quote).toContainText("总住宿晚数3 晚");
  await expect(quote).toContainText("覆盖晚数1 晚");
  await expect(quote).toContainText("未覆盖晚数2 晚");
  await expect(quote).toContainText("未覆盖金额¥260.00");
  await expect(page.getByTestId("primary-guest-nickname")).toHaveValue(fixture.name);
  await expect(page.getByTestId("primary-guest-name")).toHaveValue(fixture.name);
  await expect(page.getByLabel("联系电话", { exact: true })).toHaveValue(fixture.phone);
  await expect(page.getByLabel("证件号码", { exact: true })).toHaveValue(fixture.identity);
  await page.getByTestId("primary-guest-nickname").fill("2C住客");
  await page.getByTestId("primary-guest-name").fill("2C 会员住客");
  await page.getByLabel("联系电话", { exact: true }).fill("13923000999");
  await page.getByLabel("证件号码", { exact: true }).fill("2C-STAY-SNAPSHOT-EDITED");
  await page.screenshot({ path: testInfo.outputPath("member-stay-form-step2c.png"), fullPage: true });
  await page.getByRole("button", { name: "核对并创建订单", exact: true }).click();
  const memberStayEffect = page.getByTestId("command-effect");
  await expect(memberStayEffect).toContainText("请核对会员住宿");
  await expect(memberStayEffect).not.toContainText("Preview");
  await expect(memberStayEffect).not.toContainText("Command");
  await expect.poll(() => createOrderBodies.length).toBe(1);
  const memberStayInput = createOrderBodies[0]?.input as Record<string, unknown>;
  expect(memberStayInput).not.toHaveProperty("bookingChannelCode");
  expect(memberStayInput).not.toHaveProperty("channelOrderReference");
  expect(memberStayInput.primaryGuest).toEqual({
    fullName: "2C 会员住客",
    nickname: "2C住客",
    phone: "13923000999",
    documentNumber: "2C-STAY-SNAPSHOT-EDITED"
  });
  expect(memberStayInput.additionalGuests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("member-stay-confirm-step2c.png"), fullPage: true });
  const createOrderResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await page.getByTestId("confirm-command").click();
  const createOrderReceipt = await createOrderResponse.then((response) => response.json()) as { result?: { orderId?: string } };
  expect(createOrderReceipt.result?.orderId).toMatch(/^order_/);
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText("住宿订单已创建，页面已刷新");
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await page.goto(`/orders/${encodeURIComponent(createOrderReceipt.result!.orderId!)}`);
  await expect(page.getByText("住宿来源", { exact: true })).toBeVisible();
  await expect(page.getByText("会员权益", { exact: true })).toBeVisible();
  await expect(page.getByText("订单来源渠道", { exact: true })).toHaveCount(0);
  await expect(page.getByText("渠道订单号", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "移动履约", exact: true }).click();
  await page.getByLabel("营业日期", { exact: true }).fill(arrival);
  const arrivalRow = page.locator("article.queue-row").filter({ hasText: "2C住客" });
  await arrivalRow.getByRole("button", { name: "入住", exact: true }).click();
  await expect(page.getByTestId("reason-note")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("办理备注（选填）", { exact: true })).toBeVisible();
  await page.getByTestId("reason-note").fill("2C 浏览器验收入住核销");
  await expect(page.getByTestId("command-return-to-edit")).toHaveCount(0);
  await expect(page.getByTestId("reason-note")).toHaveValue("2C 浏览器验收入住核销");
  await page.getByTestId("confirm-command").click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("command-result-notice")).toContainText("办理入住已完成，住宿状态已刷新");
  await expect(page.getByTestId("command-receipt")).toBeHidden();

  await page.goto(`/orders/${encodeURIComponent(createOrderReceipt.result!.orderId!)}`);
  const persistedCheckInNote = page.getByTestId("check-in-result")
    .getByText("办理备注", { exact: true })
    .locator("xpath=following-sibling::dd");
  await expect(persistedCheckInNote).toHaveText("2C 浏览器验收入住核销");

  await page.getByRole("link", { name: "会员", exact: true }).click();
  await page.getByTestId("member-search-query").fill(fixture.identity);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  await expect(page.getByTestId("member-balance-summary")).toContainText("0 间夜");
  await expect(page.getByTestId("member-ledger-history")).toContainText("预订冻结");
  await expect(page.getByTestId("member-ledger-history")).toContainText("公卫单人间会员");
  const heldEntry = page.getByTestId("member-ledger-entry-hold");
  await expect(heldEntry).toContainText("余额 -1 间夜");
  const consumedEntry = page.getByTestId("member-ledger-entry-consume");
  await expect(consumedEntry).toContainText("入住核销");
  await expect(consumedEntry).toContainText("本次核销 1 间夜");
  await expect(consumedEntry).not.toContainText("0 间夜");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("member-stay-step2c.png"), fullPage: true });
});
