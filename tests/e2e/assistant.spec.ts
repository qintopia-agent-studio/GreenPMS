import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { openQuickPopoverOrderDrawer } from "./quick-popover-helpers";
import { assistantGuides } from "../../packages/contracts/src/assistant.ts";
import type { OrderViewDto } from "../../apps/web/src/types.ts";
const propertyId = "prop_qintopia_demo";
async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.locator(".room-status-grid").or(page.getByRole("heading", { name: "房态任务", exact: true }))).toBeVisible();
}
async function command(request: APIRequestContext, commandType: string, input: object) {
  const headers = () => ({ "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() });
  const response = await request.post("/api/v1/command-previews", { headers: headers(), data: { commandType, input: { propertyId, ...input } } });
  expect(response.status(), await response.text()).toBe(200); const { preview } = await response.json();
  const confirmed = await request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, { headers: headers(), data: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash, reason: commandType === "CREATE_ORDER" ? { code: "CREATE_STANDARD_ORDER", note: "" } : { code: commandType, note: "助手合成回归" } } });
  expect(confirmed.status(), await confirmed.text()).toBe(200); expect((await confirmed.json()).businessCommitted).toBe(true); return (await confirmed.json()).result;
}
async function order(request: APIRequestContext) {
  const arrivalDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const end = new Date(arrivalDate); end.setUTCDate(end.getUTCDate() + 2); const departureDate = end.toISOString().slice(0, 10);
  const available = await request.get(`/api/v1/properties/${propertyId}/availability?arrivalDate=${arrivalDate}&departureDate=${departureDate}&unitKind=ROOM`);
  expect(available.status(), await available.text()).toBe(200);
  const unit = (await available.json()).units.find((u: { available: boolean }) => u.available); expect(unit).toBeTruthy();
  const quoted = await request.post("/api/v1/quotes", { headers: { "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() }, data: { propertyId, inventoryUnitId: unit.id, arrivalDate, departureDate, stayType: "TRANSIENT", pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1" } });
  expect(quoted.status(), await quoted.text()).toBe(200);
  const created = await command(request, "CREATE_ORDER", { quoteId: (await quoted.json()).quote.quoteId, primaryGuest: { fullName: "助手回归客人", nickname: "助手回归" }, bookingChannelCode: "WECOM" });
  await command(request, "CHECK_IN", { orderId: created.orderId }); return created.orderId as string;
}
async function enabledUi(page: Page) {
  // Only the model-facing UI response is simulated. Business data and form gates stay real.
  await page.route("**/api/v1/assistant/settings?*", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), enabled: true } }); });
}
test("assistant reserves working space and preserves scroll; settings fit the viewport", async ({ page }) => {
  await login(page);
  const hasCalendar = await page.locator(".room-status-grid-scroll").count() > 0;
  const before = await page.locator(".main-content").boundingBox();
  const scroller = page.locator(".room-status-grid-scroll");
  if (hasCalendar) await scroller.evaluate(el => { el.scrollLeft = 120; el.scrollTop = 80; });
  const position = hasCalendar ? await scroller.evaluate(el => [el.scrollLeft, el.scrollTop]) : [];
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
  const after = await page.locator(".main-content").boundingBox();
  expect(after?.width).toBe(before!.width - (await page.evaluate(() => innerWidth > 860) ? 400 : 0)); expect(after?.x).toBe(before?.x);
  if (hasCalendar) expect(await scroller.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual(position);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await expect(page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true })).toBeFocused();
  if (hasCalendar) expect(await scroller.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual(position);
  await page.goto("/settings/ai"); await expect(page.getByLabel("Base URL", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("assistant composer separates sending, line breaks and IME confirmation", async ({ page }) => {
  await enabledUi(page);
  const received: string[] = [];
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/assistant/chat", async route => {
    received.push(route.request().postDataJSON().message);
    await responseReady;
    await route.fulfill({ json: { conversationId: "synthetic-keyboard", text: "已收到完整问题。", entries: [] } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.locator(".assistant-suggestions button")).toHaveCount(5);
  const input = page.getByLabel("向 AI 助手提问");
  await input.fill("核对房态");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("核对房态\n");
  await input.fill("核对房态\n再办理续住");
  await input.dispatchEvent("compositionstart");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter" });
  await input.dispatchEvent("compositionend");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 });
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true });
  expect(received).toEqual([]);
  await expect(input).toHaveValue("核对房态\n再办理续住");
  const mobile = await page.evaluate(() => matchMedia("(max-width: 720px)").matches);
  await input.press("Enter");
  if (mobile) {
    await expect(input).toHaveValue("核对房态\n再办理续住\n");
    expect(received).toEqual([]);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  }
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]).toBe("核对房态\n再办理续住");
  await input.fill("上一条仍在处理中");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  expect(received).toHaveLength(1);
  release();
  await expect(page.locator(".assistant-markdown")).toHaveText("已收到完整问题。");
});
test("assistant distinguishes suggested questions and saves explicit feedback with retry", async ({ page }) => {
  await enabledUi(page);
  const sources: string[] = [], feedbacks: string[] = [];
  await page.route("**/api/v1/assistant/chat", route => {
    sources.push(route.request().postDataJSON().source);
    return route.fulfill({ json: { conversationId: "synthetic-feedback", questionId: `synthetic-question-${sources.length}`, text: "请先核对房态，再进入正式操作页面。", entries: [] } });
  });
  await page.route("**/api/v1/assistant/questions/*/feedback", route => {
    feedbacks.push(route.request().postDataJSON().feedback);
    return feedbacks.length === 1
      ? route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "反馈未能保存，请稍后重试。", retryable: true } } })
      : route.fulfill({ json: { saved: true } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await page.locator(".assistant-suggestions button").first().click();
  await expect(page.locator(".assistant-feedback")).toBeVisible(); expect(sources).toEqual(["SUGGESTION"]);
  const unresolved = page.getByRole("button", { name: "未解决", exact: true });
  await unresolved.click(); await expect(page.locator(".assistant-feedback [role=alert]")).toBeVisible();
  await expect(unresolved).toHaveAttribute("aria-pressed", "false");
  await unresolved.click(); await expect(unresolved).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".assistant-feedback-status")).toHaveText("反馈已记录");
  await unresolved.click(); expect(feedbacks).toEqual(["UNRESOLVED", "UNRESOLVED"]);
  await page.getByRole("button", { name: "已解决", exact: true }).click();
  await expect(page.getByRole("button", { name: "已解决", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(feedbacks).toEqual(["UNRESOLVED", "UNRESOLVED", "RESOLVED"]);
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "已解决", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("向 AI 助手提问").fill("帮我打开会员页面");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".assistant-feedback")).toHaveCount(2); expect(sources).toEqual(["SUGGESTION", "USER"]);
});
test("assistant opens the real stay-date form with durable guidance and no business submission", async ({ page }) => {
  await login(page); const orderId = process.env.ASSISTANT_TEST_ORDER_ID ?? await order(page.request);
  await enabledUi(page);
  const requests: Array<{conversationId?: string}> = [];
  let releaseFirst!: () => void;
  await page.route("**/api/v1/assistant/chat", async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
    return route.fulfill({ json: { conversationId: "synthetic-ui", text: requests.length === 1 ? "请在已打开的表单核对新离店日期。" : "仍在处理同一个订单。", entries: requests.length === 1 ? [{ page: "order", orderId, action: "EXTEND_STAY", ...assistantGuides.EXTEND_STAY }] : [] } });
  });
  await page.goto(`/orders/${orderId}`); await expect(page.locator('[data-order-action="ADJUST_DEPARTURE"]')).toBeEnabled({ timeout: 30_000 });
  await page.goto("/orders");
  let writes = 0; page.on("request", request => { if (request.method() === "POST" && /command-previews|\/quotes/.test(request.url())) writes++; });
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await page.getByLabel("向 AI 助手提问").fill("打开这个订单的续住入口"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByLabel("向 AI 助手提问").fill("跳转前保留的草稿");
  releaseFirst();
  const dialog = page.locator("dialog[open]"); await expect(dialog.locator(".assistant-operation-guide")).toBeVisible();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("跳转前保留的草稿");
  await page.screenshot(); // flush rendering; catches StrictMode cleanup hiding the guide immediately after mount
  await expect(dialog.locator(".assistant-operation-guide")).toBeVisible();
  const panel = page.getByTestId("ai-assistant-panel");
  await expect(panel).toBeVisible(); expect(writes).toBe(0);
  const formBounds = await dialog.locator(":scope > .modal-shell").boundingBox();
  const assistantBounds = await panel.boundingBox();
  expect(formBounds && assistantBounds && (formBounds.x + formBounds.width <= assistantBounds.x + 1 || formBounds.y + formBounds.height <= assistantBounds.y + 1)).toBe(true);
  await page.screenshot({path: test.info().outputPath("assistant-with-form.png")});
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
  await page.getByLabel("向 AI 助手提问").fill("还需要核对什么？");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await panel.getByRole("button", {name: "发送", exact: true}).click();
  await expect(panel).toContainText("仍在处理同一个订单。");
  expect(requests[1]?.conversationId).toBe("synthetic-ui");
  await page.getByLabel("向 AI 助手提问").fill("保留的后续问题");
  const note = dialog.locator(".modal-shell textarea").last();
  await note.fill("同一个问题的操作备注");
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("保留的后续问题");
  await page.getByLabel("向 AI 助手提问").press("Escape");
  await expect(panel).toBeHidden();
  await expect(note).toHaveValue("同一个问题的操作备注");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("保留的后续问题");
  await page.locator('[data-order-action="ADJUST_DEPARTURE"]').click();
  await expect(panel).toBeVisible();
  await expect(page.locator("dialog[open] .assistant-operation-guide")).toHaveCount(0);
  await page.locator("dialog[open]").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("保留的后续问题");
});

test("all five suggestions keep the assistant open while their buttons unmount", async ({ page }) => {
  await enabledUi(page);
  let releaseReply: (() => void) | undefined;
  const received: Array<{ source: string; message: string }> = [];
  await page.route("**/api/v1/assistant/chat", async route => {
    received.push(route.request().postDataJSON());
    await new Promise<void>(resolve => { releaseReply = resolve; });
    await route.fulfill({ json: { conversationId: "suggestion-dismiss-regression", text: "已收到默认问题。", entries: [] } });
  });
  await login(page);
  const trigger = page.locator(".assistant-trigger:not(.assistant-trigger-compact)").filter({ visible: true });
  const panel = page.getByTestId("ai-assistant-panel");
  await trigger.click();
  try {
    for (let index = 0; index < 5; index++) {
      if (index) await panel.getByRole("button", { name: "新建对话", exact: true }).click();
      const suggestions = panel.locator(".assistant-suggestions button");
      await expect(suggestions).toHaveCount(5);
      const prompt = await suggestions.nth(index).locator("small").innerText();
      // Cover clicks on descendants as well as keyboard activation of the button.
      if (index === 4) { await suggestions.nth(index).focus(); await page.keyboard.press("Enter"); }
      else await suggestions.nth(index).locator(index % 2 ? "small" : "strong").click();
      await expect.poll(() => received.length).toBe(index + 1);
      await expect(panel).toBeVisible();
      await expect(panel.locator(".assistant-wait")).toBeVisible();
      expect(received[index]).toMatchObject({ source: "SUGGESTION", message: prompt });
      releaseReply?.();
      await expect(panel.locator(".assistant-message-assistant")).toContainText("已收到默认问题。");
    }
    if (await page.evaluate(() => innerWidth > 860)) {
      await page.locator(".main-content").click({ position: { x: 20, y: 20 } });
      await expect(panel).toBeVisible();
      await trigger.click();
      await expect(panel).toBeHidden();
      await trigger.click();
      await expect(panel.locator(".assistant-message-assistant")).toBeVisible();
    }
    await page.getByLabel("向 AI 助手提问").press("Escape");
    await expect(panel).toBeHidden();
  } finally { releaseReply?.(); }
});

test("streamed text appears before completion; stop and failure discard the draft without navigation", async ({ page }) => {
  await enabledUi(page);
  await page.addInitScript(() => {
    const original = window.fetch;
    const state = window as unknown as { emitAssistant: (value: object) => void; assistantAborted: boolean };
    window.fetch = async (input, init) => {
      if (input !== "/api/v1/assistant/chat") return original(input, init);
      state.assistantAborted = false;
      return new Response(new ReadableStream({ start(controller) {
        state.emitAssistant = value => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
        init?.signal?.addEventListener("abort", () => { state.assistantAborted = true; controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await login(page);
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  const input = page.getByLabel("向 AI 助手提问"), panel = page.getByTestId("ai-assistant-panel");
  const emit = (event: object) => page.evaluate(value => (window as unknown as { emitAssistant: (event: object) => void }).emitAssistant(value), event);
  await input.fill("流式测试"); await panel.getByRole("button", { name: "发送", exact: true }).click();
  await emit({ type: "status", phase: "thinking", round: 1 });
  await emit({ type: "delta", text: "正在逐步显示", round: 1 });
  await expect(panel.locator(".assistant-message-partial")).toContainText("正在逐步显示");
  await expect(panel.locator(".assistant-feedback")).toHaveCount(0);
  await panel.getByRole("button", { name: "停止生成" }).click();
  await expect(panel).toContainText("已停止生成");
  await expect(panel.locator(".assistant-message-partial")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { assistantAborted: boolean }).assistantAborted)).toBe(true);
  await input.fill("重试问题"); await panel.getByRole("button", { name: "发送", exact: true }).click();
  await emit({ type: "delta", text: "不完整回答", round: 1 });
  await emit({ type: "error", code: "VALIDATION_ERROR", status: 400, message: "模型响应中断" });
  await expect(panel.getByRole("alert")).toContainText("模型响应中断");
  await expect(panel.locator(".assistant-message-partial")).toHaveCount(0);
  await input.fill("完成测试"); await panel.getByRole("button", { name: "发送", exact: true }).click();
  await emit({ type: "delta", text: "完整回答", round: 1 });
  await emit({ type: "done", result: { conversationId: "stream-ui", text: "完整回答", entries: [], questionId: "stream-question" } });
  await expect(panel.locator(".assistant-feedback")).toBeVisible();
  await expect(panel.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

for (const openOrder of ["order-first", "assistant-first"] as const) test(`order read drawers stay independent: ${openOrder}`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "covers the modal desktop drawer and responsive transition in one journey");
  await enabledUi(page);
  await page.route("**/api/v1/assistant/chat", route => route.fulfill({ json: {
    conversationId: "independent-drawers", text: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 项：请在订单页面核对操作。`).join("\n\n"), entries: []
  } }));
  await login(page); const id = process.env.ASSISTANT_TEST_ORDER_ID ?? await order(page.request);
  const details = await (await page.request.get(`/api/v1/orders/${id}`)).json() as OrderViewDto;
  await page.reload();
  const trigger = page.locator(".assistant-trigger:not(.assistant-trigger-compact)").filter({ visible: true });
  const panel = page.getByTestId("ai-assistant-panel"), messages = panel.locator(".assistant-messages");
  async function prepareConversation() {
    await page.getByLabel("向 AI 助手提问").fill("合成滚动测试");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await expect(panel.locator(".assistant-message-assistant")).toContainText("第 30 项");
    await messages.evaluate(el => { el.scrollTop = 100; });
    await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(100);
  }
  if (openOrder === "assistant-first") await trigger.click();
  if (openOrder === "assistant-first") await prepareConversation();
  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${details.currentSegment.inventoryUnitId}"][data-service-date="${details.currentSegment.arrivalDate}"]`);
  await cell.focus(); await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await openQuickPopoverOrderDrawer(popover, "助手回归");
  const drawer = page.locator("dialog[open]").last();
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate(el => el.matches(":modal"))).toBe(true);
  if (openOrder === "order-first") await drawer.locator(":scope > .modal-shell").getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(drawer).toBeVisible();
  if (openOrder === "order-first") await prepareConversation();
  await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(100);
  for (const width of [1440, 1024, 900, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel).toBeVisible();
    await expect(async () => {
      const form = await drawer.locator(":scope > .modal-shell").boundingBox(), assistant = await panel.boundingBox();
      expect(form && assistant && (form.x + form.width <= assistant.x + 1 || form.y + form.height <= assistant.y + 1)).toBe(true);
    }).toPass();
    await expect(drawer.getByRole("button", { name: "查看完整订单", exact: true })).toBeVisible();
    const body = drawer.locator(":scope > .modal-shell > .modal-body");
    await body.evaluate(el => { el.scrollTop = 100; });
    const scrollTop = await body.evaluate(el => el.scrollTop);
    await page.getByLabel("向 AI 助手提问").fill("保留助手草稿");
    // The calendar is inert while the drawer is open; use its local switch.
    const layoutTrigger = drawer.locator(":scope > .modal-shell").getByRole("button", { name: "AI 助手", exact: true });
    // Cover both the panel close button and the drawer toggle, including its icon.
    for (const closeButton of [panel.getByRole("button", { name: "关闭 AI 助手" }), layoutTrigger.locator("svg")]) {
      await closeButton.click();
      await expect(panel).toBeHidden();
      await expect(drawer).toBeVisible();
      await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(scrollTop);
      await expect(async () => {
        const bounds = await drawer.boundingBox();
        expect(bounds!.x + bounds!.width).toBeCloseTo(width, 0);
      }).toPass();
      await layoutTrigger.click();
      await expect(drawer).toBeVisible();
      await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("保留助手草稿");
      await expect.poll(() => body.evaluate(el => el.scrollTop)).toBe(scrollTop);
      await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(100);
    }
    await page.screenshot({ path: testInfo.outputPath(`assistant-order-drawer-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByLabel("向 AI 助手提问").fill("仅编辑助手草稿");
  let confirmation = false;
  page.on("dialog", dialog => { confirmation = true; void dialog.dismiss(); });
  // Assistant draft changes must not mark the order form as edited.
  await drawer.locator(":scope > .modal-shell").getByRole("button", { name: "关闭", exact: true }).first().press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(confirmation).toBe(false);
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("仅编辑助手草稿");
  await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(100);
  await expect(panel.locator(".assistant-message-assistant")).toContainText("第 30 项");
  const reopenBounds = (await page.getByRole("button", { name: "打开订单详情", exact: true }).boundingBox())!;
  const panelBounds = (await panel.boundingBox())!;
  expect(reopenBounds.y + reopenBounds.height).toBeLessThanOrEqual(panelBounds.y);
  // Genuine outside clicks still dismiss only the read drawer.
  await page.setViewportSize({ width: 1440, height: 900 });
  await cell.press("Enter");
  await openQuickPopoverOrderDrawer(popover, "助手回归");
  await expect(drawer).toBeVisible();
  const background = (await page.locator(".main-content").boundingBox())!;
  await page.mouse.click(background.x + 20, background.y + 20);
  await expect(drawer).toHaveCount(0);
  await expect(panel).toBeVisible();
  // Moving a hidden assistant between the page and a drawer must also preserve reading position.
  await panel.getByRole("button", { name: "关闭 AI 助手" }).click();
  await cell.press("Enter");
  await openQuickPopoverOrderDrawer(popover, "助手回归");
  await expect(drawer).toBeVisible();
  await drawer.locator(":scope > .modal-shell").getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(drawer).toHaveCount(0);
  await trigger.click();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("仅编辑助手草稿");
  await expect.poll(() => messages.evaluate(el => el.scrollTop)).toBe(100);
});

test("assistant can open after a modal form and each pane preserves the other's draft", async ({ page }, testInfo) => {
  await enabledUi(page);
  await login(page); const id = process.env.ASSISTANT_TEST_ORDER_ID ?? await order(page.request);
  await page.goto(`/orders/${id}`);
  await page.locator('[data-order-action="ADJUST_DEPARTURE"]').click();
  const dialog = page.locator("dialog[open]"), panel = page.getByTestId("ai-assistant-panel");
  const shell = dialog.locator(":scope > .modal-shell"), note = shell.locator("textarea").last();
  await note.fill("关闭助手也必须保留的订单备注");
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && /command-previews|\/quotes/.test(request.url())) writes++; });
  await shell.getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(note).toHaveValue("关闭助手也必须保留的订单备注");
  await expect(async () => {
    const form = await shell.boundingBox(), assistant = await panel.boundingBox();
    expect(form && assistant && (form.x + form.width <= assistant.x + 1 || form.y + form.height <= assistant.y + 1)).toBe(true);
  }).toPass();
  await page.getByLabel("向 AI 助手提问").fill("未发送的助手问题");
  await panel.getByRole("button", { name: "关闭 AI 助手" }).click();
  await expect(panel).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(note).toHaveValue("关闭助手也必须保留的订单备注");
  await shell.getByRole("button", { name: "AI 助手", exact: true }).click();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("未发送的助手问题");
  await page.screenshot({ path: testInfo.outputPath("assistant-form-independent.png") });
  await shell.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(page.getByLabel("向 AI 助手提问")).toHaveValue("未发送的助手问题");
  expect(writes).toBe(0);
});
