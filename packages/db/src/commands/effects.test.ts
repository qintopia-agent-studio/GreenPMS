import { describe, expect, it } from "vitest";
import { optionalString } from "./effects.ts";

describe("optionalString", () => {
  it("normalizes blank optional input to an omitted value", () => {
    expect(optionalString({}, "note")).toBeUndefined();
    expect(optionalString({ note: null }, "note")).toBeUndefined();
    expect(optionalString({ note: "   " }, "note")).toBeUndefined();
  });

  it("trims populated input and rejects non-string values", () => {
    expect(optionalString({ note: "  已核对  " }, "note")).toBe("已核对");
    expect(() => optionalString({ note: 123 }, "note")).toThrow("note must be a string");
  });
});
