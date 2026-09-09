import { expect, test } from "@playwright/test";
const demo = { propertyId: "prop_qintopia_demo", memberId: "member_demo_profile" };

test("history candidates load only on demand and recover without losing prior pages", async ({ page }, testInfo) => {
  await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "demo-pass-2026" } });
  const profileResponse = await page.request.get(`/api/v1/members/${demo.memberId}?propertyId=${demo.propertyId}`);
  expect(profileResponse.ok()).toBe(true);
  const { member, balanceAsOfDate: arrival } = await profileResponse.json();
  const departure = new Date(`${arrival}T00:00:00Z`);
  departure.setUTCDate(departure.getUTCDate() + 1);
  const departureDate = departure.toISOString().slice(0, 10);
  let candidateCalls = 0;
  let detailCalls = 0;
  page.on("request", (request) => {
    if (/\/api\/v1\/orders\/[^/?]+$/.test(new URL(request.url()).pathname)) detailCalls += 1;
  });
  await page.route("**/api/v1/orders?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("reconversionMemberId")).toBe(demo.memberId);
    expect(query.get("pageSize")).toBe("25");
    candidateCalls += 1;
    if (candidateCalls === 1 || candidateCalls === 3) {
      await route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR", message: "测试读取暂时不可用" } });
      return;
    }
    const second = Boolean(query.get("beforeId"));
    await route.fulfill({ json: {
      businessDate: "2026-09-09", nextCursor: second ? null : "order_candidate_first",
      orders: [{
        id: second ? "order_candidate_second" : "order_candidate_first", property_id: demo.propertyId,
        status: "CHECKED_OUT", stay_status: "COMPLETED", booking_channel_code: "WECOM", member_id: null, member_contract_id: null,
        arrival_date: "2026-09-01", departure_date: "2026-09-03", current_unit_code: second ? "102" : "101",
        current_primary_guest: { fullName: member.full_name, nickname: member.nickname, phone: member.phone, documentNumber: member.identity_card_number }
      }]
    } });
  });
  await page.goto(`/members?memberId=${demo.memberId}`);
  await page.getByTestId("open-member-corrections").click();
  await expect(page.getByTestId("member-correction-mode")).toHaveValue("CORRECT_MEMBER_PROFILE");
  expect(candidateCalls).toBe(0);
  await page.getByTestId("member-correction-mode").selectOption("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("历史住宿未能完整载入", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("membership-reconversion-source-stay")).toContainText("住宿尚未载入，请重试");
  await dialog.getByRole("button", { name: "重试载入住宿" }).click();
  const select = dialog.getByTestId("membership-reconversion-source-stay");
  await expect(select).toHaveValue("order_candidate_first");
  await dialog.getByRole("button", { name: "载入更多历史住宿" }).click();
  await expect(dialog.getByRole("button", { name: "重试载入住宿" })).toBeVisible();
  await expect(select).toHaveValue("order_candidate_first");
  await page.screenshot({ path: testInfo.outputPath("candidate-retry.png"), fullPage: true });
  await dialog.getByRole("button", { name: "重试载入住宿" }).click();
  await expect(select.locator("option")).toHaveCount(2);
  await expect(select).toHaveValue("order_candidate_first");
  await expect(dialog.getByRole("button", { name: "载入更多历史住宿" })).toHaveCount(0);
  expect(detailCalls).toBe(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByTestId("arrange-member-stay").click();
  await expect(page).toHaveURL(new RegExp(`\\/\\?propertyId=${demo.propertyId}&memberId=${demo.memberId}$`));
  await expect(page.getByText(/正在为 .* 安排住宿/)).toBeVisible();
  const availability = await (await page.request.get(`/api/v1/properties/${demo.propertyId}/availability?arrivalDate=${arrival}&departureDate=${departureDate}&unitKind=ROOM`)).json();
  const unit = availability.units.find((item: { available: boolean; roomTypeCode: string }) => item.available && item.roomTypeCode === "shared_bath_single");
  expect(unit).toBeDefined();
  let drawer;
  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "新建住宿或锁房", exact: true }).click();
    drawer = page.getByRole("dialog", { name: "新建住宿或锁房", exact: true });
    await drawer.getByTestId("room-status-unit-select").selectOption(unit.id);
  } else {
    await page.getByTestId("arrival-date").fill(arrival);
    const cell = page.locator(`[data-room-status-cell="true"][data-unit-id="${unit.id}"][data-service-date="${arrival}"]`);
    await expect(cell).toBeVisible();
    await cell.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("room-status-quick-popover").getByRole("button", { name: "创建订单", exact: true }).click();
    drawer = page.locator("dialog.room-status-write-drawer");
  }
  await drawer.getByLabel("入住日期", { exact: true }).fill(arrival);
  await drawer.getByLabel("退房日期", { exact: true }).fill(departureDate);
  await drawer.getByRole("button", { name: "创建正常住宿订单", exact: true }).click();
  await expect(page.getByTestId("use-member-entitlement")).toBeChecked();
  await expect(page.getByTestId("member-profile-select")).toHaveValue(demo.memberId);
  await expect(page.getByTestId("primary-guest-name")).toHaveValue(member.full_name);
  await expect(page.getByTestId("primary-guest-phone")).toHaveValue(member.phone);
  await page.screenshot({ path: testInfo.outputPath("member-stay-prefill.png") });

});
