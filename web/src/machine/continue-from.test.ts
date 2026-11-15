import type { Journal } from "@core/core/journal.mjs";
import { journal_digest } from "@core/core/journal.mjs";
import type { HelpRequest } from "@shared/api";
import { describe, expect, it } from "vitest";
import { chooseFork, forkBody, forkHeader, type BranchInfo, type ForkInput } from "./continue-from";
import type { PlayerCommand } from "./player-marks";

const STEP = 10_000;

function command(number: number): PlayerCommand {
  const time = number * STEP;
  return { number, text: `cmd${number}`, start: number, index: number, time, target: time + STEP - 1, by: "student", port: 0, uncertain: false };
}

const COMMANDS = [command(1), command(2), command(3)];

function help(id: number, eventCount: number, replied = false): HelpRequest {
  return { id, event_count: eventCount, reply_branch_id: replied ? 99 : null } as HelpRequest;
}

const INFO: BranchInfo = {
  branchId: 7,
  attemptId: 3,
  assignmentId: 4,
  classId: 5,
  studentId: 6,
  node: "m1",
  help: [{ request: help(1, 2), time: 2 * STEP }],
};

function input(change: Partial<ForkInput>): ForkInput {
  return {
    viewer: { id: 6, role: "student" },
    info: INFO,
    position: 2 * STEP,
    eventCount: 2,
    commands: COMMANDS,
    seeking: false,
    replyId: null,
    ...change,
  };
}

const TEACHER = { id: 9, role: "teacher" } as const;

describe("chooseFork", () => {
  it("the student on their own branch continues from the position", () => {
    expect(chooseFork(input({ eventCount: 5 }))).toEqual({
      kind: "continue",
      label: "Продовжити звідси",
      eventCount: 5,
      help: null,
      disabled: false,
    });
  });

  it("a teacher on the moment of a request replies to it, at the event of the request", () => {
    const choice = chooseFork(input({ viewer: TEACHER, eventCount: 4, position: 2 * STEP + 500 }));
    expect(choice).toMatchObject({ kind: "reply", eventCount: 2, label: "Продовжити звідси", disabled: false });
    expect(choice?.help?.id).toBe(1);
  });

  it("the button of a link from the request is named for the answer", () => {
    expect(chooseFork(input({ viewer: TEACHER, replyId: 1 }))?.label).toBe("Відповісти звідси");
  });

  it("a teacher away from the moment of a request has no button", () => {
    expect(chooseFork(input({ viewer: TEACHER, position: 3 * STEP }))).toBeNull();
  });

  it("a request that is already answered is not a moment to reply to", () => {
    const answered = { ...INFO, help: [{ request: help(1, 2, true), time: 2 * STEP }] };
    expect(chooseFork(input({ viewer: TEACHER, info: answered }))).toBeNull();
  });

  it("a submission has no fork, for anyone", () => {
    expect(chooseFork(input({ info: null }))).toBeNull();
    expect(chooseFork(input({ info: null, viewer: TEACHER }))).toBeNull();
  });

  it("another student has no button", () => {
    expect(chooseFork(input({ viewer: { id: 77, role: "student" } }))).toBeNull();
  });

  it("while a seek runs the button is there but disabled", () => {
    expect(chooseFork(input({ seeking: true }))?.disabled).toBe(true);
    expect(chooseFork(input({ viewer: TEACHER, seeking: true }))?.disabled).toBe(true);
  });
});

describe("the branch a fork creates", () => {
  const journal: Journal = {
    header: {
      format: "v86-replay/9",
      profile: "buildroot",
      seed: 1,
      machine: "m1",
      lesson: [{ t: "note", at: 1, text: "примітка" }],
      parent: { digest: "old", event: 1 },
    },
    events: [0, 1, 2, 3].map((i) => ({ t: "serial", c: 0, w: i, data: `${i}` })) as Journal["events"],
  };
  const NOW = "2037-11-13T10:00:00.000Z";

  it("the header does not inherit the lesson marks and names the prefix as the parent", () => {
    const header = forkHeader(journal, 2, NOW);
    expect(header).not.toHaveProperty("lesson");
    expect(header).toMatchObject({ profile: "buildroot", seed: 1, machine: "m1", recorded_at: NOW });
    expect(header.parent).toEqual({ digest: journal_digest({ events: journal.events.slice(0, 2) }), event: 2 });
    expect(journal.header.lesson).toHaveLength(1);
  });

  it("continue is the head of the student's work", () => {
    const choice = chooseFork(input({ eventCount: 3 }));
    if (choice === null) throw new Error("no choice");
    const body = forkBody(INFO, journal, choice, NOW);
    expect(body).toMatchObject({ node: "m1", parent: { branch_id: 7, event: 3 }, kind: "continue", make_head: true });
    expect(body.header).not.toHaveProperty("lesson");
  });

  it("reply is not the head and forks at the event of the request", () => {
    const choice = chooseFork(input({ viewer: TEACHER, eventCount: 4 }));
    if (choice === null) throw new Error("no choice");
    expect(forkBody(INFO, journal, choice, NOW)).toMatchObject({
      node: "m1",
      parent: { branch_id: 7, event: 2 },
      kind: "reply",
      make_head: false,
    });
  });
});
