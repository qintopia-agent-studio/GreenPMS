import { describe, expect, it } from "vitest";
import { memberStayHref, memberStayIntent } from "./memberStayIntent";

describe("member lodging continuation", () => {
  it("targets the real inventory route and preserves identity only in its property", () => {
    const url = new URL(memberStayHref("property A", "member B"), "http://localhost");
    expect(url.pathname).toBe("/");
    expect(memberStayIntent(url.search, "property A")).toBe("member B");
    expect(memberStayIntent(url.search, "property C")).toBeUndefined();
    expect(memberStayIntent("?propertyId=property+A&memberId=", "property A")).toBeUndefined();
  });
});
