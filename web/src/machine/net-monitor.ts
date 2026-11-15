// What the topology carries, for the screen: how many frames went over each link and the last frames of each
// machine. The monitor sits between `build_topology` and the machines (`wrap`): it needs no change in the core.
//
// A frame sent by machine A reaches the switches and the other machines inside the same call (the switch
// delivers synchronously), so the monitor knows the sender while `net_in` of the receivers runs. A receiver
// counts on its own link; the trunks between its switch and the sender's switch count once per frame sent,
// however many machines behind them receive it. A trunk that carries a frame to a switch with no receiver
// behind it is not counted: the monitor sees frames only where machines send and receive.

import type { Topology, TopologyLink, TopologyNetMachine } from "@core/net/topology.mjs";

/** The newest frames kept per machine. */
export const FRAME_LOG_LIMIT = 500;
/** The screen is refreshed at most this often, however many frames arrive. */
export const NET_PUBLISH_MS = 500;
/** Bytes of each frame kept: Ethernet, 802.1Q, the longest IPv4 and TCP headers fit. */
export const CAPTURED_BYTES = 160;

export type FrameDirection = "out" | "in";

export interface FrameRecord {
  /** Milliseconds since the monitor was created (the page was opened). */
  t: number;
  /** `out`: the machine sent it, `in`: the network delivered it to the machine. */
  dir: FrameDirection;
  /** The first `CAPTURED_BYTES` of the frame. */
  bytes: Uint8Array;
  /** Length of the whole frame. */
  length: number;
}

export interface NetSnapshot {
  /** Frames per link, by `linkKey`. */
  readonly counts: ReadonlyMap<string, number>;
  /** The newest frames per machine id, the oldest first. */
  readonly frames: ReadonlyMap<string, readonly FrameRecord[]>;
}

export const EMPTY_NET: NetSnapshot = { counts: new Map(), frames: new Map() };

type NetLinks = Pick<Topology, "links">;

/** The key of a link in `NetSnapshot.counts`: `machine:<id>`, `trunk:<a>|<b>` (ids sorted), `uplink:<switch>`. */
export function linkKey(link: TopologyLink): string {
  if (link.machine !== undefined) return `machine:${link.machine}`;
  if (link.to !== undefined) return trunkKey(link.switch, link.to);
  return `uplink:${link.switch}`;
}

function trunkKey(a: string, b: string): string {
  return a < b ? `trunk:${a}|${b}` : `trunk:${b}|${a}`;
}

interface Emission {
  node: string;
  /** The trunks this frame has already been counted on. */
  crossed: Set<string>;
}

export interface NetMonitorOptions {
  /** Milliseconds, monotonic; the default is `performance.now`. */
  now?: () => number;
}

export class NetMonitor {
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #listeners = new Set<() => void>();
  readonly #counts = new Map<string, number>();
  readonly #logs = new Map<string, FrameRecord[]>();
  readonly #switchOf = new Map<string, string>();
  readonly #neighbours = new Map<string, string[]>();
  #snapshot: NetSnapshot = EMPTY_NET;
  #emission: Emission | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastPublish = Number.NEGATIVE_INFINITY;
  #dirty = false;
  #disposed = false;

  constructor(options: NetMonitorOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#startedAt = this.#now();
  }

  getSnapshot = (): NetSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Learns which switch each machine is on and how the switches are connected. Counts are kept. */
  configure(topology: NetLinks): void {
    this.#switchOf.clear();
    this.#neighbours.clear();
    for (const link of topology.links) {
      if (link.machine !== undefined) this.#switchOf.set(link.machine, link.switch);
      else if (link.to !== undefined) {
        this.#neighbours.set(link.switch, [...(this.#neighbours.get(link.switch) ?? []), link.to]);
        this.#neighbours.set(link.to, [...(this.#neighbours.get(link.to) ?? []), link.switch]);
      }
    }
  }

  /** The machine as `build_topology` should see it: every frame it sends or receives is counted and logged. */
  wrap(node: string, machine: TopologyNetMachine): TopologyNetMachine {
    const taps = new Map<(frame: Uint8Array) => void, (frame: Uint8Array) => void>();
    return {
      net_in: (frame) => {
        this.#received(node, frame);
        machine.net_in(frame);
      },
      on: (name, fn) => {
        const tap = (frame: Uint8Array) => this.#sent(node, frame, fn);
        taps.set(fn, tap);
        machine.on(name, tap);
      },
      off: (name, fn) => {
        const tap = taps.get(fn);
        if (tap === undefined) return;
        taps.delete(fn);
        machine.off?.(name, tap);
      },
    };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  #sent(node: string, frame: Uint8Array, deliver: (frame: Uint8Array) => void): void {
    if (this.#disposed) {
      deliver(frame);
      return;
    }
    this.#record(node, "out", frame);
    this.#bump(`machine:${node}`);
    const outer = this.#emission;
    this.#emission = { node, crossed: new Set() };
    try {
      deliver(frame);
    } finally {
      this.#emission = outer;
    }
  }

  #received(node: string, frame: Uint8Array): void {
    if (this.#disposed) return;
    this.#record(node, "in", frame);
    this.#bump(`machine:${node}`);
    const sender = this.#emission;
    if (sender === null || sender.node === node) return;
    for (const key of this.#trunksBetween(sender.node, node)) {
      if (sender.crossed.has(key)) continue;
      sender.crossed.add(key);
      this.#bump(key);
    }
  }

  /** The trunk keys on the way from one machine to another; empty when they share a switch or are not connected. */
  #trunksBetween(from: string, to: string): string[] {
    const start = this.#switchOf.get(from);
    const goal = this.#switchOf.get(to);
    if (start === undefined || goal === undefined || start === goal) return [];
    const previous = new Map<string, string>([[start, start]]);
    const queue = [start];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const neighbour of this.#neighbours.get(next) ?? []) {
        if (previous.has(neighbour)) continue;
        previous.set(neighbour, next);
        queue.push(neighbour);
      }
    }
    const keys: string[] = [];
    for (let at = goal; at !== start; ) {
      const before = previous.get(at);
      if (before === undefined) return [];
      keys.push(trunkKey(before, at));
      at = before;
    }
    return keys;
  }

  #bump(key: string): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
    this.#schedulePublish();
  }

  #record(node: string, dir: FrameDirection, frame: Uint8Array): void {
    const log = this.#logs.get(node) ?? [];
    this.#logs.set(node, log);
    log.push({ t: this.#now() - this.#startedAt, dir, bytes: frame.slice(0, CAPTURED_BYTES), length: frame.length });
    if (log.length > FRAME_LOG_LIMIT) log.shift();
  }

  #schedulePublish(): void {
    this.#dirty = true;
    if (this.#timer !== null) return;
    const wait = Math.max(0, this.#lastPublish + NET_PUBLISH_MS - this.#now());
    this.#timer = setTimeout(() => this.#publish(), wait);
  }

  #publish(): void {
    this.#timer = null;
    if (!this.#dirty || this.#disposed) return;
    this.#dirty = false;
    this.#lastPublish = this.#now();
    this.#snapshot = {
      counts: new Map(this.#counts),
      frames: new Map([...this.#logs].map(([node, log]) => [node, [...log]])),
    };
    for (const listener of [...this.#listeners]) listener();
  }
}
