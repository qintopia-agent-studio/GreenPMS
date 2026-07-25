import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { RoomStatusBoardDto } from "@qintopia/contracts";
import { sql } from "kysely";
import { createDatabase } from "../../packages/db/src/database.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const operator = { username: "operator", password: "demo-pass-2026" };

interface MaintenanceCandidate {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
}

interface PreviewResponseBody {
  preview: {
    previewId: string;
    commandType: string;
    effectHash: string;
    effect: Record<string, unknown>;
    expiresAt: string;
  };
  receipt: {
    receiptId: string;
    result?: Record<string, unknown>;
  };
}

interface ReceiptResponseBody {
  receiptId: string;
  commandId: string;
  executionStatus: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN";
  businessCommitted: boolean;
  correlationId: string;
  result?: Record<string, unknown>;
  error?: { code?: string; details?: { causeCode?: string } };
  resourceRefs: string[];
  factRefs: string[];
}

interface PersistedRecoverySnapshot {
  state?: string;
  commandType?: string;
  confirmationKey?: string;
  targetRefs?: string[];
}

function isDesktopProject(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop" || process.env.ROOM_STATUS_E2E_PROJECT === "desktop";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function roomStatusResponse(page: Page) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${propertyId}/room-status`
      && response.status() === 200;
  });
}

async function login(page: Page): Promise<RoomStatusBoardDto> {
  await page.goto(process.env.ROOM_STATUS_E2E_BASE_URL ?? "/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  const responsePromise = roomStatusResponse(page);
  await page.getByTestId("login-submit").click();
  const response = await responsePromise;
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
  await expect(page.getByRole("grid")).toBeVisible();
  return response.json() as Promise<RoomStatusBoardDto>;
}

function findMaintenanceCandidate(board: RoomStatusBoardDto): MaintenanceCandidate {
  for (const room of board.rooms) {
    const canLockMaintenance = room.allowedActions.some((action) => (
      action.code === "LOCK_MAINTENANCE" && action.enabled
    ));
    if (!canLockMaintenance || room.intervals.some((interval) => interval.sourceKind === "MAINTENANCE")) continue;
    const day = room.days.find((candidate) => candidate.available && candidate.conflicts.length === 0);
    if (day) {
      return {
        unitId: room.id,
        arrivalDate: day.serviceDate,
        departureDate: addDays(day.serviceDate, 1)
      };
    }
  }
  throw new Error("The shared E2E database has no available room for a one-night maintenance command");
}

async function openMaintenanceCommand(page: Page, candidate: MaintenanceCandidate, businessReason: string) {
  const unitSelect = page.getByTestId("room-status-unit-select");
  await expect(unitSelect).toHaveAccessibleName("房间或床位");
  await unitSelect.selectOption(candidate.unitId);
  await page.getByLabel("入住日期", { exact: true }).fill(candidate.arrivalDate);
  await page.getByLabel("退房日期", { exact: true }).fill(candidate.departureDate);
  await page.getByRole("button", { name: "放置维修锁房", exact: true }).click();
  await page.getByLabel("维修原因").fill(businessReason);
  await page.getByRole("button", { name: "继续生成 Preview", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function createPreview(page: Page, trigger: Locator) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/command-previews"
      && response.status() === 200
  ));
  await trigger.click();
  const response = await responsePromise;
  const body = await response.json() as PreviewResponseBody;
  expect(body.preview.commandType).toBe("LOCK_MAINTENANCE");
  return {
    preview: body.preview,
    idempotencyKey: response.request().headers()["idempotency-key"] ?? ""
  };
}

async function readCommandRecoveries(page: Page): Promise<PersistedRecoverySnapshot[]> {
  return page.evaluate(() => Array.from(
    { length: sessionStorage.length },
    (_, index) => sessionStorage.key(index)
  ).filter((key): key is string => Boolean(key?.startsWith("qintopia.command-recovery.v1:")))
    .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null") as PersistedRecoverySnapshot));
}

async function releaseMaintenanceForCleanup(page: Page, maintenanceLockId: string) {
  const nonce = randomUUID();
  const previewResponse = await page.request.post("/api/v1/command-previews", {
    headers: {
      "Idempotency-Key": `e2e-cleanup-preview-${nonce}`,
      "X-Correlation-ID": `e2e-cleanup-preview-${nonce}`
    },
    data: {
      commandType: "RELEASE_MAINTENANCE",
      input: { propertyId, maintenanceLockId }
    }
  });
  if (!previewResponse.ok()) throw new Error(`Cleanup Preview failed: ${previewResponse.status()} ${await previewResponse.text()}`);
  const prepared = await previewResponse.json() as PreviewResponseBody;
  const confirmResponse = await page.request.post(`/api/v1/command-previews/${prepared.preview.previewId}/confirm`, {
    headers: {
      "Idempotency-Key": `e2e-cleanup-confirm-${nonce}`,
      "X-Correlation-ID": `e2e-cleanup-confirm-${nonce}`
    },
    data: {
      propertyId,
      commandType: "RELEASE_MAINTENANCE",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "E2E_CLEANUP", note: "Release a maintenance lock left by an interrupted E2E assertion" }
    }
  });
  if (!confirmResponse.ok()) throw new Error(`Cleanup Confirm failed: ${confirmResponse.status()} ${await confirmResponse.text()}`);
  const receipt = await confirmResponse.json() as ReceiptResponseBody;
  if (receipt.executionStatus !== "EXECUTED" || !receipt.businessCommitted) {
    throw new Error(`Cleanup Confirm failed: ${confirmResponse.status()} ${JSON.stringify(receipt)}`);
  }
}

async function blockCountForReason(reason: string): Promise<number> {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const row = await db.selectFrom("maintenance_locks")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("property_id", "=", propertyId)
      .where("reason", "=", reason)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  } finally {
    await db.destroy();
  }
}

async function previewAndConfirm(page: Page, reasonNote: string, expectedEffect: readonly string[]) {
  await page.getByTestId("create-command-preview").click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toBeVisible();
  for (const text of expectedEffect) await expect(effect).toContainText(text);
  await page.getByTestId("reason-note").fill(reasonNote);
  await page.getByTestId("confirm-command").click();
  const receipt = page.getByTestId("command-receipt");
  await expect(receipt).toContainText("业务写入已提交");
  await expect(receipt).toContainText("EXECUTED");
  return receipt;
}

async function finishReceipt(page: Page, waitForRefresh = false) {
  const refresh = waitForRefresh ? roomStatusResponse(page) : undefined;
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByTestId("command-receipt")).toBeHidden();
  if (refresh) await refresh;
}

test("desktop expired LOCK_MAINTENANCE Preview fails closed and regeneration writes no lock", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only room-status Preview expiry coverage");
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const board = await login(page);
  const candidate = findMaintenanceCandidate(board);
  const businessReason = `E2E expired room-status Preview ${randomUUID()}`;
  expect(await blockCountForReason(businessReason)).toBe(0);

  const db = createDatabase(e2eDatabaseUrl);
  try {
    // Keep the server-built effect and Receipt, but shorten this real Preview's TTL so the UI and PostgreSQL expire together.
    await page.route("**/api/v1/command-previews", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = await response.json() as PreviewResponseBody;
      expect(body.preview.previewId).toMatch(/^preview_/);
      expect(body.preview.commandType).toBe("LOCK_MAINTENANCE");
      expect(body.receipt.receiptId).toMatch(/^receipt_/);
      const stored = await db.updateTable("command_previews")
        .set({ expires_at: sql<Date>`clock_timestamp() + interval '2 seconds'` })
        .where("id", "=", body.preview.previewId)
        .where("command_type", "=", "LOCK_MAINTENANCE")
        .returning("expires_at")
        .executeTakeFirstOrThrow();
      const preview = { ...body.preview, expiresAt: new Date(stored.expires_at).toISOString() };
      await route.fulfill({
        response,
        json: { ...body, preview }
      });
    }, { times: 1 });

    await openMaintenanceCommand(page, candidate, businessReason);
    const first = await createPreview(page, page.getByTestId("create-command-preview"));
    expect(first.preview.previewId).toMatch(/^preview_/);
    expect(first.idempotencyKey).toMatch(/^web-preview-lock_maintenance-/);
    expect(first.preview.effect).toMatchObject({
      inventoryUnit: { id: candidate.unitId },
      arrivalDate: candidate.arrivalDate,
      departureDate: candidate.departureDate,
      reason: businessReason
    });
    await expect(page.getByTestId("command-effect")).toContainText(businessReason);
    await page.getByTestId("reason-note").fill("An expired room-status Preview must never place a Block");

    await expect(page.getByRole("alert").filter({ hasText: "Preview 已过期" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("confirm-command")).toHaveCount(0);
    const regenerate = page.getByTestId("regenerate-command-preview");
    await expect(regenerate).toBeVisible();

    const staleConfirmationKey = `e2e-confirm-expired-lock-maintenance-${randomUUID()}`;
    const staleResponse = await page.request.post(`/api/v1/command-previews/${first.preview.previewId}/confirm`, {
      headers: {
        "Idempotency-Key": staleConfirmationKey,
        "X-Correlation-ID": staleConfirmationKey
      },
      data: {
        propertyId,
        commandType: "LOCK_MAINTENANCE",
        confirmation: true,
        expectedEffectHash: first.preview.effectHash,
        reason: { code: "E2E_EXPIRED", note: "The endpoint must reject the same Preview hidden by the UI guard" }
      }
    });
    expect(staleResponse.status()).toBe(409);
    const rejected = await staleResponse.json() as ReceiptResponseBody;
    expect(rejected).toMatchObject({
      executionStatus: "NOT_EXECUTED",
      businessCommitted: false,
      error: { code: "PREVIEW_STALE", details: { causeCode: "PREVIEW_EXPIRED" } },
      resourceRefs: [],
      factRefs: []
    });
    expect(await blockCountForReason(businessReason)).toBe(0);

    await expect(regenerate).toBeEnabled();
    const second = await createPreview(page, regenerate);
    expect(second.preview.previewId).toMatch(/^preview_/);
    expect(second.preview.previewId).not.toBe(first.preview.previewId);
    expect(second.idempotencyKey).toMatch(/^web-preview-lock_maintenance-/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.preview.effect).toMatchObject({
      inventoryUnit: { id: candidate.unitId },
      arrivalDate: candidate.arrivalDate,
      departureDate: candidate.departureDate,
      reason: businessReason
    });
    const regeneratedEffect = page.getByTestId("command-effect");
    for (const text of [candidate.arrivalDate, candidate.departureDate, businessReason]) {
      await expect(regeneratedEffect).toContainText(text);
    }
    await expect(page.getByTestId("confirm-command")).toBeEnabled();

    const previews = await db.selectFrom("command_previews")
      .select(["id", "expires_at", "status", "used_at"])
      .where("id", "in", [first.preview.previewId, second.preview.previewId])
      .orderBy("id")
      .execute();
    expect(previews).toHaveLength(2);
    const expiredPreview = previews.find((preview) => preview.id === first.preview.previewId);
    expect(expiredPreview).toMatchObject({ status: "EXPIRED", used_at: null });
    expect(new Date(expiredPreview!.expires_at).toISOString()).toBe(first.preview.expiresAt);
    expect(previews.find((preview) => preview.id === second.preview.previewId)).toMatchObject({ status: "OPEN", used_at: null });
    expect(await blockCountForReason(businessReason)).toBe(0);

    await page.getByRole("button", { name: "取消", exact: true }).click();
  } finally {
    await db.destroy();
  }
});

test("desktop LOCK_MAINTENANCE recovery keeps the original key and resolves one committed lock", async ({ page }, testInfo) => {
  test.skip(!isDesktopProject(testInfo), "desktop-only room-status Confirm recovery coverage");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const board = await login(page);
  const candidate = findMaintenanceCandidate(board);
  const businessReason = `E2E lost room-status Confirm response ${randomUUID()}`;
  const db = createDatabase(e2eDatabaseUrl);
  let primaryError: unknown;
  try {
    expect(await db.selectFrom("maintenance_locks")
      .select("id")
      .where("reason", "=", businessReason)
      .execute()).toHaveLength(0);

    await openMaintenanceCommand(page, candidate, businessReason);
    const prepared = await createPreview(page, page.getByTestId("create-command-preview"));
    await expect(page.getByTestId("command-effect")).toContainText(businessReason);
    await page.getByTestId("reason-note").fill("Recover the committed LOCK_MAINTENANCE command without retrying it");

    let originalConfirmationKey = "";
    let confirmPostCount = 0;
    const confirmPath = `/api/v1/command-previews/${prepared.preview.previewId}/confirm`;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === confirmPath) confirmPostCount += 1;
    });
    await page.route(`**${confirmPath}`, async (route) => {
      originalConfirmationKey = route.request().headers()["idempotency-key"] ?? "";
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    }, { times: 1 });

    await page.getByTestId("confirm-command").click();
    await expect(page.getByText("执行状态需要恢复查询", { exact: true })).toBeVisible();
    await expect(page.getByTestId("confirm-command")).toHaveCount(0);
    await expect(page.getByTestId("regenerate-command-preview")).toHaveCount(0);
    expect(originalConfirmationKey).toMatch(/^web-confirm-lock_maintenance-/);
    expect(confirmPostCount).toBe(1);

    const persistedBeforeClose = await readCommandRecoveries(page);
    expect(persistedBeforeClose).toHaveLength(1);
    expect(persistedBeforeClose[0]).toMatchObject({
      state: "UNKNOWN",
      commandType: "LOCK_MAINTENANCE",
      confirmationKey: originalConfirmationKey,
      targetRefs: [`inventoryUnitId=${candidate.unitId}`]
    });

    await page.getByRole("button", { name: "取消", exact: true }).click();
    let recovery = page.getByTestId("inventory-command-recovery");
    await expect(recovery).toContainText("LOCK_MAINTENANCE");
    await expect(recovery).toContainText("UNKNOWN");
    await expect(recovery).toContainText(originalConfirmationKey);

    await page.reload();
    await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
    await expect(page.getByRole("grid")).toBeVisible();
    recovery = page.getByTestId("inventory-command-recovery");
    await expect(recovery).toContainText("UNKNOWN");
    await expect(recovery).toContainText(originalConfirmationKey);
    expect(await readCommandRecoveries(page)).toEqual([expect.objectContaining({
      state: "UNKNOWN",
      commandType: "LOCK_MAINTENANCE",
      confirmationKey: originalConfirmationKey
    })]);
    expect(confirmPostCount).toBe(1);

    await recovery.getByTestId("inventory-command-recovery-open").click();
    let recoveryQueryCount = 0;
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const url = new URL(request.url());
      if (url.pathname === "/api/v1/command-results"
        && url.searchParams.get("propertyId") === propertyId
        && url.searchParams.get("commandType") === "LOCK_MAINTENANCE"
        && url.searchParams.get("idempotencyKey") === originalConfirmationKey) recoveryQueryCount += 1;
    });
    const recoveryResponsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== "GET") return false;
      const url = new URL(response.url());
      return url.pathname === "/api/v1/command-results"
        && url.searchParams.get("propertyId") === propertyId
        && url.searchParams.get("commandType") === "LOCK_MAINTENANCE"
        && url.searchParams.get("idempotencyKey") === originalConfirmationKey;
    });
    await page.getByRole("button", { name: "查询命令结果", exact: true }).click();
    const recoveryResponse = await recoveryResponsePromise;
    expect(recoveryResponse.status()).toBe(200);
    const recoveredBody = await recoveryResponse.json() as ReceiptResponseBody;
    expect(recoveredBody).toMatchObject({
      executionStatus: "EXECUTED",
      businessCommitted: true
    });
    expect(recoveredBody.resourceRefs).toHaveLength(1);
    expect(recoveredBody.resourceRefs[0]).toMatch(/^maint_/);
    expect(recoveryQueryCount).toBe(1);

    const recoveredReceipt = page.getByTestId("command-receipt");
    const recoveredOriginal = page.getByTestId("command-recovered-original");
    await expect(recoveredOriginal).toHaveAttribute("data-command-state", "duplicate-returned-original-receipt");
    await expect(recoveredOriginal).toContainText("没有重复执行业务命令");
    await expect(recoveredReceipt).toContainText("业务写入已提交");
    await expect(recoveredReceipt).toContainText("EXECUTED");
    const receiptIdCode = recoveredReceipt.locator("code").filter({ hasText: /^receipt_/ });
    const commandIdCode = recoveredReceipt.locator("code").filter({ hasText: /^command_/ });
    const blockIdCode = recoveredReceipt.locator("code").filter({ hasText: /^maint_/ });
    await expect(receiptIdCode).toHaveCount(1);
    await expect(commandIdCode).toHaveCount(1);
    await expect(blockIdCode).toHaveCount(1);
    const receiptId = (await receiptIdCode.textContent())?.trim();
    const commandId = (await commandIdCode.textContent())?.trim();
    const blockId = (await blockIdCode.textContent())?.trim();
    expect(receiptId).toBe(recoveredBody.receiptId);
    expect(commandId).toBe(recoveredBody.commandId);
    expect(blockId).toBe(recoveredBody.resourceRefs[0]);
    expect(blockId).toMatch(/^maint_/);
    expect(confirmPostCount).toBe(1);

    const committed = await db.selectFrom("command_executions")
      .innerJoin("command_receipts", "command_receipts.command_id", "command_executions.id")
      .select([
        "command_executions.id as command_id",
        "command_executions.state",
        "command_receipts.id as receipt_id",
        "command_receipts.execution_status",
        "command_receipts.business_committed"
      ])
      .where("command_executions.property_id", "=", propertyId)
      .where("command_executions.command_type", "=", "LOCK_MAINTENANCE")
      .where("command_executions.idempotency_key", "=", originalConfirmationKey)
      .execute();
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      command_id: commandId,
      state: "APPLIED",
      receipt_id: receiptId,
      execution_status: "EXECUTED",
      business_committed: true
    });

    const blocks = await db.selectFrom("maintenance_locks")
      .select(["id", "inventory_unit_id", "arrival_date", "departure_date", "reason", "status", "created_by_command_id"])
      .where("property_id", "=", propertyId)
      .where("reason", "=", businessReason)
      .execute();
    expect(blocks).toEqual([{
      id: blockId,
      inventory_unit_id: candidate.unitId,
      arrival_date: candidate.arrivalDate,
      departure_date: candidate.departureDate,
      reason: businessReason,
      status: "ACTIVE",
      created_by_command_id: committed[0]!.command_id
    }]);
    const activeClaims = await db.selectFrom("inventory_claims")
      .select("id")
      .where("source_type", "=", "MAINTENANCE")
      .where("source_id", "=", blockId!)
      .where("active", "=", true)
      .execute();
    expect(activeClaims).toHaveLength(1);

    await finishReceipt(page, true);
    await expect(page.getByTestId("inventory-command-recovery")).toBeHidden();
    expect(await page.evaluate(() => Array.from(
      { length: sessionStorage.length },
      (_, index) => sessionStorage.key(index)
    ).filter((key) => key?.startsWith("qintopia.command-recovery.v1:")).length)).toBe(0);

    const interval = page.locator(`[data-room-status-row="${candidate.unitId}"] .room-status-interval-maintenance`);
    await expect(interval).toHaveCount(1);
    await interval.click();
    await expect(page.locator("section.room-status-context-section").filter({
      has: page.getByRole("heading", { name: "来源事实" })
    })).toContainText(businessReason);
    await page.locator(".room-status-context-actions")
      .getByRole("button", { name: "释放维修锁房", exact: true })
      .click();
    const releaseReceipt = await previewAndConfirm(page, "Release the recovered E2E maintenance lock", [
      blockId!,
      candidate.arrivalDate,
      candidate.departureDate,
      "RELEASE_MAINTENANCE"
    ]);
    await expect(releaseReceipt.locator("code").filter({ hasText: blockId! })).toHaveCount(1);
    await finishReceipt(page, true);
    await expect(interval).toHaveCount(0);

    const released = await db.selectFrom("maintenance_locks")
      .select(["status", "released_by_command_id", "released_at"])
      .where("id", "=", blockId!)
      .executeTakeFirstOrThrow();
    expect(released.status).toBe("RELEASED");
    expect(released.released_by_command_id).toMatch(/^command_/);
    expect(released.released_at).not.toBeNull();
    const remainingClaims = await db.selectFrom("inventory_claims")
      .select("id")
      .where("source_type", "=", "MAINTENANCE")
      .where("source_id", "=", blockId!)
      .where("active", "=", true)
      .execute();
    expect(remainingClaims).toHaveLength(0);
    expect(confirmPostCount).toBe(1);
    expect(recoveryQueryCount).toBe(1);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      const activeBlocks = await db.selectFrom("maintenance_locks")
        .select("id")
        .where("property_id", "=", propertyId)
        .where("reason", "=", businessReason)
        .where("status", "=", "ACTIVE")
        .execute();
      for (const block of activeBlocks) await releaseMaintenanceForCleanup(page, block.id);
      const remainingActiveBlocks = await db.selectFrom("maintenance_locks")
        .select("id")
        .where("property_id", "=", propertyId)
        .where("reason", "=", businessReason)
        .where("status", "=", "ACTIVE")
        .execute();
      if (remainingActiveBlocks.length > 0) throw new Error(`Cleanup left active Blocks: ${remainingActiveBlocks.map((block) => block.id).join(", ")}`);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await db.destroy();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      if (!primaryError) throw cleanupError;
      await testInfo.attach("room-status-cleanup-error", {
        body: cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError),
        contentType: "text/plain"
      });
    }
  }
});
