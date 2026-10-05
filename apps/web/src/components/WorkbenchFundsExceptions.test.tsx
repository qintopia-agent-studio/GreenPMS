import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { WorkbenchFundsExceptionItem, WorkbenchFundsExceptionList } from "@qintopia/contracts";
import { WorkbenchFundsContext, WorkbenchFundsReadState, WorkbenchFundsResults, WorkbenchFundsRow } from "./WorkbenchFundsExceptions";

const item: WorkbenchFundsExceptionItem = {
  id: "receipt-1", kind: "UNALLOCATED_COLLECTION", orderId: null, billId: "bill-1", reference: "原单 & 123",
  customerLabel: "付款昵称", roomLabel: null, amountMinor: 60000, occurredAt: "2026-01-01T00:00:00Z", reason: "收款仍有金额未匹配"
};
const navigation = { returnSearch: "propertyId=p&tab=EXCEPTIONS&date=2026-01-01", onNext: () => {}, onFirst: () => {}, hasCursor: false };
const data: WorkbenchFundsExceptionList = { enabled: false, items: [item], total: 81, nextCursor: "opaque/+=" };
function html(content: React.ReactNode) { return renderToStaticMarkup(<MemoryRouter>{content}</MemoryRouter>); }

describe("workbench financial follow-up presentation", () => {
  it("uses the order number for normal excess funds and describes occupants only as a clue", () => {
    const excess = { ...item, kind: "ORDER_EXCESS" as const, reference: null, billId: null, orderId: "order-2", customerLabel: "入住客人" };
    const result = html(<WorkbenchFundsRow item={excess} returnSearch={navigation.returnSearch} />);
    expect(result).toContain("订单编号：order-2");
    expect(result).not.toContain("来源编号待核对");
    for (const markup of [result, html(<WorkbenchFundsContext item={excess} />)]) {
      expect(markup).toContain("入住者线索：入住客人");
      expect(markup).toContain("付款归属待核实");
      expect(markup).not.toContain("付款客户：入住客人");
    }
  });
  it("shows historical items with feature disabled, full result count and visible pagination, not an amount sum", () => {
    const result = html(<WorkbenchFundsResults data={data} {...navigation} />);
    expect(result).toContain("共 81 条资金待办");
    expect(result).toContain("本页 1 条");
    expect(result).toContain("下一页资金待办");
    expect(result).toContain("新资金能力已关闭");
    expect(result).toContain("600.00");
    expect(result).not.toContain("资金总额");
  });
  it("shows an unknown amount as review, not zero, and never guesses order ownership", () => {
    const result = html(<WorkbenchFundsRow item={{ ...item, kind: "UNASSIGNED_REFUND", amountMinor: null, reason: "先核对成功退款，原收款单号 123" }} returnSearch={navigation.returnSearch} />);
    expect(result).toContain("金额待核对");
    expect(result).toContain('href="/orders"');
    expect(result).toContain("先核对成功退款");
    expect(result).not.toContain("0.00");
    expect(result).not.toContain("/orders/null");
  });
  it("links known orders to their original detail, while receipts use the existing order selection", () => {
    expect(html(<WorkbenchFundsRow item={{ ...item, kind: "ORDER_EXCESS", orderId: "order-2" }} returnSearch={navigation.returnSearch} />)).toContain('href="/orders/order-2"');
    const result = html(<WorkbenchFundsRow item={item} returnSearch={navigation.returnSearch} />);
    expect(result).toContain('href="/orders"');
    expect(result).toContain("付款人待核实");
    expect(result).toContain("原单 &amp; 123");
  });
  it("keeps loading and failed reads distinct from a successful empty result and offers independent retry", () => {
    const loading = html(<WorkbenchFundsReadState data={undefined} error={undefined} onRetry={() => {}} {...navigation} />);
    expect(loading).toContain("正在读取资金待办");
    expect(loading).not.toContain("共 0 条");
    const failure = html(<WorkbenchFundsReadState data={data} error={new Error("offline")} onRetry={() => {}} {...navigation} />);
    expect(failure).toContain("重试资金待办");
    expect(failure).toContain("条数与金额暂不可用");
    expect(failure).not.toContain("600.00");
    expect(failure).not.toContain("共 0 条");
  });
  it("keeps first-page recovery available when a previously selected page became empty", () => {
    const result = html(<WorkbenchFundsResults data={{ ...data, items: [], nextCursor: null }} {...navigation} hasCursor />);
    expect(result).toContain("返回第一页");
    expect(result).toContain("共 81 条");
    expect(result).not.toContain("下一页资金待办");
  });
  it("carries copyable reference and freezes allocation advice for refund review or unknown amounts", () => {
    for (const hint of [{ ...item, kind: "UNASSIGNED_REFUND" as const }, { ...item, amountMinor: null }]) {
      const result = html(<WorkbenchFundsContext item={hint} />);
      expect(result).toContain("复制来源编号");
      expect(result).toContain("不应继续分配或留存");
      expect(result).not.toContain("再选择正确订单");
    }
    expect(html(<WorkbenchFundsContext item={item} />)).toContain("不会自动匹配或提交");
  });
});
