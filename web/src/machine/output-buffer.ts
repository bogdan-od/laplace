// Console output kept on the main thread, so that a terminal mounted later (a second mount, a remount
// after navigation) can draw what the machine already printed, and the room can resend a history.

export class OutputBuffer {
  readonly maxBytes: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped) this.#bytes -= dropped.length;
    }
  }

  clear(): void {
    this.#chunks = [];
    this.#bytes = 0;
  }

  chunks(): readonly Uint8Array[] {
    return this.#chunks;
  }

  /** The last `limit` bytes. */
  tail(limit: number): Uint8Array {
    const size = Math.min(limit, this.#bytes);
    const out = new Uint8Array(size);
    let end = size;
    for (let i = this.#chunks.length - 1; i >= 0 && end > 0; i--) {
      const chunk = this.#chunks[i];
      if (!chunk) continue;
      const part = chunk.length > end ? chunk.subarray(chunk.length - end) : chunk;
      end -= part.length;
      out.set(part, end);
    }
    return out;
  }
}
