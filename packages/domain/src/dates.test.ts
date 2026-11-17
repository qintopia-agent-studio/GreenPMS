import { describe, expect, it } from "vitest";
import { addMembershipValidity, enumerateServiceDates, parseLocalDate } from "./dates.ts";

describe("membership calendar validity", () => {
  it.each([
    ["2026-11-17", "P1Y", "2027-11-17"],
    ["2026-11-17", "P6M", "2027-05-17"],
    ["2026-01-31", "P1M", "2026-02-28"],
    ["2026-01-31", "P2M", "2026-03-31"],
    ["2028-02-29", "P1Y", "2029-02-28"],
    ["0098-12-31", "P1Y", "0099-12-31"]
  ])("adds %s + %s", (date, period, expected) => {
    expect(addMembershipValidity(date, period)).toBe(expected);
  });
  it.each(["P0M", "P01Y", "P1D", "P1Y1M", "P-1M", "P1.5Y", "P2147483648M", "P999999Y", "P1M "])("rejects %s", (period) => {
    expect(() => addMembershipValidity("2026-01-31", period)).toThrow();
  });
  it("rejects date overflow and invalid source dates", () => {
    expect(() => addMembershipValidity("0000-12-31", "P1Y")).toThrow();
    expect(() => addMembershipValidity("9999-12-31", "P1M")).toThrow();
    expect(() => addMembershipValidity("2026-02-30", "P1Y")).toThrow();
  });
});

describe("local service dates", () => {
  it("uses the half-open arrival/departure interval", () => {
    expect(enumerateServiceDates("2026-07-20", "2026-07-23")).toEqual(["2026-07-20", "2026-07-21", "2026-07-22"]);
  });

  it("rejects invalid and empty stays", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow(/Invalid local date/);
    expect(() => enumerateServiceDates("2026-07-20", "2026-07-20")).toThrow(/must be after/);
  });

  it("rejects resource-exhausting service-date ranges", () => {
    expect(() => enumerateServiceDates("2026-01-01", "2027-01-03")).toThrow(/cannot exceed 366/);
    expect(enumerateServiceDates("2026-01-01", "2027-01-02")).toHaveLength(366);
  });
});
