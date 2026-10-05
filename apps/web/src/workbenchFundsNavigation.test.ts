import { describe, expect, it } from "vitest";
import { workbenchBackHref, workbenchFundsHint } from "./workbenchFundsNavigation";
import { orderDetailBackTarget } from "./pages/OrderDetailPage";

describe("workbench funds return navigation", () => {
  const search = new URLSearchParams({ propertyId: "p", date: "2026-01-01", tab: "EXCEPTIONS", fundsQuery: "原收款 123", fundsCursor: "opaque/+=" }).toString();
  it("restores exception tab, lodging date, search and opaque funds page", () => {
    const href = workbenchBackHref({ workbenchSearch: search });
    const params = new URLSearchParams(href!.split("?")[1]);
    expect(href).toMatch(/^\/today\?/);
    expect(params.get("date")).toBe("2026-01-01");
    expect(params.get("tab")).toBe("EXCEPTIONS");
    expect(params.get("fundsQuery")).toBe("原收款 123");
    expect(params.get("fundsCursor")).toBe("opaque/+=");
    expect(orderDetailBackTarget({ workbenchSearch: search })).toBe(href);
  });
  it("preserves order-selection round trip before returning to the workbench", () => {
    expect(orderDetailBackTarget({ workbenchSearch: search, orderListSearch: "propertyId=p&q=客人&before=order_b" })).toBe("/orders?propertyId=p&before=order_b&q=%E5%AE%A2%E4%BA%BA");
  });
  it("does not restore foreign destinations or old-property hints", () => {
    expect(workbenchBackHref({ workbenchSearch: "propertyId=//outside&returnTo=https://evil" })).toBeUndefined();
    expect(workbenchBackHref({ returnTo: "/today" })).toBeUndefined();
    const state = { workbenchSearch: search, workbenchFundsHint: { kind: "UNALLOCATED_COLLECTION", reference: "receipt" } };
    expect(workbenchFundsHint(state, "other-store")).toBeUndefined();
    expect(workbenchFundsHint(state, "p")?.reference).toBe("receipt");
  });
});
