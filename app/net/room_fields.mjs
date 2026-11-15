import { MAX_MACHINES } from "./topology.mjs";

export const MAX_FIELD_CHARS = 64;
export const TASK_KINDS = ["journal", "topology"];

const ID_RE = /^[\w-]+$/;

// Id of a machine or a submission group: a non-empty string matching the pattern, up to 64 characters.
export const is_field_id = value => typeof value === "string" && value.length <= MAX_FIELD_CHARS && ID_RE.test(value);

// Below: cleaning of the optional room protocol fields. An invalid value becomes null:
// the server drops the field, and the message itself survives.
export const clean_machine = value => is_field_id(value) ? value : null;
export const clean_group = clean_machine;

// The whole array is either accepted or rejected: half a list of machines would mislead the teacher.
// An empty array is the same as a missing field.
export function clean_machines(value) {
    if(!Array.isArray(value) || value.length === 0 || value.length > MAX_MACHINES) return null;
    if(!value.every(is_field_id) || new Set(value).size !== value.length) return null;
    return [...value];
}

// "journal" is the default value; an unknown kind becomes it too.
export const clean_task_kind = value => TASK_KINDS.includes(value) ? value : "journal";
