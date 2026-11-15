export type TaskKind = "journal" | "topology";

export const MAX_FIELD_CHARS: number;
export const TASK_KINDS: readonly TaskKind[];

export function is_field_id(value: unknown): value is string;
/** An invalid value becomes `null`: the server drops the field, the message itself survives. */
export function clean_machine(value: unknown): string | null;
export function clean_group(value: unknown): string | null;
/** All or nothing: a non-empty array of unique valid ids, at most `MAX_MACHINES`, else `null`. */
export function clean_machines(value: unknown): string[] | null;
/** Unknown kinds become `"journal"`. */
export function clean_task_kind(value: unknown): TaskKind;
