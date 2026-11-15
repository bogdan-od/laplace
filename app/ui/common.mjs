import { PROFILES } from "../profiles.mjs";
import { read_journal } from "../core/journal.mjs";

const OBJECT_URL_LIFETIME_MS = 1000;
const ISO_DATE_LENGTH = 10;
const MS_PER_S = 1000;
const S_PER_MIN = 60;

export const $ = id => document.getElementById(id);

export function format_clock(ms) {
    const seconds = Math.floor(ms / MS_PER_S);
    return `${String(Math.floor(seconds / S_PER_MIN)).padStart(2, "0")}:${String(seconds % S_PER_MIN).padStart(2, "0")}`;
}

export const ratio_of = (part, whole) => (whole ? part / whole : 0);

export function profile_by_name(name) {
    if(!Object.hasOwn(PROFILES, name)) throw new Error(`Невідомий профіль: ${name}`);
    return PROFILES[name];
}

export function profile_name(name) {
    profile_by_name(name);
    return name;
}

export function parse_journal_text(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch (error) {
        if(!(error instanceof SyntaxError)) throw error;
        throw new Error("Журнал: файл не є JSON");
    }
    return read_journal(json);
}

export async function fetch_journal(url) {
    const response = await fetch(url);
    if(!response.ok) throw new Error(`Журнал не знайдено: ${url} (${response.status})`);
    return parse_journal_text(await response.text());
}

export function save_journal(journal, name) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(journal)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-${new Date().toISOString().slice(0, ISO_DATE_LENGTH)}.v86j.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

export function show_error(text) {
    $("err").textContent = text;
}

export async function report_errors(task) {
    try {
        await task();
    } catch (error) {
        show_error(error.message);
    }
}
