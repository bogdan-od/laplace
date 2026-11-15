import { Injectable } from '@nestjs/common';

const DEFAULT_WORKERS = 2;
const DEFAULT_TIMEOUT_MS = 180_000;

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** Limits of the replay workers, read once from the environment when the application starts. */
@Injectable()
export class RunnerConfig {
  /** Replay workers alive at the same time (`RUNNER_WORKERS`). */
  readonly workers = positiveInt('RUNNER_WORKERS', DEFAULT_WORKERS);
  /** Real time one journal may take to replay (`RUNNER_TIMEOUT_MS`). */
  readonly timeoutMs = positiveInt('RUNNER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}
