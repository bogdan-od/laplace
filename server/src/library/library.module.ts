import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../assignments/assignments.module';
import { ClassesModule } from '../classes/classes.module';
import { JournalsModule } from '../journals/journals.module';
import { DerivedItemsService } from './derived-items.service';
import { EmbedController } from './embed.controller';
import { EmbedService } from './embed.service';
import { LibraryJournalsService } from './library-journals.service';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [AssignmentsModule, ClassesModule, JournalsModule],
  controllers: [LibraryController, EmbedController],
  providers: [
    DerivedItemsService,
    EmbedService,
    LibraryJournalsService,
    LibraryService,
  ],
  exports: [LibraryService],
})
export class LibraryModule {}
