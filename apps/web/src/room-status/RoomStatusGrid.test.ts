import { describe, expect, it } from "vitest";
import { roomStatusIntervalServiceDateAtPointer } from "./RoomStatusGrid";

describe("roomStatusIntervalServiceDateAtPointer", () => {
  const dates = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];

  it("maps every visible part of a multi-day interval to the date that was clicked", () => {
    const bounds = { left: 100, width: 300 };
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 110)).toBe("2026-08-01");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 210)).toBe("2026-08-02");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 0, 3, bounds, 399)).toBe("2026-08-03");
  });

  it("fails closed to the rendered interval start for keyboard activation or invalid geometry", () => {
    expect(roomStatusIntervalServiceDateAtPointer(dates, 1, 4, { left: 100, width: 0 }, 0)).toBe("2026-08-02");
    expect(roomStatusIntervalServiceDateAtPointer(dates, 1, 4, { left: 100, width: 300 }, Number.NaN)).toBe("2026-08-02");
  });
});
