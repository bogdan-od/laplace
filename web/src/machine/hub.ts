// MachineHub: owns machine sessions outside React. StrictMode mounts a component
// twice; a Machine created in an effect would start two Workers. A session lives while it has subscribers,
// and a release is delayed, so mount -> unmount -> mount reuses the same session.

export interface HubSession {
  dispose(): void;
}

export const RELEASE_DELAY_MS = 1000;

interface Slot<S> {
  session: S;
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class MachineHub<S extends HubSession> {
  readonly #slots = new Map<string, Slot<S>>();
  readonly #delayMs: number;

  constructor(delayMs: number = RELEASE_DELAY_MS) {
    this.#delayMs = delayMs;
  }

  /** The session under `key`, created by `create` when there is none (or when it has just been disposed). */
  acquire(key: string, create: () => S): S {
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = { session: create(), count: 0, timer: null };
      this.#slots.set(key, slot);
    }
    if (slot.timer !== null) clearTimeout(slot.timer);
    slot.timer = null;
    slot.count++;
    return slot.session;
  }

  /** One subscriber less; with none left for `RELEASE_DELAY_MS` the session is disposed. */
  release(key: string): void {
    const slot = this.#slots.get(key);
    if (!slot || slot.count === 0) return;
    slot.count--;
    if (slot.count > 0) return;
    slot.timer = setTimeout(() => {
      // A new acquire cancelled this timer; reaching here means nobody came back.
      this.#slots.delete(key);
      slot.session.dispose();
    }, this.#delayMs);
  }

  peek(key: string): S | undefined {
    return this.#slots.get(key)?.session;
  }

  get size(): number {
    return this.#slots.size;
  }
}
