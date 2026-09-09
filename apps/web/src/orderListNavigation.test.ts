import { describe, expect, it } from "vitest";
import { orderListBackHref, orderPreviousPages } from "./orderListNavigation";

describe("order list return location", () => {
  it("restores the search and page without accepting external destinations", () => {
    expect(orderListBackHref({ orderListSearch: "propertyId=prop_a&q=205&status=CHECKED_OUT&before=order_b" })).toBe("/orders?propertyId=prop_a&before=order_b&q=205&status=CHECKED_OUT");
    expect(orderListBackHref({ orderListSearch: "returnTo=https://outside.example&status=UNKNOWN&before=//outside" })).toBe("/orders");
    expect(orderPreviousPages({ orderPreviousPages: ["", "order_a"] })).toEqual(["", "order_a"]);
    expect(orderPreviousPages({ orderPreviousPages: ["/outside"] })).toEqual([]);
  });
});
