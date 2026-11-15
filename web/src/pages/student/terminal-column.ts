/**
 * What the left column of the student's page holds: the terminal while the student is in the room, a short wait for the room to answer,
 * and nothing when the student is offline (the width then goes to the submission panel and the player).
 */
export type TerminalColumn = "connecting" | "terminal" | "none";

export function terminalColumn(joined: boolean, present: boolean): TerminalColumn {
  if (!joined) return "connecting";
  return present ? "terminal" : "none";
}
