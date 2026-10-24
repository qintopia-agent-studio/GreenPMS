import type { WorkbenchExceptionsQuery, WorkbenchExceptionsResponse } from "@qintopia/contracts";

export type ReadWorkbenchExceptions = (query: WorkbenchExceptionsQuery, signal?: AbortSignal) => Promise<WorkbenchExceptionsResponse>;
export interface WorkbenchExceptionsState {
  loading: boolean;
  page: number;
  data?: WorkbenchExceptionsResponse;
  error?: unknown;
}

/** A single visible page: obsolete reads can never replace a newer refresh or scope. */
export function createWorkbenchExceptionsReader(propertyId: string, read: ReadWorkbenchExceptions, timeoutMs = 12_000) {
  let state: WorkbenchExceptionsState = { loading: true, page: 1 };
  const listeners = new Set<() => void>();
  let generation = 0;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  let lastBusinessDate: string | undefined;

  function publish(next: WorkbenchExceptionsState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function cancel() {
    generation += 1;
    clearTimeout(timeout);
    controller?.abort();
  }
  async function load(afterId: string | undefined, page: number) {
    cancel();
    cursor = afterId;
    const requestGeneration = generation;
    controller = new AbortController();
    const signal = controller.signal;
    publish({ loading: true, page });
    timeout = setTimeout(() => {
      if (generation !== requestGeneration) return;
      const error = new Error("异常事项读取超时，请重试");
      controller?.abort(error);
      publish({ loading: false, page, error });
    }, timeoutMs);
    try {
      const data = await read({ propertyId, ...(afterId ? { afterId } : {}), limit: 50 }, signal);
      if (generation !== requestGeneration || signal.aborted) return;
      if (data.propertyId !== propertyId) throw new Error("异常事项门店不匹配，请刷新重试");
      // Never combine the next page with yesterday's traversal after crossing midnight.
      if (afterId && lastBusinessDate && data.businessDate !== lastBusinessDate) {
        lastBusinessDate = data.businessDate;
        void load(undefined, 1);
        return;
      }
      lastBusinessDate = data.businessDate;
      publish({ loading: false, page, data });
    } catch (error) {
      if (generation === requestGeneration && !signal.aborted) publish({ loading: false, page, error });
    } finally {
      if (generation === requestGeneration) clearTimeout(timeout);
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => { void load(undefined, 1); },
    retry: () => { void load(cursor, state.page); },
    firstPage: () => { void load(undefined, 1); },
    nextPage: () => { if (!state.loading && state.data?.nextCursor) void load(state.data.nextCursor, state.page + 1); },
    cancel
  };
}
