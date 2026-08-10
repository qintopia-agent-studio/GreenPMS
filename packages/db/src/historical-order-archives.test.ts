import { describe, expect, it } from "vitest";
import { maskHistoricalArchivePhone } from "./historical-order-archives";

describe("historical archive phone presentation", () => {
  it("never returns the complete stored phone to a general READ projection", () => {
    const raw = "13800138000";
    const masked = maskHistoricalArchivePhone(raw);
    expect(masked).toBe("*******8000");
    expect(masked).not.toContain(raw);
  });

  it("preserves an honest null when no historical phone was recorded", () => {
    expect(maskHistoricalArchivePhone(null)).toBeNull();
  });

  it.each(["8", "8000", "80000", "无", "  "])("fully masks a short or irregular value: %s", (raw) => {
    const masked = maskHistoricalArchivePhone(raw);
    expect(masked).toMatch(/^\*+$/);
    expect(masked).not.toContain(raw);
  });

  it("keeps only the final four characters of a longer formatted value", () => {
    const raw = "138-0013-8000";
    const masked = maskHistoricalArchivePhone(raw);
    expect(masked).toBe("********8000");
    expect(masked).not.toContain(raw);
  });
});
