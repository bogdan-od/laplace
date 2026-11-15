import { read_journal, type Journal } from "@core/core/journal.mjs";
import { MAX_JOURNAL_BYTES } from "@shared/limits";

export const MAX_JOURNAL_MB = MAX_JOURNAL_BYTES / 2 ** 20;

export type JournalFile = { journal: Journal; error: null } | { journal: null; error: string };

/** The text of a chosen file -> a journal the player would accept, else the reason in words. The server checks it again. */
export function parseJournalFile(text: string): JournalFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { journal: null, error: "Файл не є коректним JSON" };
  }
  try {
    return { journal: read_journal(raw), error: null };
  } catch (error) {
    return { journal: null, error: `Файл не є журналом: ${error instanceof Error ? error.message : String(error)}` };
  }
}
