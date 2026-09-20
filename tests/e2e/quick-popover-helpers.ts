import { expect, type Locator } from "@playwright/test";

// Compact cards keep only common actions; the existing page-level button opens details.
export async function openQuickPopoverOrderDrawer(popover: Locator, nickname?: string): Promise<void> {
  const choices = popover.locator(".room-status-quick-orders button");
  if (await choices.count() > 1) {
    if (!nickname) throw new Error("Multiple orders require an explicit guest selection");
    const choice = choices.filter({ hasText: nickname });
    await expect(choice).toHaveCount(1);
    await choice.click();
  }
  const summary = popover.locator(".room-status-quick-order-heading");
  await expect(summary).toBeVisible({ timeout: 30_000 });
  if (nickname) await expect(summary).toContainText(nickname);
  await popover.getByRole("button", { name: "关闭快捷操作", exact: true }).click();
  await popover.page().getByRole("button", { name: "打开订单详情", exact: true }).click();
}
