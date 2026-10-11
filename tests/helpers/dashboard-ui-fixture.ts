import type { Page } from "@playwright/test";
import type { DashboardDetailsResponse, DashboardResponse } from "@qintopia/contracts";
import type { MetaDto, PrincipalDto } from "../../apps/web/src/types";

const businessDate = "2026-10-09";
const asOf = "2026-10-09T04:00:00.000Z";
const money = { currency: "CNY", collectedMinor: "600000", refundedMinor: "20000", correctedMinor: "-1000", netMinor: "579000", reviewCount: 0, reviewMinor: "0" };
function dateAfter(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dashboardFixture(url: URL): DashboardResponse {
  const propertyId = url.pathname.split("/")[4]!;
  const from = url.searchParams.get("from") ?? "2026-09-09";
  const to = url.searchParams.get("to") ?? "2026-10-08";
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const paid = url.searchParams.has("building") ? 3 : 6;
  const history = { paidUnitNights: paid * days, freeUnitNights: days, capacityUnitNights: 20 * days, occupancyRate: paid * 5, quality: "COMPLETE" as const, reviewCount: 0, reason: "界面回归样例：按当前目录口径" };
  return {
    propertyId, asOf, businessDate, timezone: "Asia/Shanghai", currency: "CNY", definitionVersion: "2026-10-09.1",
    range: { from, to }, previousRange: { from: dateAfter(from, -days), to: dateAfter(from, -1) },
    history, previous: history, occupancyChangePoints: 0,
    stayTrend: Array.from({ length: days }, (_, index) => ({ date: dateAfter(from, index), paid, free: 1, capacity: 20, quality: "COMPLETE" })),
    breakdown: [{ building: "一号楼", roomType: "标准双人间", ...history }],
    sources: [{ source: "WECOM", unitNights: paid * days }, { source: "FREE", unitNights: days }],
    money: [money], previousMoney: [money], moneyTrend: [{ date: to, money: [money] }],
    current: { paidGuests: propertyId === "ui-b" ? 2 : 12, freeGuests: 1, guestReviewOrders: 0, arrivals: 3, departures: 2, overdue: 1, debts: [{ currency: "CNY", amountMinor: "40000", count: 2 }], retained: [{ currency: "CNY", amountMinor: "20000", count: 1 }] },
    future: Array.from({ length: Number(url.searchParams.get("futureDays") ?? 14) }, (_, index) => ({ date: dateAfter(businessDate, index), paid: 6, free: 1, maintenance: 1, review: 0, availableRooms: 5, availableBeds: 7, capacity: 20, quality: "COMPLETE" })),
    filters: { buildings: ["一号楼", "二号楼"], roomTypes: ["标准双人间", "六人床位房"] }, warnings: []
  };
}

export async function installDashboardUiFixture(page: Page) {
  const state = { fail: false, requests: [] as URL[], unexpected: [] as string[], hold: null as null | ((url: URL) => Promise<void>) };
  const principal: PrincipalDto = { subjectId: "ui-test-only", displayName: "界面回归样例", credentialType: "SESSION", propertyAccess: { "ui-a": "READ", "ui-b": "READ" }, propertyCommandGrants: {}, allowedActions: {} };
  const meta: MetaDto = { properties: ["ui-a", "ui-b"].map((id, index) => ({ id, code: id, name: `界面回归样例${index + 1}`, timezone: "Asia/Shanghai", currency: "CNY" })), inventoryUnits: [], pricingPolicyVersions: [], members: [], memberContracts: [], membershipProducts: [] };
  // Network fixtures isolate UI behavior; they do not validate login, permissions, SQL, or runtime readiness.
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/me") return route.fulfill({ json: principal });
    if (url.pathname === "/api/v1/meta") return route.fulfill({ json: meta });
    if (url.pathname === "/api/v1/auth/logout") return route.fulfill({ status: 204 });
    if (url.pathname === "/api/v1/assistant/settings") return route.fulfill({ json: { version: 1, enabled: false, baseUrl: "", model: "", hasKey: false, keyReady: false, canManage: false, managementPropertyId: null, updatedAt: null } });
    if (/\/properties\/ui-[ab]\/dashboard(?:\/details)?$/.test(url.pathname)) {
      state.requests.push(url);
      await state.hold?.(url);
      if (state.fail) return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "界面回归：服务暂不可用" } });
      const summary = dashboardFixture(url);
      if (url.pathname.endsWith("/details")) {
        const pageNumber = Number(url.searchParams.get("page") ?? 0);
        const empty = url.searchParams.get("metric") === "FREE";
        const detail: DashboardDetailsResponse = {
          asOf, definitionVersion: summary.definitionVersion, range: summary.range, changedSinceSummary: pageNumber > 0,
          items: empty ? [] : [{ id: `ui-fact-${pageNumber}`, date: summary.range.from, metric: "PAID", label: `界面样例事实 ${pageNumber + 1}`, orderId: "ui-order", memberId: null, unitId: null, units: 1, amountMinor: null, currency: null, registeredAt: null, businessDate: null, reason: "仅供界面回归，不代表真实业务记录" }],
          total: empty ? 0 : 51, page: pageNumber, pageSize: 50
        };
        return route.fulfill({ json: detail });
      }
      return route.fulfill({ json: summary });
    }
    state.unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  return state;
}
