import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface RoomStatusFixtureUnit {
  id: string;
  allowedActions: Array<{ code: string; enabled: boolean }>;
  days: Array<{
    serviceDate: string;
    status: string;
    available: boolean;
    intervalIds: string[];
    conflicts: unknown[];
  }>;
  children: RoomStatusFixtureUnit[];
}

interface RoomStatusFixtureBoard {
  businessDate: string;
  rooms: RoomStatusFixtureUnit[];
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatMonthDay(value: string): string {
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", level: 2 })).toBeVisible();
}

async function roomStatusBusinessDate(request: APIRequestContext): Promise<string> {
  const response = await request.get(
    "/api/v1/properties/prop_qintopia_demo/room-status?arrivalDate=2026-01-01&departureDate=2026-01-31&page=0&pageSize=50"
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as Pick<RoomStatusFixtureBoard, "businessDate">).businessDate;
}

async function setBoardRange(page: Page, arrivalDate: string): Promise<RoomStatusFixtureBoard> {
  const boardDepartureDate = addDays(arrivalDate, 30);
  const rangeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET"
      && url.pathname.endsWith("/room-status")
      && url.searchParams.get("arrivalDate") === arrivalDate
      && url.searchParams.get("departureDate") === boardDepartureDate
      && response.ok();
  });
  await page.getByTestId("arrival-date").fill(arrivalDate);
  const response = await rangeResponse;
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("room-status-board-range")).toHaveAttribute("data-range-arrival", arrivalDate);
  await expect(page.getByTestId("room-status-board-range")).toHaveAttribute("data-range-departure", boardDepartureDate);
  return await response.json() as RoomStatusFixtureBoard;
}

function roomStatusUnits(units: readonly RoomStatusFixtureUnit[]): RoomStatusFixtureUnit[] {
  return units.flatMap((unit) => [unit, ...roomStatusUnits(unit.children)]);
}

function recoveryQuoteCandidate(
  board: RoomStatusFixtureBoard,
  arrivalDate: string,
  departureDate: string,
  actionCode: "BACKFILL_ORDER" | "CREATE_ORDER"
): RoomStatusFixtureUnit | undefined {
  return roomStatusUnits(board.rooms).find((unit) => {
    const historical = actionCode === "BACKFILL_ORDER";
    const expectedDates: string[] = [];
    for (let date = arrivalDate; date < departureDate; date = addDays(date, 1)) expectedDates.push(date);
    const days = expectedDates.map((date) => unit.days.find((candidate) => candidate.serviceDate === date));
    return Boolean(days.every((day) => day
      && day.conflicts.length === 0
      && day.intervalIds.length === 0
      && (historical && day.serviceDate < board.businessDate ? day.status === "AVAILABLE" : day.available))
      && unit.allowedActions.some((action) => action.code === actionCode && action.enabled));
  });
}

async function selectDraft(page: Page, unitId: string, arrivalDate: string, departureDate: string) {
  const openDrawer = page.locator("dialog.room-status-write-drawer");
  if (await openDrawer.isVisible()) {
    await openDrawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(openDrawer).toBeHidden();
  }
  const cell = roomCell(page, unitId, arrivalDate);
  const drawer = page.locator("dialog.room-status-write-drawer");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await cell.scrollIntoViewIfNeeded();
    await expect(cell).toBeVisible();
    await cell.focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("room-status-quick-popover");
    try {
      await expect(popover).toBeVisible({ timeout: 5_000 });
      await expect(popover).toHaveAttribute("data-unit-id", unitId);
      await expect(popover).toHaveAttribute("data-selection-kind", "day");
      await popover.getByRole("button", { name: "创建订单", exact: true }).click({ timeout: 5_000 });
      await expect(drawer).toBeVisible({ timeout: 5_000 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.keyboard.press("Escape").catch(() => undefined);
      await expect(popover).toBeHidden({ timeout: 2_000 }).catch(() => undefined);
    }
  }
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await drawer.getByLabel("退房日期", { exact: true }).fill(departureDate);
}

function roomCell(page: Page, unitId: string, serviceDate: string) {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

function roomRow(page: Page, unitId: string) {
  return page.locator(`[data-room-status-row="${unitId}"]`);
}

async function commandHeaders(scope: string) {
  return {
    "Idempotency-Key": `stage-1-${scope}`,
    "X-Correlation-ID": `stage-1-${scope}`
  };
}

async function createOccupiedFixture(request: APIRequestContext, arrivalDate: string, departureDate: string) {
  const quote = await request.post("/api/v1/quotes", {
    headers: await commandHeaders("fixture-quote"),
    data: {
      propertyId: "prop_qintopia_demo",
      inventoryUnitId: "unit_room_109",
      arrivalDate,
      departureDate,
      pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1"
    }
  });
  expect(quote.ok(), await quote.text()).toBe(true);
  const quoteBody = (await quote.json()).quote as {
    quoteId: string;
    currentContractAmount: { minorUnits: number };
  };
  const preview = await request.post("/api/v1/command-previews", {
    headers: await commandHeaders("fixture-preview"),
    data: {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: "prop_qintopia_demo",
        quoteId: quoteBody.quoteId,
        primaryGuest: { fullName: "阶段一冲突夹具", nickname: "冲突夹具" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null,
        targetCurrentContractAmountMinor: quoteBody.currentContractAmount.minorUnits
      }
    }
  });
  expect(preview.ok(), await preview.text()).toBe(true);
  const previewBody = (await preview.json()).preview;
  const confirm = await request.post(`/api/v1/command-previews/${previewBody.previewId}/confirm`, {
    headers: await commandHeaders("fixture-confirm"),
    data: {
      propertyId: "prop_qintopia_demo",
      commandType: "CREATE_ORDER",
      confirmation: true,
      expectedEffectHash: previewBody.effectHash,
      reason: { code: "CREATE_STANDARD_ORDER", note: "" }
    }
  });
  expect(confirm.ok(), await confirm.text()).toBe(true);
}

test.describe("第 1 步 / 阶段 1 自动报价", () => {
  test.skip(({ isMobile }) => isMobile, "阶段 1 人工停点使用桌面房态；移动完整旅程在发布阶段验收");

  test("有效库存目录 READY 时恢复床位连续选区的创建住宿入口", async ({ page }) => {
    await login(page);
    const businessDate = await roomStatusBusinessDate(page.request);
    const draftArrivalDate = addDays(businessDate, 7);
    const draftDepartureDate = addDays(businessDate, 11);
    await setBoardRange(page, addDays(businessDate, 4));
    await expect(page.getByText(/投影不完整/)).toHaveCount(0);

    const drawer = page.locator("dialog.room-status-write-drawer");
    const expandBeds = roomRow(page, "unit_room_102").getByRole("button", { name: /展开.*床位/ });
    await expandBeds.click();
    await expect(roomRow(page, "unit_room_102").getByRole("button", { name: /收起.*床位/ }))
      .toHaveAttribute("aria-expanded", "true");
    const startCell = roomCell(page, "unit_room_102_bed_b", draftArrivalDate);
    const endCell = roomCell(page, "unit_room_102_bed_b", addDays(draftDepartureDate, -1));
    await startCell.scrollIntoViewIfNeeded();
    const startBox = await startCell.boundingBox();
    const endBox = await endCell.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height - 8);
    await page.mouse.down();
    await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + endBox!.height - 8, { steps: 4 });
    await page.mouse.up();

    const rangePopover = page.getByTestId("room-status-quick-popover");
    await expect(rangePopover).toBeVisible();
    await expect(rangePopover).toHaveAttribute("data-unit-id", "unit_room_102_bed_b");
    await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
    await expect(rangePopover).toContainText("4晚");
    await rangePopover.getByRole("button", { name: "创建订单", exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("入住日期", { exact: true })).toHaveValue(draftArrivalDate);
    await expect(drawer.getByLabel("退房日期", { exact: true })).toHaveValue(draftDepartureDate);
    for (const action of ["创建正常住宿订单", "创建免费入住", "放置维修锁房"]) {
      await expect(drawer.getByRole("button", { name: action, exact: true })).toBeVisible();
      await expect(drawer.getByRole("button", { name: action, exact: true })).toBeEnabled();
    }
  });

  test("慢速修改 102 日期时自动收口中间报价并显示最终金额", async ({ page }, testInfo) => {
    await login(page);
    const businessDate = await roomStatusBusinessDate(page.request);
    const draftArrivalDate = addDays(businessDate, 7);
    const firstDepartureDate = addDays(businessDate, 9);
    const finalDepartureDate = addDays(businessDate, 13);
    await setBoardRange(page, addDays(businessDate, 4));

    let releaseFirstResponse!: () => void;
    let reportFirstResponseHeld!: () => void;
    const firstResponseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    const firstResponseHeld = new Promise<void>((resolve) => { reportFirstResponseHeld = resolve; });
    const quotePayloads: Array<Record<string, unknown>> = [];
    let held = false;
    await page.route("**/api/v1/quotes", async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      quotePayloads.push(payload);
      if (!held
        && payload.inventoryUnitId === "unit_room_102"
        && payload.arrivalDate === draftArrivalDate
        && payload.departureDate === firstDepartureDate) {
        held = true;
        const response = await route.fetch();
        reportFirstResponseHeld();
        await firstResponseGate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    const room102 = roomRow(page, "unit_room_102");
    await expect(room102).toContainText("整房/单床");
    await expect(room102.getByText("拆床销售", { exact: true })).toHaveCount(0);
    await room102.screenshot({ path: testInfo.outputPath("stage-1-room-102-sales-presentation.png") });
    await selectDraft(page, "unit_room_102", draftArrivalDate, firstDepartureDate);
    await firstResponseHeld;
    expect(quotePayloads.at(-1)).toEqual(expect.objectContaining({ inventoryUnitId: "unit_room_102" }));
    await page.getByLabel("退房日期", { exact: true }).fill(finalDepartureDate);
    const quoteRecovery = page.getByTestId("quote-recovery");
    if (await quoteRecovery.isVisible()) await expect(quoteRecovery).toContainText("报价正在提交");
    await expect(page.getByRole("button", { name: /查询.*结果/ })).toHaveCount(0);

    releaseFirstResponse();
    const quoteResult = page.getByTestId("quote-result");
    await expect(quoteResult).toContainText("6 晚", { timeout: 15_000 });
    await expect(quoteResult).toContainText("¥1,392");
    await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
    expect(quotePayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ inventoryUnitId: "unit_room_102", arrivalDate: draftArrivalDate, departureDate: firstDepartureDate }),
      expect.objectContaining({ inventoryUnitId: "unit_room_102", arrivalDate: draftArrivalDate, departureDate: finalDepartureDate })
    ]));
    await quoteResult.screenshot({ path: testInfo.outputPath("stage-1-slow-draft-quote-result.png") });
    await page.screenshot({ path: testInfo.outputPath("stage-1-slow-draft-auto-quote.png"), fullPage: true });
  });

  test("自动显示 104 十晚金额并对真实占用给出业务冲突", async ({ page }, testInfo) => {
    const quotePayloads: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/quotes")) {
        quotePayloads.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await login(page);
    const businessDate = await roomStatusBusinessDate(page.request);
    const displayDate = addDays(businessDate, 7);
    const longStayDepartureDate = addDays(businessDate, 17);
    await setBoardRange(page, addDays(businessDate, 4));

    for (const [unitId, location] of [
      ["unit_room_d_gen_01", "D栋 D01"],
      ["unit_room_d_gen_05", "D栋 D05"],
      ["unit_room_e_gen_01", "E栋 E01"],
      ["unit_room_e_gen_03", "E栋 E03"]
    ] as const) {
      await expect(roomRow(page, unitId)).toContainText(location);
    }
    const room302 = roomRow(page, "unit_room_302");
    await expect(room302).toContainText("3栋 302");
    await expect(room302).toContainText("单人间（公卫）");
    await expect(page.getByText(/D-GEN-|E-GEN-/)).toHaveCount(0);

    const room302Cell = roomCell(page, "unit_room_302", displayDate);
    await room302Cell.scrollIntoViewIfNeeded();
    await room302Cell.focus();
    await page.keyboard.press("Enter");
    const room302Popover = page.getByTestId("room-status-quick-popover");
    await expect(room302Popover).toBeVisible();
    await expect(room302Popover).toHaveAttribute("data-unit-id", "unit_room_302");
    await expect(room302Popover).toContainText("3栋 302 单人间（公卫）");
    await room302Popover.screenshot({ path: testInfo.outputPath("stage-1-room-302-display-name.png") });
    await page.keyboard.press("Escape");

    await selectDraft(page, "unit_room_104", displayDate, longStayDepartureDate);
    const quoteResult = page.getByTestId("quote-result");
    await expect(quoteResult).toBeVisible({ timeout: 15_000 });
    await expect(quoteResult).toContainText("10 晚");
    await expect(quoteResult).toContainText("按 7 夜价格档");
    await expect(quoteResult).toContainText("¥1,760");
    await expect(page.getByRole("button", { name: "应用选区", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "清除选区", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "获取服务端报价", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("住宿类型")).toHaveCount(0);
    expect(quotePayloads.at(-1)).not.toHaveProperty("stayType");
    const settledQuoteCount = quotePayloads.length;
    await page.waitForTimeout(1_000);
    expect(quotePayloads).toHaveLength(settledQuoteCount);

    const fixtureArrivalDate = addDays(businessDate, 20);
    const fixtureDepartureDate = addDays(businessDate, 22);
    const conflictArrivalDate = addDays(businessDate, 21);
    const conflictDepartureDate = addDays(businessDate, 23);
    await createOccupiedFixture(page.request, fixtureArrivalDate, fixtureDepartureDate);
    const beforeOrders = await page.request.get("/api/v1/orders?propertyId=prop_qintopia_demo");
    const beforeCount = (await beforeOrders.json()).orders.length as number;
    await selectDraft(page, "unit_room_109", addDays(businessDate, 23), addDays(businessDate, 24));
    await page.getByLabel("入住日期", { exact: true }).fill(conflictArrivalDate);
    await page.getByLabel("退房日期", { exact: true }).fill(conflictDepartureDate);
    await expect(page.getByText("正常订单 已有住宿，不能重复安排", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${formatMonthDay(fixtureArrivalDate)}至${formatMonthDay(fixtureDepartureDate)}`, { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/Claim|conflict|阻断|unit_room_/i);
    await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
    const afterOrders = await page.request.get("/api/v1/orders?propertyId=prop_qintopia_demo");
    expect((await afterOrders.json()).orders).toHaveLength(beforeCount);

    await page.screenshot({ path: testInfo.outputPath("stage-1-auto-quote.png"), fullPage: true });
  });

  test("横向拖选锁定起始房间行且不受纵向指针漂移影响", async ({ page }, testInfo) => {
    await login(page);
    await setBoardRange(page, "2026-07-23");

    const startCell = roomCell(page, "unit_room_102", "2026-07-26");
    const endCell = roomCell(page, "unit_room_102", "2026-07-29");
    const adjacentCell = roomCell(page, "unit_room_103", "2026-07-29");
    const sourceRow = startCell.locator("xpath=ancestor::*[@data-room-status-row][1]");
    await startCell.scrollIntoViewIfNeeded();
    const startBox = await startCell.boundingBox();
    const endBox = await endCell.boundingBox();
    const adjacentBox = await adjacentCell.boundingBox();
    const rowBoxBefore = await sourceRow.boundingBox();
    expect(startBox).not.toBeNull();
    expect(endBox).not.toBeNull();
    expect(adjacentBox).not.toBeNull();
    expect(rowBoxBefore).not.toBeNull();

    await startCell.hover({ position: { x: startBox!.width / 2, y: startBox!.height - 8 } });
    await page.mouse.down();
    await expect(sourceRow).toHaveClass(/is-drag-source-row/);
    await page.mouse.move(
      endBox!.x + endBox!.width / 2,
      adjacentBox!.y + adjacentBox!.height - 8,
      { steps: 1 }
    );

    await expect(page.getByTestId("room-status-quick-popover")).toBeHidden();
    await expect(page.locator("dialog.room-status-write-drawer")).toBeHidden();
    await expect(roomCell(page, "unit_room_102", "2026-07-29")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`[data-room-status-cell="true"][data-unit-id="unit_room_103"][aria-selected="true"]`)).toHaveCount(0);
    const rowBoxDuring = await sourceRow.boundingBox();
    expect(rowBoxDuring?.y).toBe(rowBoxBefore!.y);
    expect(rowBoxDuring?.height).toBe(rowBoxBefore!.height);

    await page.mouse.up();
    await expect(sourceRow).not.toHaveClass(/is-drag-source-row/);
    const rangePopover = page.getByTestId("room-status-quick-popover");
    await expect(rangePopover).toBeVisible();
    await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
    await expect(rangePopover).toContainText("4晚");
    const rowBoxAfter = await sourceRow.boundingBox();
    expect(rowBoxAfter?.y).toBe(rowBoxBefore!.y);
    expect(rowBoxAfter?.height).toBe(rowBoxBefore!.height);
    await page.screenshot({ path: testInfo.outputPath("stage-1-drag-locked-to-source-row.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(rangePopover).toBeHidden();

    await startCell.hover({ position: { x: startBox!.width / 2, y: startBox!.height - 8 } });
    await page.mouse.down();
    await expect(sourceRow).toHaveClass(/is-drag-source-row/);
    await page.keyboard.press("Escape");
    await expect(sourceRow).not.toHaveClass(/is-drag-source-row/);
    await expect(page.locator('[data-room-status-cell="true"][aria-selected="true"]')).toHaveCount(0);
    await page.mouse.move(endBox!.x + endBox!.width / 2, adjacentBox!.y + adjacentBox!.height - 8);
    await expect(page.locator('[data-room-status-cell="true"][aria-selected="true"]')).toHaveCount(0);
    await page.mouse.up();

    await page.evaluate(() => {
      document.addEventListener("pointerdown", (event) => {
        (window as typeof window & { __activePointerId: number }).__activePointerId = event.pointerId;
      }, { once: true });
    });
    await startCell.hover({ position: { x: startBox!.width / 2, y: startBox!.height - 8 } });
    await page.mouse.down();
    await expect(sourceRow).toHaveClass(/is-drag-source-row/);
    const activePointerId = await page.evaluate(() => (window as typeof window & { __activePointerId: number }).__activePointerId);
    await startCell.dispatchEvent("lostpointercapture", { pointerId: activePointerId });
    await expect(sourceRow).not.toHaveClass(/is-drag-source-row/);
    await expect(page.locator('[data-room-status-cell="true"][aria-selected="true"]')).toHaveCount(0);
    await page.mouse.move(endBox!.x + endBox!.width / 2, adjacentBox!.y + adjacentBox!.height - 8);
    await expect(page.locator('[data-room-status-cell="true"][aria-selected="true"]')).toHaveCount(0);
    await page.mouse.up();
  });

  test("连续拖选日期时不发送中间报价并在选择动作后显示最终报价", async ({ page }, testInfo) => {
    const quotePayloads: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/quotes")) {
        quotePayloads.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await login(page);
    const businessDate = await roomStatusBusinessDate(page.request);
    const draftArrivalDate = addDays(businessDate, 7);
    const draftDepartureDate = addDays(businessDate, 11);
    await setBoardRange(page, addDays(businessDate, 4));
    expect(quotePayloads).toHaveLength(0);

    const startCell = roomCell(page, "unit_room_102", draftArrivalDate);
    await startCell.scrollIntoViewIfNeeded();
    const stableLayoutBefore = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
      if (!grid) throw new Error("房态网格不存在");
      const box = grid.getBoundingClientRect();
      return {
        windowY: window.scrollY,
        gridTop: box.top,
        gridHeight: box.height,
        gridTopScroll: grid.scrollTop,
        clientHeight: grid.clientHeight,
        scrollHeight: grid.scrollHeight
      };
    });
    const startBox = await startCell.boundingBox();
    expect(startBox).not.toBeNull();
    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
    await page.mouse.down();
    for (const date of [1, 2, 3].map((days) => addDays(draftArrivalDate, days))) {
      const cell = roomCell(page, "unit_room_102", date);
      const box = await cell.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 3 });
      await page.waitForTimeout(420);
      expect(quotePayloads).toHaveLength(0);
      expect(await page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".room-status-grid-scroll");
        if (!grid) throw new Error("房态网格不存在");
        const bounds = grid.getBoundingClientRect();
        return {
          windowY: window.scrollY,
          gridTop: bounds.top,
          gridHeight: bounds.height,
          gridTopScroll: grid.scrollTop,
          clientHeight: grid.clientHeight,
          scrollHeight: grid.scrollHeight
        };
      })).toEqual(stableLayoutBefore);
    }
    await page.mouse.up();
    const rangePopover = page.getByTestId("room-status-quick-popover");
    await expect(rangePopover).toBeVisible();
    await expect(rangePopover).toHaveAttribute("data-selection-kind", "range");
    await expect(rangePopover).toContainText("4晚");
    expect(quotePayloads).toHaveLength(0);
    await rangePopover.getByRole("button", { name: "创建订单", exact: true }).click();
    await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(draftArrivalDate);
    await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(draftDepartureDate);
    await expect(page.getByTestId("quote-result")).toContainText("4 晚", { timeout: 15_000 });
    await expect(page.getByTestId("quote-result")).toContainText("¥928");
    expect(quotePayloads).toHaveLength(1);
    expect(quotePayloads[0]).toEqual(expect.objectContaining({
      inventoryUnitId: "unit_room_102",
      arrivalDate: draftArrivalDate,
      departureDate: draftDepartureDate
    }));
    await page.screenshot({ path: testInfo.outputPath("stage-1-stable-grid-during-drag.png"), fullPage: true });
  });

  test("当前报价不闪恢复门禁，抽屉关闭后进入恢复且自动核对失败只执行一次", async ({ page }) => {
    await login(page);
    const propertyId = "prop_qintopia_demo";
    const storageKey = "qintopia.quote-command-recovery.v1:subject_demo_operator:prop_qintopia_demo";
    const storageMarkerKey = `qintopia.recovery-coordination.v1:${encodeURIComponent(storageKey)}`;
    const probe = await page.request.get(
      `/api/v1/properties/${propertyId}/room-status?arrivalDate=2026-01-01&departureDate=2026-01-31&page=0&pageSize=50`
    );
    expect(probe.ok(), await probe.text()).toBe(true);
    const { businessDate } = await probe.json() as Pick<RoomStatusFixtureBoard, "businessDate">;
    const scenarios = [
      {
        name: "历史补录",
        arrivalDate: addDays(businessDate, -3),
        departureDate: addDays(businessDate, -2),
        actionCode: "BACKFILL_ORDER" as const,
        actionLabel: "补录住宿"
      },
      {
        name: "跨今天补录",
        arrivalDate: addDays(businessDate, -2),
        departureDate: addDays(businessDate, 2),
        actionCode: "BACKFILL_ORDER" as const,
        actionLabel: "补录住宿"
      },
      {
        name: "未来预订",
        arrivalDate: addDays(businessDate, 7),
        departureDate: addDays(businessDate, 8),
        actionCode: "CREATE_ORDER" as const,
        actionLabel: "创建订单"
      }
    ];
    let recoveryResolveCalls = 0;
    let failRecoveryResolve = true;
    let quoteRequestCalls = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/quotes")) quoteRequestCalls += 1;
    });
    await page.route("**/api/v1/command-results/resolve", async (route) => {
      recoveryResolveCalls += 1;
      if (failRecoveryResolve) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "RECOVERY_CHECK_UNAVAILABLE", message: "模拟恢复查询失败" })
        });
        return;
      }
      await route.continue();
    });

    for (const scenario of scenarios) {
      const callsBeforeScenario = recoveryResolveCalls;
      const quoteCallsBeforeScenario = quoteRequestCalls;
      failRecoveryResolve = true;
      const board = await setBoardRange(page, scenario.arrivalDate);
      const unit = recoveryQuoteCandidate(board, scenario.arrivalDate, scenario.departureDate, scenario.actionCode);
      expect(unit, `${scenario.name}需要一个可报价房源`).toBeDefined();
      if (!unit) throw new Error(`${scenario.name}缺少可报价房源`);

      let releaseQuoteResponse!: () => void;
      let quoteResponseHeld!: () => void;
      let quoteResponseSettled!: () => void;
      const quoteResponseGate = new Promise<void>((resolve) => { releaseQuoteResponse = resolve; });
      const quoteResponseHeldGate = new Promise<void>((resolve) => { quoteResponseHeld = resolve; });
      const quoteResponseSettledGate = new Promise<void>((resolve) => { quoteResponseSettled = resolve; });
      await page.route("**/api/v1/quotes", async (route) => {
        quoteResponseHeld();
        await quoteResponseGate;
        const response = await route.fetch();
        await route.fulfill({ response });
        quoteResponseSettled();
      }, { times: 1 });

      const cell = roomCell(page, unit.id, scenario.arrivalDate);
      await cell.scrollIntoViewIfNeeded();
      if (scenario.departureDate === addDays(scenario.arrivalDate, 1)) {
        await cell.focus();
        await page.keyboard.press("Enter");
      } else {
        const lastNightCell = roomCell(page, unit.id, addDays(scenario.departureDate, -1));
        const startBox = await cell.boundingBox();
        const endBox = await lastNightCell.boundingBox();
        expect(startBox).not.toBeNull();
        expect(endBox).not.toBeNull();
        await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
        await page.mouse.down();
        await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + endBox!.height / 2, { steps: 4 });
        await page.mouse.up();
      }
      const popover = page.getByTestId("room-status-quick-popover");
      await expect(popover).toBeVisible();
      await page.evaluate(() => {
        const trackedWindow = window as typeof window & { __roomStatusQuoteFlashObserver?: MutationObserver };
        trackedWindow.__roomStatusQuoteFlashObserver?.disconnect();
        const root = document.documentElement;
        root.dataset.quotePageRecoverySeen = "false";
        root.dataset.quoteActionGateSeen = "false";
        root.dataset.quoteWorkbenchRecoverySeen = "false";
        const captureTransientRecoveryUi = () => {
          if (document.querySelector('[data-testid="inventory-quote-recovery-entry"]')) {
            root.dataset.quotePageRecoverySeen = "true";
          }
          if (document.querySelector(".room-status-action-gate")) {
            root.dataset.quoteActionGateSeen = "true";
          }
          if (document.querySelector('[data-testid="quote-recovery"]')) {
            root.dataset.quoteWorkbenchRecoverySeen = "true";
          }
        };
        const observer = new MutationObserver(captureTransientRecoveryUi);
        observer.observe(document.body, { childList: true, subtree: true });
        trackedWindow.__roomStatusQuoteFlashObserver = observer;
        captureTransientRecoveryUi();
      });
      await popover.getByRole("button", { name: scenario.actionLabel, exact: true }).click();
      const drawer = page.locator("dialog.room-status-write-drawer");
      await expect(drawer).toBeVisible();
      await drawer.evaluate(
        (element, name) => element.setAttribute("data-recovery-test-instance", name),
        scenario.name
      );
      await quoteResponseHeldGate;

      const entry = page.getByTestId("inventory-quote-recovery-entry");
      await expect(entry).toBeHidden();
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute("data-recovery-test-instance", scenario.name);
      await expect(drawer).toHaveAccessibleName(scenario.actionLabel);
      await expect(drawer.getByTestId("quote-recovery")).toHaveCount(0);
      await expect(drawer.locator(".room-status-pricing-progress")).toHaveText("报价正在提交");
      await expect(drawer.locator(".room-status-action-gate")).toHaveCount(0);
      await expect(drawer.locator(".room-status-context")).toHaveCount(1);
      await expect(drawer.getByRole("heading", { name: "日期选区", exact: true })).toBeVisible();
      await expect(drawer.getByRole("heading", { name: "可执行操作", exact: true })).toBeVisible();
      await expect(page.locator("dialog.room-status-view-drawer")).toHaveCount(0);
      expect(await page.evaluate(() => {
        const trackedWindow = window as typeof window & { __roomStatusQuoteFlashObserver?: MutationObserver };
        trackedWindow.__roomStatusQuoteFlashObserver?.disconnect();
        return {
          pageRecovery: document.documentElement.dataset.quotePageRecoverySeen,
          actionGate: document.documentElement.dataset.quoteActionGateSeen,
          workbenchRecovery: document.documentElement.dataset.quoteWorkbenchRecoverySeen
        };
      })).toEqual({
        pageRecovery: "false",
        actionGate: "false",
        workbenchRecovery: "false"
      });
      await drawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(entry).toBeVisible();
      expect(recoveryResolveCalls).toBe(callsBeforeScenario);

      const pollResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET"
          && url.pathname.endsWith("/room-status")
          && url.searchParams.get("arrivalDate") === scenario.arrivalDate
          && response.ok();
      }, { timeout: 10_000 });

      await cell.focus();
      await page.keyboard.press("Enter");
      await expect(popover).toBeVisible();
      const blockedAction = popover.getByRole("button", { name: scenario.actionLabel, exact: true });
      await expect(blockedAction).toBeDisabled();
      await page.waitForTimeout(350);
      expect(quoteRequestCalls).toBe(quoteCallsBeforeScenario + 1);
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();

      await pollResponse;
      await expect(drawer).toBeHidden();

      await page.evaluate(({ key }) => {
        window.dispatchEvent(new CustomEvent("qintopia:recovery-storage-sync", {
          detail: { storageKey: key }
        }));
      }, { key: storageKey });
      await page.waitForTimeout(700);
      await expect(drawer).toBeHidden();

      await entry.getByRole("button", { name: "打开处理入口", exact: true }).click();
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAccessibleName("报价恢复");
      await expect(drawer.locator(".room-status-context")).toHaveCount(0);
      await expect(drawer.getByRole("heading", { name: "日期选区", exact: true })).toHaveCount(0);
      await expect(drawer.getByRole("heading", { name: "可执行操作", exact: true })).toHaveCount(0);
      await expect.poll(async () => await page.evaluate(({ key }) => {
        const value = window.localStorage.getItem(key);
        return value ? (JSON.parse(value) as { state?: string }).state : undefined;
      }, { key: storageKey })).toBe("UNKNOWN");
      expect(recoveryResolveCalls).toBe(callsBeforeScenario + 1);
      await expect(drawer.getByTestId("quote-recovery")).toContainText("报价结果尚未确认");
      await expect(drawer.getByRole("button", { name: "核对原报价结果", exact: true })).toBeVisible();

      for (let sync = 0; sync < 3; sync += 1) {
        await page.evaluate(({ key }) => {
          window.dispatchEvent(new CustomEvent("qintopia:recovery-storage-sync", {
            detail: { storageKey: key }
          }));
        }, { key: storageKey });
      }
      await page.waitForTimeout(700);
      expect(recoveryResolveCalls).toBe(callsBeforeScenario + 1);

      failRecoveryResolve = false;
      releaseQuoteResponse();
      await quoteResponseSettledGate;
      await drawer.getByRole("button", { name: "核对原报价结果", exact: true }).click();
      await expect(entry).toBeHidden();
      await expect(drawer.getByTestId("quote-result")).toBeVisible({ timeout: 15_000 });
      expect(recoveryResolveCalls).toBe(callsBeforeScenario + 2);
      expect(quoteRequestCalls).toBe(quoteCallsBeforeScenario + 1);

      await expect.poll(async () => await page.evaluate(({ key }) => (
        window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key)
      ), { key: storageKey })).toBeNull();
      await page.evaluate(({ key, markerKey }) => {
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
        window.localStorage.removeItem(markerKey);
        window.dispatchEvent(new CustomEvent("qintopia:recovery-storage-sync", {
          detail: { storageKey: key }
        }));
      }, { key: storageKey, markerKey: storageMarkerKey });
      await drawer.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
      await expect(drawer).toBeHidden();
    }
  });
});
