import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MachineStatus } from '@core/core/engine.mjs';
import type { Journal, SerialPort } from '@core/core/journal.mjs';
import type {
  AgentChannel,
  AgentResult,
} from '@core/machine/agent_channel.mjs';
import type {
  WorkerMessage,
  WorkerOp,
  WorkerReplies,
  WorkerRequest,
} from '@core/machine/worker_protocol.mjs';
import { agentChannelCore } from '../core';
import { repoRoot } from '../repo-root';

const WORKER_FILE = join('app', 'machine', 'node_worker.mjs');
const MAX_OLD_GENERATION_MB = 512;
const SYSTEM_TIMEOUT_MS = 10_000;
/** Silence of a running worker after which the guest is taken to stand still (JIT compilation, image reads). */
const STALL_SILENCE_MS = 1_000;
const AGENT_PORT: SerialPort = 1;

export interface ServerMachineOptions {
  /** The journal to replay; its header says which profile and boot snapshot to use. */
  journal: Journal;
  /** Machine id in the topology, for messages. */
  id: string;
}

export interface ServerMachineEvents {
  /** The replay reached the end of the journal. */
  end: undefined;
  /** The worker failed or the core reported a divergence; the machine does not recover. */
  error: string;
  net_out: Uint8Array;
}

type Listeners = {
  [K in keyof ServerMachineEvents]: ((value: ServerMachineEvents[K]) => void)[];
};

type RequestOf<K extends WorkerOp> = Omit<
  Extract<WorkerRequest, { op: K }>,
  'id'
>;

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
}

/**
 * The part of `Machine` (app/machine/machine.mjs) that `launch_topology`, `build_topology` and
 * `AgentChannel` use, on a worker thread of the server. It replays one journal and can then go
 * live; there is no seek, snapshots or crash recovery: a failed machine stays failed.
 */
export class ServerMachine {
  readonly agent: AgentChannel;
  /** Resolves when the worker thread is gone (or was never started). */
  readonly closed: Promise<void>;
  user_paused = false;

  private worker: Worker | null = null;
  private stopped = false;
  private live = false;
  private status: MachineStatus | null = null;
  private lastHeard = 0;
  private seq = 0;
  private speed: number | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Listeners = { end: [], error: [], net_out: [] };
  private readonly started: Promise<void>;
  private settleStart!: { resolve: () => void; reject: (e: Error) => void };
  private settleClosed!: () => void;

  constructor(private readonly options: ServerMachineOptions) {
    const { AgentChannel } = agentChannelCore();
    this.agent = new AgentChannel(
      (text) => this.type(text, 'system', AGENT_PORT),
      { stalled: () => this.workerStalled() },
    );
    this.started = new Promise((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });
    this.started.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
  }

  get id(): string {
    return this.options.id;
  }

  on<K extends keyof ServerMachineEvents>(
    name: K,
    fn: (value: ServerMachineEvents[K]) => void,
  ): void {
    this.listeners[name].push(fn);
  }

  off(name: 'net_out', fn: (frame: Uint8Array) => void): void {
    this.listeners[name] = this.listeners[name].filter((item) => item !== fn);
  }

  /** Spawns the worker and resolves when the machine runs. */
  async start(): Promise<WorkerReplies['start']> {
    try {
      const { header, events } = this.options.journal;
      const worker = new Worker(join(repoRoot(), WORKER_FILE), {
        resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB },
      });
      this.worker = worker;
      this.lastHeard = performance.now();
      worker.on('message', (message: WorkerMessage) => this.onMessage(message));
      worker.on('error', (error) =>
        this.fail(`Помилка воркера: ${error.message}`),
      );
      worker.on('exit', (code) => this.onExit(code));
      const reply = await this.request<'start'>({
        op: 'start',
        params: {
          profile: header.profile,
          seed: header.seed,
          epoch: header.epoch,
          events,
          on_journal_end: 'pause',
          check_every_ms: 0,
          recorded_host_nan: header.host_nan ?? null,
          boot_digest: header.start?.digest ?? null,
          speed: this.speed ?? undefined,
        },
      });
      this.status = reply.status;
      this.settleStart.resolve();
      return reply;
    } catch (error) {
      const failure = asError(error);
      this.settleStart.reject(failure);
      throw failure;
    }
  }

  /** Terminates the worker and rejects everything in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.settleStart.reject(new Error('зупинено'));
    this.rejectAll(new Error('зупинено'));
    if (this.worker === null) {
      this.settleClosed();
      return;
    }
    await this.worker.terminate();
    await this.closed;
  }

  type(data: string, by?: string, port: SerialPort = 0): void {
    this.send({ op: 'type', data, by, port });
  }

  net_in(frame: Uint8Array): void {
    this.send({ op: 'net_in', frame });
  }

  set_speed(x: number): void {
    this.speed = x;
    this.send({ op: 'speed', x });
  }

  pause(): void {
    this.user_paused = true;
    this.send({ op: 'pause' });
  }

  resume(): void {
    this.user_paused = false;
    this.send({ op: 'resume' });
  }

  check(options: { pause?: boolean } = {}): Promise<number> {
    return this.request<'check'>({ op: 'check', pause: options.pause });
  }

  async journal(): Promise<Journal> {
    const { events } = await this.request<'journal'>({ op: 'journal' });
    return { header: this.options.journal.header, events };
  }

  async go_live(): Promise<void> {
    await this.request<'go_live'>({ op: 'go_live' });
    this.user_paused = false;
    this.live = true;
  }

  /** A command through the system channel (ttyS1), live mode only. Rejects when the agent does not answer in time. */
  async system(
    command: string,
    { timeout_ms = SYSTEM_TIMEOUT_MS }: { timeout_ms?: number } = {},
  ): Promise<AgentResult> {
    await this.started;
    if (!this.live) {
      throw new Error(
        'Системну команду не можна виконати: машина не в живому режимі',
      );
    }
    return this.agent.request(command, timeout_ms);
  }

  /** Whether the guest is not running although it should: the emulator waits for the host or is silent. */
  private workerStalled(): boolean {
    if (this.worker === null || this.status?.paused) return false;
    return (
      this.status?.waiting === true ||
      performance.now() - this.lastHeard > STALL_SILENCE_MS
    );
  }

  private send(request: WorkerRequest): void {
    this.worker?.postMessage(request);
  }

  private request<K extends WorkerOp>(
    request: RequestOf<K>,
  ): Promise<WorkerReplies[K]> {
    const worker = this.worker;
    if (worker === null || this.stopped) {
      return Promise.reject(new Error('Машину зупинено'));
    }
    const id = ++this.seq;
    return new Promise<WorkerReplies[K]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve,
        reject,
      });
      worker.postMessage({ ...request, id });
    });
  }

  private onMessage(message: WorkerMessage): void {
    this.lastHeard = performance.now();
    switch (message.op) {
      case 'done':
        this.settle(message.id, message.value, null);
        return;
      case 'error':
        if (message.id !== undefined) {
          this.settle(message.id, undefined, new Error(message.message));
        } else {
          this.fail(message.message);
        }
        return;
      case 'status':
        this.status = message.status;
        return;
      case 'serial1':
        this.agent.feed(message.data);
        return;
      case 'net_out':
        this.emit('net_out', message.frame);
        return;
      case 'end':
        this.emit('end', undefined);
        return;
      case 'serial':
      case 'serial2':
      case 'snapshot':
        return;
      default: {
        const unreachable: never = message;
        throw new Error(
          `unexpected worker message ${JSON.stringify(unreachable)}`,
        );
      }
    }
  }

  private settle(id: number, value: unknown, error: Error | null): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (error) waiter.reject(error);
    else waiter.resolve(value as never);
  }

  private onExit(code: number): void {
    this.worker = null;
    if (!this.stopped) this.fail(`Воркер завершився з кодом ${code}`);
    this.settleClosed();
  }

  /** After a failure the core does not answer any more: nothing in flight can finish. */
  private fail(message: string): void {
    if (this.stopped) return;
    this.rejectAll(new Error(message));
    this.emit('error', message);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.agent.reject_all(error);
  }

  private emit<K extends keyof ServerMachineEvents>(
    name: K,
    value: ServerMachineEvents[K],
  ): void {
    for (const fn of this.listeners[name]) fn(value);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
