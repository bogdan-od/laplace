import { describe, expect, it } from "vitest";
import { terminalColumn } from "./terminal-column";

describe("terminalColumn", () => {
  it("waits for the room before it decides", () => {
    expect(terminalColumn(false, false)).toBe("connecting");
    expect(terminalColumn(false, true)).toBe("connecting");
  });

  it("shows the terminal for a student in the room and no column for an offline one", () => {
    expect(terminalColumn(true, true)).toBe("terminal");
    expect(terminalColumn(true, false)).toBe("none");
  });
});
