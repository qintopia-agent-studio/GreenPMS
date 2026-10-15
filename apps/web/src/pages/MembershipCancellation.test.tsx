import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { MembershipOrderSummaryDto } from "../types";
import { MembershipOrdersPanel, CancelMembershipOrderDialog } from "./MembersPage";
import { u1PreviewHasBusinessEvidence } from "../ui";

const empty = { order: { id: "duplicate", product_name: "公卫四人间会员", status: "DRAFT", currency: "CNY",
  listed_price_minor: 93600, agreed_price_minor: 93600, price_adjustment_minor: 0, entitlement_units: 30,
  entitlement_unit_kind: "BED_NIGHT", allowed_inventory_kind: "BED", contract_id: null, entitlement_lot_id: null },
  paymentFacts: [], paymentTotalMinor: 0, paymentDifferenceMinor: -93600 } as unknown as MembershipOrderSummaryDto;
const render = (summary: MembershipOrderSummaryDto, canCancel = true) => renderToStaticMarkup(createElement(MemoryRouter, null,
  createElement(MembershipOrdersPanel, { view: { membershipProducts: [], membershipOrders: [summary] } as never,
    disabled: false, canCreate: true, canRecordPayment: true, canCorrectPayment: true, canActivate: true, canCancel,
    onCreate() {}, onPayment() {}, onCorrect() {}, onActivate() {}, onCancel() {} })));
describe("空白会员订单取消", () => {
  it("仅向有权限人员展示空白草稿取消入口", () => {
    expect(render(empty)).toContain('data-testid="cancel-membership-order"');
    expect(render(empty, false)).not.toContain('data-testid="cancel-membership-order"');
    for (const summary of [
      { ...empty, order: { ...empty.order, status: "ACTIVE" as const } },
      { ...empty, order: { ...empty.order, contract_id: "contract" } },
      { ...empty, order: { ...empty.order, entitlement_lot_id: "lot" } },
      { ...empty, paymentFacts: [{ fact_id: "p", fact_type: "COLLECTION", net_effect_minor: 0 }] as never }
    ]) expect(render(summary)).not.toContain('data-testid="cancel-membership-order"');
  });
  it("取消后展示原因及操作人，不提示差额也不允许收款、生效或再次取消", () => {
    const html = render({ ...empty, order: { ...empty.order, status: "VOIDED" }, cancellation: {
      reason: "重复办理", actor_display_name: "工作人员甲", created_at: "2026-10-15T08:00:00Z", command_id: "cmd"
    } });
    for (const text of ["已取消", "重复办理", "工作人员甲"]) expect(html).toContain(text);
    for (const id of ["membership-payment-difference", "record-membership-payment", "activate-membership-order", "cancel-membership-order"]) expect(html).not.toContain(`data-testid="${id}"`);
    expect(render({ ...empty, order: { ...empty.order, status: "VOIDED" } })).toContain("已作废");
  });
  it("原因表单支持退回编辑，不会以空白原因提交", () => {
    const html = renderToStaticMarkup(createElement(CancelMembershipOrderDialog, { propertyId: "p", summary: empty, onClose() {}, onSubmit() {} }));
    expect(html).toContain("取消原因");
    expect(html).toContain('disabled=""');
  });
  it("核对证据须绑定目标订单及原始原因", () => {
    const effect = { operation: "CANCEL_MEMBERSHIP_ORDER", membershipOrderId: "duplicate", memberName: "山风", productName: "公卫四人间会员", reason: "重复办理", fromStatus: "DRAFT", toStatus: "VOIDED" };
    const input = { membershipOrderId: "duplicate", reason: "重复办理" };
    expect(u1PreviewHasBusinessEvidence("CANCEL_MEMBERSHIP_ORDER", effect, input)).toBe(true);
    expect(u1PreviewHasBusinessEvidence("CANCEL_MEMBERSHIP_ORDER", { ...effect, membershipOrderId: "normal" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("CANCEL_MEMBERSHIP_ORDER", { ...effect, reason: "别的原因" }, input)).toBe(false);
    expect(u1PreviewHasBusinessEvidence("CANCEL_MEMBERSHIP_ORDER", { ...effect, hiddenPayment: 93600 }, input)).toBe(false);
  });
});
