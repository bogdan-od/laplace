// The real wiring of a `LessonSession`, as `attempt-factory.ts` does for an attempt.

import { Machine } from "@core/machine/machine.mjs";
import { api } from "@/lib/api";
import { MachineHub } from "./hub";
import { LessonSession, type LessonDeps, type LessonSource } from "./lesson-session";

/** The memory the machine of a lesson may keep for its snapshots. */
const SNAPSHOT_BYTES = 256 << 20;

function realDeps(): LessonDeps {
  return {
    api,
    createMachine: (options) => new Machine(options),
    loadImagesRoot: async () => (await api("GET /api/images")).root,
    snapshotBytes: SNAPSHOT_BYTES,
  };
}

export const lessonHub = new MachineHub<LessonSession>();

/** The key of an assignment stays `lesson:<id>`; a previewed item has its own, so the two never meet. */
export const lessonKey = (source: LessonSource): string => (source.kind === "assignment" ? `lesson:${source.id}` : `lesson-item:${source.id}`);

export function acquireLesson(source: LessonSource): LessonSession {
  const session = lessonHub.acquire(lessonKey(source), () => new LessonSession(source, realDeps()));
  session.start();
  return session;
}

export function releaseLesson(source: LessonSource): void {
  lessonHub.release(lessonKey(source));
}
