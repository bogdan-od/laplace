import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ApiError, BranchDetail, Id } from '@shared/api';
import {
  evs,
  openAttempt,
  putEvents,
  startBranch,
  world,
} from './attempt-fixtures';
import { createTestApp, TestApp, whoAmI } from './helpers';

let t: TestApp;
before(async () => {
  t = await createTestApp();
});
after(async () => {
  await t.close();
});

describe('GET /api/branches/:id', () => {
  test('the owner and the teachers get the attempt, the others do not', async () => {
    const w = await world(t);
    const attempt = await openAttempt(w.student, w.assignment.id);
    const start = await startBranch(w.student, attempt.id);
    await putEvents(w.student, start.id, 0, evs(0, 6));
    const help = (
      await w.student
        .post(`/api/attempts/${attempt.id}/help`)
        .send({
          node: 'm1',
          branch_id: start.id,
          event_count: 6,
          text: 'Не працює',
        })
        .expect(201)
    ).body as { id: Id };
    const teacher = await whoAmI(w.owner);
    t.db.run(
      `INSERT INTO teacher_inputs (assignment_id, student_id, node_id, port, data, author_id, received_at)
       VALUES (?, ?, 'm1', 0, 'ls\n', ?, 1)`,
      w.assignment.id,
      attempt.user.id,
      teacher.id,
    );
    const url = `/api/branches/${start.id}`;

    const own = (await w.student.get(url).expect(200)).body as BranchDetail;
    assert.equal(own.branch.id, start.id);
    assert.equal(own.attempt_id, attempt.id);
    assert.deepEqual(own.assignment, {
      id: w.assignment.id,
      title: w.assignment.title,
      class_id: w.classId,
    });
    assert.deepEqual(own.student, attempt.user);
    assert.equal(own.machine, 'm1');
    assert.deepEqual(
      own.help_requests.map((item) => item.id),
      [help.id],
    );
    assert.deepEqual(own.teacher_inputs, []);

    for (const teacherClient of [w.owner, w.assistant]) {
      const seen = (await teacherClient.get(url).expect(200))
        .body as BranchDetail;
      assert.equal(seen.teacher_inputs.length, 1);
      assert.equal(seen.teacher_inputs[0]?.data, 'ls\n');
      assert.equal(seen.teacher_inputs[0]?.author.id, teacher.id);
    }

    await t.client().get(url).expect(401);
    await w.stranger.get(url).expect(404);
    await w.outsider.get(url).expect(404);
    await w.classmate.get(url).expect(403);
    const missing = await w.student.get('/api/branches/999999').expect(404);
    assert.equal((missing.body as ApiError).message, 'Гілку не знайдено');
  });
});
