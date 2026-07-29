import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import { createDatabase } from "../../packages/db/src/database.ts";

const propertyId = "prop_qintopia_demo";
const databaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";

function desktopOnly(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop" || process.env.ROOM_STATUS_E2E_PROJECT === "desktop";
}

function mobileOnly(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile" || process.env.ROOM_STATUS_E2E_PROJECT === "mobile";
}

function addDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page): Promise<RoomStatusBoardDto> {
  await page.goto("/");
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  const boardResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/properties/${propertyId}/room-status` && response.status() === 200);
  await page.getByTestId("login-submit").click();
  const response = await boardResponse;
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

function availableRoom(board: RoomStatusBoardDto): { unitId: string; arrivalDate: string; departureDate: string } {
  for (const room of board.rooms) {
    if (!room.allowedActions.some((action) => action.code === "LOCK_MAINTENANCE" && action.enabled)) continue;
    const day = room.days.find((candidate) => candidate.available && candidate.conflicts.length === 0);
    if (day) return { unitId: room.id, arrivalDate: day.serviceDate, departureDate: addDay(day.serviceDate) };
  }
  throw new Error("No available room for U1 maintenance acceptance");
}

async function openMaintenanceReview(page: Page, candidate: ReturnType<typeof availableRoom>, reason: string) {
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${candidate.unitId}"][data-service-date="${candidate.arrivalDate}"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "维修锁房", exact: true }).click();
  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("开始日期", { exact: true })).toHaveValue(candidate.arrivalDate);
  await expect(drawer.getByLabel("结束日期", { exact: true })).toHaveValue(candidate.departureDate);
  await drawer.getByLabel("维修原因").fill(reason);
  const preview = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/command-previews"
    && response.status() === 200);
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  await preview;
  await expect(page.getByTestId("command-effect")).toContainText("请核对设置维修锁房");
}

async function releaseByReason(page: Page, reason: string) {
  const db = createDatabase(databaseUrl);
  try {
    const locks = await db.selectFrom("maintenance_locks").select("id").where("property_id", "=", propertyId).where("reason", "=", reason).where("status", "=", "ACTIVE").execute();
    for (const lock of locks) {
      const nonce = randomUUID();
      const preview = await page.request.post("/api/v1/command-previews", {
        headers: { "Idempotency-Key": `u1-cleanup-preview-${nonce}`, "X-Correlation-ID": `u1-cleanup-preview-${nonce}` },
        data: { commandType: "RELEASE_MAINTENANCE", input: { propertyId, maintenanceLockId: lock.id } }
      });
      const prepared = await preview.json() as { preview: { previewId: string; effectHash: string } };
      await page.request.post(`/api/v1/command-previews/${prepared.preview.previewId}/confirm`, {
        headers: { "Idempotency-Key": `u1-cleanup-confirm-${nonce}`, "X-Correlation-ID": `u1-cleanup-confirm-${nonce}` },
        data: { propertyId, commandType: "RELEASE_MAINTENANCE", confirmation: true, expectedEffectHash: prepared.preview.effectHash, reason: { code: "U1_E2E_CLEANUP", note: "清理 U1 浏览器验收维修锁房" } }
      });
    }
  } finally {
    await db.destroy();
  }
}

test("U1 returns to the maintenance draft, confirms once, auto closes and refreshes", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 command-shell journey");
  const board = await login(page);
  const candidate = availableRoom(board);
  const reason = `U1 返回草稿 ${randomUUID()}`;
  try {
    await openMaintenanceReview(page, candidate, reason);
    const dialog = page.locator("dialog.modal-wide");
    await expect(page.getByTestId("command-review-heading")).toBeFocused();
    await expect(dialog).not.toContainText(/Preview|Confirm|Receipt|Command|effectHash|Claim/);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.room-status-write-drawer").getByLabel("维修原因")).toHaveValue(reason);

    const escapeReturnPreview = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/command-previews" && response.status() === 200);
    await page.locator("dialog.room-status-write-drawer").getByRole("button", { name: "继续核对", exact: true }).click();
    await escapeReturnPreview;
    await dialog.getByTestId("command-return-to-edit").click();
    await expect(page.locator("dialog.room-status-write-drawer").getByLabel("维修原因")).toHaveValue(reason);

    const secondPreview = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/command-previews" && response.status() === 200);
    await page.locator("dialog.room-status-write-drawer").getByRole("button", { name: "继续核对", exact: true }).click();
    await secondPreview;
    let confirmCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(request.url()).pathname)) confirmCount += 1;
    });
    await page.evaluate(() => {
      (window as typeof window & { u1ReceiptWasVisible?: boolean }).u1ReceiptWasVisible = false;
      const observer = new MutationObserver(() => {
        const receipt = document.querySelector<HTMLElement>("[data-testid='command-receipt']");
        if (receipt && receipt.getClientRects().length > 0) (window as typeof window & { u1ReceiptWasVisible?: boolean }).u1ReceiptWasVisible = true;
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    await page.getByTestId("confirm-command").click();
    await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("command-result-notice"))
      .toContainText("维修锁房已设置，房态已刷新", { timeout: 15_000 });
    expect(confirmCount).toBe(1);
    expect(await page.evaluate(() => (window as typeof window & { u1ReceiptWasVisible?: boolean }).u1ReceiptWasVisible)).toBe(false);
    await expect.poll(() => page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);
  } finally {
    await releaseByReason(page, reason);
  }
});

test("U1 unknown result only queries the original confirmation key after reload", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 recovery journey");
  test.setTimeout(60_000);
  const board = await login(page);
  const candidate = availableRoom(board);
  const reason = `U1 结果恢复 ${randomUUID()}`;
  let releaseConfirm: (() => void) | undefined;
  try {
    await openMaintenanceReview(page, candidate, reason);
    let confirmationKey = "";
    let confirmCount = 0;
    const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
    await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
      confirmationKey = route.request().headers()["idempotency-key"] ?? "";
      confirmCount += 1;
      await confirmGate;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });
    await page.getByTestId("confirm-command").click({ timeout: 5_000 });
    await expect(page.getByTestId("command-shell-progress")).toContainText("正在提交设置维修锁房");
    await expect(page.locator("dialog.modal-wide").getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
    releaseConfirm?.();
    await expect(page.getByText("设置维修锁房结果需要查询", { exact: true })).toBeVisible();
    expect(confirmationKey).toMatch(/^web-confirm-lock_maintenance-/);
    expect(confirmCount).toBe(1);
    await expect(page.getByTestId("command-close")).toHaveText("关闭");
    await page.getByTestId("command-close").click({ timeout: 5_000 });
    await expect(page.getByTestId("inventory-command-recovery")).toContainText("设置维修锁房结果需要恢复查询");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 10_000 });
    const recovery = page.getByTestId("inventory-command-recovery");
    await expect(recovery).toBeVisible();
    const restoredContextDrawer = page.locator("dialog.modal-drawer");
    await restoredContextDrawer.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    if (await restoredContextDrawer.isVisible()) {
      await restoredContextDrawer.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(restoredContextDrawer).toBeHidden();
    }
    const openRecovery = recovery.getByRole("button", { name: "查询设置维修锁房结果" });
    await expect(openRecovery).toBeEnabled();
    await openRecovery.click({ timeout: 5_000 });
    const resultRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === "/api/v1/command-results" && url.searchParams.get("idempotencyKey") === confirmationKey;
    }, { timeout: 5_000 });
    const queryOriginal = page.getByRole("button", { name: "查询原操作结果" });
    await expect(queryOriginal).toBeEnabled();
    await queryOriginal.click({ timeout: 5_000 });
    await resultRequest;
    await expect(page.locator("dialog.modal-wide")).toBeHidden();
    await expect(page.getByTestId("command-result-notice")).toContainText("维修锁房已设置，房态已刷新");
    expect(confirmCount).toBe(1);
  } finally {
    releaseConfirm?.();
    await releaseByReason(page, reason);
  }
});

test("U1 mobile member draft survives review and success closes without a receipt page", async ({ page }, testInfo) => {
  test.skip(!mobileOnly(testInfo), "mobile U1 command-shell journey");
  await login(page);
  await page.getByRole("link", { name: "会员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "会员档案" })).toBeVisible();
  await page.getByTestId("create-member").click();
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const values = {
    fullName: `U1移动会员${suffix}`,
    identity: `U1-MOBILE-${suffix}`,
    phone: `139${suffix.replace(/[^0-9]/g, "").padEnd(8, "0").slice(0, 8)}`,
    wechat: `wx-u1-${suffix.toLowerCase()}`
  };
  await page.getByTestId("member-full-name").fill(values.fullName);
  await page.getByTestId("member-identity-card").fill(values.identity);
  await page.getByTestId("member-phone").fill(values.phone);
  await page.getByTestId("member-wechat").fill(values.wechat);
  const firstPreview = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/command-previews" && response.status() === 200);
  await page.getByRole("button", { name: "核对并创建", exact: true }).click();
  await firstPreview;
  await expect(page.getByTestId("command-effect")).toContainText(values.fullName);
  await expect(page.locator("dialog.modal-wide")).not.toContainText(/Preview|Confirm|Receipt|Command/);
  await page.getByTestId("command-return-to-edit").click();
  await expect(page.getByTestId("member-full-name")).toHaveValue(values.fullName);
  await expect(page.getByTestId("member-identity-card")).toHaveValue(values.identity);
  await expect(page.getByTestId("member-phone")).toHaveValue(values.phone);
  await expect(page.getByTestId("member-wechat")).toHaveValue(values.wechat);

  const secondPreview = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/command-previews" && response.status() === 200);
  await page.getByRole("button", { name: "核对并创建", exact: true }).click();
  await secondPreview;
  await page.getByRole("button", { name: "确认创建会员档案", exact: true }).click();
  await expect(page.locator("dialog.modal-wide")).toBeHidden();
  await expect(page.getByTestId("command-result-notice")).toContainText("会员档案已创建，会员列表已刷新");
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect.poll(() => page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);
});
