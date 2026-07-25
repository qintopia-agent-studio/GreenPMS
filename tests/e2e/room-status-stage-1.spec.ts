import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房态与可售" })).toBeVisible();
}

async function setBoardRange(page: Page, arrivalDate: string, departureDate: string) {
  await page.getByTestId("arrival-date").fill(arrivalDate);
  await page.getByTestId("departure-date").fill(departureDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 15_000 });
}

async function selectDraft(page: Page, unitId: string, arrivalDate: string, departureDate: string) {
  const unitSelect = page.getByTestId("room-status-unit-select");
  await unitSelect.selectOption(unitId);
  await page.getByLabel("入住日期", { exact: true }).fill(arrivalDate);
  await page.getByLabel("退房日期", { exact: true }).fill(departureDate);
}

function roomCell(page: Page, unitId: string, serviceDate: string) {
  return page.locator(
    `[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${serviceDate}"]`
  );
}

async function commandHeaders(scope: string) {
  return {
    "Idempotency-Key": `stage-1-${scope}`,
    "X-Correlation-ID": `stage-1-${scope}`
  };
}

async function createOccupiedFixture(request: APIRequestContext) {
  const quote = await request.post("/api/v1/quotes", {
    headers: await commandHeaders("fixture-quote"),
    data: {
      propertyId: "prop_qintopia_demo",
      inventoryUnitId: "unit_room_109",
      arrivalDate: "2026-08-10",
      departureDate: "2026-08-12",
      pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1"
    }
  });
  expect(quote.ok(), await quote.text()).toBe(true);
  const quoteId = (await quote.json()).quote.quoteId as string;
  const preview = await request.post("/api/v1/command-previews", {
    headers: await commandHeaders("fixture-preview"),
    data: {
      commandType: "CREATE_ORDER",
      input: {
        propertyId: "prop_qintopia_demo",
        quoteId,
        primaryGuest: { fullName: "阶段一冲突夹具", nickname: "冲突夹具" },
        bookingChannelCode: "WECOM",
        channelOrderReference: null
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
      reason: { code: "CREATE_STANDARD_ORDER", note: "阶段一占用冲突夹具" }
    }
  });
  expect(confirm.ok(), await confirm.text()).toBe(true);
}

test.describe("第 1 步 / 阶段 1 自动报价", () => {
  test.skip(({ isMobile }) => isMobile, "阶段 1 人工停点使用桌面房态；移动完整旅程在发布阶段验收");

  test("慢速修改 102 日期时自动收口中间报价并显示最终金额", async ({ page }, testInfo) => {
    await login(page);
    await setBoardRange(page, "2026-07-23", "2026-08-15");

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
        && payload.arrivalDate === "2026-07-26"
        && payload.departureDate === "2026-07-28") {
        held = true;
        const response = await route.fetch();
        reportFirstResponseHeld();
        await firstResponseGate;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    await selectDraft(page, "unit_room_102", "2026-07-26", "2026-07-28");
    await firstResponseHeld;
    const inventorySection = page.getByRole("heading", { name: "库存单元" }).locator("..").locator("..");
    await expect(inventorySection.getByText("整房销售", { exact: true })).toBeVisible();
    await expect(inventorySection.getByText("支持整房及单床销售", { exact: true })).toBeVisible();
    await expect(inventorySection.getByText("拆床销售", { exact: true })).toHaveCount(0);
    expect(quotePayloads.at(-1)).toEqual(expect.objectContaining({ inventoryUnitId: "unit_room_102" }));
    await inventorySection.screenshot({ path: testInfo.outputPath("stage-1-room-102-sales-presentation.png") });
    await page.getByLabel("退房日期", { exact: true }).fill("2026-08-01");
    await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /查询.*结果/ })).toHaveCount(0);

    releaseFirstResponse();
    const quoteResult = page.getByTestId("quote-result");
    await expect(quoteResult).toContainText("6 晚", { timeout: 15_000 });
    await expect(quoteResult).toContainText("¥1,392");
    await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
    expect(quotePayloads).toEqual(expect.arrayContaining([
      expect.objectContaining({ inventoryUnitId: "unit_room_102", arrivalDate: "2026-07-26", departureDate: "2026-07-28" }),
      expect.objectContaining({ inventoryUnitId: "unit_room_102", arrivalDate: "2026-07-26", departureDate: "2026-08-01" })
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
    await setBoardRange(page, "2026-07-23", "2026-08-15");

    const options = page.getByTestId("room-status-unit-select").locator("option");
    await expect(options.filter({ hasText: /^D栋 D01 / })).toHaveCount(1);
    await expect(options.filter({ hasText: /^D栋 D05 / })).toHaveCount(1);
    await expect(options.filter({ hasText: /^E栋 E01 / })).toHaveCount(1);
    await expect(options.filter({ hasText: /^E栋 E03 / })).toHaveCount(1);
    await expect(options.filter({ hasText: /^3栋 302 单人间（公卫）（房间）$/ })).toHaveCount(1);
    await expect(options.filter({ hasText: /^302 · 302/ })).toHaveCount(0);
    await expect(options.filter({ hasText: /D-GEN-|E-GEN-/ })).toHaveCount(0);

    await page.getByTestId("room-status-unit-select").selectOption("unit_room_302");
    const inventorySection = page.getByRole("heading", { name: "库存单元" }).locator("..").locator("..");
    await expect(inventorySection.getByText("3栋 302 单人间（公卫）", { exact: true })).toBeVisible();
    await expect(page.getByText(/^302 · 302/)).toHaveCount(0);
    await inventorySection.screenshot({ path: testInfo.outputPath("stage-1-room-302-display-name.png") });

    await selectDraft(page, "unit_room_104", "2026-07-26", "2026-08-05");
    const quoteResult = page.getByTestId("quote-result");
    await expect(quoteResult).toBeVisible({ timeout: 15_000 });
    await expect(quoteResult).toContainText("10 晚");
    await expect(quoteResult).toContainText("按 7 夜价格档");
    await expect(quoteResult).toContainText("¥1,086");
    await expect(page.getByRole("button", { name: "应用选区", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "清除选区", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "获取服务端报价", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("住宿类型")).toHaveCount(0);
    expect(quotePayloads.at(-1)).not.toHaveProperty("stayType");
    const settledQuoteCount = quotePayloads.length;
    await page.waitForTimeout(1_000);
    expect(quotePayloads).toHaveLength(settledQuoteCount);

    await createOccupiedFixture(page.request);
    const beforeOrders = await page.request.get("/api/v1/orders?propertyId=prop_qintopia_demo");
    const beforeCount = (await beforeOrders.json()).orders.length as number;
    await selectDraft(page, "unit_room_109", "2026-08-11", "2026-08-13");
    await expect(page.getByText("109 在 2026-08-11 至 2026-08-12 已有住宿，不能重复安排", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("main")).not.toContainText(/Claim|conflict|阻断|unit_room_/i);
    await expect(page.getByTestId("quote-recovery")).toHaveCount(0);
    const afterOrders = await page.request.get("/api/v1/orders?propertyId=prop_qintopia_demo");
    expect((await afterOrders.json()).orders).toHaveLength(beforeCount);

    await page.screenshot({ path: testInfo.outputPath("stage-1-auto-quote.png"), fullPage: true });
  });

  test("横向拖选锁定起始房间行且不受纵向指针漂移影响", async ({ page }, testInfo) => {
    await login(page);
    await setBoardRange(page, "2026-07-23", "2026-08-15");

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
    const arrivalBeforeDrag = await page.getByLabel("入住日期", { exact: true }).inputValue();
    const departureBeforeDrag = await page.getByLabel("退房日期", { exact: true }).inputValue();

    await startCell.hover({ position: { x: startBox!.width / 2, y: startBox!.height - 8 } });
    await page.mouse.down();
    await expect(sourceRow).toHaveClass(/is-drag-source-row/);
    await page.mouse.move(
      endBox!.x + endBox!.width / 2,
      adjacentBox!.y + adjacentBox!.height - 8,
      { steps: 1 }
    );

    await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue(arrivalBeforeDrag);
    await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue(departureBeforeDrag);
    await expect(roomCell(page, "unit_room_102", "2026-07-29")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`[data-room-status-cell="true"][data-unit-id="unit_room_103"][aria-selected="true"]`)).toHaveCount(0);
    const rowBoxDuring = await sourceRow.boundingBox();
    expect(rowBoxDuring?.y).toBe(rowBoxBefore!.y);
    expect(rowBoxDuring?.height).toBe(rowBoxBefore!.height);

    await page.mouse.up();
    await expect(sourceRow).not.toHaveClass(/is-drag-source-row/);
    await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue("2026-07-26");
    await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue("2026-07-30");
    const rowBoxAfter = await sourceRow.boundingBox();
    expect(rowBoxAfter?.y).toBe(rowBoxBefore!.y);
    expect(rowBoxAfter?.height).toBe(rowBoxBefore!.height);
    await expect(page.getByTestId("quote-result")).toContainText("4 晚", { timeout: 15_000 });
    await page.screenshot({ path: testInfo.outputPath("stage-1-drag-locked-to-source-row.png"), fullPage: true });

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

  test("连续拖选日期时右侧滚动容器保持稳定并显示最终报价", async ({ page }, testInfo) => {
    const quotePayloads: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/quotes")) {
        quotePayloads.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await login(page);
    await setBoardRange(page, "2026-07-23", "2026-08-15");
    await selectDraft(page, "unit_room_102", "2026-07-26", "2026-07-28");
    await expect(page.getByTestId("quote-result")).toContainText("2 晚", { timeout: 15_000 });
    expect(quotePayloads).toHaveLength(1);

    const sideColumn = page.locator(".room-status-side-column");
    await sideColumn.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>(".room-status-side-column");
      if (!element) throw new Error("找不到右侧滚动容器");
      const samples: Array<{ scrollTop: number; clientHeight: number; scrollHeight: number; position: number }> = [];
      let sampling = true;
      const sample = () => {
        const maxScrollTop = element.scrollHeight - element.clientHeight;
        samples.push({
          scrollTop: element.scrollTop,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          position: maxScrollTop > 0 ? element.scrollTop / maxScrollTop : 0
        });
        if (sampling) requestAnimationFrame(sample);
      };
      (window as typeof window & {
        __sideColumnSamples: typeof samples;
        __stopSideColumnSampling: () => void;
      }).__sideColumnSamples = samples;
      (window as typeof window & {
        __sideColumnSamples: typeof samples;
        __stopSideColumnSampling: () => void;
      }).__stopSideColumnSampling = () => { sampling = false; };
      requestAnimationFrame(sample);
    });

    const startCell = roomCell(page, "unit_room_102", "2026-07-26");
    await startCell.scrollIntoViewIfNeeded();
    const startBox = await startCell.boundingBox();
    expect(startBox).not.toBeNull();
    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + startBox!.height / 2);
    await page.mouse.down();
    for (const date of ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]) {
      const cell = roomCell(page, "unit_room_102", date);
      const box = await cell.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 3 });
      await page.waitForTimeout(420);
      expect(quotePayloads).toHaveLength(1);
    }
    await page.mouse.up();

    await expect(page.getByLabel("入住日期", { exact: true })).toHaveValue("2026-07-26");
    await expect(page.getByLabel("退房日期", { exact: true })).toHaveValue("2026-08-01");
    await expect(page.getByTestId("quote-result")).toContainText("6 晚", { timeout: 15_000 });
    await expect(page.getByTestId("quote-result")).toContainText("¥1,392");
    expect(quotePayloads).toHaveLength(2);
    expect(quotePayloads[1]).toEqual(expect.objectContaining({
      inventoryUnitId: "unit_room_102",
      arrivalDate: "2026-07-26",
      departureDate: "2026-08-01"
    }));
    await page.evaluate(() => (window as typeof window & { __stopSideColumnSampling: () => void }).__stopSideColumnSampling());
    await page.waitForTimeout(50);

    const samples = await page.evaluate(() => (window as typeof window & {
      __sideColumnSamples: Array<{ scrollTop: number; clientHeight: number; scrollHeight: number; position: number }>;
    }).__sideColumnSamples);
    expect(samples.length).toBeGreaterThan(20);
    expect(new Set(samples.map((sample) => sample.clientHeight))).toEqual(new Set([samples[0]!.clientHeight]));
    expect(new Set(samples.map((sample) => sample.scrollHeight))).toEqual(new Set([samples[0]!.scrollHeight]));
    expect(new Set(samples.map((sample) => sample.scrollTop))).toEqual(new Set([samples[0]!.scrollTop]));
    expect(samples.every((sample) => sample.position === samples[0]!.position)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("stage-1-stable-side-column-during-drag.png"), fullPage: true });
  });
});
