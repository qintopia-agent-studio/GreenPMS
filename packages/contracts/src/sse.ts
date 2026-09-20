/** Incremental SSE framing shared by the provider and browser transports.
 * Callers own UTF-8 decoding, byte limits and the required terminal event. */
export class SseDecoder {
  private pending = "";
  private data: string[] = [];
  private eventSize = 0;
  push(chunk: string): string[] {
    this.pending += chunk;
    const events: string[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.pending);
      if (!match || match[0] === "\r" && match.index === this.pending.length - 1) break;
      const line = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = []; this.eventSize = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.data.push(value); this.eventSize += value.length;
      }
      if (this.eventSize > 256_000) throw new Error("SSE event too large");
    }
    if (this.pending.length + this.eventSize > 256_000) throw new Error("SSE event too large");
    return events;
  }
}
