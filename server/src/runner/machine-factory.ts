import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ServerMachine, type ServerMachineOptions } from './server-machine';

/** Creates server machines and knows which worker threads are still alive, so shutdown can end them. */
@Injectable()
export class MachineFactory implements OnModuleDestroy {
  private readonly alive = new Set<ServerMachine>();

  create(options: ServerMachineOptions): ServerMachine {
    const machine = new ServerMachine(options);
    this.alive.add(machine);
    void machine.closed.then(() => this.alive.delete(machine));
    return machine;
  }

  /** Machines whose worker thread has not exited yet. */
  get aliveCount(): number {
    return this.alive.size;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.alive].map((machine) => machine.stop()));
  }

  async onModuleDestroy(): Promise<void> {
    await this.stopAll();
  }
}
