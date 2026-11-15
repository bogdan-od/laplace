import { describe, expect, it, vi } from "vitest";
import { helpMomentHref } from "./help-moment";

vi.mock("@/lib/api", () => ({ api: vi.fn(async () => ({})) }));
vi.mock("@core/core/journal.mjs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  read_journal: (json: unknown) => json,
  event_times: () => Float64Array.from([10, 250.4, 900]),
}));

const REQUEST = { id: 8, branch_id: 77, event_count: 2 };

describe("helpMomentHref", () => {
  it("opens the branch at the guest time of the last event of the request", async () => {
    expect(await helpMomentHref(REQUEST)).toBe("/play/branch-77?t=250");
  });

  it("adds the request to answer", async () => {
    expect(await helpMomentHref(REQUEST, true)).toBe("/play/branch-77?t=250&reply=8");
  });
});
