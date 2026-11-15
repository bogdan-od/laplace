import { Machine } from "../machine/machine.mjs";
import { duration_ms, event_times, commands } from "../core/journal.mjs";
import { $, format_clock, ratio_of, profile_name, fetch_journal, save_journal, show_error, report_errors } from "./common.mjs";
import { Router } from "../net/router.mjs";
import { read_relay_url } from "../net/config.mjs";
import { join_room } from "./room_mode.mjs";
import { Network, shell_ready } from "./network.mjs";
import { ReportQueue, upload_journal } from "./report_queue.mjs";
import { SessionKeeper, find_unfinished, open_store, room_key_name, session_key } from "./session_keeper.mjs";

const SNAP_EVERY_MS = 15000;
const CHECK_EVERY_MS = 10000;
const MS_PER_S = 1000;
const PERCENT = 100;
const SPEED_MAX = 0;
const TERM_COLS = 110;
const TERM_ROWS = 30;
const DEFAULT_NAME = "student";
const DEFAULT_PROFILE = "buildroot";

let session_keeper = null;
const reports = new ReportQueue({ upload: upload_journal, on_link: show_link, on_submitted: () => session_keeper?.finish() });

const params = new URLSearchParams(location.search);
const name = params.get("name") || DEFAULT_NAME;

report_errors(start_lab);

async function start_lab() {
    const task_url = params.get("task");
    const profile = profile_name(params.get("profile") ?? DEFAULT_PROFILE);
    const room_name = params.get("room");
    const store = await open_store();
    const key = session_key({ profile, task: task_url, room: room_name, name });
    const restored = store ? await choose_session(store, key, room_name) : null;
    const task = !restored && task_url ? await fetch_journal(task_url) : null;
    // A lesson (header.lesson) in a saved session is markup of someone else's recording: after a rollback its indices
    // go past the journal.
    const journal = restored ? { header: omit_lesson(restored.meta.header), events: restored.events } : task;
    const machine = new Machine({
        profile, root: "../", journal, on_journal_end: "live",
        snap_every_ms: SNAP_EVERY_MS, check_every_ms: CHECK_EVERY_MS, name,
    });
    window.machine = machine;
    open_terminal(machine);
    attach(machine, journal ? duration_ms(journal) : null, restored ? "Відновлюю сесію" : "Відтворюю завдання");
    if(journal) machine.set_speed(SPEED_MAX);
    else $("banner").textContent = "Машина ваша";
    const router = new Router(machine);
    const ready = shell_ready(machine, profile);
    const relay_url = await relay_url_or_null();
    const network = new Network(machine, router, { relay_url });
    wire_buttons(machine, network);
    if(room_name) reports.attach(await join_room(machine, { room_name, name, profile, router, network, ready }));
    if(!room_name) report_errors(() => network.start(ready, null));
    await machine.start();
    // The boot snapshot was taken after the prompt was printed; an empty line makes the shell print it again
    // (journaled like any input). The guest clock is that of the snapshot: the date is set through the system channel.
    if(!journal) machine.begin_session();
    if(store) await keep_session(store, machine, { key, room: room_name }, restored);
}

// An unfinished saved session with the same parameters: ask whether to restore it or start over.
async function choose_session(store, key, room_name) {
    const saved = await find_unfinished(store, key);
    if(!saved) return null;
    const when = new Date(saved.meta.updated).toLocaleString("uk-UA");
    if(!confirm(`Відновити попередню сесію? Остання зміна: ${when}, подій у журналі: ${saved.events.length}`)) {
        await store.remove(key);
        return null;
    }
    // The student's number N in the room depends on the client key: without it the server would assign a different one.
    if(room_name && saved.meta.room_key) sessionStorage.setItem(room_key_name(room_name), saved.meta.room_key);
    return saved;
}

const omit_lesson = ({ lesson, ...header }) => header;

async function keep_session(store, machine, options, restored) {
    try {
        const keeper = new SessionKeeper(store, machine, options);
        await keeper.begin(restored);
        session_keeper = keeper;
    } catch(error) {
        console.warn("Session saving is off:", error);
    }
}

async function relay_url_or_null() {
    try {
        return await read_relay_url(params);
    } catch (error) {
        show_error(error.message);
        return null;
    }
}

function open_terminal(machine) {
    const term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, convertEol: false });
    term.open($("terminal"));
    term.onData(data => machine.type(data));
    machine.on("serial", bytes => term.write(bytes));
    machine.on("reset", () => term.reset());
}

function attach(machine, replay_ms, replay_label) {
    machine.on("status", status => {
        on_status(status);
        if(replay_ms !== null && !status.ended && !machine.recovering) show_progress(status, replay_ms, replay_label);
    });
    machine.on("recovering", () => {
        $("banner").textContent = "Збій машини, відновлюю…";
        $("note").textContent = "";
    });
    machine.on("recovered", () => { $("note").textContent = "Машину відновлено після збою, робота не втрачена"; });
    machine.on("end", () => { $("banner").textContent = "Машина ваша"; });
    machine.on("error", show_error);
}

function on_status(status) {
    $("mode").textContent = status.mode === "live" ? "жива" : "повтор";
    $("vt").textContent = (status.vtime / MS_PER_S).toFixed(1);
    $("total").textContent = status.total;
}

function show_progress(status, replay_ms, label) {
    const percent = Math.floor(ratio_of(status.vtime, replay_ms) * PERCENT);
    $("banner").textContent = `${label}… ${percent}%`;
}

function wire_buttons(machine, network) {
    machine.on("status", status => { $("rollback").disabled = status.mode !== "live"; });
    $("rollback").onclick = () => report_errors(() => toggle_rollback_list(machine, network));
    $("save").onclick = () => report_errors(async () => save_journal(await machine.checked_journal(), name));
    $("problem").onclick = () => report_errors(() => send_journal(machine, "problem"));
    $("submit").onclick = () => report_errors(() => send_journal(machine, "submit"));
    $("copy").onclick = () => report_errors(copy_link);
}

async function send_journal(machine, kind) {
    $("note").textContent = "";
    await reports.add(kind, await machine.checked_journal());
}

function show_link(id) {
    $("link").value = new URL(`player.html?j=/journals/${id}`, location.href).href;
    $("share").hidden = false;
}

async function copy_link() {
    const input = $("link");
    input.select();
    await navigator.clipboard.writeText(input.value);
}

async function toggle_rollback_list(machine, network) {
    const list = $("rollback_list");
    if(!list.hidden) return close_rollback_list();
    const journal = await machine.journal();
    const times = event_times(journal);
    const own = commands(journal.events).filter(command => command.by === "student");
    const items = [{ label: "До початку", index: 0 }, ...own.map(command => ({
        label: `${format_clock(times[command.start])}  ${command.text}`, index: command.start, text: command.text,
    }))];
    list.replaceChildren(...items.map(item => rollback_item(machine, network, item)));
    list.hidden = false;
}

function close_rollback_list() {
    $("rollback_list").hidden = true;
    $("rollback_list").replaceChildren();
}

function rollback_item(machine, network, { label, index, text }) {
    const item = document.createElement("li");
    item.textContent = label;
    item.onclick = () => report_errors(() => roll_back(machine, network, index, text));
    return item;
}

async function roll_back(machine, network, index, text) {
    const target = text === undefined ? "початку" : `«${text}»`;
    if(!confirm(`Відкотити машину до ${target}? Все після цього моменту зникне з журналу`)) return;
    close_rollback_list();
    $("rollback").disabled = true;
    await machine.rollback(index);
    // Back at the very start the journal is empty: the shell prompt, clock and network are prepared as at startup.
    if(index === 0) {
        machine.begin_session();
        network.reconfigure();
    }
    $("note").textContent = `Відкочено до ${target}`;
}
