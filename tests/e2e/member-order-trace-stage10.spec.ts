import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { prepareStage10MemberTraceAcceptance, type Stage10MemberTraceFixture } from "./setup-stage10-acceptance.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
let fixture: Stage10MemberTraceFixture | undefined;

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

async function login(page: Page, activeFixture: Stage10MemberTraceFixture): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(activeFixture.operator.username);
  await page.getByTestId("login-password").fill(activeFixture.operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async ({}, workerInfo) => {
  if (workerInfo.project.name !== "desktop") return;
  fixture = await prepareStage10MemberTraceAcceptance(e2eDatabaseUrl, {
    suffix: `member-trace-${workerInfo.workerIndex}`
  });
});

test("4.3 member lodging and entitlement records link to each other without exposing internal ids", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop member trace coverage");
  const activeFixture = fixture!;
  const stay = activeFixture.memberStay;
  await login(page, activeFixture);

  const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${stay.unitId}"][data-service-date="${stay.arrivalDate}"]`);
  await expect(cell).toBeVisible();
  await cell.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("room-status-quick-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-unit-id", stay.unitId);
  const orderOption = popover.locator(".room-status-quick-orders button").filter({ hasText: stay.nickname });
  await expect(orderOption).toHaveCount(1);
  await orderOption.click();

  const drawer = page.locator("dialog.room-status-view-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "会员权益", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(drawer).toContainText("公卫单人间会员");
  await expect(drawer).not.toContainText(/contract_[a-z0-9_-]+|lot_[a-z0-9_-]+/i);
  await drawer.getByRole("button", { name: "查看会员档案", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/members\\?memberId=${encodeURIComponent(activeFixture.memberId)}&contractId=`));
  await expect(page.locator(".member-profile-panel")).toContainText(activeFixture.memberName);
  const target = page.getByTestId("member-entitlement-target");
  await expect(target).toBeVisible();
  await expect(target).toContainText("当前住宿使用");
  await expect(target).toContainText("公卫单人间会员");

  const orderLedgerEntry = page.locator("[data-testid^='member-ledger-entry-']").filter({ has: page.getByRole("link", { name: "查看住宿订单", exact: true }) }).first();
  await expect(orderLedgerEntry).toBeVisible();
  await orderLedgerEntry.getByRole("link", { name: "查看住宿订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${encodeURIComponent(stay.orderId)}$`));
  await expect(page.getByRole("heading", { name: stay.nickname, exact: true })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/members?memberId=${encodeURIComponent(activeFixture.memberId)}&contractId=contract_missing`);
  await expect(page.locator(".member-profile-panel")).toContainText(activeFixture.memberName);
  await expect(page.getByTestId("member-entitlement-target")).toHaveCount(0);
  await expect(page.locator(".member-entitlement-lot")).toBeVisible();
  await expect(page.locator(".members-page")).not.toContainText("contract_missing");
});
