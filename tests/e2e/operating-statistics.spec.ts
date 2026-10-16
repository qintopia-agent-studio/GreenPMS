import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { MetaDto } from "../../apps/web/src/types";
import type { CommandType, ReceiptDto, RoomCatalogView, RoomStatusBoardDto } from "@qintopia/contracts";

const propertyId = "prop_qintopia_demo";
const headers = () => ({ "idempotency-key": randomUUID(), "x-correlation-id": randomUUID() });

async function catalog(page: Page): Promise<RoomCatalogView> {
  const response = await page.request.get(`/api/v1/properties/${propertyId}/room-catalog`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

// 与楼栋排序旅程一致：仅通过受控命令准备独立房源，实际统计开关全部点击 UI。
async function command(page: Page, commandType: CommandType, input: Record<string, unknown>): Promise<ReceiptDto> {
  const previewResponse = await page.request.post("/api/v1/command-previews", {
    headers: headers(), data: { commandType, input: { propertyId, ...input } }
  });
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const { preview } = await previewResponse.json();
  const response = await page.request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, {
    headers: headers(), data: { propertyId, commandType, expectedEffectHash: preview.effectHash, confirmation: true,
      reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" }
        : { code: commandType === "MANAGE_ROOM_CATALOG" ? "ROOM_CATALOG_CHANGE" : "E2E_ACCEPTANCE", note: "经营住宿统计浏览器合成验收" } }
  });
  expect(response.ok(), await response.text()).toBe(true);
  const receipt = await response.json() as ReceiptDto;
  expect(receipt.businessCommitted, JSON.stringify(receipt.error)).toBe(true);
  return receipt;
}

async function openRoomSettings(page: Page) {
  await page.goto("/settings/rooms");
  await expect(page.getByRole("heading", { name: "房型与价格", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "房间与床位", exact: true }).click();
  await expect(page.getByRole("heading", { name: "实际房间与床位", exact: true })).toBeVisible();
}

async function openBatchCategory(page: Page, building: string, included: boolean) {
  await page.getByRole("button", { name: "批量设置分类", exact: true }).click();
  await page.getByRole("combobox", { name: "选择楼栋", exact: true }).selectOption(building);
  await page.getByRole("radio", { name: included ? /^经营单元/ : /^非经营单元/ }).check();
  await page.getByRole("button", { name: "下一步：核对修改", exact: true }).click();
}

async function confirmStatistics(page: Page, expectedTitle: string, reason: string) {
  const effect = page.getByTestId("command-effect");
  await expect(effect).toContainText(expectedTitle);
  await expect(effect).toContainText("过去和今后的经营入住率");
  await expect(effect).toContainText("房间内的床位一并调整");
  await expect(effect).toContainText("入住记录、订单、收付款、经营销售额和今日新增订单数照常保留");
  const note = page.getByTestId("reason-note");
  const confirm = page.getByTestId("confirm-command");
  await expect(note).toHaveValue("");
  await expect(confirm).toBeDisabled();
  await note.fill("   ");
  await expect(confirm).toBeDisabled();
  await note.fill(reason);
  await expect(confirm).toBeEnabled();
  const confirmation = page.waitForResponse(response => /\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
    && response.request().method() === "POST");
  await confirm.click();
  const response = await confirmation;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).businessCommitted).toBe(true);
  await expect(page.getByRole("status").filter({ hasText: "房间分类已保存" })).toBeVisible({ timeout: 30_000 });
  await expect(confirm).toBeHidden();
  const done = page.getByRole("dialog").getByRole("button", { name: "完成", exact: true });
  if (await done.isVisible()) await done.click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

test("桌面管理员单房及整栋调整经营统计：原因必填、保存可读回、房态订单保留", async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, "本切片的桌面验收旅程");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const suffix = randomUUID().slice(0, 8);
  const guest = `统计住客${suffix}`;

  await test.step("管理员登录，使用既有房源准备独立预订，不改变房间总数或价格", async () => {
    await page.goto("/settings/rooms");
    await page.getByTestId("login-username").fill("admin");
    await page.getByTestId("login-password").fill("demo-pass-2026");
    await page.getByTestId("login-submit").click();
    await expect(page.getByRole("heading", { name: "房型与价格", exact: true })).toBeVisible();
  });

  const initial = await catalog(page);
  const wholeRooms = initial.rooms.filter(room => room.active && initial.types.some(type => type.code === room.typeCode && type.saleMode === "ROOM"));
  const occupied = wholeRooms.find(room => initial.rooms.filter(candidate => candidate.active && candidate.buildingCode === room.buildingCode).length >= 2)!;
  expect(occupied).toBeDefined();
  const building = occupied.buildingCode;
  const rooms = initial.rooms.filter(room => room.active && room.buildingCode === building);
  const empty = rooms.find(room => room.assetId !== occupied.assetId)!;
  const codes = rooms.map(room => room.code);
  expect(rooms.every(room => room.includedInOperatingStatistics)).toBe(true);
  const arrivalDate = "2034-06-10";
  const departureDate = nextDate(arrivalDate);
  const metaResponse = await page.request.get("/api/v1/meta");
  expect(metaResponse.ok()).toBe(true);
  const meta = await metaResponse.json() as MetaDto;
  const policy = meta.pricingPolicyVersions.filter(policy => policy.property_id === propertyId
    && policy.calculation_kind === "DURATION_BAND_TOTAL" && policy.stay_type === null
    && policy.effective_from !== null && policy.effective_from <= arrivalDate
    && (policy.effective_until === null || arrivalDate < policy.effective_until))
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? "")
      || Number(b.code === "MANAGED_ROOM_PRICES") - Number(a.code === "MANAGED_ROOM_PRICES") || b.version - a.version)[0];
  expect(policy).toBeDefined();
  const quoteResponse = await page.request.post("/api/v1/quotes", { headers: headers(), data: {
    propertyId, inventoryUnitId: occupied.unitId, arrivalDate, departureDate,
    pricingPolicyVersionId: policy!.id
  } });
  expect(quoteResponse.ok(), await quoteResponse.text()).toBe(true);
  const { quote } = await quoteResponse.json();
  const created = await command(page, "CREATE_ORDER", { quoteId: quote.quoteId,
    primaryGuest: { fullName: guest, nickname: guest }, bookingChannelCode: "WECOM" });
  const orderId = String(created.result!.orderId);
  const originalOrderResponse = await page.request.get(`/api/v1/orders/${orderId}`);
  expect(originalOrderResponse.ok(), await originalOrderResponse.text()).toBe(true);
  const originalOrder = (await originalOrderResponse.json()).order;
  expect(originalOrder.status).toBe("RESERVED");
  const originalQuery = new URLSearchParams({ arrivalDate, departureDate, search: building });
  const originalBoardResponse = await page.request.get(`/api/v1/properties/${propertyId}/room-status?${originalQuery}`);
  expect(originalBoardResponse.ok(), await originalBoardResponse.text()).toBe(true);
  const originalBoard = await originalBoardResponse.json() as RoomStatusBoardDto;

  try {

  await test.step("单房进入核对，空白原因不能确认，保存后仍可读回", async () => {
    await openRoomSettings(page);
    await page.getByRole("button", { name: `${occupied.code} 分类：经营单元，点击修改`, exact: true }).click();
    await page.getByRole("radio", { name: "非经营单元", exact: false }).check();
    await page.getByRole("button", { name: "下一步：核对修改", exact: true }).click();
    await expect(page.getByTestId("command-effect")).toContainText(`${building}栋 ${occupied.code}`);
    // 核对本身不写设置。
    expect((await catalog(page)).rooms.find(room => room.assetId === occupied.assetId)!.includedInOperatingStatistics).toBe(true);
    await confirmStatistics(page, "设为非经营单元：1 间", "宿舍单房不纳入经营住宿统计");
    await page.reload();
    await page.getByRole("button", { name: "房间与床位", exact: true }).click();
    await expect(page.getByRole("button", { name: `${occupied.code} 分类：非经营单元，点击修改`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `${empty.code} 分类：经营单元，点击修改`, exact: true })).toBeVisible();
    const saved = await catalog(page);
    expect(saved.rooms.find(room => room.assetId === occupied.assetId)!.includedInOperatingStatistics).toBe(false);
    expect(saved.rooms.find(room => room.assetId === empty.assetId)!.includedInOperatingStatistics).toBe(true);
  });

  await test.step("混合设置整栋排除，核对展示全部实体房及保留财务的说明", async () => {
    await page.getByRole("combobox", { name: "楼栋", exact: true }).selectOption(building);
    await expect(page.getByRole("navigation", { name: "按经营分类筛选" }).getByRole("button", { name: /^经营单元/ })).toHaveText(`经营单元${rooms.length - 1}`);
    await openBatchCategory(page, building, false);
    for (const code of codes) await expect(page.getByTestId("command-effect")).toContainText(code);
    await confirmStatistics(page, `设为非经营单元：${rooms.length} 间`, "整栋宿舍统一排除，真实资金和订单继续保留");
    await page.reload();
    await page.getByRole("button", { name: "房间与床位", exact: true }).click();
    expect((await catalog(page)).rooms.filter(room => room.buildingCode === building).every(room => !room.includedInOperatingStatistics)).toBe(true);
    await page.getByRole("combobox", { name: "楼栋", exact: true }).selectOption(building);
    await expect(page.getByRole("navigation", { name: "按经营分类筛选" }).getByRole("button", { name: /^非经营单元/ })).toHaveText(`非经营单元${rooms.length}`);
    await page.getByRole("button", { name: "批量设置分类", exact: true }).click();
    await page.getByRole("combobox", { name: "选择楼栋", exact: true }).selectOption(building);
    await expect(page.getByRole("button", { name: "下一步：核对修改", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("operating-statistics-building-excluded.png"), fullPage: true });
  });

  await test.step("排除经营统计后，房态仍显示房间与预订订单，订单详情可打开", async () => {
    await page.goto("/");
    await page.getByTestId("arrival-date").fill(arrivalDate);
    await page.getByRole("searchbox", { name: "搜索房间或床位", exact: true }).fill(building);
    for (const room of rooms) await expect(page.locator(`[data-room-status-row="${room.unitId}"]`)).toBeVisible();
    const query = new URLSearchParams({ arrivalDate, departureDate, search: building });
    const response = await page.request.get(`/api/v1/properties/${propertyId}/room-status?${query}`);
    expect(response.ok(), await response.text()).toBe(true);
    const board = await response.json() as RoomStatusBoardDto;
    expect(board.rooms.map(room => room.id).sort()).toEqual(originalBoard.rooms.map(room => room.id).sort());
    expect(board.rooms.find(room => room.id === occupied.unitId)!.intervals.some(interval => interval.references.some(reference => reference.type === "ORDER" && reference.id === orderId))).toBe(true);
    const orderResponse = await page.request.get(`/api/v1/orders/${orderId}`);
    expect(orderResponse.ok(), await orderResponse.text()).toBe(true);
    expect((await orderResponse.json()).order).toEqual(originalOrder);
    await page.goto(`/orders/${orderId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(guest);
  });

  await test.step("整栋重新计入仍需原因，重载后设置均恢复", async () => {
    await openRoomSettings(page);
    await openBatchCategory(page, building, true);
    await confirmStatistics(page, `设为经营单元：${rooms.length} 间`, "验收完成，恢复该合成楼栋经营统计");
    await page.reload();
    await page.getByRole("button", { name: "房间与床位", exact: true }).click();
    await page.getByRole("combobox", { name: "楼栋", exact: true }).selectOption(building);
    await expect(page.getByRole("navigation", { name: "按经营分类筛选" }).getByRole("button", { name: /^经营单元/ })).toHaveText(`经营单元${rooms.length}`);
    const saved = await catalog(page);
    expect(saved.rooms.filter(room => room.buildingCode === building).every(room => room.includedInOperatingStatistics)).toBe(true);
    expect(saved.history.some(change => change.reason === "整栋宿舍统一排除，真实资金和订单继续保留")).toBe(true);
  });
  expect(errors).toEqual([]);
  } finally {
    const current = await catalog(page);
    const reset = current.rooms.filter(room => rooms.some(original => original.assetId === room.assetId)
      && !room.includedInOperatingStatistics).map(room => room.assetId);
    if (reset.length) await command(page, "MANAGE_ROOM_CATALOG", { expectedVersion: current.version,
      action: "SET_OPERATING_STATISTICS", assetIds: reset, included: true });
    await command(page, "CANCEL_ORDER", { orderId });
  }
});


test("房源分类筛选与滚动：查看分类不改数据，表格中央可上下滚动", async ({ page, isMobile }) => {
  await page.goto("/settings/rooms");
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await page.getByRole("button", { name: "房间与床位", exact: true }).click();
  const before = await catalog(page);
  const active = before.rooms.filter(room => room.active);
  const filters = page.getByRole("navigation", { name: "按经营分类筛选" });
  await filters.getByRole("button", { name: /^非经营单元/ }).click();
  await expect(page.locator(".catalog-room-table tbody tr")).toHaveCount(active.filter(room => !room.includedInOperatingStatistics).length);
  await filters.getByRole("button", { name: /^经营单元/ }).click();
  await expect(page.locator(".catalog-room-table tbody tr")).toHaveCount(active.filter(room => room.includedInOperatingStatistics).length);
  await filters.getByRole("button", { name: /^全部/ }).click();
  await page.getByRole("button", { name: "批量设置分类", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await catalog(page)).version).toBe(before.version);
  if (!isMobile) {
    const viewport = page.viewportSize()!;
    const tableTop = await page.locator(".catalog-room-table").evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    await page.evaluate(top => window.scrollTo(0, top - 180), tableTop);
    const start = await page.evaluate(() => window.scrollY);
    const rect = (await page.locator(".catalog-room-table").boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, Math.min(viewport.height - 100, 400));
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(start + 100);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(start + 100);
  } else {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    const table = page.locator(".catalog-room-table");
    expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  }
});
