import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchExceptionsResponse } from "@qintopia/contracts";
import { createWorkbenchExceptionsReader } from "./workbenchExceptionsReader";

afterEach(() => vi.useRealTimers());
function response(overrides: Partial<WorkbenchExceptionsResponse> = {}): WorkbenchExceptionsResponse {
  return { propertyId: "sample-property", businessDate: "2026-10-24", asOf: "2026-10-24T03:00:00Z", totalOrders: 73, items: [], nextCursor: "sample-order-050", ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("workbench exceptions page lifecycle", () => {
  it("uses authoritative totals, pages by cursor, retries the same page and refreshes from the beginning", async () => {
    const read = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ nextCursor: null })).mockResolvedValueOnce(response({ totalOrders: 0, nextCursor: null }));
    const reader = createWorkbenchExceptionsReader("sample-property", read);
    reader.refresh(); await flush();
    expect(reader.getSnapshot()).toMatchObject({ loading: false, page: 1, data: { totalOrders: 73 } });
    reader.nextPage(); await flush();
    expect(read.mock.calls[1]![0]).toEqual({ propertyId: "sample-property", limit: 50, afterId: "sample-order-050" });
    expect(reader.getSnapshot()).toMatchObject({ loading: false, page: 2, error: new Error("offline") });
    expect(reader.getSnapshot().data).toBeUndefined();
    reader.retry(); await flush();
    expect(read.mock.calls[2]![0]).toEqual(read.mock.calls[1]![0]);
    expect(reader.getSnapshot()).toMatchObject({ page: 2, data: { nextCursor: null } });
    reader.nextPage();
    expect(read).toHaveBeenCalledTimes(3);
    reader.refresh(); await flush();
    expect(read.mock.calls[3]![0]).toEqual({ propertyId: "sample-property", limit: 50 });
    expect(reader.getSnapshot()).toMatchObject({ page: 1, data: { totalOrders: 0 } });
    reader.cancel();
  });

  it("cancels a slow read and ignores its eventual result after refresh", async () => {
    const slow = deferred<WorkbenchExceptionsResponse>();
    const read = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce(response({ totalOrders: 2 }));
    const reader = createWorkbenchExceptionsReader("sample-property", read);
    reader.refresh();
    const signal: AbortSignal = read.mock.calls[0]![1];
    reader.refresh(); await flush();
    expect(signal.aborted).toBe(true);
    slow.resolve(response({ totalOrders: 999 })); await flush();
    expect(reader.getSnapshot().data?.totalOrders).toBe(2);
    reader.cancel();
  });

  it("cannot publish an old property's read after disposal or accept a different property response", async () => {
    const slow = deferred<WorkbenchExceptionsResponse>();
    const old = createWorkbenchExceptionsReader("sample-old", () => slow.promise);
    const listener = vi.fn(); old.subscribe(listener); old.refresh(); old.cancel();
    const newReader = createWorkbenchExceptionsReader("sample-new", async () => response({ propertyId: "sample-old" }));
    newReader.refresh(); await flush();
    slow.resolve(response({ propertyId: "sample-old" })); await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(old.getSnapshot().data).toBeUndefined();
    expect(newReader.getSnapshot().error).toEqual(new Error("异常事项门店不匹配，请刷新重试"));
    expect(newReader.getSnapshot().data).toBeUndefined();
    newReader.cancel();
  });

  it("makes a timeout visible even if the transport never settles, and ignores late success", async () => {
    vi.useFakeTimers();
    const slow = deferred<WorkbenchExceptionsResponse>();
    const read = vi.fn().mockReturnValue(slow.promise);
    const reader = createWorkbenchExceptionsReader("sample-property", read, 100);
    reader.refresh(); await vi.advanceTimersByTimeAsync(100);
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    expect(reader.getSnapshot()).toMatchObject({ loading: false, error: new Error("异常事项读取超时，请重试") });
    slow.resolve(response()); await flush();
    expect(reader.getSnapshot().data).toBeUndefined();
    reader.cancel();
  });

  it("restarts at page one when the business date changes during pagination", async () => {
    const read = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ businessDate: "2026-10-25" }))
      .mockResolvedValueOnce(response({ businessDate: "2026-10-25", totalOrders: 9, nextCursor: null }));
    const reader = createWorkbenchExceptionsReader("sample-property", read);
    reader.refresh(); await flush(); reader.nextPage(); await flush();
    expect(read.mock.calls.map(([query]) => query.afterId)).toEqual([undefined, "sample-order-050", undefined]);
    expect(reader.getSnapshot()).toMatchObject({ loading: false, page: 1, data: { businessDate: "2026-10-25", totalOrders: 9 } });
    reader.cancel();
  });
});
