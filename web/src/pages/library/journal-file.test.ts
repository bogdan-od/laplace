import { describe, expect, it } from "vitest";
import { parseJournalFile } from "./journal-file";

const JOURNAL = { header: { format: "v86-replay/9", profile: "buildroot", seed: 1 }, events: [{ t: "clock", c: 1, w: 0, extra: 1 }] };

describe("parseJournalFile", () => {
  it("refuses a file that is not JSON", () => {
    const parsed = parseJournalFile("not json");
    expect(parsed.journal).toBeNull();
    expect(parsed.error).toBe("Файл не є коректним JSON");
  });
  it("refuses JSON that is not a journal and says why", () => {
    for (const text of ["42", "null", "{}", JSON.stringify({ ...JOURNAL, events: "x" }), JSON.stringify({ ...JOURNAL, header: { ...JOURNAL.header, format: "v86-replay/1" } })]) {
      const parsed = parseJournalFile(text);
      expect(parsed.journal).toBeNull();
      expect(parsed.error).toContain("Файл не є журналом: ");
    }
  });
  it("accepts a journal", () => {
    const parsed = parseJournalFile(JSON.stringify(JOURNAL));
    expect(parsed.error).toBeNull();
    expect(parsed.journal?.events).toHaveLength(1);
  });
});
