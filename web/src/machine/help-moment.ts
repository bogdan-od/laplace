// "Переглянути момент": the player link of a help request. The request knows the branch and how many events the
// journal had (`event_count`), not the guest time; the time comes from the journal of the branch up to that event.

import { event_times, read_journal } from "@core/core/journal.mjs";
import type { HelpRequest } from "@shared/api";
import { api } from "@/lib/api";
import { branchHref } from "./branch-tree";
import { momentTime } from "./player-marks";

/** `reply`: the teacher comes to answer the request, so the player offers "Відповісти звідси" there. */
export async function helpMomentHref(help: Pick<HelpRequest, "id" | "branch_id" | "event_count">, reply = false): Promise<string> {
  const journal = read_journal(
    await api("GET /api/branches/:id/journal", { params: { id: help.branch_id }, query: { to: help.event_count } }),
  );
  const href = branchHref(help.branch_id, momentTime(event_times(journal), help.event_count));
  return reply ? `${href}&reply=${help.id}` : href;
}
