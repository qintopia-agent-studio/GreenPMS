import { describe, expect, it } from "vitest";
import { dashboardMemberUsage, usageKey, type DashboardMemberUsageData } from "./dashboard-member-usage.ts";

const date = "2026-10-22";
function fixture(): DashboardMemberUsageData {
  return {
    members: [{ id: "member", full_name: "来源会员", nickname: "来源会员" }],
    contracts: [{ id: "contract", member_id: "member", membership_order_id: "membership", status: "ACTIVE" }],
    lots: [{ id: "lot", contract_id: "contract", status: "ACTIVE" }],
    membershipOrders: [{ id: "membership", member_id: "member", contract_id: "contract", entitlement_lot_id: "lot", status: "ACTIVE", created_by_command_id: "convert", activated_by_command_id: "convert" }],
    orders: [{ id: "order", member_id: "member", member_contract_id: "contract" }],
    coverage: [{ id: "coverage", order_id: "order", contract_id: "contract", lot_id: "lot", service_date: date, status: "CONSUMED" }],
    ledger: [{ fact_id: "consume", order_id: "order", lot_id: "lot", service_date: date, coverage_id: "coverage", entry_type: "CONSUME", quantity_delta: 0, command_id: "check-in" }]
  };
}
const result = (data: DashboardMemberUsageData) => dashboardMemberUsage(data).get(usageKey("order", date));

describe("会员权益实际净核销依据", () => {
  it.each(["missing-consume", "duplicate-consume", "wrong-quantity", "wrong-lot", "wrong-date", "double-restore"])("%s不伪造已确认使用", issue => {
    const data = fixture();
    if (issue === "missing-consume") data.ledger = [];
    if (issue === "duplicate-consume") data.ledger = [...data.ledger, { ...data.ledger[0]!, fact_id: "another-consume" }];
    if (issue === "wrong-quantity") data.ledger = [{ ...data.ledger[0]!, quantity_delta: -1 }];
    if (issue === "wrong-lot") data.ledger = [{ ...data.ledger[0]!, lot_id: "other-lot" }];
    if (issue === "wrong-date") data.ledger = [{ ...data.ledger[0]!, service_date: "2026-10-21" }];
    if (issue === "double-restore") data.ledger = [...data.ledger, ...[1, 2].map(index => ({ ...data.ledger[0]!, fact_id: `restore-${index}`, entry_type: "RESTORE" as const, quantity_delta: 1 }))];
    expect(result(data)).toMatchObject({ status: "UNKNOWN", reasonLabel: "权益使用记录待核对" });
  });
  it.each(["contract", "lot", "membership", "wrong-owner", "wrong-contract", "wrong-membership-lot", "void-contract", "void-lot", "void-membership", "draft-membership"])("%s关联缺失或作废不当作正常使用", issue => {
    const data = fixture();
    if (issue === "contract") data.contracts = [];
    if (issue === "lot") data.lots = [];
    if (issue === "membership") data.membershipOrders = [];
    if (issue === "wrong-owner") data.orders = [{ ...data.orders[0]!, member_id: "other-member" }];
    if (issue === "wrong-contract") data.coverage = [{ ...data.coverage[0]!, contract_id: "other-contract" }];
    if (issue === "wrong-membership-lot") data.membershipOrders = [{ ...data.membershipOrders[0]!, entitlement_lot_id: "other-lot" }];
    if (issue === "void-contract") data.contracts = [{ ...data.contracts[0]!, status: "VOIDED" }];
    if (issue === "void-lot") data.lots = [{ ...data.lots[0]!, status: "VOIDED" }];
    if (issue === "void-membership") data.membershipOrders = [{ ...data.membershipOrders[0]!, status: "VOIDED" }];
    if (issue === "draft-membership") data.membershipOrders = [{ ...data.membershipOrders[0]!, status: "DRAFT" }];
    expect(result(data)?.status).toBe("UNKNOWN");
  });
  it("合法旧合同无memberId仍按明确订单合同及净核销确认，显示名可由合同提供", () => {
    const data = fixture(); data.members = []; data.membershipOrders = [];
    data.contracts = [{ ...data.contracts[0]!, member_id: null, membership_order_id: null, member_name: "历史权益持有人" }];
    data.orders = [{ ...data.orders[0]!, member_id: null }];
    data.ledger = [{ ...data.ledger[0]!, fact_id: "hold", entry_type: "HOLD", quantity_delta: -1 }, ...data.ledger];
    expect(result(data)).toEqual({ status: "CONFIRMED", memberId: null, memberName: "历史权益持有人", basis: "MEMBER_ENTITLEMENT" });
    data.contracts = [{ ...data.contracts[0]!, member_name: "" }];
    expect(result(data)).toEqual({ status: "CONFIRMED", memberId: null, basis: "MEMBER_ENTITLEMENT" });
    data.orders = [{ ...data.orders[0]!, member_contract_id: "other-contract" }];
    expect(result(data)?.status).toBe("UNKNOWN");
  });
  it("缺会员显示档案不影响已确认使用，但非空会员权属冲突仍待核对", () => {
    const data = fixture(); data.members = [];
    expect(result(data)).toMatchObject({ status: "CONFIRMED", memberId: "member", basis: "MEMBER_ENTITLEMENT" });
    data.orders = [{ ...data.orders[0]!, member_id: "different-member" }];
    expect(result(data)?.status).toBe("UNKNOWN");
    data.orders = [{ ...data.orders[0]!, member_id: "member" }];
    data.contracts = [{ ...data.contracts[0]!, member_id: null, membership_order_id: null }];
    expect(result(data)?.status).toBe("UNKNOWN");
  });
  it("在住转换的逐日CONVERSION_CONSUME覆盖有效，返还后净使用为零", () => {
    const data = fixture(); data.ledger = [{ ...data.ledger[0]!, entry_type: "CONVERSION_CONSUME", quantity_delta: -1 }];
    expect(result(data)).toMatchObject({ status: "CONFIRMED", basis: "MEMBER_ENTITLEMENT" });
    data.ledger = [...data.ledger, { ...data.ledger[0]!, fact_id: "restore", entry_type: "RESTORE", quantity_delta: 1 }];
    expect(result(data)).toBeUndefined();
  });
  it.each(["state", "type", "quantity", "created-command", "activated-command"])("无coverage转换的%s依据不完整须待核对", issue => {
    const data = fixture(); data.coverage = [];
    data.ledger = [{ ...data.ledger[0]!, coverage_id: null, entry_type: "CONVERSION_CONSUME", quantity_delta: -1, command_id: "convert", command_type: "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", command_state: "APPLIED" }];
    if (issue === "state") data.ledger = [{ ...data.ledger[0]!, command_state: "EXECUTING" }];
    if (issue === "type") data.ledger = [{ ...data.ledger[0]!, command_type: "CREATE_ORDER" }];
    if (issue === "quantity") data.ledger = [{ ...data.ledger[0]!, quantity_delta: 0 }];
    if (issue === "created-command") data.membershipOrders = [{ ...data.membershipOrders[0]!, created_by_command_id: "other-command" }];
    if (issue === "activated-command") data.membershipOrders = [{ ...data.membershipOrders[0]!, activated_by_command_id: "other-command" }];
    expect(result(data)?.status).toBe("UNKNOWN");
  });
  it("同一订单同日多个同来源有效记录仍只有一个统计份额", () => {
    const data = fixture();
    data.coverage = [...data.coverage, { ...data.coverage[0]!, id: "second-coverage" }];
    data.ledger = [...data.ledger, { ...data.ledger[0]!, fact_id: "second-consume", coverage_id: "second-coverage" }];
    expect(dashboardMemberUsage(data).size).toBe(1);
    expect(result(data)?.status).toBe("CONFIRMED");
  });
});
