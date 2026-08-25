import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { AuthPrincipal, CommandEnvelope, CommandType, ReceiptDto } from "@qintopia/contracts";
import { todayInTimeZone } from "@qintopia/domain";
import type { Kysely } from "kysely";
import { confirmCommandPreview, createCommandPreview } from "../../packages/db/src/commands/service.ts";
import { createDatabase } from "../../packages/db/src/database.ts";
import { withPropertyClockForTesting } from "../../packages/db/src/members.ts";
import { createQuoteForTesting } from "../../packages/db/src/pricing-service.ts";
import type { Database } from "../../packages/db/src/schema.ts";
import { resetE2eDatabase } from "./reset-database.ts";

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL
  ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e";
const propertyId = "prop_qintopia_demo";
const pricingPolicyVersionId = "policy_qintopia_public_2026_rev561_v1";
const operator = { username: "operator", password: "demo-pass-2026" };

const setupPrincipal: AuthPrincipal = {
  subjectId: "subject_demo_agent",
  credentialId: "token_demo_write",
  credentialType: "TOKEN",
  displayName: "完成住宿浏览器验收数据",
  propertyAccess: new Map([[propertyId, "WRITE"]])
};

interface CompleteStayFixture {
  orderId: string;
  nickname: string;
  arrivalDate: string;
  departureDate: string;
  contractAmountMinor: number;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isDesktop(testInfo: TestInfo): boolean {
  return testInfo.project.name === "desktop";
}

async function execute(
  db: Kysely<Database>,
  commandType: CommandType,
  input: Record<string, unknown>,
  key: string
): Promise<ReceiptDto> {
  const prepared = await createCommandPreview(db, setupPrincipal, { commandType, input } as CommandEnvelope, {
    idempotencyKey: `${key}-preview`,
    correlationId: key
  });
  const receipt = await confirmCommandPreview(db, setupPrincipal, prepared.preview.previewId, {
    propertyId,
    commandType,
    confirmation: true,
    expectedEffectHash: prepared.preview.effectHash,
    reason: commandType === "CREATE_ORDER"
      ? { code: "CREATE_STANDARD_ORDER", note: "" }
      : { code: "E2E_SETUP", note: "准备完成住宿浏览器验收" }
  }, {
    idempotencyKey: `${key}-confirm`,
    correlationId: key
  });
  if (!receipt.businessCommitted) {
    throw new Error(`${key} did not commit: ${receipt.error?.code ?? receipt.executionStatus}`);
  }
  return receipt;
}

async function prepareCompleteStayFixture(): Promise<CompleteStayFixture> {
  await resetE2eDatabase(e2eDatabaseUrl);
  const db = createDatabase(e2eDatabaseUrl);
  try {
    const businessDate = todayInTimeZone("Asia/Shanghai");
    const arrivalDate = addDays(businessDate, -6);
    const departureDate = addDays(businessDate, -1);
    const unit = await db.selectFrom("inventory_units")
      .select(["id", "code"])
      .where("property_id", "=", propertyId)
      .where("code", "=", "202")
      .executeTakeFirstOrThrow();
    const nickname = `完成住宿验收-${businessDate.replaceAll("-", "")}`;

    const created = await withPropertyClockForTesting(new Date(`${arrivalDate}T12:00:00+08:00`), async () => {
      const quote = await createQuoteForTesting(db, {
        propertyId,
        inventoryUnitId: unit.id,
        arrivalDate,
        departureDate,
        pricingPolicyVersionId,
        stayType: "TRANSIENT"
      });
      const receipt = await execute(db, "CREATE_ORDER", {
        propertyId,
        quoteId: quote.quoteId,
        primaryGuest: {
          fullName: "完成住宿浏览器验收住客",
          nickname,
          phone: "13800002020",
          documentNumber: `E2E-COMPLETE-${businessDate}`
        },
        bookingChannelCode: "WECOM",
        channelOrderReference: null
      }, `complete-stay-create-${businessDate}`);
      const orderId = receipt.result?.orderId;
      if (typeof orderId !== "string") throw new Error("Complete-stay fixture order was not created");
      return { orderId, contractAmountMinor: quote.currentContractAmount.minorUnits };
    });

    await withPropertyClockForTesting(new Date(`${arrivalDate}T14:00:00+08:00`), () => execute(db, "RECORD_COLLECTION", {
      propertyId,
      orderId: created.orderId,
      amountMinor: created.contractAmountMinor,
      method: "WECOM",
      transactionReference: `WX-E2E-COMPLETE-${businessDate}`,
      note: "客人实际入住期间已足额收款"
    }, `complete-stay-collection-${businessDate}`));

    return {
      orderId: created.orderId,
      nickname,
      arrivalDate,
      departureDate,
      contractAmountMinor: created.contractAmountMinor
    };
  } finally {
    await db.destroy();
  }
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("login-username").fill(operator.username);
  await page.getByTestId("login-password").fill(operator.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "房间与床位逐日房态", exact: true })
    .or(page.getByRole("heading", { name: "今日运营任务", exact: true }))).toBeVisible({ timeout: 30_000 });
}

async function orderView(page: Page, orderId: string) {
  const response = await page.request.get(`/api/v1/orders/${encodeURIComponent(orderId)}`);
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    order: { status: string };
    stay: { status: string };
    amounts: {
      currentContractAmount: { minorUnits: number };
      netRecordedCollection: { minorUnits: number };
      collectionDifference: { minorUnits: number };
    };
    collectionFacts: Array<{ fact_type: string; amount_minor: number; net_effect_minor: number }>;
  }>;
}

let fixture: CompleteStayFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await prepareCompleteStayFixture();
});

test("完成住宿：已足额收款的逾期预订一次完成且不重复收款", async ({ page }, testInfo) => {
  test.skip(!isDesktop(testInfo), "desktop browser journey");
  await login(page);
  await page.goto(`/orders/${encodeURIComponent(fixture.orderId)}`);
  await expect(page.getByRole("heading", { name: fixture.nickname, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".order-title-row")).toContainText("已预订");

  const before = await orderView(page, fixture.orderId);
  expect(before.order.status).toBe("RESERVED");
  expect(before.stay.status).toBe("PLANNED");
  expect(before.amounts.netRecordedCollection.minorUnits).toBe(fixture.contractAmountMinor);
  expect(before.collectionFacts).toHaveLength(1);

  await page.getByTestId("complete-stay").click();
  const form = page.getByRole("dialog", { name: "完成住宿", exact: true });
  await expect(form).toContainText("客人已经实际入住并离店");
  await form.getByTestId("complete-stay-confirmed").check();
  await form.getByTestId("complete-stay-reason").fill("客人实际入住并已离店，补记遗漏的住宿完成记录");

  const previewResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/v1/command-previews"
      && response.status() === 200
  ));
  await form.getByTestId("complete-stay-submit").click();
  const preview = await previewResponse;
  const previewRequest = preview.request().postDataJSON() as { commandType?: string; input?: Record<string, unknown> };
  expect(previewRequest.commandType).toBe("COMPLETE_STAY");
  expect(previewRequest.input).toMatchObject({
    propertyId,
    orderId: fixture.orderId,
    actualStayCompletedConfirmed: true
  });

  const review = page.getByRole("dialog", { name: "完成住宿", exact: true });
  await expect(review.getByTestId("command-effect")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole("heading", { name: "请核对完成住宿", exact: true })).toBeVisible();
  await expect(review).toContainText(fixture.arrivalDate);
  await expect(review).toContainText(fixture.departureDate);
  await expect(review).toContainText("本次补记实收");
  await expect(review).toContainText("¥0.00");
  await expect(review).toContainText("订单直接成为已结单");
  await expect(review).not.toContainText("无法安全保存本次操作的恢复状态");
  await expect(review.getByRole("button", { name: "查询完成住宿结果", exact: true })).toHaveCount(0);

  const confirmResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && /\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(new URL(response.url()).pathname)
      && response.status() === 200
  ));
  await review.getByRole("button", { name: "确认完成住宿", exact: true }).click();
  await expect(confirmResponse).resolves.toBeTruthy();
  await expect(review).toContainText("操作已完成", { timeout: 30_000 });
  await expect(review.getByRole("region", { name: "完成住宿已记录", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "完成", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".order-title-row").getByText("已退房", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("order-command-recovery")).toHaveCount(0);
  await expect(page.getByText("无法安全保存本次操作的恢复状态", { exact: false })).toHaveCount(0);

  const after = await orderView(page, fixture.orderId);
  expect(after.order.status).toBe("CHECKED_OUT");
  expect(after.stay.status).toBe("COMPLETED");
  expect(after.amounts.currentContractAmount.minorUnits).toBe(fixture.contractAmountMinor);
  expect(after.amounts.netRecordedCollection.minorUnits).toBe(fixture.contractAmountMinor);
  expect(after.amounts.collectionDifference.minorUnits).toBe(0);
  expect(after.collectionFacts).toEqual([
    expect.objectContaining({
      fact_type: "COLLECTION",
      amount_minor: fixture.contractAmountMinor,
      net_effect_minor: fixture.contractAmountMinor
    })
  ]);
});
