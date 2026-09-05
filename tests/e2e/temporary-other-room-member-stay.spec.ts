import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AuthPrincipal, CommandEnvelope, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { authScope } from "../helpers/auth-principals.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const fixturePrincipal: AuthPrincipal = {
  subjectId: "subject_demo_agent",
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "Temporary other-room E2E setup",
  ...authScope()
};

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedWholeRoomMember(label: string, ordinal: number) {
  const suffix = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
  const memberId = `member_temporary_other_room_e2e_${suffix}`;
  const phone = `13795${String(ordinal).padStart(6, "0")}`;
  const name = `临时安排验收会员-${label}`;
  const db = createDatabase(e2eDatabaseUrl);
  try {
    await db.insertInto("members").values({
      id: memberId,
      identity_card_number: `TEMP-ROOM-E2E-${label.toUpperCase()}`,
      nickname: name,
      full_name: name,
      phone,
      wechat: `temporary-room-e2e-${suffix}`
    }).execute();
    await db.insertInto("member_property_links").values({ member_id: memberId, property_id: propertyId }).execute();

    const execute = async (envelope: CommandEnvelope, key: string): Promise<ReceiptDto> => {
      const preview = await createCommandPreview(db, fixturePrincipal, envelope, {
        idempotencyKey: `${key}-preview`,
        correlationId: key
      });
      const receipt = await confirmCommandPreview(db, fixturePrincipal, preview.preview.previewId, {
        propertyId,
        commandType: envelope.commandType,
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: { code: envelope.commandType, note: `准备临时安排验收会员 ${label}` }
      }, {
        idempotencyKey: `${key}-confirm`,
        correlationId: key
      });
      if (!receipt.businessCommitted) {
        throw new Error(`${envelope.commandType} fixture failed: ${JSON.stringify(receipt.error)}`);
      }
      return receipt;
    };

    const membership = await execute({
      commandType: "CREATE_MEMBERSHIP_ORDER",
      input: {
        propertyId,
        memberId,
        membershipProductId: "membership_product_shared_bath_single_v1",
        agreedPriceMinor: 162_000
      }
    }, `temporary-room-${suffix}-membership`);
    const membershipOrderId = membership.result!.membershipOrderId as string;
    await execute({
      commandType: "RECORD_MEMBERSHIP_PAYMENT",
      input: {
        propertyId,
        membershipOrderId,
        amountMinor: 1,
        transactionReference: `TEMP-ROOM-E2E-${suffix}`
      }
    }, `temporary-room-${suffix}-payment`);
    await execute({
      commandType: "ACTIVATE_MEMBERSHIP_ORDER",
      input: { propertyId, membershipOrderId }
    }, `temporary-room-${suffix}-activation`);
  } finally {
    await db.destroy();
  }
  return { memberId, name, phone };
}

async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto("/");
  const username = page.getByTestId("login-username");
  const authenticatedHeading = page.getByRole("heading", { name: "房间与床位逐日房态" })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }));
  await expect(username.or(authenticatedHeading)).toBeVisible({ timeout: 30_000 });
  if (await username.isVisible()) {
    await username.fill("operator");
    await page.getByTestId("login-password").fill("demo-pass-2026");
    await page.getByTestId("login-submit").click();
  }
  await expect(authenticatedHeading).toBeVisible({ timeout: 30_000 });
}

async function availablePrivateSingle(page: Page, arrivalDate: string, departureDate: string) {
  const response = await page.request.get(
    `/api/v1/properties/${propertyId}/availability?arrivalDate=${arrivalDate}&departureDate=${departureDate}&unitKind=ROOM`
  );
  expect(response.ok()).toBe(true);
  const availability = await response.json() as {
    units: Array<{ id: string; code: string; roomTypeCode: string | null; available: boolean }>;
  };
  const target = availability.units.find((unit) => unit.available && unit.roomTypeCode === "private_bath_single");
  expect(target, "需要一间连续可售的独卫单人间").toBeDefined();
  return target!;
}

async function openOrderForm(
  page: Page,
  target: { id: string; code: string },
  arrivalDate: string,
  departureDate: string
): Promise<Locator> {
  const mobile = (page.viewportSize()?.width ?? 0) < 576;
  let drawer: Locator;
  if (mobile) {
    await page.getByRole("button", { name: "新建住宿或锁房", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "新建住宿或锁房", exact: true });
    await expect(drawer).toBeVisible();
    const unitSelect = drawer.getByTestId("room-status-unit-select");
    await expect(unitSelect.locator(`option[value="${target.id}"]`)).toContainText(target.code);
    await unitSelect.selectOption(target.id);
  } else {
    const boardDeparture = addDays(arrivalDate, 30);
    const rangeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname.endsWith("/room-status")
        && url.searchParams.get("arrivalDate") === arrivalDate
        && url.searchParams.get("departureDate") === boardDeparture
        && response.ok();
    });
    await page.getByTestId("arrival-date").fill(arrivalDate);
    await rangeResponse;
    await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
    const cell = page.locator(
      `[data-room-status-cell="true"][data-unit-id="${target.id}"][data-service-date="${arrivalDate}"]`
    );
    await cell.scrollIntoViewIfNeeded();
    await cell.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("room-status-quick-popover");
    await expect(popover).toBeVisible();
    await popover.getByRole("button", { name: "创建订单", exact: true }).click();
    drawer = page.locator("dialog.room-status-write-drawer");
  }
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await drawer.getByLabel("退房日期", { exact: true }).fill(departureDate);
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  const quoteWorkbench = page.getByRole("complementary", { name: "住宿金额", exact: true });
  await expect(quoteWorkbench).toBeVisible();
  await expect(quoteWorkbench.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
  return quoteWorkbench;
}

async function assertFitsViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a box`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right edge`).toBeLessThanOrEqual(viewport.width + 1);
}

async function assertNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function completeTemporaryArrangement(
  page: Page,
  testInfo: TestInfo,
  width: number,
  ordinal: number,
  dateOffset: number
): Promise<void> {
  await page.setViewportSize({ width, height: width >= 1000 ? 720 : 839 });
  const label = `${testInfo.project.name}-${width}`;
  const member = await seedWholeRoomMember(label, ordinal);
  await ensureLoggedIn(page);
  const arrivalDate = addDays(todayInTimeZone("Asia/Shanghai"), dateOffset);
  const departureDate = addDays(arrivalDate, 1);
  const target = await availablePrivateSingle(page, arrivalDate, departureDate);
  const drawer = await openOrderForm(page, target, arrivalDate, departureDate);

  await expect(drawer.getByTestId("temporary-other-room-confirmed")).toHaveCount(0);
  await drawer.getByTestId("use-member-entitlement").check();
  await drawer.getByTestId("member-search").fill(member.phone);
  const memberSelect = drawer.getByTestId("member-profile-select");
  await expect(memberSelect.locator(`option[value="${member.memberId}"]`)).toContainText(member.name);
  await memberSelect.selectOption(member.memberId);

  const arrangement = drawer.getByRole("region", { name: "临时安排其他房型" });
  await expect(arrangement).toBeVisible({ timeout: 15_000 });
  await expect(arrangement).toContainText("本次临时安排其他房型");
  await expect(arrangement).toContainText("系统显示原会员房型仍可能有空房");
  await expect(drawer.getByTestId("temporary-other-room-reason")).toHaveCount(0);
  await drawer.getByTestId("temporary-other-room-confirmed").check();
  const reason = `现场协调安排 ${width}px`;
  const reasonInput = drawer.getByTestId("temporary-other-room-reason");
  await expect(reasonInput).toBeEnabled({ timeout: 15_000 });
  await reasonInput.fill(reason);
  const quote = drawer.getByTestId("quote-result");
  await expect(quote).toContainText("覆盖晚数1 晚", { timeout: 15_000 });
  await expect(quote).toContainText("本次补差¥0.00");

  const checkboxBox = await drawer.getByTestId("temporary-other-room-confirmed").boundingBox();
  const titleBox = await arrangement.locator(".form-label-with-hint").boundingBox();
  expect(checkboxBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(checkboxBox!.width).toBe(18);
  expect(checkboxBox!.height).toBe(18);
  expect(Math.abs(checkboxBox!.y + checkboxBox!.height / 2 - titleBox!.y - titleBox!.height / 2)).toBeLessThanOrEqual(1);

  const help = arrangement.getByRole("note", { name: /临时安排说明/ });
  await help.focus();
  const tooltip = help.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveCSS("opacity", "1");
  await expect(tooltip).toContainText("会员原有房型与后续权益不会改变");
  await assertFitsViewport(page, drawer, `${width}px drawer`);
  await assertFitsViewport(page, arrangement, `${width}px arrangement`);
  await assertFitsViewport(page, tooltip, `${width}px tooltip`);
  await assertNoPageOverflow(page);
  await reasonInput.focus();

  const createButton = drawer.getByTestId("create-order");
  await expect(createButton).toBeEnabled();
  await assertFitsViewport(page, createButton, `${width}px create button`);
  await page.screenshot({ path: testInfo.outputPath(`temporary-other-room-${width}-form.png`), fullPage: true });
  await createButton.click();

  const effect = page.getByTestId("command-effect");
  await expect(effect).toContainText("本次临时安排其他房型", { timeout: 15_000 });
  await expect(effect).toContainText("原适用房型单人间（公卫）");
  await expect(effect).toContainText("实际房型单人间（独卫）");
  await expect(effect).toContainText(reason);
  await expect(effect).not.toContainText(/Lot|projection|override|temporaryOtherRoom/);
  await assertFitsViewport(page, page.locator("dialog.modal-wide"), `${width}px preview`);
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`temporary-other-room-${width}-preview.png`), fullPage: true });

  const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname));
  await page.getByTestId("confirm-command").click();
  const confirmResponse = await confirmed;
  const receipt = await confirmResponse.json() as { result?: { orderId?: string }; error?: unknown };
  expect(confirmResponse.status(), JSON.stringify(receipt)).toBe(200);
  expect(receipt.result?.orderId).toMatch(/^order_/);
  await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });

  await page.goto(`/orders/${encodeURIComponent(receipt.result!.orderId!)}`);
  const history = page.getByTestId("temporary-other-room-arrangement-history");
  await expect(history).toContainText("本次临时安排其他房型", { timeout: 30_000 });
  await expect(history).toContainText("单人间（公卫）");
  await expect(history).toContainText("单人间（独卫）");
  await expect(history).toContainText(target.code);
  await expect(history).toContainText(reason);
  await expect(history).toContainText("Demo Operator");
  await expect(history.getByText("操作时间", { exact: true })).toBeVisible();
  await assertFitsViewport(page, history, `${width}px immutable history`);
  await assertNoPageOverflow(page);
}

test("temporary whole-room member arrangement completes at desktop and compact mobile widths", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const widths = testInfo.project.name === "desktop" ? [1280] : [412, 375, 320];
  for (const [index, width] of widths.entries()) {
    await completeTemporaryArrangement(
      page,
      testInfo,
      width,
      (testInfo.project.name === "desktop" ? 1 : 10) + index,
      (testInfo.project.name === "desktop" ? 180 : 200) + index * 2
    );
  }
});

test("desktop temporary arrangement restores the committed Quote after response loss", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only Quote recovery journey");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const member = await seedWholeRoomMember("quote-recovery-desktop", 2);
  await ensureLoggedIn(page);
  const arrivalDate = addDays(todayInTimeZone("Asia/Shanghai"), 260);
  const departureDate = addDays(arrivalDate, 1);
  const target = await availablePrivateSingle(page, arrivalDate, departureDate);
  let drawer = await openOrderForm(page, target, arrivalDate, departureDate);

  await drawer.getByTestId("use-member-entitlement").check();
  await drawer.getByTestId("member-search").fill(member.phone);
  const memberSelect = drawer.getByTestId("member-profile-select");
  await expect(memberSelect.locator(`option[value="${member.memberId}"]`)).toContainText(member.name);
  await memberSelect.selectOption(member.memberId);
  await expect(drawer.getByRole("region", { name: "临时安排其他房型" })).toBeVisible({ timeout: 15_000 });

  let temporaryQuotePostCount = 0;
  let originalQuoteKey = "";
  await page.route("**/api/v1/quotes", async (route) => {
    const input = route.request().postDataJSON() as { temporaryOtherRoom?: boolean };
    if (input.temporaryOtherRoom !== true) {
      await route.continue();
      return;
    }
    temporaryQuotePostCount += 1;
    if (temporaryQuotePostCount !== 1) {
      await route.continue();
      return;
    }
    originalQuoteKey = route.request().headers()["idempotency-key"] ?? "";
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });

  await drawer.getByTestId("temporary-other-room-confirmed").check();
  const recovery = drawer.getByTestId("quote-recovery");
  await expect(recovery).toContainText("报价结果尚未确认", { timeout: 15_000 });
  expect(originalQuoteKey).toMatch(/^web-create-quote-/);
  expect(temporaryQuotePostCount).toBe(1);

  await page.reload();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态" })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
  drawer = page.locator("dialog.room-status-write-drawer");
  if (!await drawer.getByTestId("quote-recovery").isVisible().catch(() => false)) {
    const entry = page.getByTestId("inventory-quote-recovery-entry");
    await expect(entry).toBeVisible();
    await entry.getByRole("button", { name: "打开处理入口", exact: true }).click();
  }
  const restoredRecovery = drawer.getByTestId("quote-recovery");
  await expect(restoredRecovery).toContainText("报价结果尚未确认", { timeout: 15_000 });
  await expect(drawer.getByTestId("use-member-entitlement")).toBeChecked();
  await expect(drawer.getByTestId("member-profile-select")).toHaveValue(member.memberId);

  const recovered = page.waitForResponse((response) => {
    if (response.request().method() !== "POST"
      || new URL(response.url()).pathname !== "/api/v1/command-results/resolve") return false;
    const body = response.request().postDataJSON() as {
      propertyId?: string;
      commandType?: string;
      idempotencyKey?: string;
    };
    return body.propertyId === propertyId
      && body.commandType === "CREATE_QUOTE"
      && body.idempotencyKey === originalQuoteKey;
  });
  await restoredRecovery.getByRole("button", { name: "核对原报价结果", exact: true }).click();
  expect((await recovered).status()).toBe(200);
  await expect(drawer.getByTestId("quote-recovery")).toHaveCount(0);
  await expect(drawer.getByTestId("quote-result")).toContainText("本次补差¥0.00");
  await expect(drawer.getByTestId("use-member-entitlement")).toBeChecked();
  await expect(drawer.getByTestId("member-profile-select")).toHaveValue(member.memberId);
  await expect(drawer.getByTestId("temporary-other-room-confirmed")).toBeChecked();
  expect(temporaryQuotePostCount).toBe(1);

  const storageKey = `qintopia.quote-command-recovery.v1:subject_demo_operator:${propertyId}`;
  await expect.poll(() => page.evaluate((key) => ({
    local: localStorage.getItem(key),
    session: sessionStorage.getItem(key)
  }), storageKey)).toEqual({ local: null, session: null });

  await drawer.getByRole("button", { name: "关闭办理区域", exact: true }).click();
  drawer = await openOrderForm(page, target, arrivalDate, addDays(departureDate, 1));
  await drawer.getByTestId("use-member-entitlement").check();
  await drawer.getByTestId("member-search").fill(member.phone);
  await drawer.getByTestId("member-profile-select").selectOption(member.memberId);
  await expect(drawer.getByTestId("temporary-other-room-confirmed")).toBeVisible({ timeout: 15_000 });
  await expect(drawer.getByTestId("temporary-other-room-confirmed")).not.toBeChecked();
  expect(temporaryQuotePostCount).toBe(1);
});
