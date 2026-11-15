import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import type { Readable } from 'node:stream';
import { notFound } from '../common/api-exception';

/** Builds the full journal of a branch (the attempts module owns branches and chunks). */
export interface JournalAssembler {
  /** The journal of the branch cut to its first `to` events (all of them by default), as a JSON stream. */
  assemble(branchId: Id, to?: number): Readable | Promise<Readable>;
}

export const NO_BRANCHES: JournalAssembler = {
  assemble: () => {
    throw notFound('Спробу не знайдено');
  },
};

/**
 * Entry point used by the library. Until the attempts module plugs in, every branch is "not found".
 * It calls `use(assembler)` in onModuleInit; the library never imports it.
 */
@Injectable()
export class JournalAssembly implements JournalAssembler {
  private assembler: JournalAssembler = NO_BRANCHES;

  use(assembler: JournalAssembler): void {
    this.assembler = assembler;
  }

  assemble(branchId: Id, to?: number): Readable | Promise<Readable> {
    return this.assembler.assemble(branchId, to);
  }
}
