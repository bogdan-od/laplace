// The part of `Machine` (app/machine/machine.mjs) that the machine layer uses. A session works with this
// interface, so tests can pass a fake; the real class satisfies it, which the factory checks at compile time.

import type { Machine } from "@core/machine/machine.mjs";

type Methods =
  | "on"
  | "start"
  | "stop"
  | "type"
  | "teacher_input"
  | "run_setup"
  | "begin_session"
  | "net_in"
  | "set_speed"
  | "pause"
  | "resume"
  | "check"
  | "journal"
  | "checked_journal"
  | "header_now"
  | "go_live"
  | "rollback";

type Fields = "dead" | "failed" | "recovering" | "status" | "mirror" | "live" | "user_paused";

export type MachineLike = Pick<Machine, Methods> & Readonly<Pick<Machine, Fields>>;
