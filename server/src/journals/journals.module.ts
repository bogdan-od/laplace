import { Module } from '@nestjs/common';
import { JournalAssembly } from './journal-assembly';
import { JournalStore } from './journal-store';

@Module({
  providers: [JournalStore, JournalAssembly],
  exports: [JournalStore, JournalAssembly],
})
export class JournalsModule {}
