import { expect, test } from "@playwright/test";
import { prepareStage13Acceptance, type Stage13AcceptanceFixture } from "./setup-stage13-acceptance";

let fixture: Stage13AcceptanceFixture;
test.beforeAll(async () => { fixture = await prepareStage13Acceptance(process.env.E2E_DATABASE_URL); });

test("server pages preserve detail return context and a historical correction selection across pages", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: fixture.operator.password } });
  const original = (await (await page.request.get("/api/v1/orders?propertyId=prop_qintopia_demo")).json()).orders.find((row: { id: string }) => row.id === fixture.conversion.orderId);
  expect(original).toBeDefined();
  const rows = Array.from({ length: 53 }, (_, index) => ({
    ...original, id: index === 52 ? original.id : `order_page_${String(index).padStart(3, "0")}`,
    current_primary_guest: { ...original.current_primary_guest, nickname: `分页旅人 ${index}` }
  }));
  const seen: URLSearchParams[] = [];
  await page.route("**/api/v1/orders?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    seen.push(query);
    const selected = query.getAll("orderIds");
    const candidates = selected.length ? rows.filter((row) => selected.includes(row.id))
      : query.get("query") === "指定唯一" ? [rows[52]!] : rows;
    const start = query.get("beforeId") ? candidates.findIndex((row) => row.id === query.get("beforeId")) + 1 : 0;
    const pageSize = Number(query.get("pageSize"));
    expect(pageSize).toBeGreaterThan(0);
    const result = candidates.slice(start, start + pageSize);
    await route.fulfill({ json: { businessDate: fixture.businessDate, orders: result, nextCursor: start + pageSize < candidates.length ? result.at(-1)!.id : null } });
  });
  await page.goto("/orders?q=分页&status=CHECKED_OUT");
  const table = page.getByTestId("orders-table");
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.getByRole("link", { name: "分页旅人 52", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.conversion.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("details[data-testid='arrangement-history']")).not.toHaveAttribute("open", "");
  await page.locator("details[data-testid='arrangement-history'] > summary").click();
  await expect(page.getByRole("heading", { name: "原始预订安排", exact: true })).toBeVisible();
  await page.locator("details[data-testid='arrangement-history'] > summary").click();
  await page.locator("details > summary").filter({ hasText: /^计价记录$/ }).click();
  await expect(page.getByRole("heading", { name: "计价记录", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("order-detail.png"), fullPage: true });
  await page.getByRole("link", { name: "返回订单", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("searchbox")).toHaveValue("分页");
  await expect(page.getByRole("combobox", { name: "状态", exact: true })).toHaveValue("CHECKED_OUT");
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("searchbox").fill("指定唯一");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(seen.some((query) => query.get("query") === "指定唯一" && !query.has("beforeId"))).toBe(true);

  await page.getByRole("button", { name: "修改历史安排", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修改历史住宿安排", exact: true });
  const select = dialog.getByRole("combobox", { name: "加入已完成订单", exact: true });
  await expect(select.locator("option")).toHaveCount(26);
  await select.selectOption(rows[0]!.id);
  await dialog.getByRole("button", { name: "加入修改清单", exact: true }).click();
  await dialog.getByRole("button", { name: "下一页住宿", exact: true }).click();
  await expect(select.locator(`option[value="${rows[25]!.id}"]`)).toHaveCount(1);
  await select.selectOption(rows[25]!.id);
  await dialog.getByRole("button", { name: "加入修改清单", exact: true }).click();
  await expect(dialog.locator(".historical-correction-item")).toHaveCount(2);
  await expect(dialog).toContainText("分页旅人 0");
  await expect(dialog).toContainText("分页旅人 25");
  await dialog.getByLabel("查找已完成住宿", { exact: true }).fill("指定唯一");
  await dialog.getByRole("button", { name: "查询住宿", exact: true }).click();
  await expect(select.locator("option")).toHaveCount(2);
  await expect(dialog.locator(".historical-correction-item")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("orders-selection-across-pages.png") });
});
