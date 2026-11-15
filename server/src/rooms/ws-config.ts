import { Injectable } from '@nestjs/common';
import { WS_PING_MS, WS_STALE_MS } from '@shared/limits';

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** Timings of the WebSocket liveness check, read once from the environment (tests shorten them). */
@Injectable()
export class WsConfig {
  /** A client that has pinged and then stays silent this long is dropped (`WS_STALE_MS`). */
  readonly staleMs = positiveInt('WS_STALE_MS', WS_STALE_MS);
  /** How often silent clients are looked for. */
  readonly sweepMs = Math.min(WS_PING_MS, Math.ceil(this.staleMs / 3));
}
