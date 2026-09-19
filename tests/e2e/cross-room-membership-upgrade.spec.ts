import { expect, test, type APIRequestContext } from "@playwright/test";
import { createDatabase } from "../../packages/db/src/database.ts";

const propertyId = "prop_qintopia_demo";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
function dateShift(days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function command(request: APIRequestContext, commandType: string, input: Record<string, unknown>) {
  const nonce = crypto.randomUUID();
  const response = await request.post("/api/v1/command-previews", {
    headers: { "idempotency-key": `p-${nonce}`, "x-correlation-id": nonce }, data: { commandType, input: { propertyId, ...input } }
  });
  expect(response.status(), await response.text()).toBe(200);
  const { preview } = await response.json();
  const confirmation = await request.post(`/api/v1/command-previews/${preview.previewId}/confirm`, {
    headers: { "idempotency-key": `c-${nonce}`, "x-correlation-id": nonce },
    data: { propertyId, commandType, confirmation: true, expectedEffectHash: preview.effectHash,
      reason: { code: input.backfill ? "BACKFILL_STAY" : commandType, note: input.backfillReason ?? "合成跨房型升级验收" } }
  });
  const receipt = await confirmation.json();
  expect(receipt.businessCommitted, JSON.stringify(receipt)).toBe(true);
  return receipt.result;
}

test("cross-room upgrade retains the guest room and presents explicit consent, real funds and seven nights", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/accounts");
  await page.getByTestId("login-username").fill("operator");
  await page.getByTestId("login-password").fill("demo-pass-2026");
  await page.getByTestId("login-submit").click();
  await expect(page.getByRole("heading", { name: "我的账号" })).toBeVisible();
  const db = createDatabase(process.env.E2E_DATABASE_URL ?? "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e");
  const unit = await db.selectFrom("inventory_units").select(["id", "code"])
    .where("room_type_code", "=", "private_bath_standard").where("active", "=", true).orderBy("code")
    .offset(testInfo.project.name === "mobile" ? 1 : 0).executeTakeFirstOrThrow();
  await db.destroy();
  const phone = testInfo.project.name === "mobile" ? "19900006502" : "19900006501";
  const member = await command(page.request, "CREATE_MEMBER", { fullName: "跨房型升级合成客人", nickname: `跨房型-${testInfo.project.name}`, phone, wechat: "synthetic-cross-room" });
  const quoteResponse = await page.request.post("/api/v1/quotes", {
    headers: { "idempotency-key": crypto.randomUUID(), "x-correlation-id": crypto.randomUUID() },
    data: { propertyId, inventoryUnitId: unit.id, stayType: "CUSTOM", arrivalDate: dateShift(-6), departureDate: dateShift(1), pricingPolicyVersionId: "policy_qintopia_public_2026_rev561_v1" }
  });
  expect(quoteResponse.status(), await quoteResponse.text()).toBe(200);
  const { quote } = await quoteResponse.json();
  const created = await command(page.request, "CREATE_ORDER", { quoteId: quote.quoteId,
    primaryGuest: { fullName: "跨房型升级合成客人", nickname: `跨房型-${testInfo.project.name}`, phone },
    bookingChannelCode: "WECOM", channelOrderReference: null, backfill: true, backfillReason: "补录合成在住验收" });
  await command(page.request, "RECORD_COLLECTION", { orderId: created.orderId, amountMinor: 72_000,
    method: "WECOM", transactionReference: `SYNTHETIC-CROSS-SOURCE-${testInfo.project.name}` });
  await page.goto(`/orders/${created.orderId}`);
  await page.getByTestId("convert-stay-collections-to-membership").click();
  const dialog = page.getByRole("dialog", { name: "升级会员", exact: true });
  await dialog.getByRole("combobox", { name: "会员产品", exact: true }).selectOption("membership_product_private_bath_single_v1");
  await expect(dialog.getByLabel("会员成交价（元）")).toHaveValue("2160");
  await dialog.getByTestId("conversion-remaining-payment-reference").fill(`SYNTHETIC-CROSS-REMAINING-${testInfo.project.name}`);
  await dialog.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(dialog).toContainText("请确认本次临时安排其他整房");
  await dialog.getByLabel("本次临时安排其他整房", { exact: true }).check();
  await dialog.getByLabel("临时安排原因", { exact: true }).fill("客户升级独卫单人间会员，本次保留原房间");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("cross-room-upgrade-form.png") });
  await dialog.getByRole("button", { name: "下一步", exact: true }).click();
  const effect = page.getByTestId("command-effect");
  await expect(effect).toContainText("本次临时安排其他整房");
  for (const text of ["¥720.00", "¥1,440.00", "¥2,160.00", "7 间夜", "23 间夜"]) await expect(effect).toContainText(text);
  await expect(page.getByTestId("confirm-command")).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("cross-room-upgrade-review.png") });
  await page.getByTestId("confirm-command").click();
  await expect(page.getByTestId("convert-stay-collections-to-membership")).toHaveCount(0);
  await page.reload();
  const view = await (await page.request.get(`/api/v1/orders/${created.orderId}`)).json();
  expect(view.order.status).toBe("CHECKED_IN");
  expect(view.membershipConversion.memberId).toBe(member.memberId);
  expect(view.amounts.currentContractAmount.minorUnits).toBe(0);
  expect(view.coverageSet.filter((c: { status: string }) => c.status === "CONSUMED")).toHaveLength(7);
  expect(view.effectiveArrangement.intervals.every((i: { inventoryUnitId: string }) => i.inventoryUnitId === unit.id)).toBe(true);
  expect(view.amendments.find((a: { amendment_type: string }) => a.amendment_type === "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP").payload.crossRoomUpgrade.reason).toContain("本次保留原房间");
  await expect(page.getByTestId("extend-stay")).toHaveCount(0);
  await expect(page.getByTestId("temporary-other-room-arrangement-history")).toContainText("客户升级独卫单人间会员，本次保留原房间");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("cross-room-upgrade-result.png") });
  expect(errors).toEqual([]);
});
