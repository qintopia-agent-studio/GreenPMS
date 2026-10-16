import { describe, expect, it } from "vitest";
import type { RoomStatusBoardDto, RoomStatusSyncDto } from "@qintopia/contracts";
import { ApiError } from "../api";
import { RoomStatusProjectionError, RoomStatusQueryTimeoutError, roomStatusReadRetryable, roomStatusSyncNeedsBoard, validateRoomStatusSync } from "./roomStatusSync";
const sync: RoomStatusSyncDto = { propertyId: "property_test", businessDate: "2026-10-16", asOf: "2026-10-16T08:00:00Z", revision: "7", accessLevel: "WRITE", authorizationKey: "a".repeat(64) };
const board = { ...sync, asOf: "2026-10-15T08:00:00Z", freshUntil: "2026-10-15T08:00:05Z" } as RoomStatusBoardDto;
describe("room-status synchronization", () => {
  it("does not reload an unchanged board just because its five-second display hint elapsed", () => {
    expect(roomStatusSyncNeedsBoard(sync, board)).toBe(false);
  });
  it("refreshes actual changes, business midnight and effective permission changes", () => {
    for (const change of [{ revision: "8" }, { businessDate: "2026-10-17" }, { authorizationKey: "b".repeat(64) }, { accessLevel: "READ" as const }, { propertyId: "another_property" }]) {
      expect(roomStatusSyncNeedsBoard({ ...sync, ...change }, board)).toBe(true);
    }
    expect(roomStatusSyncNeedsBoard(sync, undefined)).toBe(true);
  });
  it("retries transport/server failures but not invalid data, authorization or invalid requests", () => {
    for (const error of [new TypeError("Failed to fetch"), new RoomStatusQueryTimeoutError(), new ApiError(503, {}), new ApiError(429, {})]) expect(roomStatusReadRetryable(error)).toBe(true);
    for (const error of [new RoomStatusProjectionError(new Error("invalid history")), new ApiError(401, {}), new ApiError(403, {}), new ApiError(400, {}), new Error("unexpected implementation error")]) expect(roomStatusReadRetryable(error)).toBe(false);
  });
  it("rejects cross-property or malformed light responses before trusting their revision", () => {
    expect(() => validateRoomStatusSync(sync, sync.propertyId)).not.toThrow();
    for (const bad of [null, { ...sync, propertyId: "other" }, { ...sync, revision: "oops" }, { ...sync, accessLevel: "ADMIN" }, { ...sync, authorizationKey: "" }]) {
      expect(() => validateRoomStatusSync(bad, sync.propertyId)).toThrow(RoomStatusProjectionError);
    }
  });
});
