import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadPoller } from "./readPoller";

afterEach(() => vi.useRealTimers());
describe("order read lifecycle", () => {
  it.each([2_000, 4_500, 8_000])("displays a successful %i ms read without overlapping polling", async (delay) => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("order"), delay)));
    const onValue = vi.fn();
    const poller = createReadPoller({ read, onValue, onError: vi.fn(), intervalMs: 4_000, timeoutMs: 20_000, visible: () => true });
    await vi.advanceTimersByTimeAsync(delay);
    expect(onValue).toHaveBeenCalledWith("order");
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
  });
  it("coalesces refreshes and ignores a disposed order's late response", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const read = vi.fn((nextSignal: AbortSignal) => { signal = nextSignal; return new Promise<string>((resolve) => { finish = resolve; }); });
    const onValue = vi.fn();
    const poller = createReadPoller({ read, onValue, onError: vi.fn(), intervalMs: 4_000, timeoutMs: 20_000, visible: () => true });
    poller.refresh(); poller.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    finish("first");
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
    expect(signal.aborted).toBe(true);
    finish("old order");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onValue).toHaveBeenCalledTimes(1);
  });
  it("reports 503 and timeout without replacing the last value, then recovers", async () => {
    vi.useFakeTimers();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce("saved")
      .mockRejectedValueOnce(new Error("503"))
      .mockImplementationOnce((signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))))
      .mockResolvedValue("restored");
    const onValue = vi.fn(); const onError = vi.fn();
    const poller = createReadPoller({ read, onValue, onError, intervalMs: 4_000, timeoutMs: 20_000, visible: () => true });
    await vi.advanceTimersByTimeAsync(28_000);
    expect(onValue.mock.calls).toEqual([["saved"]]);
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onValue).toHaveBeenLastCalledWith("restored");
    poller.dispose();
  });
});
