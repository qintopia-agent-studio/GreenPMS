/** Default-discovery UI regression; every API response is synthetic and intercepted.
 * No authentication session, command confirmation, database reset or business write. */
import { expect, test } from "@playwright/test";
import order from "./fixtures/refund-reconciliation-order.json";

for (const failFirstResolve of [false, true]) {
  test(`收退款返回修改恢复原选流水${failFirstResolve ? "，读取失败后显式重试" : ""}`, async ({ page }) => {
    const propertyId = order.order.property_id;
    const occurredAt = "2026-07-28T08:00:00Z";
    const source = { id: "ui_collection", kind: "COLLECTION", reference: "UI-COLLECTION-1000", originalTransactionReference: null,
      nickname: "合成付款人", amountMinor: 100000, allocatedMinor: 0, remainingMinor: 100000, status: "AVAILABLE", occurredAt,
      orderId: null, membershipOrderId: null, recommendationReasons: [], allocations: [],
      refundSummary: { succeededMinor: 100000, matchedMinor: 0, unassignedMinor: 100000, pendingCount: 0, reviewCount: 0 } };
    const refund = { ...source, id: "ui_refund", kind: "REFUND", reference: "UI-REFUND-1000", originalTransactionReference: source.reference, refundSummary: undefined };
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const resolutions: string[] = []; let failed = false; let previews = 0; let confirmations = 0;
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/me") return route.fulfill({ json: { subjectId: "ui_refund_operator", credentialType: "SESSION", displayName: "合成核对操作员", propertyAccess: { [propertyId]: "WRITE" }, propertyCommandGrants: { [propertyId]: ["RECORD_COLLECTION", "RECORD_REFUND"] }, allowedActions: { [propertyId]: ["RECORD_COLLECTION", "RECORD_REFUND"] } } });
      if (url.pathname === "/api/v1/meta") return route.fulfill({ json: { properties: [{ id: propertyId, code: "UI", name: "合成门店", timezone: "Asia/Shanghai", currency: "CNY" }], inventoryUnits: order.referencedInventoryUnits, pricingPolicyVersions: [], members: [], memberContracts: [], membershipProducts: [] } });
      if (url.pathname === `/api/v1/orders/${order.order.id}`) return route.fulfill({ json: order });
      if (url.pathname === "/api/v2/retained-funds") return route.fulfill({ json: { items: [], hasMore: false, enabled: true, nextCursor: null } });
      if (["/api/v1/external-payments", "/api/v2/external-payments"].includes(url.pathname)) {
        const billId = url.searchParams.get("billId");
        if (billId) {
          resolutions.push(billId);
          if (failFirstResolve && billId === source.id && !failed) { failed = true; return route.fulfill({ status: 503, json: { code: "UNAVAILABLE", message: "合成短暂读取失败", retryable: true } }); }
        }
        const items = [url.searchParams.get("kind") === "REFUND" ? refund : source].filter(item => !billId || item.id === billId);
        return route.fulfill({ json: { enabled: true, items, hasMore: false, nextBeforeId: null, lastSyncedAt: occurredAt, synchronizationError: false } });
      }
      if (url.pathname === "/api/v1/command-previews") {
        previews += 1;
        const input = route.request().postDataJSON().input;
        expect(input.reconciliation.source.externalPaymentBillId).toBe(source.id);
        expect(input.reconciliation.refunds[0].externalPaymentBillId).toBe(refund.id);
        return route.fulfill({ json: { preview: { previewId: `ui_preview_${previews}`, commandType: "RECORD_REFUND", expiresAt: new Date(Date.now()+60000).toISOString(), effectHash: "a".repeat(64), warnings: [], effect: {
          operation: "RECONCILE_WECOM_REFUNDS", orderId: order.order.id, orderStatus: "RESERVED", currency: "CNY",
          source: { ...input.reconciliation.source, transactionReference: source.reference, occurredAt },
          refunds: [{ ...input.reconciliation.refunds[0], refundReference: refund.reference, occurredAt }], collectedMinor: 100000, refundedMinor: 100000, netEffectMinor: 0, note: input.reconciliation.note
        } }, receipt: { receiptId: "ui_preview_receipt", commandId: "ui_preview_command", correlationId: "ui_preview_correlation", executionStatus: "EXECUTED", businessCommitted: true, committedAt: occurredAt, resourceRefs: [], factRefs: [] } } });
      }
      if (url.pathname.endsWith("/confirm")) confirmations += 1;
      return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Synthetic UI endpoint not used" } });
    });
    await page.goto(`/orders/${order.order.id}`);
    await page.locator('[data-order-action="RECORD_REFUND"]').first().click();
    await page.getByRole("button", { name: "原收款尚未登记，一起补齐", exact: true }).click();
    await page.getByRole("button", { name: "选择需要补记的企业微信原收款", exact: true }).click();
    await page.getByTestId("reconciliation-source-picker").locator(".external-payment-option").click();
    await page.getByRole("button", { name: "选择第 1 笔企业微信退款", exact: true }).click();
    await page.getByTestId("reconciliation-refund-0-picker").locator(".external-payment-option").click();
    await page.getByTestId("reconciliation-note").fill("合成退款补记说明");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("confirm-command")).toBeEnabled();
    await page.getByRole("button", { name: "返回修改", exact: true }).click();
    await expect(page.getByTestId("reconciliation-source-amount")).toHaveValue("1000");
    await expect(page.getByTestId("reconciliation-refund-amount-0")).toHaveValue("1000");
    await expect(page.getByTestId("reconciliation-note")).toHaveValue("合成退款补记说明");
    if (failFirstResolve) {
      const picker = page.getByTestId("reconciliation-source-picker");
      await expect(picker.getByRole("alert")).toContainText("暂时无法核实原选流水");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await expect(page.getByText("原收款资料尚未载入，请稍候核对", { exact: true })).toBeVisible();
      expect(previews).toBe(1);
      await picker.getByRole("button", { name: "重试原选流水", exact: true }).click();
    }
    await expect(page.getByTestId("reconciliation-source-picker").getByRole("button", { name: "选择需要补记的企业微信原收款", exact: true })).toContainText("合成付款人");
    await expect(page.getByTestId("reconciliation-refund-0-picker").getByRole("button", { name: "选择第 1 笔企业微信退款", exact: true })).toContainText("合成付款人");
    expect(resolutions).toContain(source.id); expect(resolutions).toContain(refund.id);
    if (failFirstResolve) expect(resolutions.filter(id => id === source.id)).toHaveLength(2);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("confirm-command")).toBeEnabled();
    expect(previews).toBe(2); expect(confirmations).toBe(0); expect(errors).toEqual([]);
  });
}
