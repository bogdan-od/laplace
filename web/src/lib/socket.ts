// One WebSocket per tab, outside React. Reconnects with the core's Backoff,
// pings every WS_PING_MS, repeats the last `join` after a reconnect, and stops for good on `replaced`.

import { Backoff, CONNECT_TIMEOUT_MS } from "@core/net/backoff.mjs";
import type { ClientMessage, ServerMessage, ServerMessageType } from "@shared/ws";
import { WS_PING_MS } from "@shared/limits";

export type SocketState =
  | "idle" // connect() not called yet, or close() called
  | "connecting"
  | "open"
  | "waiting" // closed by the network, a reconnect is scheduled
  | "replaced" // another tab took over; no more reconnects
  | "unauthorized"; // the server closed with 4401; the HTTP layer sends the user to /login

/** Close code the server uses when the session cookie is missing. */
export const CLOSE_NOT_LOGGED_IN = 4401;

/** The part of a WebSocket the class uses; tests substitute it (no DOM event classes needed). */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

class BrowserSocket implements WebSocketLike {
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  readonly #ws: WebSocket;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.onopen = () => this.onopen?.();
    this.#ws.onmessage = (event) => this.onmessage?.({ data: event.data });
    this.#ws.onclose = (event) => this.onclose?.({ code: event.code });
    this.#ws.onerror = () => this.onerror?.();
  }

  get readyState(): number {
    return this.#ws.readyState;
  }

  send(data: string): void {
    this.#ws.send(data);
  }

  close(code?: number): void {
    this.#ws.close(code);
  }
}

export interface BackoffLike {
  next(): number;
  reset(): void;
}

export interface SocketOptions {
  url?: string;
  createWebSocket?: (url: string) => WebSocketLike;
  backoff?: BackoffLike;
  pingMs?: number;
  connectTimeoutMs?: number;
}

const OPEN = 1;

const SERVER_TYPES: Record<ServerMessageType, true> = {
  joined: true,
  "peer-joined": true,
  "peer-left": true,
  signal: true,
  frame: true,
  serial: true,
  input: true,
  frozen: true,
  tile: true,
  notify: true,
  submission: true,
  "check-run": true,
  replaced: true,
  pong: true,
  error: true,
};

function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = value.type;
  return typeof type === "string" && Object.hasOwn(SERVER_TYPES, type);
}

function defaultUrl(): string {
  const scheme = globalThis.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${globalThis.location.host}/ws`;
}

type Handler<T extends ServerMessageType> = (message: Extract<ServerMessage, { type: T }>) => void;
type AnyHandler = (message: ServerMessage) => void;

export class Socket {
  readonly #options: SocketOptions;
  readonly #backoff: BackoffLike;
  readonly #handlers = new Map<ServerMessageType, Set<AnyHandler>>();
  readonly #stateListeners = new Set<() => void>();
  #state: SocketState = "idle";
  #ws: WebSocketLike | null = null;
  #lastJoin: Extract<ClientMessage, { type: "join" }> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SocketOptions = {}) {
    this.#options = options;
    this.#backoff = options.backoff ?? new Backoff();
  }

  get state(): SocketState {
    return this.#state;
  }

  /** For useSyncExternalStore. */
  subscribeState = (listener: () => void): (() => void) => {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  };

  getState = (): SocketState => this.#state;

  connect(): void {
    if (this.#state === "replaced" || this.#state === "connecting" || this.#state === "open") return;
    this.#clearTimers();
    this.#open();
  }

  /** Leaves the room state alone: a later connect() repeats the last join. */
  close(): void {
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      detach(ws);
      ws.close();
    }
    if (this.#state !== "replaced") this.#setState("idle");
  }

  on<T extends ServerMessageType>(type: T, handler: Handler<T>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    // The set for `type` only ever receives messages of that type (see #dispatch).
    const stored = handler as AnyHandler;
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  /** Sends if the connection is open; returns false otherwise (the message is not queued). */
  send(message: ClientMessage): boolean {
    if (message.type === "join") this.#lastJoin = message;
    const ws = this.#ws;
    if (!ws || ws.readyState !== OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  /** Enters an assignment room now, and again after every reconnect. */
  join(assignmentId: number, machines?: string[]): void {
    const message: Extract<ClientMessage, { type: "join" }> = { type: "join", assignment_id: assignmentId };
    if (machines) message.machines = machines;
    this.send(message);
  }

  leave(): void {
    this.#lastJoin = null;
  }

  #open(): void {
    const url = this.#options.url ?? defaultUrl();
    const create = this.#options.createWebSocket ?? ((target: string) => new BrowserSocket(target));
    const ws = create(url);
    this.#ws = ws;
    this.#setState("connecting");
    ws.onopen = () => this.#onOpen(ws);
    ws.onmessage = (event) => this.#onMessage(ws, event.data);
    ws.onclose = (event) => this.#onClose(ws, event.code);
    ws.onerror = () => {
      // The close event follows an error; reconnecting happens there.
    };
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#ws === ws && this.#state === "connecting") {
        detach(ws);
        ws.close();
        this.#scheduleReconnect();
      }
    }, this.#options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  }

  #onOpen(ws: WebSocketLike): void {
    if (this.#ws !== ws) return;
    this.#clearConnectTimer();
    this.#backoff.reset();
    this.#setState("open");
    this.#pingTimer = setInterval(() => this.send({ type: "ping" }), this.#options.pingMs ?? WS_PING_MS);
    if (this.#lastJoin) this.send(this.#lastJoin);
  }

  #onMessage(ws: WebSocketLike, data: unknown): void {
    if (this.#ws !== ws || typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isServerMessage(parsed)) return;
    if (parsed.type === "replaced") {
      this.#stopForGood("replaced");
    }
    for (const handler of [...(this.#handlers.get(parsed.type) ?? [])]) handler(parsed);
  }

  #onClose(ws: WebSocketLike, code: number): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#clearTimers();
    if (this.#state === "replaced") return;
    if (code === CLOSE_NOT_LOGGED_IN) {
      this.#setState("unauthorized");
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    this.#clearTimers();
    this.#ws = null;
    this.#setState("waiting");
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#open();
    }, this.#backoff.next());
  }

  #stopForGood(state: "replaced"): void {
    this.#clearTimers();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      detach(ws);
      ws.close();
    }
    this.#setState(state);
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer !== null) clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  #clearTimers(): void {
    this.#clearConnectTimer();
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#pingTimer = null;
    this.#retryTimer = null;
  }

  #setState(state: SocketState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#stateListeners]) listener();
  }
}

function detach(ws: WebSocketLike): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
}
