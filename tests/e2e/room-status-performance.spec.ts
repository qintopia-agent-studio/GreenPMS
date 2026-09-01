import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { AuthPrincipal, RoomStatusBoardDto } from "@qintopia/contracts";
import { todayInTimeZone, sha256 } from "@qintopia/domain";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { createRoomStatusViewState, serializeRoomStatusRestoration } from "../../apps/web/src/room-status/roomStatusState.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const baseUrl = process.env.ROOM_STATUS_E2E_BASE_URL ?? "/";
const performancePropertyId = "prop_e2e_room_status_performance";
const performancePropertyCode = "Z-RS-PERF";
const operator = { username: "operator", password: "demo-pass-2026" };
const operatorSubjectId = "subject_demo_operator";
const agentSubjectId = "subject_demo_agent";
const performanceTokenId = "token_e2e_room_status_performance";
const roomStatusPageSize = 50;

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop" || process.env.ROOM_STATUS_E2E_PROJECT === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile" || process.env.ROOM_STATUS_E2E_PROJECT === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function preparePerformanceProperty(arrivalDate: string): Promise<void> {
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const operatorSubject = await db.selectFrom("subjects")
      .select("id")
      .where("username", "=", operator.username)
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("properties").values({
        id: performancePropertyId,
        code: performancePropertyCode,
        name: "Room Status Performance Fixture",
        timezone: "Asia/Shanghai",
        currency: "CNY"
      }).onConflict((conflict) => conflict.column("id").doNothing()).execute();
      await trx.insertInto("inventory_units").values(Array.from({ length: 200 }, (_, index) => {
        const suffix = index.toString().padStart(3, "0");
        return {
          id: `unit_e2e_room_status_performance_${suffix}`,
          property_id: performancePropertyId,
          kind: "ROOM" as const,
          parent_room_id: null,
          code: `PERF-${suffix}`,
          name: `Performance room ${suffix}`,
          active: true,
          catalog_version: null,
          building_code: "PERF",
          room_type_code: null,
          pricing_product_code: null,
          inventory_basis: "INDEPENDENT" as const,
          code_provenance: "PMS_GENERATED" as const,
          physical_bed_count: 1
        };
      })).onConflict((conflict) => conflict.column("id").doNothing()).execute();
      await trx.insertInto("room_status_revisions").values({
        property_id: performancePropertyId,
        revision: 0
      }).onConflict((conflict) => conflict.column("property_id").doNothing()).execute();
      await trx.insertInto("subject_property_grants").values({
        subject_id: operatorSubject.id,
        property_id: performancePropertyId,
        access_level: "WRITE"
      }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
        access_level: "WRITE"
      })).execute();
      await trx.insertInto("subject_property_grants").values({
        subject_id: agentSubjectId,
        property_id: performancePropertyId,
        access_level: "WRITE"
      }).onConflict((conflict) => conflict.columns(["subject_id", "property_id"]).doUpdateSet({
        access_level: "WRITE"
      })).execute();
      await trx.insertInto("api_tokens").values({
        id: performanceTokenId,
        subject_id: agentSubjectId,
        label: "Room-status performance fixture writer",
        secret_hash: sha256("e2e-room-status-performance-token"),
        access_ceiling: "WRITE",
        property_scope: performancePropertyId,
        expires_at: "2035-01-01T00:00:00.000Z",
        revoked_at: null,
        rotated_from_id: null,
        replaced_by_id: null
      }).onConflict((conflict) => conflict.column("id").doUpdateSet({
        revoked_at: null,
        replaced_by_id: null,
        expires_at: "2035-01-01T00:00:00.000Z"
      })).execute();
    });

    const principal: AuthPrincipal = {
      subjectId: agentSubjectId,
      credentialId: performanceTokenId,
      credentialType: "TOKEN",
      displayName: "Room-status performance fixture writer",
      propertyAccess: new Map([[performancePropertyId, "WRITE"]])
    };
    for (let index = 0; index < 200; index += 10) {
      const suffix = index.toString().padStart(3, "0");
      const reason = `E2E performance typed source ${arrivalDate} ${suffix}`;
      const existing = await db.selectFrom("maintenance_locks")
        .select(["id", "status"])
        .where("property_id", "=", performancePropertyId)
        .where("reason", "=", reason)
        .execute();
      if (existing.some((lock) => lock.status === "ACTIVE")) continue;
      const generation = existing.length + 1;
      const sourceStart = addDays(arrivalDate, index % 20);
      const sourceEnd = addDays(sourceStart, 21);
      const preview = await createCommandPreview(db, principal, {
        commandType: "LOCK_MAINTENANCE",
        input: {
          propertyId: performancePropertyId,
          inventoryUnitId: `unit_e2e_room_status_performance_${suffix}`,
          arrivalDate: sourceStart,
          departureDate: sourceEnd,
          reason
        }
      }, {
        idempotencyKey: `e2e-performance-preview-${arrivalDate}-${suffix}-${generation}`,
        correlationId: `e2e-performance-preview-${arrivalDate}-${suffix}-${generation}`
      });
      await confirmCommandPreview(db, principal, preview.preview.previewId, {
        propertyId: performancePropertyId,
        commandType: "LOCK_MAINTENANCE",
        confirmation: true,
        expectedEffectHash: preview.preview.effectHash,
        reason: {
          code: "E2E_PERFORMANCE_FIXTURE",
          note: "Populate the measured room-status projection with real typed sources"
        }
      }, {
        idempotencyKey: `e2e-performance-confirm-${arrivalDate}-${suffix}-${generation}`,
        correlationId: `e2e-performance-confirm-${arrivalDate}-${suffix}-${generation}`
      });
    }
  } finally {
    await db.destroy();
  }
}

function roomStatusResponse(
  page: Page,
  expectedRange?: { arrivalDate: string; departureDate: string }
) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && (!expectedRange || (url.searchParams.get("arrivalDate") === expectedRange.arrivalDate
        && url.searchParams.get("departureDate") === expectedRange.departureDate))
      && response.status() === 200;
  });
}

async function login(page: Page): Promise<void> {
  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态" })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible();
}

test("200 real inventory units by 30 nights become keyboard-interactive within two seconds", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop room-status performance coverage");
  test.setTimeout(120_000);
  const arrivalDate = todayInTimeZone("Asia/Shanghai");
  await preparePerformanceProperty(arrivalDate);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  const departureDate = addDays(arrivalDate, 30);
  await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), {
    key: `qintopia.room-status-view.v1:${operatorSubjectId}:${performancePropertyId}`,
    value: serializeRoomStatusRestoration({
      version: 1,
      propertyId: performancePropertyId,
      range: { arrivalDate, departureDate },
      revision: "0",
      savedAt: new Date().toISOString(),
      state: createRoomStatusViewState()
    })
  });

  const committedRange = page.getByTestId("room-status-board-range");
  const responsePromise = roomStatusResponse(page, { arrivalDate, departureDate });
  const startedAt = performance.now();
  await page.getByTestId("property-select").selectOption(performancePropertyId);
  const response = await responsePromise;
  await expect(committedRange).toHaveAttribute("data-range-arrival", arrivalDate);
  await expect(committedRange).toHaveAttribute("data-range-departure", departureDate);

  const grid = committedRange.getByRole("grid");
  await expect(grid).toBeVisible();
  const renderedBuildingGroupCount = 1;
  await expect(grid).toHaveAttribute("aria-rowcount", String(roomStatusPageSize + renderedBuildingGroupCount + 1));
  const renderedDateCount = await grid.locator(".room-status-date-header").count();
  expect(renderedDateCount).toBeGreaterThan(0);
  expect(renderedDateCount).toBeLessThanOrEqual(31);
  await expect(grid.locator("[data-room-status-row]")).toHaveCount(roomStatusPageSize);
  await expect(grid.locator("[data-room-status-cell='true']")).toHaveCount(roomStatusPageSize * renderedDateCount);

  const firstCell = grid.locator("[data-room-status-cell='true']").first();
  await firstCell.focus();
  await page.keyboard.press("ArrowRight");
  await expect(grid.locator("[data-room-status-cell='true']:focus")).toHaveAttribute("data-service-date", addDays(arrivalDate, 1));
  const elapsedMs = performance.now() - startedAt;
  expect(elapsedMs, "first 30-night page through keyboard-interactive 200-unit property")
    .toBeLessThanOrEqual(2_000);

  const responseBody = await response.body();
  const board = JSON.parse(responseBody.toString("utf8")) as RoomStatusBoardDto;
  expect(board.dates).toHaveLength(30);
  expect(board.rooms.reduce((count, room) => count + 1 + room.children.length, 0)).toBe(roomStatusPageSize);
  expect(board.rooms.flatMap((room) => room.intervals).filter((interval) => interval.sourceKind === "MAINTENANCE").length).toBeGreaterThanOrEqual(5);
  const renderedDates = await grid.locator("[data-room-status-row]").first()
    .locator("[data-room-status-cell='true']")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-service-date")).filter((date): date is string => date !== null));
  const visibleStartDate = renderedDates.at(0)!;
  const visibleEndDate = addDays(renderedDates.at(-1)!, 1);
  const visibleMaintenanceCount = board.rooms
    .flatMap((room) => room.intervals)
    .filter((interval) => interval.sourceKind === "MAINTENANCE"
      && interval.startDate < visibleEndDate
      && interval.endDate > visibleStartDate)
    .length;
  await expect(grid.locator(".room-status-interval-maintenance")).toHaveCount(visibleMaintenanceCount);
  expect(board.page).toMatchObject({ index: 0, size: roomStatusPageSize, totalRooms: 200, totalPages: 4 });
  expect(responseBody.byteLength).toBeLessThanOrEqual(2_100_000);
  expect(response.headers()["content-encoding"]).toMatch(/^(br|gzip|zstd)$/);

  const filteredResponsePromise = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return candidate.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && url.searchParams.get("search") === "PERF-190"
      && candidate.status() === 200;
  });
  await page.getByLabel("搜索房间或床位").fill("PERF-190");
  const filteredResponse = await filteredResponsePromise;
  const filteredBoard = await filteredResponse.json() as RoomStatusBoardDto;
  expect(filteredBoard.page).toMatchObject({ index: 0, totalRooms: 1, totalPages: 1 });
  expect(filteredBoard.rooms.map((room) => room.code)).toEqual(["PERF-190"]);
  expect(filteredBoard.filterOptions.capacities).toContain(1);
  await expect(grid.locator("[data-room-status-row]")).toHaveCount(1);
});

test("restoration scans server pages until the previously selected room is visible again", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop cross-page restoration coverage");
  test.setTimeout(120_000);
  const arrivalDate = todayInTimeZone("Asia/Shanghai");
  const departureDate = addDays(arrivalDate, 14);
  const targetUnitId = "unit_e2e_room_status_performance_175";
  await preparePerformanceProperty(arrivalDate);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);

  await page.evaluate(({ key, value }) => window.sessionStorage.setItem(key, value), {
    key: `qintopia.room-status-view.v1:${operatorSubjectId}:${performancePropertyId}`,
    value: serializeRoomStatusRestoration({
      version: 1,
      propertyId: performancePropertyId,
      range: { arrivalDate, departureDate },
      revision: "0",
      savedAt: new Date().toISOString(),
      state: createRoomStatusViewState({
        roomPageIndex: 0,
        focusedCell: { unitId: targetUnitId, serviceDate: arrivalDate },
        selection: {
          unitId: targetUnitId,
          anchorDate: arrivalDate,
          focusDate: arrivalDate,
          arrivalDate,
          departureDate: addDays(arrivalDate, 1)
        }
      })
    })
  });

  const finalPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && url.searchParams.get("page") === "3"
      && response.status() === 200;
  });
  await page.getByTestId("property-select").selectOption(performancePropertyId);
  await finalPageResponse;

  const targetCell = page.locator(
    `[data-room-status-cell="true"][data-unit-id="${targetUnitId}"][data-service-date="${arrivalDate}"]`
  );
  await expect(targetCell).toBeVisible();
  await expect(targetCell).toHaveAttribute("aria-selected", "true");
  await expect(targetCell).toBeFocused();
});

test("mobile operators can page through every room in a property larger than one server page", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile room pagination coverage");
  test.setTimeout(120_000);
  const arrivalDate = todayInTimeZone("Asia/Shanghai");
  await preparePerformanceProperty(arrivalDate);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript((propertyId) => {
    window.localStorage.setItem("qintopia.propertyId", propertyId);
  }, performancePropertyId);

  const firstPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && url.searchParams.get("page") === "0"
      && response.status() === 200;
  });
  await login(page);
  await firstPageResponse;

  const pager = page.getByRole("navigation", { name: "移动房源分页" });
  await expect(pager).toContainText("房源第 1 / 4 页，共 200 间");
  await expect(page.getByRole("region", { name: /房态二维网格/ })).toHaveCount(0);

  const secondPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && url.searchParams.get("page") === "1"
      && response.status() === 200;
  });
  await pager.getByRole("button", { name: "下一页房源" }).click();
  await secondPageResponse;
  await expect(pager).toContainText("房源第 2 / 4 页，共 200 间");
  await page.screenshot({ path: testInfo.outputPath("room-status-mobile-pagination-200-rooms.png"), fullPage: true });

  await page.getByRole("button", { name: "新建住宿或锁房" }).click();
  const unitSelect = page.getByTestId("room-status-unit-select");
  await expect(unitSelect.locator("option")).toHaveCount(roomStatusPageSize + 1);
  await expect(unitSelect.locator("option[value='unit_e2e_room_status_performance_050']")).toHaveCount(1);
  await expect(unitSelect.locator("option[value='unit_e2e_room_status_performance_000']")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  const previousPageResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname === `/api/v1/properties/${performancePropertyId}/room-status`
      && url.searchParams.get("page") === "0"
      && response.status() === 200;
  });
  await pager.getByRole("button", { name: "上一页房源" }).click();
  await previousPageResponse;
  await expect(pager).toContainText("房源第 1 / 4 页，共 200 间");
});
