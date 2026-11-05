import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantSettings, AssistantSettingsInput } from "../../packages/contracts/src/assistant.ts";
import { installDashboardUiFixture } from "../helpers/dashboard-ui-fixture";

async function fixture(page: Page) {
  const base = await installDashboardUiFixture(page);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let settings: AssistantSettings = { version: 3, enabled: true, baseUrl: "https://primary.example/v1", model: "slow", hasKey: true, keyReady: true, canManage: true, managementPropertyId: "ui-a", updatedAt: null,
    providers: { primary: { name: "主供应商", enabled: true, baseUrl: "https://primary.example/v1", model: "slow", hasKey: true, testedAt: null }, backup: { name: "备用供应商", enabled: false, baseUrl: "", model: "", hasKey: false, testedAt: null } },
    routing: { state: "primary", retryAfter: null, lastFailure: null, lastCheckedAt: null } };
  await page.route("**/api/v1/assistant/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "GET" ? undefined : route.request().postDataJSON();
    if (body) requests.push({ path, body });
    if (path.endsWith("/settings")) {
      if (body) {
        const input = body as AssistantSettingsInput, role = input.provider ?? "primary", provider = settings.providers![role];
        settings = { ...settings, version: settings.version + 1, enabled: input.enabled, providers: { ...settings.providers!, [role]: { ...provider,
          name: input.name ?? provider.name, enabled: input.providerEnabled ?? provider.enabled, baseUrl: input.baseUrl, model: input.model,
          hasKey: provider.hasKey || Boolean(input.apiKey), testedAt: input.testToken ? "2026-11-05T00:00:00Z" : provider.testedAt } } };
      }
      return route.fulfill({ json: settings });
    }
    if (path.endsWith("/test")) return route.fulfill({ json: { message: "连接与工具调用测试通过。", testToken: `test-${settings.version}-${body.provider}` } });
    if (path.endsWith("/promote-backup")) {
      const { primary, backup } = settings.providers!;
      settings = { ...settings, version: settings.version + 1, baseUrl: backup.baseUrl, model: backup.model,
        providers: { primary: backup, backup: primary } };
      return route.fulfill({ json: settings });
    }
    if (path.endsWith("/recover-primary")) {
      settings = { ...settings, routing: { state: "primary", retryAfter: null, lastFailure: null, lastCheckedAt: "2026-11-05T00:01:00Z" } };
      return route.fulfill({ json: { message: "主供应商已恢复。", settings } });
    }
    return route.fallback();
  });
  return { base, requests, get settings() { return settings; }, set settings(next: AssistantSettings) { settings = next; } };
}

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "AI 助手", exact: true }).filter({ visible: true }).click();
  await expect(page.getByTestId("ai-assistant-panel")).toBeVisible();
}

test("provider cards bind test receipts to connection changes and promote saved tested backup", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/settings/ai");
  const primary = page.getByRole("form", { name: "主用供应商", exact: true });
  const backup = page.getByRole("form", { name: "备用供应商", exact: true });
  await expect(primary.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
  await backup.getByLabel("备用 Base URL", { exact: true }).fill("https://backup.example/v1");
  await backup.getByLabel("备用 API Key", { exact: true }).fill("synthetic-test-key");
  await backup.getByLabel("备用模型名称", { exact: true }).fill("stable");
  await expect(backup.getByLabel("启用备用供应商", { exact: true })).toBeDisabled();
  await backup.getByRole("button", { name: "测试连接", exact: true }).click();
  await backup.getByLabel("启用备用供应商", { exact: true }).check();
  await backup.getByLabel("备用模型名称", { exact: true }).fill("stable-new");
  await expect(backup.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await backup.getByRole("button", { name: "测试连接", exact: true }).click();
  await backup.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(backup.getByLabel("备用 API Key", { exact: true })).toHaveValue("");
  await expect(backup.getByRole("button", { name: "设为主用", exact: true })).toBeEnabled();
  expect(state.requests.filter(request => request.path.endsWith("/settings")).at(-1)?.body).toMatchObject({ provider: "backup", expectedVersion: 3, testToken: "test-3-backup", providerEnabled: true, model: "stable-new" });
  await primary.getByLabel("主用供应商名称").fill("未保存名称");
  await expect(backup.getByRole("button", { name: "设为主用", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重新载入", exact: true }).click();
  await backup.getByRole("button", { name: "设为主用", exact: true }).click();
  await expect(primary.getByLabel("Base URL", { exact: true })).toHaveValue("https://backup.example/v1");
  await expect(backup.getByLabel("备用 Base URL", { exact: true })).toHaveValue("https://primary.example/v1");
  await expect(page.getByText("主备优先级已互换，双方启用状态和已有对话保持不变。", { exact: false })).toBeVisible();
  await expect(backup.getByLabel("启用备用供应商", { exact: true })).toBeChecked();
  await expect(backup.getByRole("button", { name: "设为主用", exact: true })).toBeEnabled();
  expect(state.settings.providers!.backup.testedAt).toBeNull();
  expect(state.requests.filter(request => request.path.endsWith("/promote-backup"))).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: test.info().outputPath("provider-settings.png"), fullPage: true });
  expect(state.base.unexpected).toEqual([]);
});

test("manual recovery refreshes health and manual backup retry keeps original question and context", async ({ page }) => {
  const state = await fixture(page);
  state.settings = { ...state.settings, routing: { state: "backup", retryAfter: "2099-01-01T00:00:00Z", lastFailure: "AI_HTTP_503", lastCheckedAt: null } };
  const received: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/assistant/chat", async route => {
    const input = route.request().postDataJSON(); received.push(input);
    if (received.length === 2) return route.fulfill({ contentType: "text/event-stream", body: frame({ type: "delta", text: "不应保留的半截内容", round: 1 }) + frame({ type: "error", status: 400, code: "VALIDATION_ERROR", message: "合成供应商连接中断", backupRetryAvailable: true }) });
    return route.fulfill({ json: { conversationId: "synthetic-context", text: input.useBackup ? "备用完成的完整回答" : "第一轮已完成", entries: [] } });
  });
  await page.goto("/settings/ai");
  await page.getByRole("button", { name: "立即检查恢复", exact: true }).click();
  await expect(page.getByText("当前优先使用主供应商", { exact: true })).toBeVisible();
  await openAssistant(page);
  const input = page.getByLabel("向 AI 助手提问");
  await input.fill("已有上下文的问题"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("第一轮已完成", { exact: true })).toBeVisible();
  await input.fill("失败后应该原样重试的问题"); await page.getByRole("button", { name: "发送", exact: true }).click();
  const retry = page.getByRole("button", { name: "用备用重新回答", exact: true });
  await expect(retry).toBeVisible(); await expect(page.getByText("不应保留的半截内容", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("provider-backup-retry.png") });
  await input.fill("另外准备的新问题草稿"); await retry.click();
  await expect(page.getByText("备用完成的完整回答", { exact: true })).toBeVisible();
  expect(received).toHaveLength(3);
  expect(received[2]).toEqual({ ...received[1], useBackup: true });
  await expect(input).toHaveValue("另外准备的新问题草稿");
  await expect(page.locator(".assistant-message-user")).toHaveCount(2);
  await expect(retry).toHaveCount(0);
});

test("stopping a backup retry clears partial output and never schedules another retry", async ({ page }) => {
  await fixture(page);
  let requests = 0, release: (() => void) | undefined;
  await page.route("**/api/v1/assistant/chat", async route => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 400, json: { code: "VALIDATION_ERROR", message: "合成失败", details: { backupRetryAvailable: true } } });
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { conversationId: "synthetic-late", text: "不应显示的迟到结果", entries: [] } }).catch(() => {});
  });
  await page.goto("/settings/ai"); await openAssistant(page);
  await page.getByLabel("向 AI 助手提问").fill("停止验收问题"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "用备用重新回答", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.getByText("已停止生成，可以修改问题后重新发送。", { exact: true })).toBeVisible();
  release?.();
  await expect(page.getByRole("button", { name: "用备用重新回答", exact: true })).toHaveCount(0);
  await expect(page.getByText("不应显示的迟到结果", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  expect(requests).toBe(2);
});

test("priority swaps preserve both enabled providers, conversation context and the user's draft in both directions", async ({ page }) => {
  const state = await fixture(page);
  state.settings = { ...state.settings, providers: { ...state.settings.providers!, backup: {
    name: "稳定供应商", enabled: true, baseUrl: "https://backup.example/v1", model: "stable", hasKey: true, testedAt: "2026-11-05T00:00:00Z"
  } } };
  const received: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/assistant/chat", async route => {
    received.push(route.request().postDataJSON());
    return route.fulfill({ json: { conversationId: "context-across-swaps", text: `第 ${received.length} 轮完整回答`, entries: [] } });
  });
  await page.goto("/settings/ai"); await openAssistant(page);
  const input = page.getByLabel("向 AI 助手提问");
  await input.fill("互换前建立上下文"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("第 1 轮完整回答", { exact: true })).toBeVisible();
  await input.fill("互换后继续的草稿");
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  const promote = page.getByRole("button", { name: "设为主用", exact: true });
  await promote.click();
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue("https://backup.example/v1");
  await expect(page.getByLabel("启用主用供应商", { exact: true })).toBeChecked();
  await expect(page.getByLabel("启用备用供应商", { exact: true })).toBeChecked();
  await expect(promote).toBeEnabled();
  expect(state.settings.providers!.backup.testedAt).toBeNull();
  await openAssistant(page);
  await expect(input).toHaveValue("互换后继续的草稿");
  await expect(page.getByText("第 1 轮完整回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("第 2 轮完整回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
  await promote.click();
  await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue("https://primary.example/v1");
  await expect(page.getByLabel("启用主用供应商", { exact: true })).toBeChecked();
  await expect(page.getByLabel("启用备用供应商", { exact: true })).toBeChecked();
  await openAssistant(page);
  await input.fill("换回后继续原有对话"); await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("第 3 轮完整回答", { exact: true })).toBeVisible();
  expect(received.map(request => request.conversationId)).toEqual([undefined, "context-across-swaps", "context-across-swaps"]);
  expect(received[1]?.message).toBe("互换后继续的草稿");
  expect(state.requests.filter(request => request.path.endsWith("/test"))).toHaveLength(0);
  expect(state.requests.filter(request => request.path.endsWith("/settings"))).toHaveLength(0);
  expect(state.requests.filter(request => request.path.endsWith("/promote-backup"))).toHaveLength(2);
  await expect(page.locator(".assistant-message-user")).toHaveCount(3);
  await expect(page.locator(".assistant-message-assistant")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("provider-swap-context.png") });
});

test("an actual SSE response keeps streaming through a priority swap and the next question retains context", async ({ page }) => {
  const state = await fixture(page);
  state.settings = { ...state.settings, providers: { ...state.settings.providers!, backup: {
    name: "稳定供应商", enabled: true, baseUrl: "https://backup.example/v1", model: "stable", hasKey: true, testedAt: "2026-11-05T00:00:00Z"
  } } };
  const received: Array<Record<string, unknown>> = [];
  let pending: ServerResponse | undefined, cancelled = 0;
  // A local synthetic HTTP endpoint sends the first SSE chunk before promotion,
  // then releases the remaining chunks afterward. It tests browser cancellation
  // and context state; real provider selection/DB semantics have separate contracts.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": new URL(page.url()).origin, "Access-Control-Allow-Credentials": "true" });
    response.on("close", () => { if (!response.writableEnded) cancelled++; });
    if (received.length === 1) {
      pending = response;
      response.write(frame({ type: "status", phase: "fallback", round: 1 }));
    } else response.end(frame({ type: "done", result: { conversationId: "stream-across-swap", text: "互换后的后续回答", entries: [] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
    await page.route("**/api/v1/assistant/chat", route => route.continue({ url: endpoint }));
    await page.goto("/settings/ai"); await openAssistant(page);
    const input = page.getByLabel("向 AI 助手提问");
    await input.fill("正在输出时互换"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => received.length).toBe(1);
    await expect(page.getByTestId("ai-assistant-panel").getByRole("status")).toHaveText("正在思考…");
    await expect(page.getByTestId("ai-assistant-panel").getByText(/主服务暂时不可用|备用服务/)).toHaveCount(0);
    pending!.write(frame({ type: "delta", text: "互换前已开始输出", round: 1 }));
    await expect(page.getByText("互换前已开始输出", { exact: true })).toBeVisible();
    await expect(page.getByTestId("ai-assistant-panel").getByRole("status")).toHaveText("正在回答…");
    await page.getByRole("button", { name: "关闭 AI 助手", exact: true }).click();
    await page.getByRole("button", { name: "设为主用", exact: true }).click();
    await expect(page.getByText("主备优先级已互换，双方启用状态和已有对话保持不变。", { exact: false })).toBeVisible();
    await openAssistant(page);
    await expect(page.getByText("互换前已开始输出", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
    expect(cancelled).toBe(0);
    pending!.write(frame({ type: "delta", text: "，互换后继续完成", round: 1 }));
    pending!.end(frame({ type: "done", result: { conversationId: "stream-across-swap", text: "互换前已开始输出，互换后继续完成", entries: [] } }));
    await expect(page.getByText("互换前已开始输出，互换后继续完成", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
    await input.fill("继续这次对话"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("互换后的后续回答", { exact: true })).toBeVisible();
    expect(received).toHaveLength(2);
    expect(received[1]?.conversationId).toBe("stream-across-swap");
    expect(cancelled).toBe(0);
    await page.screenshot({ path: test.info().outputPath("provider-swap-stream.png") });
  } finally {
    pending?.end(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
