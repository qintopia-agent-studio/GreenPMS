import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("historical archive API client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends potentially identifying search text in a POST body instead of the URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ archives: [], truncated: false }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    await api.historicalOrderArchives("property-1", { query: "13800138000" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/historical-order-archives");
    expect(init).toMatchObject({ method: "POST" });
    expect(String(url)).not.toContain("13800138000");
    expect(JSON.parse(String(init?.body))).toEqual({ propertyId: "property-1", query: "13800138000" });
  });
});
