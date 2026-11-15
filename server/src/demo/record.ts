import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LessonMark } from '@core/core/journal.mjs';
import { repoRoot } from '../repo-root';
import {
  DEMO_JOURNALS_DIR,
  LESSON_MARKUP,
  MARKS_FILE,
  SCENARIOS,
  type Scenario,
} from './demo-data';
import { recordSession, type Recording } from './session';

/** Lesson notes at the event counts the recorder saw before each step. */
function lessonMarks(recording: Recording): LessonMark[] {
  const at = (step: number): number => recording.before[step]?.m1 ?? 0;
  return LESSON_MARKUP.map((item) =>
    item.t === 'note'
      ? { t: 'note', at: at(item.step), text: item.text }
      : { t: 'self', from: at(item.from), to: at(item.to), text: item.text },
  );
}

type Marks = Record<string, Record<string, number>[]>;

/** `DEMO_SCENARIOS=vlan-good,vlan-bad` records only those scenarios and keeps the marks of the others. */
function selected(): typeof SCENARIOS {
  const names = process.env.DEMO_SCENARIOS?.split(',').filter(Boolean);
  if (!names) return SCENARIOS;
  const unknown = names.filter(
    (name) => !SCENARIOS.some((scenario) => scenario.name === name),
  );
  if (unknown.length > 0)
    throw new Error(`unknown scenarios: ${unknown.join(', ')}`);
  return SCENARIOS.filter((scenario) => names.includes(scenario.name));
}

/** Prints the check results and reports whether they match what the scenario is for. */
function checksAgree(scenario: Scenario, recording: Recording): boolean {
  const rcs = recording.checks.map((check) => check.rc);
  for (const check of recording.checks)
    console.log(
      `  ${check.title}: rc ${check.rc}${check.rc === 0 ? '' : ` (${check.output.trim().slice(-200)})`}`,
    );
  if (rcs.length === 0) return true;
  const allPass = rcs.every((rc) => rc === 0);
  const anyFail = rcs.some((rc) => rc !== 0);
  const agree = scenario.passes ? allPass : anyFail;
  if (!agree)
    console.log(
      `  MISMATCH: ${scenario.name} should ${scenario.passes ? 'pass all checks' : 'fail a check'}`,
    );
  return agree;
}

async function main(): Promise<void> {
  const dir = join(repoRoot(), DEMO_JOURNALS_DIR);
  mkdirSync(dir, { recursive: true });
  const marksFile = join(dir, MARKS_FILE);
  const marks: Marks =
    process.env.DEMO_SCENARIOS && existsSync(marksFile)
      ? (JSON.parse(readFileSync(marksFile, 'utf8')) as Marks)
      : {};
  let allAgree = true;
  for (const scenario of selected()) {
    const started = Date.now();
    const recording = await recordSession(
      scenario.topology,
      scenario.steps,
      scenario.checks,
    );
    for (const [node, journal] of Object.entries(recording.journals)) {
      if (scenario.name === 'lesson')
        journal.header.lesson = lessonMarks(recording);
      writeFileSync(
        join(dir, `${scenario.name}.${node}.json`),
        JSON.stringify(journal),
      );
    }
    marks[scenario.name] = recording.before;
    const events = Object.entries(recording.journals).map(
      ([node, journal]) => `${node}=${journal.events.length}`,
    );
    console.log(
      `${scenario.name}: ${events.join(' ')} events, ${Math.round((Date.now() - started) / 1000)} s`,
    );
    allAgree = checksAgree(scenario, recording) && allAgree;
  }
  writeFileSync(marksFile, JSON.stringify(marks));
  if (!allAgree) throw new Error('some recordings do not match their checks');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
