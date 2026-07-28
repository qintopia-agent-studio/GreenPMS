import { describe, expect, it } from "vitest";
import { roomStatusPopoverPosition, roomStatusPopoverViewportEventShouldClose } from "./RoomStatusQuickPopover";

describe("roomStatusPopoverPosition", () => {
  it("uses the right side when enough space remains", () => {
    expect(roomStatusPopoverPosition(
      { left: 100, right: 194, top: 80, bottom: 130 },
      { width: 1280, height: 720 },
      { width: 320, height: 260 }
    )).toEqual({ left: 202, top: 80 });
  });

  it("moves left and clamps vertically near the viewport edge", () => {
    expect(roomStatusPopoverPosition(
      { left: 1100, right: 1194, top: 650, bottom: 700 },
      { width: 1280, height: 720 },
      { width: 320, height: 260 }
    )).toEqual({ left: 772, top: 452 });
  });

  it("keeps a narrow viewport margin when neither side fits", () => {
    const position = roomStatusPopoverPosition(
      { left: 80, right: 174, top: 20, bottom: 70 },
      { width: 340, height: 400 },
      { width: 324, height: 300 }
    );
    expect(position.left).toBe(8);
    expect(position.top).toBe(20);
  });
});

describe("roomStatusPopoverViewportEventShouldClose", () => {
  it("keeps the popover open for its own overflow scroll", () => {
    expect(roomStatusPopoverViewportEventShouldClose("scroll", true)).toBe(false);
    expect(roomStatusPopoverViewportEventShouldClose("scroll", false)).toBe(true);
    expect(roomStatusPopoverViewportEventShouldClose("resize", true)).toBe(true);
  });
});
