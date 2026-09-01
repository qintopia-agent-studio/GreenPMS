import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  prepareStage11Acceptance,
  prepareStage11MobileAcceptance,
  type Stage11AcceptanceFixture,
  type Stage11MobileAcceptanceFixture,
  type Stage11MoveFixture,
  type Stage11SchemeFixture,
  type Stage11StayFixture
} from "./setup-stage11-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const forbiddenProtocol = /Preview|Confirm|Receipt|Command|MOVE_UNIT|(?:order|stay|segment|amendment|revision|claim|coverage|fact)_[a-z0-9_-]+/i;
let fixture: Stage11AcceptanceFixture;
let mobileFixture: Stage11MobileAcceptanceFixture;

test.describe.configure({ mode: "serial" });

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile";
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function login(page: Page): Promise<void> {
  const active = mobileFixture ?? fixture;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(active.operator.username);
  await page.getByTestId("login-password").fill(active.operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
}

async function openOrder(page: Page, stay: Stage11StayFixture): Promise<void> {
  await page.goto(`/orders/${encodeURIComponent(stay.orderId)}`);
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function getOrderView(page: Page, stay: Stage11StayFixture) {
  const response = await page.request.get(`/api/v1/orders/${encodeURIComponent(stay.orderId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    order: { status: string; arrival_date: string; departure_date: string; version: number };
    stay: { status: string };
    effectiveArrangement: {
      arrivalDate: string;
      departureDate: string;
      intervals: Array<{ inventoryUnitId: string; arrivalDate: string; departureDate: string }>;
    };
    arrangementHistory: Array<{ type: string }>;
    pricingRevisions: Array<{ current_contract_amount_minor: number; policy_base_amount_minor: number; pricing_basis: string }>;
    coverageSet: Array<{ inventory_unit_id: string; service_date: string; status: string }>;
    collectionFacts: Array<Record<string, unknown>>;
    amounts: { currentContractAmount: { minorUnits: number }; netRecordedCollection: { minorUnits: number } };
  }>;
}

async function repriceOrder(page: Page, stay: Stage11StayFixture, targetCurrentContractAmountMinor: number): Promise<void> {
  const nonce = `stage11-wecom-reprice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previewResponse = await page.request.post("/api/v1/command-previews", {
    headers: { "Idempotency-Key": `${nonce}-preview`, "X-Correlation-ID": nonce },
    data: {
      commandType: "REPRICE_ORDER",
      input: { propertyId, orderId: stay.orderId, targetCurrentContractAmountMinor }
    }
  });
  if (!previewResponse.ok()) throw new Error(`WECOM repricing Preview failed: ${previewResponse.status()} ${await previewResponse.text()}`);
  const prepared = await previewResponse.json() as { preview: { previewId: string; effectHash: string } };
  const confirmResponse = await page.request.post(`/api/v1/command-previews/${prepared.preview.previewId}/confirm`, {
    headers: { "Idempotency-Key": `${nonce}-confirm`, "X-Correlation-ID": nonce },
    data: {
      propertyId,
      commandType: "REPRICE_ORDER",
      confirmation: true,
      expectedEffectHash: prepared.preview.effectHash,
      reason: { code: "STAGE11_WECOM_OLD_PRICE", note: "换房前已有企业微信人工偏价" }
    }
  });
  if (!confirmResponse.ok()) throw new Error(`WECOM repricing Confirm failed: ${confirmResponse.status()} ${await confirmResponse.text()}`);
}

async function fillMoveDraft(page: Page, stay: Stage11MoveFixture): Promise<Locator> {
  await page.getByRole("button", { name: "换房", exact: true }).click();
  return fillOpenMoveDrawer(page, stay);
}

async function fillOpenMoveDrawer(page: Page, stay: Stage11MoveFixture): Promise<Locator> {
  const drawer = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toContainText(forbiddenProtocol);
  await expect(drawer.getByTestId("move-unit-order-context")).toContainText(stay.nickname);
  await drawer.getByTestId("move-effective-date").fill(stay.effectiveDate);
  await drawer.getByTestId("move-unit-target-search").fill(stay.target.code);
  await expect(drawer.getByTestId("move-unit-id")).not.toContainText(/产品\s|shared_bath|private_bath|_room|_bed/i);
  await drawer.getByTestId("move-unit-id").selectOption(stay.target.id);
  await expect(drawer.getByTestId("move-unit-target-status")).toContainText(
    /目标区间可用|目标区间已有占用/,
    { timeout: 30_000 }
  );
  await drawer.getByTestId("move-unit-reason").fill("住客确认更换住宿房源");
  return drawer;
}

async function showStayRange(page: Page, stay: Stage11StayFixture): Promise<void> {
  await page.goto("/");
  await page.getByTestId("arrival-date").fill(stay.arrivalDate);
  await expect(page.getByTestId("room-status-range-loading")).toBeHidden({ timeout: 30_000 });
}

async function openMoveFromRoomStatus(page: Page, stay: Stage11MoveFixture): Promise<{ cell: Locator; context: Locator; drawer: Locator }> {
  await showStayRange(page, stay);
  let cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.source.id}"][data-service-date="${stay.arrivalDate}"]`);
  if (await cell.count() === 0 && stay.source.kind === "BED") {
    const roomCode = stay.source.code.split("-")[0]!;
    await page.getByRole("button", { name: new RegExp(`^展开.*${roomCode}.*床位$`) }).click();
    cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.source.id}"][data-service-date="${stay.arrivalDate}"]`);
  }
  await expect(cell).toContainText(stay.nickname, { timeout: 30_000 });
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await cell.click();
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", stay.source.id);
  const orderOption = popover.locator(".room-status-quick-orders button").filter({ hasText: stay.nickname });
  await expect(orderOption).toHaveCount(1);
  await orderOption.click();
  const context = page.locator(".room-status-order-context").filter({ hasText: stay.nickname });
  await expect(context).toBeVisible({ timeout: 30_000 });
  await context.getByRole("button", { name: "换房", exact: true }).click();
  const drawer = await fillOpenMoveDrawer(page, stay);
  return { cell, context, drawer };
}

async function waitForMovePreview(drawer: Locator): Promise<Locator> {
  const preview = drawer.getByTestId("move-unit-preview");
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(drawer.getByRole("button", { name: "继续核对", exact: true })).toBeEnabled();
  return preview;
}

async function confirmMove(page: Page, drawer: Locator, options: { hideOrderDelta?: boolean } = {}): Promise<void> {
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review).not.toContainText(forbiddenProtocol);
  if (options.hideOrderDelta) {
    await expect(review).not.toContainText(/原订单金额|订单金额变化/);
  }
  const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
    && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.status() === 200);
  await review.getByTestId("confirm-command").click();
  await confirmed;
  await expect(review).toBeHidden({ timeout: 30_000 });
}

async function performMove(page: Page, stay: Stage11MoveFixture): Promise<void> {
  await openOrder(page, stay);
  const drawer = await fillMoveDraft(page, stay);
  await waitForMovePreview(drawer);
  await confirmMove(page, drawer);
}

async function openDateDrawer(page: Page, stay: Stage11StayFixture): Promise<Locator> {
  await openOrder(page, stay);
  const button = page.getByRole("button", { name: /调整住宿日期|调整退房日期/, exact: true });
  await expect(button).toBeVisible();
  await button.click();
  return page.getByRole("dialog", { name: /调整住宿日期|调整退房日期/, exact: true });
}

async function confirmDateChange(page: Page, drawer: Locator, reviewTitle: RegExp): Promise<void> {
  await drawer.getByRole("button", { name: "继续核对", exact: true }).click();
  const review = page.getByRole("dialog", { name: reviewTitle });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await review.getByTestId("confirm-command").click();
  await expect(review).toBeHidden({ timeout: 30_000 });
}

function intervalCodes(
  view: Awaited<ReturnType<typeof getOrderView>>,
  units: readonly { id: string; code: string }[]
) {
  const codes = new Map(units.map((unit) => [unit.id, unit.code]));
  return view.effectiveArrangement.intervals.map((interval) => ({
    unitCode: codes.get(interval.inventoryUnitId) ?? interval.inventoryUnitId,
    arrivalDate: interval.arrivalDate,
    departureDate: interval.departureDate
  }));
}

test.beforeAll(async ({}, workerInfo) => {
  if (workerInfo.project.name === "mobile") {
    mobileFixture = await prepareStage11MobileAcceptance(e2eDatabaseUrl, {
      suffix: `stage11-${workerInfo.project.name}-${workerInfo.workerIndex}`
    });
    return;
  }
  fixture = await prepareStage11Acceptance(e2eDatabaseUrl, {
    reset: false,
    suffix: `stage11-${workerInfo.project.name}-${workerInfo.workerIndex}`
  });
});

test("4.4 same-price and cross-price moves show full timelines, reprice, and refresh immediately", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 pricing and refresh");
  await login(page);
  await page.setViewportSize({ width: 1440, height: 720 });
  let movePreviewRequests = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/v1/command-previews")) return;
    try {
      if ((request.postDataJSON() as { commandType?: string }).commandType === "MOVE_UNIT") movePreviewRequests += 1;
    } catch {
      // Ignore unrelated malformed requests; the product request still has to remain stable below.
    }
  });

  const sameBefore = await getOrderView(page, fixture.samePrice);
  await openOrder(page, fixture.samePrice);
  let drawer = await fillMoveDraft(page, fixture.samePrice);
  let preview = await waitForMovePreview(drawer);
  await expect(preview.getByTestId("move-unit-before-timeline")).toContainText(fixture.samePrice.source.code);
  await expect(preview.getByTestId("move-unit-after-timeline")).toContainText(fixture.samePrice.source.code);
  await expect(preview.getByTestId("move-unit-after-timeline")).toContainText(fixture.samePrice.target.code);
  await expect(drawer.getByTestId("move-unit-original-amount")).toBeVisible();
  await confirmMove(page, drawer);
  const sameAfter = await getOrderView(page, fixture.samePrice);
  expect(sameAfter.amounts.currentContractAmount.minorUnits).toBe(sameBefore.amounts.currentContractAmount.minorUnits);
  expect(sameAfter.effectiveArrangement.intervals.map((item) => item.inventoryUnitId))
    .toEqual([fixture.samePrice.source.id, fixture.samePrice.target.id]);
  await expect(page.locator(".order-unit")).toContainText(fixture.samePrice.target.code);

  const crossBefore = await getOrderView(page, fixture.crossPrice);
  await openOrder(page, fixture.crossPrice);
  drawer = await fillMoveDraft(page, fixture.crossPrice);
  preview = await waitForMovePreview(drawer);
  const originalText = await drawer.getByTestId("move-unit-original-amount").textContent();
  await expect(preview).toContainText("换房后订单金额");
  const drawerBody = drawer.locator(".modal-body");
  const stableScrollTop = await drawerBody.evaluate((element) => {
    element.scrollTop = Math.min(260, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(stableScrollTop).toBeGreaterThan(0);
  const reasonField = drawer.getByTestId("move-unit-reason");
  await reasonField.evaluate((element) => element.focus({ preventScroll: true }));
  const requestsBeforePolling = movePreviewRequests;
  for (let second = 0; second < 9; second += 1) {
    await page.waitForTimeout(1_000);
    expect(await drawerBody.evaluate((element) => element.scrollTop)).toBe(stableScrollTop);
  }
  await expect(reasonField).toBeFocused();
  await expect(preview).toBeVisible();
  expect(movePreviewRequests).toBe(requestsBeforePolling);
  await confirmMove(page, drawer);
  const crossAfter = await getOrderView(page, fixture.crossPrice);
  expect(crossAfter.amounts.currentContractAmount.minorUnits).not.toBe(crossBefore.amounts.currentContractAmount.minorUnits);
  expect(crossAfter.pricingRevisions.at(-1)?.current_contract_amount_minor).toBe(crossAfter.amounts.currentContractAmount.minorUnits);
  await expect(page.getByTestId("order-amounts")).not.toContainText(originalText ?? "__missing__");
});

test("4.4 channel and free moves keep their distinct pricing semantics", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 order-type pricing");
  await login(page);

  await openOrder(page, fixture.external);
  let drawer = await fillMoveDraft(page, fixture.external);
  await drawer.getByTestId("move-channel-amount").fill(fixture.external.targetContractYuan);
  await drawer.getByTestId("move-channel-reason").fill(fixture.external.channelPriceDifferenceReason);
  let preview = await waitForMovePreview(drawer);
  await expect(preview).toContainText("本单渠道应结金额");
  await expect(preview).toContainText("与政策基础金额差额");
  await expect(preview).toContainText("渠道价格差异说明");
  await expect(preview).not.toContainText(/原订单金额|订单金额变化|已登记净收款|待补收参考|建议退款/);
  await confirmMove(page, drawer, { hideOrderDelta: true });
  const externalView = await getOrderView(page, fixture.external);
  expect(externalView.amounts.currentContractAmount.minorUnits).toBe(Number(fixture.external.targetContractYuan) * 100);
  expect(externalView.collectionFacts).toEqual([]);

  await openOrder(page, fixture.free);
  drawer = await fillMoveDraft(page, fixture.free);
  preview = await waitForMovePreview(drawer);
  await expect(drawer.getByTestId("move-channel-amount")).toHaveCount(0);
  await expect(drawer.getByTestId("move-wecom-amount")).toHaveCount(0);
  await expect(preview).toContainText("¥0.00");
  await confirmMove(page, drawer);
  const freeView = await getOrderView(page, fixture.free);
  expect(freeView.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(freeView.collectionFacts).toEqual([]);
});

test("4.4 current and planned positions remain distinct across extension and future-move clipping", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 position and date combinations");
  await login(page);

  await openOrder(page, fixture.futureShorten);
  let positions = page.getByTestId("accommodation-position-summary");
  await expect(positions).toContainText("当前住宿位置");
  await expect(positions).toContainText(fixture.futureShorten.source.code);
  await expect(positions).toContainText("计划换至");
  await expect(positions).toContainText(fixture.futureShorten.target.code.split("-")[0]!);
  await expect(positions).toContainText(fixture.futureShorten.target.name);
  let drawer = await openDateDrawer(page, fixture.futureShorten);
  await drawer.getByTestId("stay-date-departure").fill(fixture.futureShorten.newDepartureDate);
  await drawer.getByTestId("stay-date-reason").fill("住客缩短住宿并裁剪未来换房");
  await expect(drawer.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  await expect(drawer.getByTestId("stay-date-preview-timeline")).not.toContainText(fixture.futureShorten.target.name);
  await confirmDateChange(page, drawer, /缩短住宿/);
  const shortened = await getOrderView(page, fixture.futureShorten);
  expect(shortened.effectiveArrangement.intervals).toEqual([{
    inventoryUnitId: fixture.futureShorten.source.id,
    arrivalDate: fixture.futureShorten.arrivalDate,
    departureDate: fixture.futureShorten.newDepartureDate
  }]);

  await openOrder(page, fixture.historicalExtend);
  positions = page.getByTestId("accommodation-position-summary");
  await expect(positions).toContainText("当前住宿位置");
  await expect(positions).toContainText(fixture.historicalExtend.target.code.split("-")[0]!);
  await expect(positions).toContainText(fixture.historicalExtend.target.name);
  await expect(positions).not.toContainText("计划换至");
  drawer = await openDateDrawer(page, fixture.historicalExtend);
  await drawer.getByTestId("stay-date-departure").fill(fixture.historicalExtend.newDepartureDate);
  await drawer.getByTestId("stay-date-reason").fill("历史换房后的住客确认续住");
  await expect(drawer.getByTestId("stay-date-price-preview")).toBeVisible({ timeout: 30_000 });
  await expect(drawer.getByTestId("stay-date-preview-timeline")).toContainText(fixture.historicalExtend.target.name);
  await confirmDateChange(page, drawer, /延长住宿/);
  const extended = await getOrderView(page, fixture.historicalExtend);
  expect(extended.effectiveArrangement.intervals.at(-1)).toMatchObject({
    inventoryUnitId: fixture.historicalExtend.target.id,
    departureDate: fixture.historicalExtend.newDepartureDate
  });
});

test("4.4 bed, room, member, WECOM, capacity, and inventory rules fail closed or commit as intended", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 inventory and entitlement rules");
  await login(page);

  const memberBefore = await getOrderView(page, fixture.member);
  await performMove(page, fixture.member);
  const memberAfter = await getOrderView(page, fixture.member);
  expect(memberAfter.coverageSet.filter((item) => item.status === "HELD").map((item) => item.inventory_unit_id))
    .toContain(fixture.member.target.id);
  expect(memberAfter.coverageSet.filter((item) => item.status === "HELD")).toHaveLength(
    memberBefore.coverageSet.filter((item) => item.status === "HELD").length
  );
  expect(memberAfter.amounts.currentContractAmount.minorUnits).toBe(0);

  const wecomPolicyAmount = (await getOrderView(page, fixture.bedMove)).pricingRevisions.at(-1)!.policy_base_amount_minor;
  await repriceOrder(page, fixture.bedMove, wecomPolicyAmount - 100);
  const wecomBefore = await getOrderView(page, fixture.bedMove);
  expect(wecomBefore.pricingRevisions.at(-1)?.pricing_basis).toBe("MANUAL_ADJUSTMENT");
  const roomStatusMove = await openMoveFromRoomStatus(page, fixture.bedMove);
  await roomStatusMove.drawer.getByTestId("move-unit-target-search").fill("四人间（公卫）");
  await expect(roomStatusMove.drawer.getByTestId("move-unit-id").locator(`option[value="${fixture.bedMove.target.id}"]`))
    .toContainText(`${fixture.bedMove.target.code} · 四人间（公卫） · 床位`);
  await roomStatusMove.drawer.getByTestId("move-unit-target-search").fill(fixture.bedMove.target.code);
  const scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  await roomStatusMove.drawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(roomStatusMove.drawer).toBeHidden();
  await expect(roomStatusMove.cell).toBeFocused();
  const scrollAfterCancel = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  expect(scrollAfterCancel.x).toBe(scrollBefore.x);
  expect(Math.abs(scrollAfterCancel.y - scrollBefore.y)).toBeLessThanOrEqual(80);
  await roomStatusMove.context.getByRole("button", { name: "换房", exact: true }).click();
  const reopenedDrawer = await fillOpenMoveDrawer(page, fixture.bedMove);
  const wecomPreview = await waitForMovePreview(reopenedDrawer);
  await expect(reopenedDrawer.getByTestId("move-wecom-amount")).toHaveCount(0);
  await expect(wecomPreview).toContainText("政策基础金额");
  await confirmMove(page, reopenedDrawer);
  const bedAfter = await getOrderView(page, fixture.bedMove);
  expect(bedAfter.effectiveArrangement.intervals.at(-1)?.inventoryUnitId).toBe(fixture.bedMove.target.id);
  expect(bedAfter.pricingRevisions).toHaveLength(wecomBefore.pricingRevisions.length + 1);
  expect(bedAfter.pricingRevisions.at(-1)?.pricing_basis).toBe("POLICY");
  expect(bedAfter.pricingRevisions.at(-1)?.current_contract_amount_minor)
    .toBe(bedAfter.pricingRevisions.at(-1)?.policy_base_amount_minor);
  expect(bedAfter.collectionFacts).toEqual(wecomBefore.collectionFacts);

  const capacityBefore = await getOrderView(page, fixture.capacityBlocked);
  await openOrder(page, fixture.capacityBlocked);
  let blockedDrawer = await fillMoveDraft(page, fixture.capacityBlocked);
  await expect(blockedDrawer.getByRole("alert")).toContainText(
    `${fixture.capacityBlocked.target.code} 最多登记 1 位住宿人，当前订单有 2 位`,
    { timeout: 30_000 }
  );
  await expect(blockedDrawer.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();
  let blockedAfter = await getOrderView(page, fixture.capacityBlocked);
  expect(blockedAfter.order).toEqual(capacityBefore.order);
  expect(blockedAfter.effectiveArrangement).toEqual(capacityBefore.effectiveArrangement);
  expect(blockedAfter.pricingRevisions).toEqual(capacityBefore.pricingRevisions);
  await blockedDrawer.getByRole("button", { name: "取消", exact: true }).click();

  const conflictBefore = await getOrderView(page, fixture.conflictBlocked);
  await openOrder(page, fixture.conflictBlocked);
  blockedDrawer = await fillMoveDraft(page, fixture.conflictBlocked);
  await expect(blockedDrawer.getByTestId("move-unit-target-status")).toContainText("目标区间已有占用，请选择其他房源");
  await expect(blockedDrawer.getByRole("alert")).toContainText("目标房源在所选换房日期内已有占用，请选择其他房源。", { timeout: 30_000 });
  await expect(blockedDrawer.getByTestId("move-unit-preview")).toHaveCount(0);
  await expect(blockedDrawer.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();
  blockedAfter = await getOrderView(page, fixture.conflictBlocked);
  expect(blockedAfter.order).toEqual(conflictBefore.order);
  expect(blockedAfter.effectiveArrangement).toEqual(conflictBefore.effectiveArrangement);
  expect(blockedAfter.pricingRevisions).toEqual(conflictBefore.pricingRevisions);
  await blockedDrawer.getByRole("button", { name: "取消", exact: true }).click();
});

test("4.4 Scheme B computes equal, non-equal, wholly-earlier, and wholly-later timelines", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 Scheme B");
  await login(page);
  const schemes = Object.values(fixture.schemes) as Stage11SchemeFixture[];
  for (const scheme of schemes) {
    const drawer = await openDateDrawer(page, scheme);
    await drawer.getByTestId("stay-date-arrival").fill(scheme.newArrivalDate);
    await drawer.getByTestId("stay-date-departure").fill(scheme.newDepartureDate);
    await drawer.getByTestId("stay-date-reason").fill("按方案 B 调整多房源住宿日期");
    const preview = drawer.getByTestId("stay-date-price-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    const timeline = drawer.getByTestId("stay-date-preview-timeline");
    await expect(timeline).toBeVisible();
    for (const interval of scheme.expectedIntervals) {
      await expect(timeline).toContainText(interval.unitCode);
      await expect(timeline).toContainText(interval.arrivalDate);
      await expect(timeline).toContainText(interval.departureDate);
    }
    await confirmDateChange(page, drawer, /调整住宿日期/);
    const view = await getOrderView(page, scheme);
    expect(intervalCodes(view, [scheme.source, scheme.target])).toEqual(scheme.expectedIntervals);
  }
});

test("4.4 room status selects every visible segment of the same Stay", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop Stage 11 whole-Stay selection");
  await login(page);
  const stay = fixture.samePrice;
  if ((await getOrderView(page, stay)).effectiveArrangement.intervals.length === 1) {
    await performMove(page, stay);
  }
  await page.goto("/");
  const first = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.source.id}"][data-service-date="${stay.arrivalDate}"]`);
  const moved = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.target.id}"][data-service-date="${stay.effectiveDate}"]`);
  await expect(first).toContainText(stay.nickname, { timeout: 30_000 });
  await moved.click();
  await expect(first).toHaveClass(/is-stay-selected/);
  await expect(moved).toHaveClass(/is-stay-selected/);
  const closeQuickPopover = page.getByRole("button", { name: "关闭快捷操作", exact: true });
  if (await closeQuickPopover.isVisible()) await closeQuickPopover.click();
  await expect(first).toHaveClass(/is-stay-selected/);
  await expect(moved).toHaveClass(/is-stay-selected/);
  const openSelection = page.getByRole("button", { name: "打开选中对象上下文", exact: true });
  if (await openSelection.isVisible()) {
    await openSelection.click();
    await expect(first).toHaveClass(/is-stay-selected/);
    await expect(moved).toHaveClass(/is-stay-selected/);
    await page.getByRole("dialog", { name: "选中对象上下文", exact: true })
      .getByRole("button", { name: "关闭", exact: true }).first().click();
  }
  let visibleSegments = 0;
  for (let date = stay.arrivalDate; date < stay.departureDate; date = addDays(date, 1)) {
    const unitId = date < stay.effectiveDate ? stay.source.id : stay.target.id;
    const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${unitId}"][data-service-date="${date}"]`);
    if (await cell.count()) {
      visibleSegments += 1;
      await expect(cell).toHaveClass(/is-stay-selected/);
    }
  }
  expect(visibleSegments).toBeGreaterThanOrEqual(2);

  const otherStay = fixture.crossPrice;
  const otherCell = page.locator(`[data-room-status-cell="true"][data-unit-id="${otherStay.source.id}"][data-service-date="${otherStay.arrivalDate}"]`);
  await expect(otherCell).toContainText(otherStay.nickname);
  await otherCell.click();
  await expect(otherCell).toHaveClass(/is-stay-selected/);
  await expect(first).not.toHaveClass(/is-stay-selected/);
  await expect(moved).not.toHaveClass(/is-stay-selected/);
  await expect(page.locator("body")).not.toContainText(forbiddenProtocol);
});

test("4.4 mobile completes same-price and cross-price moves and highlights the complete Stay", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 11 pricing and whole-Stay flow");
  test.setTimeout(180_000);
  await login(page);
  const sameBefore = await getOrderView(page, mobileFixture.samePrice);
  await openOrder(page, mobileFixture.samePrice);
  let drawer = await fillMoveDraft(page, mobileFixture.samePrice);
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 24);
  expect(drawerBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await waitForMovePreview(drawer);
  await confirmMove(page, drawer);
  const sameAfter = await getOrderView(page, mobileFixture.samePrice);
  expect(sameAfter.amounts.currentContractAmount.minorUnits).toBe(sameBefore.amounts.currentContractAmount.minorUnits);
  expect(sameAfter.effectiveArrangement.intervals.map((item) => item.inventoryUnitId))
    .toEqual([mobileFixture.samePrice.source.id, mobileFixture.samePrice.target.id]);

  const crossBefore = await getOrderView(page, mobileFixture.crossPrice);
  await performMove(page, mobileFixture.crossPrice);
  const crossAfter = await getOrderView(page, mobileFixture.crossPrice);
  expect(crossAfter.amounts.currentContractAmount.minorUnits).not.toBe(crossBefore.amounts.currentContractAmount.minorUnits);

  await openOrder(page, mobileFixture.samePrice);
  const positionSummary = page.getByTestId("accommodation-position-summary");
  await expect(positionSummary).toContainText(mobileFixture.samePrice.source.code);
  await expect(positionSummary).toContainText(mobileFixture.samePrice.target.code);
  await expect(page.locator("body")).not.toContainText(forbiddenProtocol);
});

test("4.4 mobile preserves channel, WECOM reset, and free-stay pricing semantics", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 11 order-type pricing");
  test.setTimeout(180_000);
  await login(page);

  await openOrder(page, mobileFixture.external);
  let drawer = await fillMoveDraft(page, mobileFixture.external);
  await drawer.getByTestId("move-channel-amount").fill(mobileFixture.external.targetContractYuan);
  await drawer.getByTestId("move-channel-reason").fill(mobileFixture.external.channelPriceDifferenceReason);
  let preview = await waitForMovePreview(drawer);
  await expect(preview).not.toContainText(/原订单金额|订单金额变化|已登记净收款|待补收参考|建议退款/);
  await confirmMove(page, drawer, { hideOrderDelta: true });
  const externalAfter = await getOrderView(page, mobileFixture.external);
  expect(externalAfter.amounts.currentContractAmount.minorUnits).toBe(Number(mobileFixture.external.targetContractYuan) * 100);
  expect(externalAfter.collectionFacts).toEqual([]);

  const wecomBefore = await getOrderView(page, mobileFixture.wecomReset);
  expect(wecomBefore.pricingRevisions.at(-1)?.pricing_basis).toBe("MANUAL_ADJUSTMENT");
  await openOrder(page, mobileFixture.wecomReset);
  drawer = await fillMoveDraft(page, mobileFixture.wecomReset);
  await expect(drawer.getByTestId("move-wecom-amount")).toHaveCount(0);
  await waitForMovePreview(drawer);
  await confirmMove(page, drawer);
  const wecomAfter = await getOrderView(page, mobileFixture.wecomReset);
  expect(wecomAfter.pricingRevisions.at(-1)?.pricing_basis).toBe("POLICY");
  expect(wecomAfter.pricingRevisions.at(-1)?.current_contract_amount_minor)
    .toBe(wecomAfter.pricingRevisions.at(-1)?.policy_base_amount_minor);

  await openOrder(page, mobileFixture.free);
  drawer = await fillMoveDraft(page, mobileFixture.free);
  preview = await waitForMovePreview(drawer);
  await expect(preview).toContainText("¥0.00");
  await confirmMove(page, drawer);
  const freeAfter = await getOrderView(page, mobileFixture.free);
  expect(freeAfter.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(freeAfter.collectionFacts).toEqual([]);
});

test("4.4 mobile rejects a member cross-kind move without changing rights or the order", async ({ page }, testInfo) => {
  test.skip(!isMobile(testInfo), "mobile Stage 11 member rejection");
  await login(page);
  const before = await getOrderView(page, mobileFixture.memberCrossKind);
  await openOrder(page, mobileFixture.memberCrossKind);
  const drawer = await fillMoveDraft(page, mobileFixture.memberCrossKind);
  await expect(drawer.getByRole("alert")).toContainText("会员住宿只能更换到同一会员产品适用的房型", { timeout: 30_000 });
  await expect(drawer.getByRole("button", { name: "继续核对", exact: true })).toBeDisabled();
  const after = await getOrderView(page, mobileFixture.memberCrossKind);
  expect(after.order).toEqual(before.order);
  expect(after.effectiveArrangement).toEqual(before.effectiveArrangement);
  expect(after.coverageSet).toEqual(before.coverageSet);
  expect(after.pricingRevisions).toEqual(before.pricingRevisions);
});
