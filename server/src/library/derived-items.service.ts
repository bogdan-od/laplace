import { Injectable } from '@nestjs/common';
import type { Id, LibraryItem, Topology } from '@shared/api';
import { MAX_JOURNAL_BYTES } from '@shared/limits';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, forbidden, notFound } from '../common/api-exception';
import { Access, isTeacherRole } from '../classes/access.service';
import { Db } from '../db/db';
import { collect } from '../journals/collect';
import { JournalAssembly } from '../journals/journal-assembly';
import { JournalStore } from '../journals/journal-store';
import type { ClipDto, LessonFromSubmissionDto } from './dto';
import { LibraryService } from './library.service';

const NO_ATTEMPT_TEXT = 'Спробу не знайдено';

interface AssignmentScope {
  class_id: Id;
  title: string;
  topology: string;
}

/**
 * Items made from a student's attempt (lesson-from-submission, clip). It reads the attempts tables for
 * the lookup and asks the journal assembler for the journal itself.
 */
@Injectable()
export class DerivedItemsService {
  constructor(
    private readonly db: Db,
    private readonly access: Access,
    private readonly library: LibraryService,
    private readonly store: JournalStore,
    private readonly assembly: JournalAssembly,
  ) {}

  async lessonFromSubmission(
    user: AuthUser,
    dto: LessonFromSubmissionDto,
  ): Promise<LibraryItem> {
    this.library.requireTeacher(user);
    const scope = this.db.get<AssignmentScope>(
      `SELECT a.class_id, a.title, a.topology
       FROM submissions s
       JOIN attempts t ON t.id = s.attempt_id
       JOIN assignments a ON a.id = t.assignment_id
       WHERE s.id = ? AND a.deleted_at IS NULL`,
      dto.submission_id,
    );
    if (!scope) throw notFound(NO_ATTEMPT_TEXT);
    this.requireClassTeacher(user, scope.class_id);
    const topology = JSON.parse(scope.topology) as Topology;
    if (topology.machines.length !== 1) {
      throw badRequest('Урок можна створити лише зі здачі з однією машиною');
    }
    if (topology.machines[0]?.id !== dto.node) {
      throw badRequest(`Машини "${dto.node}" немає в завданні`);
    }
    const journal = this.db.get<{ branch_id: Id; event_count: number }>(
      'SELECT branch_id, event_count FROM submission_journals WHERE submission_id = ? AND node_id = ?',
      dto.submission_id,
      dto.node,
    );
    if (!journal) throw notFound(NO_ATTEMPT_TEXT);
    const assembled = await this.assemble(
      journal.branch_id,
      journal.event_count,
    );
    // The lesson markup is added by the author later; a mark copied from a student is dropped.
    const parsed = this.store.parse(assembled);
    delete parsed.header.lesson;
    const sha256 = await this.store.put(JSON.stringify(parsed));
    return this.createItem(user, 'lesson', scope.title, topology, null, sha256);
  }

  async clip(user: AuthUser, dto: ClipDto): Promise<LibraryItem> {
    this.library.requireTeacher(user);
    const branch = this.db.get<
      AssignmentScope & { node_id: string; event_count: number }
    >(
      `SELECT a.class_id, a.title, a.topology, b.node_id, b.event_count
       FROM branches b
       JOIN attempts t ON t.id = b.attempt_id
       JOIN assignments a ON a.id = t.assignment_id
       WHERE b.id = ? AND a.deleted_at IS NULL`,
      dto.branch_id,
    );
    if (!branch) throw notFound(NO_ATTEMPT_TEXT);
    this.requireClassTeacher(user, branch.class_id);
    if (dto.to_event > branch.event_count) {
      throw badRequest('Кінець фрагмента лежить за межами журналу');
    }
    const machine = (JSON.parse(branch.topology) as Topology).machines.find(
      (candidate) => candidate.id === branch.node_id,
    );
    if (!machine) throw notFound(NO_ATTEMPT_TEXT);
    const clipMachine: Topology['machines'][number] = {
      id: machine.id,
      profile: machine.profile,
      ...(machine.title === undefined ? {} : { title: machine.title }),
    };
    const topology: Topology = {
      format: 'v86-topology/1',
      machines: [clipMachine],
      switches: [],
      links: [],
    };
    const assembled = await this.assemble(dto.branch_id, dto.to_event);
    const sha256 = await this.store.put(assembled);
    return this.createItem(
      user,
      'clip',
      dto.title,
      topology,
      dto.from_ms,
      sha256,
    );
  }

  private requireClassTeacher(user: AuthUser, classId: Id): void {
    const role = this.access.roleOf(user.id, classId);
    if (role === null) throw notFound(NO_ATTEMPT_TEXT);
    if (!isTeacherRole(role)) {
      throw forbidden('Ця дія доступна лише вчителю класу');
    }
  }

  private async assemble(branchId: Id, to: number): Promise<Buffer> {
    return collect(
      await this.assembly.assemble(branchId, to),
      MAX_JOURNAL_BYTES,
    );
  }

  private createItem(
    user: AuthUser,
    kind: 'lesson' | 'clip',
    title: string,
    topology: Topology,
    clipFromMs: number | null,
    sha256: string,
  ): LibraryItem {
    const machine = topology.machines[0];
    if (!machine) throw new Error('a lesson or clip topology has no machine');
    return this.db.tx(() => {
      const item = this.library.insert(
        user,
        kind,
        title,
        '',
        topology,
        clipFromMs,
      );
      this.db.run(
        `INSERT INTO item_journals (item_id, node_id, role, journal_sha) VALUES (?, ?, 'start', ?)`,
        item.id,
        machine.id,
        sha256,
      );
      return this.library.view(item);
    });
  }
}
