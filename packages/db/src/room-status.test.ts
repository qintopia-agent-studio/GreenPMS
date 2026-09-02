import { describe, expect, it } from "vitest";
import { roomStatusActionGranted } from "./room-status.ts";

describe("roomStatusActionGranted", () => {
  it("maps room-status actions to exact command grants without WRITE inference", () => {
    const createOnly = new Set(["CREATE_ORDER"]);
    expect(roomStatusActionGranted("CREATE_ORDER", createOnly)).toBe(true);
    expect(roomStatusActionGranted("CREATE_FREE_STAY", createOnly)).toBe(true);
    expect(roomStatusActionGranted("BACKFILL_ORDER", createOnly)).toBe(true);
    expect(roomStatusActionGranted("LOCK_MAINTENANCE", createOnly)).toBe(false);
    expect(roomStatusActionGranted("RELEASE_MAINTENANCE", new Set(["RELEASE_MAINTENANCE"]))).toBe(true);
    expect(roomStatusActionGranted("COMPLETE_CLEANING", new Set(["COMPLETE_CLEANING"]))).toBe(false);
    expect(roomStatusActionGranted("LOCK_MAINTENANCE", new Set(["LOCK_*", "ADMIN"]))).toBe(false);
  });
});
