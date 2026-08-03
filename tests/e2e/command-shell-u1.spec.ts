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

async function expectRoomStatusLanding(page: Page) {
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", level: 1 })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible();
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
  await expectRoomStatusLanding(page);
  return response.json() as Promise<RoomStatusBoardDto>;
}

async function openAuthenticatedRoomStatus(page: Page): Promise<RoomStatusBoardDto> {
  const boardResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === `/api/v1/properties/${propertyId}/room-status`
      && response.status() === 200
  ));
  await page.goto("/");
  const response = await boardResponse;
  await expectRoomStatusLanding(page);
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

function availableQuoteRoom(board: RoomStatusBoardDto): ReturnType<typeof availableRoom> {
  for (const room of board.rooms) {
    if (!room.allowedActions.some((action) => action.code === "CREATE_ORDER" && action.enabled)) continue;
    const day = room.days.find((candidate) => candidate.available && candidate.conflicts.length === 0);
    if (day) return { unitId: room.id, arrivalDate: day.serviceDate, departureDate: addDay(day.serviceDate) };
  }
  throw new Error("No available room for U1 Quote recovery acceptance");
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

async function openQuoteWorkbench(page: Page, candidate: ReturnType<typeof availableRoom>) {
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${candidate.unitId}"][data-service-date="${candidate.arrivalDate}"]`);
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.click();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", candidate.unitId);
  await popover.getByRole("button", { name: "创建住宿", exact: true }).click();
  const drawer = page.locator("dialog.room-status-write-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "住宿金额", exact: true })).toBeVisible();
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

async function expectActiveMaintenanceVisible(page: Page, candidate: ReturnType<typeof availableRoom>, reason: string) {
  await expect.poll(async () => {
    const db = createDatabase(databaseUrl);
    try {
      const row = await db.selectFrom("maintenance_locks")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("property_id", "=", propertyId)
        .where("reason", "=", reason)
        .where("status", "=", "ACTIVE")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    } finally {
      await db.destroy();
    }
  }, { timeout: 15_000 }).toBe(1);
  const interval = page.locator(`[data-room-status-row="${candidate.unitId}"] .room-status-interval-maintenance`);
  await expect(interval).toBeVisible({ timeout: 15_000 });
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
    await expectActiveMaintenanceVisible(page, candidate, reason);
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
    const resultResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === "/api/v1/command-results/resolve"
        && (response.request().postDataJSON() as { idempotencyKey?: string }).idempotencyKey === confirmationKey
        && response.status() === 200;
    }, { timeout: 60_000 });
    const queryOriginal = page.getByRole("button", { name: "查询原操作结果" });
    await expect(queryOriginal).toBeEnabled();
    await queryOriginal.click({ timeout: 5_000 });
    await resultResponse;
    await expect(page.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
    await expectActiveMaintenanceVisible(page, candidate, reason);
    expect(confirmCount).toBe(1);
  } finally {
    releaseConfirm?.();
    await releaseByReason(page, reason);
  }
});

test("U1 pending command coordinates and clears across tabs without reload", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 cross-tab recovery journey");
  test.setTimeout(60_000);
  const board = await login(page);
  const candidate = availableRoom(board);
  const reason = `U1 跨标签协调 ${randomUUID()}`;
  const storageKey = "qintopia.command-recovery.v1:subject_demo_operator:property%3Aprop_qintopia_demo";
  const peer = await page.context().newPage();
  let releaseConfirm: (() => void) | undefined;
  try {
    await openMaintenanceReview(page, candidate, reason);
    await openAuthenticatedRoomStatus(peer);
    let confirmationKey = "";
    let confirmCount = 0;
    const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
    let resolveConfirmSettled: (() => void) | undefined;
    let rejectConfirmSettled: ((reason?: unknown) => void) | undefined;
    const confirmSettled = new Promise<void>((resolve, reject) => {
      resolveConfirmSettled = resolve;
      rejectConfirmSettled = reject;
    });
    await page.route("**/api/v1/command-previews/*/confirm", async (route) => {
      confirmationKey = route.request().headers()["idempotency-key"] ?? "";
      confirmCount += 1;
      await confirmGate;
      try {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
        resolveConfirmSettled?.();
      } catch (error) {
        rejectConfirmSettled?.(error);
        throw error;
      }
    }, { times: 1 });

    await page.getByTestId("confirm-command").click({ timeout: 5_000 });
    await expect(page.getByTestId("command-shell-progress")).toContainText("正在提交设置维修锁房");
    await expect.poll(() => confirmationKey, { timeout: 10_000 }).toMatch(/^web-confirm-lock_maintenance-/);

    const peerRecovery = peer.getByTestId("inventory-command-recovery");
    await expect(peerRecovery).toBeVisible({ timeout: 10_000 });
    await expect(peerRecovery).toContainText("原操作正在提交");
    await expect(peerRecovery.getByRole("button", { name: "查询设置维修锁房结果", exact: true })).toBeVisible();
    await expect.poll(() => peer.evaluate(({ key }) => {
      const serialized = localStorage.getItem(key);
      if (!serialized) return null;
      const value = JSON.parse(serialized) as { confirmationKey?: string; state?: string };
      return { confirmationKey: value.confirmationKey, state: value.state };
    }, { key: storageKey })).toEqual({ confirmationKey, state: "CONFIRMING" });

    const peerCell = peer.locator(`[data-room-status-cell="true"][data-unit-id="${candidate.unitId}"][data-service-date="${candidate.arrivalDate}"]`);
    await peerCell.scrollIntoViewIfNeeded();
    await peerCell.focus();
    await peer.keyboard.press("Enter");
    const peerPopover = peer.getByTestId("room-status-quick-popover");
    await peer.waitForTimeout(250);
    if (await peerPopover.isVisible()) {
      await expect(peerPopover).toContainText("当前选区暂无可执行操作");
      await expect(peerPopover.getByRole("button", { name: "创建住宿", exact: true })).toHaveCount(0);
      await expect(peerPopover.getByRole("button", { name: "维修锁房", exact: true })).toHaveCount(0);
      await expect(peerPopover.getByRole("button", { name: "查看房态记录", exact: true })).toBeVisible();
      await peerPopover.getByRole("button", { name: "关闭快捷操作", exact: true }).click();
    } else {
      await expect(peerRecovery).toBeVisible();
      await expect(peer.locator("dialog.modal-wide")).toHaveCount(0);
    }

    releaseConfirm?.();
    await confirmSettled;
    const peerMaintenanceInterval = peer.locator(`[data-room-status-row="${candidate.unitId}"] .room-status-interval-maintenance`);
    let peerReachedResult = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const hasRecoveryStorage = await peer.evaluate(({ key }) => localStorage.getItem(key) !== null, { key: storageKey });
      if (hasRecoveryStorage || await peerMaintenanceInterval.isVisible().catch(() => false)) {
        peerReachedResult = true;
        break;
      }
      await peer.waitForTimeout(250);
    }
    expect(peerReachedResult).toBe(true);
    if (await peer.evaluate(({ key }) => localStorage.getItem(key) !== null, { key: storageKey })) {
      if (!await peerRecovery.isVisible().catch(() => false)) {
        await peer.reload();
        await expectRoomStatusLanding(peer);
      }
      if (await peerRecovery.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await expect(peerRecovery).toContainText(/原操作正在提交|设置维修锁房结果需要恢复查询|设置维修锁房结果已确认/);
        await peerRecovery.getByRole("button", { name: /^(查询|刷新)设置维修锁房结果$/ }).click({ timeout: 5_000 });
        const queryOriginal = peer.getByRole("button", { name: "查询原操作结果", exact: true });
        if (await queryOriginal.isVisible({ timeout: 2_000 }).catch(() => false)) {
          const resultResponse = peer.waitForResponse((response) => {
            const url = new URL(response.url());
            return response.request().method() === "POST"
              && url.pathname === "/api/v1/command-results/resolve"
              && (response.request().postDataJSON() as { idempotencyKey?: string }).idempotencyKey === confirmationKey
              && response.status() === 200;
          }, { timeout: 60_000 });
          await queryOriginal.click({ timeout: 5_000 });
          await resultResponse;
        }
        await expect(peer.locator("dialog.modal-wide")).toBeHidden({ timeout: 15_000 });
      }
    }
    await expectActiveMaintenanceVisible(peer, candidate, reason);
    expect(confirmCount).toBe(1);
    await expect(peerRecovery).toBeHidden();
    const pageRecovery = page.getByTestId("inventory-command-recovery");
    const pageDialog = page.locator("dialog.modal-wide");
    if (await pageDialog.isVisible().catch(() => false) || await pageRecovery.isVisible().catch(() => false)) {
      if (!await pageDialog.isVisible().catch(() => false)) {
        await pageRecovery.getByRole("button", { name: /^(查询|刷新)设置维修锁房结果$/ }).click({ timeout: 5_000 });
      }
      const pageQueryOriginal = pageDialog.getByRole("button", { name: "查询原操作结果", exact: true });
      if (await pageQueryOriginal.isVisible({ timeout: 2_000 }).catch(() => false)) {
        const pageResultResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === "POST"
            && url.pathname === "/api/v1/command-results/resolve"
            && (response.request().postDataJSON() as { idempotencyKey?: string }).idempotencyKey === confirmationKey
            && response.status() === 200;
        }, { timeout: 60_000 });
        await pageQueryOriginal.click({ timeout: 5_000 });
        await pageResultResponse;
      }
      await expect(pageDialog).toBeHidden({ timeout: 15_000 });
    }
    await expect.poll(() => Promise.all([
      page.evaluate(({ key }) => localStorage.getItem(key), { key: storageKey }),
      peer.evaluate(({ key }) => ({ local: localStorage.getItem(key), session: sessionStorage.getItem(key) }), { key: storageKey })
    ])).toEqual([
      null,
      { local: null, session: null }
    ]);
  } finally {
    releaseConfirm?.();
    await peer.close();
    await releaseByReason(page, reason);
  }
});

test("U1 near-simultaneous confirmations across tabs send only one command", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 simultaneous-confirmation journey");
  test.setTimeout(60_000);
  const board = await login(page);
  const candidate = availableRoom(board);
  const reasons = [
    `U1 同时确认甲 ${randomUUID()}`,
    `U1 同时确认乙 ${randomUUID()}`
  ] as const;
  const storageKey = "qintopia.command-recovery.v1:subject_demo_operator:property%3Aprop_qintopia_demo";
  const confirmPattern = "**/api/v1/command-previews/*/confirm";
  const peer = await page.context().newPage();
  let releaseConfirm: (() => void) | undefined;
  let markConfirmComplete = () => {};
  let confirmCount = 0;
  const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
  const confirmComplete = new Promise<void>((resolve) => { markConfirmComplete = resolve; });

  try {
    await openAuthenticatedRoomStatus(peer);
    await openMaintenanceReview(page, candidate, reasons[0]);
    await openMaintenanceReview(peer, candidate, reasons[1]);
    await page.context().route(confirmPattern, async (route) => {
      confirmCount += 1;
      await confirmGate;
      try {
        await route.continue();
      } finally {
        markConfirmComplete();
      }
    });

    await Promise.all([
      page.getByTestId("confirm-command").evaluate((button: HTMLButtonElement) => button.click()),
      peer.getByTestId("confirm-command").evaluate((button: HTMLButtonElement) => button.click())
    ]);

    await expect.poll(() => confirmCount, { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(750);
    expect(confirmCount).toBe(1);
    await expect.poll(() => Promise.all([page, peer].map((target) => target.evaluate(({ key }) => {
      const serialized = localStorage.getItem(key);
      if (!serialized) return null;
      const recovery = JSON.parse(serialized) as { confirmationKey?: string; state?: string };
      return { confirmationKey: recovery.confirmationKey, state: recovery.state };
    }, { key: storageKey })))).toEqual([
      expect.objectContaining({ state: "CONFIRMING" }),
      expect.objectContaining({ state: "CONFIRMING" })
    ]);

    releaseConfirm?.();
    await confirmComplete;
    await expect.poll(async () => {
      const db = createDatabase(databaseUrl);
      try {
        const row = await db.selectFrom("maintenance_locks")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("property_id", "=", propertyId)
          .where("reason", "in", reasons)
          .where("status", "=", "ACTIVE")
          .executeTakeFirstOrThrow();
        return Number(row.count);
      } finally {
        await db.destroy();
      }
    }, { timeout: 15_000 }).toBe(1);
    expect(confirmCount).toBe(1);
  } finally {
    releaseConfirm?.();
    await Promise.race([confirmComplete, page.waitForTimeout(5_000)]).catch(() => undefined);
    await page.context().unroute(confirmPattern);
    await peer.close();
    await releaseByReason(page, reasons[0]);
    await releaseByReason(page, reasons[1]);
  }
});

test("U1 confirmation waiting for the shared recovery lock cannot close or send after unmount", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 recovery-lock unmount journey");
  test.setTimeout(60_000);
  const board = await login(page);
  const candidate = availableRoom(board);
  const reason = `U1 等待协调锁 ${randomUUID()}`;
  const recoveryCoordinationScope = "property-recovery:subject_demo_operator:prop_qintopia_demo";
  const lockName = `qintopia.recovery-lock.v1:${encodeURIComponent(recoveryCoordinationScope)}`;
  const context = page.context();
  const peer = await context.newPage();
  let confirmCount = 0;
  const countConfirm = (request: { method(): string; url(): string }) => {
    if (request.method() === "POST" && /\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(request.url()).pathname)) {
      confirmCount += 1;
    }
  };

  try {
    await openAuthenticatedRoomStatus(peer);
    await openMaintenanceReview(page, candidate, reason);
    await peer.evaluate((name) => {
      const state = window as typeof window & {
        u1RecoveryLockAcquired?: boolean;
        releaseU1RecoveryLock?: () => void;
      };
      void navigator.locks.request(name, { mode: "exclusive" }, () => new Promise<void>((resolve) => {
        state.u1RecoveryLockAcquired = true;
        state.releaseU1RecoveryLock = resolve;
      }));
    }, lockName);
    await expect.poll(() => peer.evaluate(() => Boolean((window as typeof window & { u1RecoveryLockAcquired?: boolean }).u1RecoveryLockAcquired))).toBe(true);

    context.on("request", countConfirm);
    await page.getByTestId("confirm-command").click({ timeout: 5_000 });
    const dialog = page.locator("dialog.modal-wide");
    await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
    await expect(dialog.getByTestId("command-return-to-edit")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(250);
    expect(confirmCount).toBe(0);

    await page.close();
    await peer.evaluate(() => (window as typeof window & { releaseU1RecoveryLock?: () => void }).releaseU1RecoveryLock?.());
    await peer.waitForTimeout(750);
    expect(confirmCount).toBe(0);

    const db = createDatabase(databaseUrl);
    try {
      const row = await db.selectFrom("maintenance_locks")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("property_id", "=", propertyId)
        .where("reason", "=", reason)
        .executeTakeFirstOrThrow();
      expect(Number(row.count)).toBe(0);
    } finally {
      await db.destroy();
    }
  } finally {
    context.off("request", countConfirm);
    if (!peer.isClosed()) {
      await peer.evaluate(() => (window as typeof window & { releaseU1RecoveryLock?: () => void }).releaseU1RecoveryLock?.()).catch(() => undefined);
      await releaseByReason(peer, reason);
      await peer.close();
    }
  }
});

test("U1 damaged local recovery stays blocked until the operator completes controlled review", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 damaged-recovery journey");
  const board = await login(page);
  const candidate = availableRoom(board);
  const storageKey = "qintopia.command-recovery.v1:subject_demo_operator:property%3Aprop_qintopia_demo";
  await page.evaluate(({ key }) => window.sessionStorage.setItem(key, "{\"version\":1"), { key: storageKey });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectRoomStatusLanding(page);

  const notice = page.getByTestId("inventory-damaged-command-recovery");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("先在当前业务页面核对订单、房态或会员记录");
  await expect(notice).toContainText("已经生效时不要重复办理");
  const discard = notice.getByRole("button", { name: "清除本物业损坏记录", exact: true });
  await expect(discard).toBeDisabled();
  await notice.getByLabel("我已核对服务端业务记录，并确认不会直接重复刚才的操作", { exact: true }).check();
  await expect(discard).toBeEnabled();
  await discard.click();
  await expect(notice).toBeHidden();
  await expect.poll(() => page.evaluate(({ key }) => window.sessionStorage.getItem(key), { key: storageKey })).toBeNull();

  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${candidate.unitId}"][data-service-date="${candidate.arrivalDate}"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  await expect(page.getByTestId("room-status-quick-popover").getByRole("button", { name: "维修锁房", exact: true })).toBeEnabled();
});

test("U1 damaged Quote recovery requires review and preserves other property records", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 damaged Quote recovery journey");
  const board = await login(page);
  const candidate = availableQuoteRoom(board);
  const storageKey = "qintopia.quote-command-recovery.v1:subject_demo_operator:prop_qintopia_demo";
  const otherStorageKey = "qintopia.quote-command-recovery.v1:subject_demo_operator:property_other";
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });
  await page.evaluate(({ key, otherKey }) => {
    localStorage.setItem(key, "{damaged-json");
    localStorage.setItem(otherKey, "preserve-other-property");
  }, { key: storageKey, otherKey: otherStorageKey });

  await openQuoteWorkbench(page, candidate);
  const notice = page.getByTestId("quote-damaged-command-recovery");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("先在当前业务页面核对订单、房态或会员记录");
  const discard = notice.getByRole("button", { name: "清除本物业损坏记录", exact: true });
  await expect(discard).toBeDisabled();
  expect(quotePostCount).toBe(0);

  await notice.getByLabel("我已核对服务端业务记录，并确认不会直接重复刚才的操作", { exact: true }).check();
  await expect(discard).toBeEnabled();
  await discard.click();
  await expect(notice).toBeHidden();
  await expect.poll(() => quotePostCount).toBe(1);
  await expect.poll(() => page.evaluate(({ key, otherKey }) => ({
    damagedRecord: localStorage.getItem(key) === "{damaged-json",
    otherRecord: localStorage.getItem(otherKey)
  }), { key: storageKey, otherKey: otherStorageKey })).toEqual({
    damagedRecord: false,
    otherRecord: "preserve-other-property"
  });
});

test("U1 orphaned Quote recovery requires explicit review before recalculating", async ({ page }, testInfo) => {
  test.skip(!desktopOnly(testInfo), "desktop U1 orphaned Quote recovery journey");
  const board = await login(page);
  const candidate = availableQuoteRoom(board);
  const storageKey = "qintopia.quote-command-recovery.v1:subject_demo_operator:prop_qintopia_demo";
  const otherStorageKey = "qintopia.quote-command-recovery.v1:subject_demo_operator:property_other";
  let quotePostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/quotes") quotePostCount += 1;
  });
  await page.evaluate(({ key, otherKey, unitId, arrivalDate, departureDate }) => {
    const input = {
      propertyId: "prop_qintopia_demo",
      inventoryUnitId: unitId,
      stayType: "TRANSIENT",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: "policy_orphaned_quote_review"
    };
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      subjectId: "subject_demo_operator",
      propertyId: "prop_qintopia_demo",
      ownerTabId: "closed-quote-tab",
      input,
      inputSignature: JSON.stringify(input),
      metadata: {
        idempotencyKey: "orphaned-quote-idempotency-key",
        correlationId: "orphaned-quote-correlation-id"
      },
      state: "SENDING"
    }));
    localStorage.setItem(otherKey, "preserve-other-property");
  }, {
    key: storageKey,
    otherKey: otherStorageKey,
    unitId: candidate.unitId,
    arrivalDate: candidate.arrivalDate,
    departureDate: candidate.departureDate
  });

  await openQuoteWorkbench(page, candidate);
  const recovery = page.getByTestId("quote-recovery");
  await expect(recovery).toContainText("另一标签正在提交报价");
  await expect(recovery).toContainText("如果原标签已经关闭，可核对原报价是否完成");
  const restart = recovery.getByRole("button", { name: "核对原报价结果", exact: true });
  await expect(restart).toBeDisabled();
  expect(quotePostCount).toBe(0);

  await recovery.getByLabel("我已关闭原报价标签，需要核对原报价结果", { exact: true }).check();
  await expect(restart).toBeEnabled();
  const resolution = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/v1/command-results/resolve"
    && response.status() === 200, { timeout: 60_000 });
  await restart.click();
  await resolution;
  await expect(recovery).toBeHidden();
  await expect.poll(() => quotePostCount).toBe(1);
  await expect(page.getByTestId("quote-result")).toBeVisible();
  await expect.poll(() => page.evaluate(({ key, otherKey }) => ({
    currentRecord: localStorage.getItem(key),
    otherRecord: localStorage.getItem(otherKey)
  }), { key: storageKey, otherKey: otherStorageKey })).toEqual({
    currentRecord: null,
    otherRecord: "preserve-other-property"
  });
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
  await expect(page.getByTestId("command-result-notice")).toContainText("会员档案已创建");
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  await expect.poll(() => page.evaluate(() => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);
});
