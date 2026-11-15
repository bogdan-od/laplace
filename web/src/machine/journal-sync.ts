// Sends the new events of one machine's journal to its branch (autosave).
// One JournalSync per machine and branch. The events come from the machine's main-thread copy of the
// journal (`Machine.mirror`); `saved` is how many of them the server already has.

import { Backoff } from "@core/net/backoff.mjs";
import { commands, type JournalEvent } from "@core/core/journal.mjs";
import type { AppendEventsBody, AppendResult } from "@shared/api";
import { AUTOSAVE_MS, KEEPALIVE_MAX_BYTES, MAX_CHUNK_BYTES } from "@shared/limits";
import { ApiFailure, NetworkFailure, describeError } from "@/lib/api";

export interface ChunkRequest {
  branchId: number;
  body: AppendEventsBody;
  /** Only for a request sent on pagehide, and only when the body fits `KEEPALIVE_MAX_BYTES`. */
  keepalive: boolean;
}

export type SendChunk = (request: ChunkRequest) => Promise<AppendResult>;

/** What the header shows: saved, saving, no connection; `error` is a refusal that retrying cannot fix. */
export type SyncStatus = "saved" | "saving" | "offline" | "error";

export interface SyncState {
  readonly status: SyncStatus;
  /** Events the server has for the branch. */
  readonly saved: number;
  readonly error: string | null;
}

export interface BackoffLike {
  next(): number;
  reset(): void;
}

export interface JournalSyncOptions {
  branchId: number;
  /** Events the server already has for this branch (0 for a new start branch, the fork index for a rollback). */
  saved: number;
  /** The current journal; read again on every send. */
  events: () => readonly JournalEvent[];
  send: SendChunk;
  intervalMs?: number;
  backoff?: BackoffLike;
  /** Body size at which one chunk is cut. Half of the server limit leaves room for the envelope. */
  chunkBytes?: number;
  keepaliveBytes?: number;
}

export interface CommandsMeta {
  commands: number;
  last_command: string;
}

const DEFAULT_CHUNK_BYTES = MAX_CHUNK_BYTES / 2;
const ENVELOPE_BYTES = 256;

export const OFFLINE_TEXT = "Немає зв'язку - зміни збережуться, щойно з'явиться мережа";

/** UTF-8 length of a string without allocating the bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export interface Batch {
  events: JournalEvent[];
  /** Approximate size of the request body. */
  bytes: number;
}

/** Events from `from` that fit into `maxBytes`; always at least one, so a huge event still goes out. */
export function takeBatch(events: readonly JournalEvent[], from: number, maxBytes: number): Batch {
  const batch: JournalEvent[] = [];
  let bytes = ENVELOPE_BYTES;
  for (let i = from; i < events.length; i++) {
    const event = events[i];
    if (!event) break;
    const size = utf8Length(JSON.stringify(event)) + 1;
    if (batch.length > 0 && bytes + size > maxBytes) break;
    batch.push(event);
    bytes += size;
  }
  return { events: batch, bytes };
}

/** The student's commands (port 0) for the teacher's tile. */
export function commandsMeta(events: readonly JournalEvent[]): CommandsMeta {
  const own = commands(events).filter((command) => command.by === "student" && command.port === 0);
  return { commands: own.length, last_command: own.at(-1)?.text ?? "" };
}

function isRecoverable(error: unknown): boolean {
  return error instanceof NetworkFailure || (error instanceof ApiFailure && error.status >= 500);
}

function gapCount(error: unknown): number | null {
  if (!(error instanceof ApiFailure) || error.status !== 409 || error.code !== "chunk_gap") return null;
  const count = error.data?.["event_count"];
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

export class JournalSync {
  readonly branchId: number;
  readonly #events: () => readonly JournalEvent[];
  readonly #send: SendChunk;
  readonly #intervalMs: number;
  readonly #backoff: BackoffLike;
  readonly #chunkBytes: number;
  readonly #keepaliveBytes: number;
  readonly #listeners = new Set<() => void>();
  #state: SyncState;
  #saved: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #started = false;
  #stopped = false;

  constructor(options: JournalSyncOptions) {
    this.branchId = options.branchId;
    this.#saved = options.saved;
    this.#events = options.events;
    this.#send = options.send;
    this.#intervalMs = options.intervalMs ?? AUTOSAVE_MS;
    this.#backoff = options.backoff ?? new Backoff();
    this.#chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.#keepaliveBytes = options.keepaliveBytes ?? KEEPALIVE_MAX_BYTES;
    this.#state = { status: "saved", saved: options.saved, error: null };
  }

  /** Events the server has; this is the `event_count` for a help request or a submission after `flushNow`. */
  get saved(): number {
    return this.#saved;
  }

  getState = (): SyncState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Starts the periodic saving. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#schedule(this.#intervalMs);
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  /**
   * Sends everything that is new and waits. `events` replaces the machine's copy (a journal just taken
   * with `check` can be ahead of the copy). Rejects when the events cannot be saved now: with
   * `NetworkFailure` when there is no connection (saving goes on in the background), with `ApiFailure`
   * on a refusal. Calls queue up: two callers never send the same chunk twice.
   */
  flushNow(events?: readonly JournalEvent[]): Promise<number> {
    this.#clearTimer();
    return this.#enqueue(async () => {
      await this.#drain(events ? () => events : this.#events, true);
      return this.#saved;
    });
  }

  /** The last save before the sync is dropped; the timer stops at once, the queued send still runs. */
  async flushAndStop(): Promise<void> {
    const flushed = this.flushNow().then(
      () => undefined,
      () => undefined,
    );
    this.#stopped = true;
    this.#clearTimer();
    await flushed;
  }

  /** The tab went to the background: send now, the timers will slow down. */
  onHidden(): void {
    this.flushNow().catch(() => undefined);
  }

  /**
   * The page is going away. Must start the request synchronously and cannot wait for the queue.
   * `keepalive` only when the body fits what browsers allow for it.
   */
  onPageHide(): void {
    if (this.#stopped) return;
    const events = this.#events();
    if (events.length <= this.#saved) return;
    const from = this.#saved;
    const batch = takeBatch(events, from, this.#chunkBytes);
    const keepalive = batch.bytes <= this.#keepaliveBytes;
    this.#send({ branchId: this.branchId, body: this.#body(from, batch.events, events), keepalive }).then(
      (result) => {
        // A page kept in the back/forward cache comes back; its state must not lag behind what was saved.
        if (result.event_count > this.#saved) this.#set({ saved: result.event_count });
      },
      () => undefined,
    );
  }

  #body(from: number, batch: JournalEvent[], all: readonly JournalEvent[]): AppendEventsBody {
    return { from, events: batch, meta: commandsMeta(all) };
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(job, job);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #drain(source: () => readonly JournalEvent[], interactive: boolean): Promise<void> {
    for (;;) {
      if (this.#stopped && !interactive) return;
      const events = source();
      // A copy that is behind the server (it lags by up to a status interval) has nothing new to send.
      if (events.length <= this.#saved) {
        this.#set({ status: "saved", error: null });
        this.#backoff.reset();
        this.#scheduleNext(this.#intervalMs);
        return;
      }
      const from = this.#saved;
      const batch = takeBatch(events, from, this.#chunkBytes);
      this.#set({ status: "saving" });
      try {
        const result = await this.#send({
          branchId: this.branchId,
          body: this.#body(from, batch.events, events),
          keepalive: false,
        });
        if (!Number.isInteger(result.event_count) || result.event_count <= from) {
          throw new ApiFailure(500, "Сервер не підтвердив збереження", undefined, null);
        }
        this.#set({ saved: result.event_count, status: "saving", error: null });
        this.#backoff.reset();
      } catch (error) {
        const gap = gapCount(error);
        if (gap !== null && gap !== from) {
          // The server has a different number of events than we assumed: continue from there.
          this.#set({ saved: gap });
          continue;
        }
        this.#fail(error);
        throw error;
      }
    }
  }

  #fail(error: unknown): void {
    if (isRecoverable(error)) {
      this.#set({ status: "offline", error: null });
      this.#scheduleNext(this.#backoff.next());
      return;
    }
    // A refusal (journal_invalid, journal_too_large, 404 ...) does not get better by retrying.
    this.#set({ status: "error", error: describeError(error) });
    this.#clearTimer();
  }

  #scheduleNext(delay: number): void {
    if (this.#started && !this.#stopped) this.#schedule(delay);
  }

  #schedule(delay: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#enqueue(() => this.#drain(this.#events, false)).catch(() => undefined);
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #set(patch: Partial<SyncState>): void {
    const next = { ...this.#state, ...patch };
    if (next.status === this.#state.status && next.saved === this.#state.saved && next.error === this.#state.error) {
      return;
    }
    if (patch.saved !== undefined) this.#saved = patch.saved;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
