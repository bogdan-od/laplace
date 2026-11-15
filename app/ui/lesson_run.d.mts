import type { Journal, LessonMark } from "../core/journal.mjs";
import type { Machine } from "../machine/machine.mjs";

/** A journal with lesson marks (`header.lesson` is required here). */
export type LessonJournal = Journal & { header: { lesson: LessonMark[] } };

/**
 * A lesson for a student: the teacher's journal plays at 1x; at the start of each "now on your own" segment the
 * replay stops and the machine becomes live. Phases (`body.dataset.lessonPhase`): play, student, retry, solution, solved, done.
 */
export class LessonRun {
    #private;
    /** `set_live` is called with `true` while the student works. Expects the lesson elements of player.html. */
    constructor(machine: Machine, journal: LessonJournal, set_live: (live: boolean) => void);
    begin(): Promise<void>;
}
