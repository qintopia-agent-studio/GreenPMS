import { afterEach, expect, it, vi } from "vitest";
import { RoomStatusHoverIntent, ROOM_STATUS_HOVER_OPEN_MS, ROOM_STATUS_HOVER_CLOSE_MS } from "./useRoomStatusHover";

afterEach(() => vi.useRealTimers());

it("ignores a passing pointer and opens only the last settled target", () => {
  vi.useFakeTimers();
  const open = vi.fn();
  const intent = new RoomStatusHoverIntent(open, vi.fn());
  intent.enter("A");
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_OPEN_MS - 1);
  expect(open).not.toHaveBeenCalled();
  intent.enter("B");
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_OPEN_MS);
  expect(open.mock.calls).toEqual([["B"]]);
});

it("bridges trigger-to-portal travel, then dismisses after leaving both", () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const intent = new RoomStatusHoverIntent(vi.fn(), close);
  intent.leave();
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_CLOSE_MS - 1);
  intent.keepOpen();
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_CLOSE_MS);
  expect(close).not.toHaveBeenCalled();
  intent.leave();
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_CLOSE_MS);
  expect(close).toHaveBeenCalledTimes(1);
});

it("a click, drag or teardown cancels both delayed operations", () => {
  vi.useFakeTimers();
  const open = vi.fn(), close = vi.fn();
  const intent = new RoomStatusHoverIntent(open, close);
  intent.enter("A");
  intent.cancel();
  vi.runAllTimers();
  intent.leave();
  intent.cancel();
  vi.runAllTimers();
  expect(open).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it("resumes a stationary pointer after an interaction finishes, but never after it leaves or is cancelled", () => {
  vi.useFakeTimers();
  const open = vi.fn();
  const intent = new RoomStatusHoverIntent(open, vi.fn());
  intent.enter("A");
  intent.suspend();
  vi.runAllTimers();
  expect(open).not.toHaveBeenCalled();
  intent.resume(() => true);
  vi.advanceTimersByTime(ROOM_STATUS_HOVER_OPEN_MS);
  expect(open.mock.calls).toEqual([["A"]]);
  intent.leave();
  intent.resume(() => true);
  vi.runAllTimers();
  intent.enter("B");
  intent.cancel();
  intent.resume(() => true);
  vi.runAllTimers();
  expect(open.mock.calls).toEqual([["A"]]);
});
