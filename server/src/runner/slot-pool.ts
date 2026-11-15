import { Injectable } from '@nestjs/common';
import { RunnerConfig } from './runner-config';

interface Waiter {
  weight: number;
  grant: (release: () => void) => void;
}

/**
 * Limits how many replay workers exist at once. A job asks for as many slots as it has workers and
 * waits its turn (first come, first served). A job that needs more than the pool holds, such as a
 * check run of a six-machine topology, gets the whole pool: it runs alone, but runs.
 */
@Injectable()
export class SlotPool {
  private used = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly config: RunnerConfig) {}

  /** Resolves with a function that gives the slots back; calling it twice is harmless. */
  acquire(weight: number): Promise<() => void> {
    const wanted = Math.min(Math.max(1, weight), this.config.workers);
    return new Promise((resolve) => {
      this.waiting.push({ weight: wanted, grant: resolve });
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      const next = this.waiting[0];
      if (!next || this.used + next.weight > this.config.workers) return;
      this.waiting.shift();
      this.used += next.weight;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        this.used -= next.weight;
        this.pump();
      });
    }
  }
}
