// "Продовжити звідси" / "Відповісти звідси": which fork the viewer may make from the position of
// the player, and the branch it creates. Pure, so the choice and the request body can be tested without a screen.

import { journal_digest, type Journal } from "@core/core/journal.mjs";
import type { CreateBranchBody, HelpRequest, JournalHeader, Role } from "@shared/api";
import { currentCommand, type PlayerCommand } from "./player-marks";

/** A request for help on the played branch and the guest time of its moment. */
export interface ForkHelp {
  request: HelpRequest;
  time: number;
}

/** What the player knows about the attempt of a branch it plays (`GET /api/branches/:id`). */
export interface BranchInfo {
  branchId: number;
  attemptId: number;
  assignmentId: number;
  classId: number;
  studentId: number;
  node: string;
  help: readonly ForkHelp[];
}

export interface ForkViewer {
  id: number;
  role: Role;
}

export interface ForkChoice {
  kind: "continue" | "reply";
  label: string;
  /** The event the new branch breaks the journal at. */
  eventCount: number;
  /** The request a `reply` answers. */
  help: HelpRequest | null;
  /** A seek is running: the position is not the place the machine stands at yet. */
  disabled: boolean;
}

export interface ForkInput {
  viewer: ForkViewer;
  /** null: the source is not a branch (a submission). */
  info: BranchInfo | null;
  position: number;
  /** Events up to `position`. */
  eventCount: number;
  commands: readonly PlayerCommand[];
  seeking: boolean;
  /** `?reply=<help id>`: the request the teacher came to answer. */
  replyId: number | null;
}

export const CONTINUE_LABEL = "Продовжити звідси";
export const REPLY_LABEL = "Відповісти звідси";

/**
 * The student on their own branch continues; a teacher answers a request of the branch when the player stands on its
 * "not working" moment (the same command as the request); nothing else forks.
 */
export function chooseFork(input: ForkInput): ForkChoice | null {
  const { viewer, info, seeking } = input;
  if (info === null) return null;
  if (viewer.id === info.studentId) {
    return { kind: "continue", label: CONTINUE_LABEL, eventCount: input.eventCount, help: null, disabled: seeking };
  }
  if (viewer.role !== "teacher") return null;
  const here = currentCommand(input.commands, input.position);
  const open = info.help.filter((item) => item.request.reply_branch_id === null);
  const onMoment = open.filter((item) => currentCommand(input.commands, item.time) === here);
  const chosen = onMoment.find((item) => item.request.id === input.replyId) ?? onMoment[0];
  if (chosen === undefined) return null;
  return {
    kind: "reply",
    label: input.replyId === null ? CONTINUE_LABEL : REPLY_LABEL,
    eventCount: chosen.request.event_count,
    help: chosen.request,
    disabled: seeking,
  };
}

/**
 * The header of a branch that goes on from the first `eventCount` events of `journal`. The lesson marks of the recording
 * are indices into the whole journal, so the new branch does not inherit them.
 */
export function forkHeader(journal: Journal, eventCount: number, recordedAt: string): JournalHeader {
  const header: JournalHeader = {
    ...journal.header,
    recorded_at: recordedAt,
    parent: { digest: journal_digest({ events: journal.events.slice(0, eventCount) }), event: eventCount },
  };
  delete header.lesson;
  return header;
}

/** The body of `POST /api/attempts/:id/branches`; only the student's own `continue` becomes the head. */
export function forkBody(info: BranchInfo, journal: Journal, choice: ForkChoice, recordedAt: string): CreateBranchBody {
  return {
    node: info.node,
    parent: { branch_id: info.branchId, event: choice.eventCount },
    kind: choice.kind,
    header: forkHeader(journal, choice.eventCount, recordedAt),
    make_head: choice.kind === "continue",
  };
}
