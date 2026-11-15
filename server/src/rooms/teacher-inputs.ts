import { Injectable } from '@nestjs/common';
import type { Id } from '@shared/api';
import type { SerialPort } from '@shared/ws';
import { Clock } from '../common/clock';
import { Db } from '../db/db';

export interface TeacherInput {
  assignmentId: Id;
  studentId: Id;
  nodeId: string;
  port: SerialPort;
  data: string;
  authorId: Id;
}

/** The log of what teachers typed into student terminals; shown next to the submission. */
@Injectable()
export class TeacherInputs {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(input: TeacherInput): void {
    this.db.run(
      `INSERT INTO teacher_inputs (assignment_id, student_id, node_id, port, data, author_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.assignmentId,
      input.studentId,
      input.nodeId,
      input.port,
      input.data,
      input.authorId,
      this.clock.now(),
    );
  }
}
