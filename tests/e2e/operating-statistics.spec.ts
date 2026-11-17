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

async function chooseCategory(page: Page, roomCode: string, included: boolean) {
  await page.getByRole("combobox", { name: `${roomCode} 分类`, exact: true }).selectOption(included ? "OPERATING" : "OTHER");
  await expect(page.getByRole("status").filter({ hasText: `${roomCode} 已设为${included ? "经营单元" : "非经营单元"}` })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("reason-note")).toHaveCount(0);
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

test("桌面管理员单房下拉直接保存：无需理由、可读回、房态订单保留", async ({ page, isMobile }, testInfo) => {
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

  await test.step("单房下拉直接保存，不弹窗、不填理由，其他房间不受影响", async () => {
    await openRoomSettings(page);
    await expect(page.getByRole("button", { name: "批量设置分类", exact: true })).toHaveCount(0);
    await chooseCategory(page, occupied.code, false);
    await page.reload();
    await expect(page.getByRole("combobox", { name: `${occupied.code} 分类`, exact: true })).toHaveValue("OTHER");
    await expect(page.getByRole("combobox", { name: `${empty.code} 分类`, exact: true })).toHaveValue("OPERATING");
    const saved = await catalog(page);
    expect(saved.rooms.find(room => room.assetId === occupied.assetId)!.includedInOperatingStatistics).toBe(false);
    expect(saved.rooms.find(room => room.assetId === empty.assetId)!.includedInOperatingStatistics).toBe(true);
    expect(saved.history.some(change => change.reason === `${occupied.code}：经营单元改为非经营单元`)).toBe(true);
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

  await test.step("单房重新计入，刷新后设置恢复", async () => {
    await openRoomSettings(page);
    await chooseCategory(page, occupied.code, true);
    await page.reload();
    await expect(page.getByRole("combobox", { name: `${occupied.code} 分类`, exact: true })).toHaveValue("OPERATING");
    expect((await catalog(page)).rooms.find(room => room.assetId === occupied.assetId)!.includedInOperatingStatistics).toBe(true);
  });
  expect(errors).toEqual([]);
  } finally {
    const current = await catalog(page);
    const reset = current.rooms.filter(room => rooms.some(original => original.assetId === room.assetId)
      && !room.includedInOperatingStatistics).map(room => room.assetId);
    for (const assetId of reset) await command(page, "MANAGE_ROOM_CATALOG", { expectedVersion: (await catalog(page)).version,
      action: "SET_OPERATING_STATISTICS", assetIds: [assetId], included: true });
    await command(page, "CANCEL_ORDER", { orderId });
  }
});


test("房型选择与编辑说明：桌面列表和手机下拉一致，标签与悬浮说明不触发写入", async ({ page, isMobile }) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/") && path !== "/api/v1/auth/login"
      && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/settings/rooms");
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房型与价格", exact: true })).toBeVisible();

  const before = await catalog(page);
  const activeTypes = before.types.filter(type => type.active);
  const editable = activeTypes.find(type => type.saleMode === "ROOM" && before.prices.some(price => price.typeCode === type.code));
  expect(editable, "种子目录应包含可编辑的整房房型和现行价格").toBeDefined();
  const alternate = activeTypes.find(type => type.code !== editable!.code && before.prices.some(price => price.typeCode === type.code));
  expect(alternate, "房型选择回归需要第二个有现行价格的房型").toBeDefined();
  const picker = page.locator(".catalog-type-picker select");
  const list = page.locator(".catalog-type-list");
  await expect(picker.locator("option")).toHaveText(activeTypes.map(type => type.name));
  await expect(list.locator("button strong")).toHaveText(activeTypes.map(type => type.name));
  if (isMobile) {
    await expect(page.getByRole("combobox", { name: "选择房型", exact: true })).toBeVisible();
    await expect(list).toBeHidden();
  } else {
    await expect(list).toBeVisible();
    await expect(picker).toBeHidden();
  }

  const detail = page.locator(".catalog-detail");
  const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const type of [alternate!, editable!]) {
    if (isMobile) await picker.selectOption(type.code);
    else await list.getByRole("button").filter({ has: page.getByText(type.name, { exact: true }) }).click();
    await expect(detail.getByRole("heading", { name: type.name, exact: true })).toBeVisible();
    await expect(picker).toHaveValue(type.code);
    await expect(list.locator("button[aria-pressed='true'] strong")).toHaveText(type.name);
    const prices = before.prices.find(price => price.typeCode === type.code)!;
    await expect(detail.locator(".catalog-price-grid dd")).toHaveText(
      (["1", "7", "14", "30"] as const).map(night => money.format(prices.anchors[night] / 100))
    );
    await expect(detail.getByRole("button", { name: "编辑房型", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "调整价格", exact: true })).toBeEnabled();
  }

  await detail.getByRole("button", { name: "编辑房型", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑房型", exact: true });
  await expect(editor.getByRole("textbox", { name: "房型名称", exact: true })).toHaveValue(editable!.name);
  const capacity = editor.getByRole("spinbutton", { name: "最多可住人数", exact: true });
  await expect(capacity).toHaveValue(String(editable!.capacity));
  await editor.getByText("最多可住人数", { exact: true }).click();
  await expect(capacity).toBeFocused();

  const hint = editor.getByRole("button", { name: "床位与入住人数说明", exact: true });
  await hint.click();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("物理床仅用于房间配置，不会自动变成可单卖的床位。");
  await expect(tooltip).toBeVisible();
  // A visible DOM box alone cannot detect a help bubble painted behind the native dialog.
  await expect.poll(() => tooltip.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
  })).toBe(true);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(hint).toBeFocused();
  await capacity.fill(editable!.capacity === 1 ? "2" : "1");
  await expect(capacity).toHaveValue(editable!.capacity === 1 ? "2" : "1");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(detail.getByRole("heading", { name: editable!.name, exact: true })).toBeVisible();
  expect((await catalog(page)).version).toBe(before.version);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
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
  await expect(page.getByRole("button", { name: "批量设置分类", exact: true })).toHaveCount(0);
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

test("分类直接保存的失败恢复：拒绝时恢复旧值，响应丢失只查询原结果", async ({ page }) => {
  await page.goto("/settings/rooms?tab=rooms");
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "实际房间与床位", exact: true })).toBeVisible();
  const initial = await catalog(page);
  const room = initial.rooms.find(room => room.active && room.includedInOperatingStatistics)!;
  const select = page.getByRole("combobox", { name: `${room.code} 分类`, exact: true });
  let confirms = 0;
  await page.route("**/api/v1/command-previews", route => route.fulfill({ status: 403, contentType: "application/json",
    body: JSON.stringify({ code: "FORBIDDEN", message: "无权修改分类", retryable: false }) }));
  await select.selectOption("OTHER");
  await expect(page.getByText("分类未完成保存", { exact: true })).toBeVisible();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("OPERATING");
  expect((await catalog(page)).version).toBe(initial.version);
  await page.unroute("**/api/v1/command-previews");
  await page.route("**/api/v1/command-previews/*/confirm", async route => {
    confirms += 1;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    expect((await response.json()).businessCommitted).toBe(true);
    await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "SERVICE_UNAVAILABLE", message: "模拟保存后响应丢失", retryable: true }) });
  });
  try {
    await select.selectOption("OTHER");
    await expect(page.getByTestId("command-recovery")).toBeVisible();
    await expect(select).toBeDisabled();
    await page.reload();
    await expect(page.getByTestId("command-recovery")).toBeVisible();
    await expect(select).toBeDisabled();
    await page.getByTestId("command-recovery-open").click();
    await page.getByRole("button", { name: "查询原操作结果", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("OTHER");
    expect(confirms).toBe(1);
    const saved = await catalog(page);
    expect(saved.version).toBe(initial.version + 1);
    expect(saved.rooms.find(item => item.assetId === room.assetId)!.includedInOperatingStatistics).toBe(false);
  } finally {
    await page.unroute("**/api/v1/command-previews/*/confirm");
    const saved = await catalog(page);
    if (!saved.rooms.find(item => item.assetId === room.assetId)!.includedInOperatingStatistics) {
      await command(page, "MANAGE_ROOM_CATALOG", { expectedVersion: saved.version,
        action: "SET_OPERATING_STATISTICS", assetIds: [room.assetId], included: true });
    }
  }
});
