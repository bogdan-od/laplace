// Raw bytes of the serial ports the teacher receives, kept per key so that a terminal opened later can draw what came
// before it. The oldest bytes fall off past the limit, so the cut can land inside an escape sequence: a terminal that
// draws the history may show a few stray characters at its very beginning.

export type SerialListener = (bytes: Uint8Array, full: boolean) => void;

interface Entry {
  chunks: Uint8Array[];
  bytes: number;
}

function trim(entry: Entry, maxBytes: number): void {
  let excess = entry.bytes - maxBytes;
  while (excess > 0) {
    const first = entry.chunks[0];
    if (!first) return;
    if (first.length <= excess) {
      entry.chunks.shift();
      entry.bytes -= first.length;
      excess -= first.length;
    } else {
      entry.chunks[0] = first.subarray(excess);
      entry.bytes -= excess;
      excess = 0;
    }
  }
}

export class SerialHistory {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Map<string, Set<SerialListener>>();

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  /** `full` replaces the whole history of the key; otherwise the bytes are appended. Listeners get the bytes as sent. */
  write(key: string, bytes: Uint8Array, full: boolean): void {
    const entry = (full ? undefined : this.#entries.get(key)) ?? { chunks: [], bytes: 0 };
    entry.chunks.push(bytes);
    entry.bytes += bytes.length;
    trim(entry, this.#maxBytes);
    this.#entries.set(key, entry);
    for (const listener of [...(this.#listeners.get(key) ?? [])]) listener(bytes, full);
  }

  read(key: string): readonly Uint8Array[] {
    return this.#entries.get(key)?.chunks.slice() ?? [];
  }

  listen(key: string, listener: SerialListener): () => void {
    const set = this.#listeners.get(key) ?? new Set<SerialListener>();
    set.add(listener);
    this.#listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(key) === set) this.#listeners.delete(key);
    };
  }

  /** Forgets the bytes; the listeners stay, their owners remove them. */
  clear(): void {
    this.#entries.clear();
  }
}
