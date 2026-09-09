/** One request at a time; explicit refreshes coalesce behind the current read. */
export function createReadPoller<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
  intervalMs: number;
  timeoutMs: number;
  visible: () => boolean;
}) {
  let disposed = false;
  let running = false;
  let queued = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh() {
    if (disposed) return;
    if (running) { queued = true; return; }
    clearTimeout(timer);
    running = true;
    controller = new AbortController();
    const signal = controller.signal;
    const timeout = setTimeout(() => controller?.abort(new Error("读取超时，请重试")), options.timeoutMs);
    try {
      const value = await options.read(signal);
      if (!disposed) {
        if (signal.aborted) options.onError(signal.reason);
        else options.onValue(value);
      }
    } catch (error) {
      if (!disposed) options.onError(signal.aborted ? signal.reason : error);
    } finally {
      clearTimeout(timeout);
      running = false;
      if (!disposed) {
        const delay = queued ? 0 : options.intervalMs;
        queued = false;
        timer = setTimeout(tick, delay);
      }
    }
  }
  function tick() {
    if (options.visible()) void refresh();
    else timer = setTimeout(tick, options.intervalMs);
  }
  void refresh();
  return {
    refresh: () => { void refresh(); },
    dispose: () => { disposed = true; clearTimeout(timer); controller?.abort(); }
  };
}
