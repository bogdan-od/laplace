import { Global, Injectable, Module } from '@nestjs/common';

/** The only source of server time. Tests replace it through DI to move the clock. */
@Injectable()
export class Clock {
  now(): number {
    return Date.now();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
