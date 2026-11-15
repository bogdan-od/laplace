import { Machine } from "../machine/machine.mjs";
import { event_times, duration_ms, commands } from "../core/journal.mjs";
import { LessonRun } from "./lesson_run.mjs";
import { Markup } from "./lesson_markup.mjs";
import { $, format_clock, ratio_of, profile_by_name, parse_journal_text, fetch_journal, save_journal, show_error, report_errors } from "./common.mjs";

const SNAP_EVERY_MS = 15000;
const CHECK_EVERY_MS = 10000;
const MS_PER_S = 1000;
const PERCENT = 100;
const SPEED_MAX = 0;
const TERM_COLS = 110;
const TERM_ROWS = 30;

const S = { journal: null, machine: null, duration: 0, commands: [], current: -1, live: false, dragging: false, status: null, marks: -1, seeking: 0 };

const term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, convertEol: false });
term.open($("terminal"));
term.onData(data => { if(S.live) S.machine.type(data); });

$("file").onchange = () => report_errors(() => load_file($("file").files[0]));
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => {
    event.preventDefault();
    report_errors(() => load_file(event.dataTransfer.files[0]));
});
const markup = new Markup(() => S.status, ms => jump_to(ms));
const params = new URLSearchParams(location.search);
const lesson_url = params.get("lesson");
const source_url = params.get("j") ?? lesson_url;
if(source_url) report_errors(async () => open_journal(await fetch_journal(source_url), lesson_url !== null));

async function load_file(file) {
    if(!file) throw new Error("Файл не вибрано");
    const journal = parse_journal_text(await file.text());
    await open_journal(journal, journal.header.lesson !== undefined);
}

async function open_journal(journal, as_lesson) {
    if(as_lesson && journal.header.lesson === undefined) throw new Error("Це не урок: у журналі немає header.lesson");
    S.machine?.stop();
    show_journal_view(journal);
    document.body.classList.toggle("lesson", as_lesson);
    S.machine = new Machine({
        profile: journal.header.profile, root: "../", journal,
        on_journal_end: "pause", snap_every_ms: SNAP_EVERY_MS, check_every_ms: CHECK_EVERY_MS,
        name: journal.header.machine, timeline_only: as_lesson,
    });
    attach(S.machine, as_lesson);
    if(as_lesson) return new LessonRun(S.machine, journal, live => { S.live = live; }).begin();
    await S.machine.start();
}

function show_journal_view(journal) {
    S.journal = journal;
    S.duration = duration_ms(journal);
    const times = event_times(journal);
    S.commands = commands(journal.events).map(cmd => ({ ...cmd, time: times[cmd.index] }));
    S.current = -1; S.marks = -1; S.live = false; S.status = null;
    term.reset();
    show_error("");
    show_header(journal);
    render_commands();
    $("timeline").max = S.duration / MS_PER_S;
    $("timeline").value = 0;
    document.body.classList.remove("live");
    $("replay").disabled = false;
    $("go_live").disabled = false;
    $("verify").disabled = false;
    $("markup").disabled = false;
    markup.load(journal, S.duration);
    $("lesson_note").hidden = true;
    $("lesson_task").hidden = true;
    $("save").hidden = true;
    $("verify_result").textContent = "";
    $("note").textContent = "";
    $("marks").replaceChildren();
}

function show_header(journal) {
    const { header, events } = journal;
    $("profile").textContent = profile_by_name(header.profile).title;
    $("machine").textContent = header.machine;
    $("recorded").textContent = header.recorded_at ? new Date(header.recorded_at).toLocaleString("uk-UA") : "невідомо";
    $("count").textContent = events.length;
    $("duration").textContent = format_clock(S.duration);
    $("parent").hidden = !header.parent;
    $("parent").textContent = header.parent ? `продовження іншого журналу з події ${header.parent.event}` : "";
}

function attach(machine, as_lesson) {
    machine.on("serial", bytes => term.write(bytes));
    machine.on("reset", () => term.reset());
    machine.on("status", on_status);
    if(!as_lesson) machine.on("end", () => { $("note").textContent = "Кінець запису. Можна продовжити самому"; });
    machine.on("error", show_error);
}

function on_status(status) {
    S.status = status;
    $("mode").textContent = status.mode === "live" ? "жива" : "повтор";
    $("play").textContent = status.paused ? "Далі" : "Пауза";
    $("vt").textContent = (status.vtime / MS_PER_S).toFixed(1);
    $("ev").textContent = `${status.next} з ${status.total}`;
    if(!S.dragging) $("timeline").value = status.vtime / MS_PER_S;
    update_current(status.vtime);
    render_marks();
}

function update_current(vtime) {
    const index = S.commands.findLastIndex(cmd => cmd.time <= vtime);
    if(index === S.current) return;
    S.current = index;
    [...$("list").children].forEach((item, i) => item.classList.toggle("cur", i === index));
}

function render_marks() {
    const snapshots = S.machine.snapshots;
    if(snapshots.length === S.marks) return;
    S.marks = snapshots.length;
    $("marks").replaceChildren(...snapshots.map(snap => mark_at(snap.vtime)));
}

function mark_at(vtime) {
    const mark = document.createElement("div");
    mark.className = "mark";
    mark.style.left = `${ratio_of(vtime, S.duration) * PERCENT}%`;
    mark.title = `знімок ${format_clock(vtime)}`;
    return mark;
}

function render_commands() {
    $("list").replaceChildren(...S.commands.map(command_item));
    $("search").value = "";
}

function command_item(cmd) {
    const item = document.createElement("li");
    const who = cmd.by === "teacher" ? "викладач: " : "";
    const sure = cmd.uncertain ? "≈ " : "";
    item.textContent = `${format_clock(cmd.time)}  ${who}${sure}${cmd.text}`;
    item.dataset.search = cmd.text.toLowerCase();
    item.onclick = () => report_errors(() => jump_to(cmd.time));
    return item;
}

// "Продовжити звідси" is not accepted while a seek runs: the new Worker has no snapshot yet.
async function while_seeking(fn) {
    S.seeking++;
    try { await fn(); } finally { S.seeking--; }
}

async function jump_to(ms) {
    if(S.live) return;
    await while_seeking(() => S.machine.seek(ms));
    if(!S.live) S.machine.pause();
}

$("search").oninput = () => {
    const query = $("search").value.trim().toLowerCase();
    for(const item of $("list").children) item.hidden = !item.dataset.search.includes(query);
};

const timeline = $("timeline");
timeline.onpointerdown = () => { S.dragging = true; };
timeline.onpointerup = () => { S.dragging = false; };
timeline.onchange = () => report_errors(seek_from_timeline);

async function seek_from_timeline() {
    if(S.live) return;
    const was_paused = S.status?.paused ?? false;
    await while_seeking(() => S.machine.seek(Number(timeline.value) * MS_PER_S));
    if(!was_paused && !S.live) S.machine.resume();
}

for(const button of document.querySelectorAll("[data-speed]")) {
    button.onclick = () => set_speed(Number(button.dataset.speed));
}

function set_speed(speed) {
    S.machine.set_speed(speed);
    for(const button of document.querySelectorAll("[data-speed]")) {
        button.classList.toggle("on", Number(button.dataset.speed) === speed);
    }
}

$("play").onclick = () => (S.status?.paused ? S.machine.resume() : S.machine.pause());
// Before the Worker starts (S.status is still null) the machine is not ready: go_live() would fail while the UI would
// already be in live mode.
$("go_live").onclick = () => { if(!S.live && S.status && !S.seeking) go_live(); };
$("save").onclick = () => report_errors(async () => save_journal(await S.machine.journal(), S.journal.header.machine));
$("verify").onclick = () => report_errors(verify_journal);

function go_live() {
    report_errors(() => S.machine.go_live());
    S.live = true;
    document.body.classList.add("live");
    $("replay").disabled = true;
    $("go_live").disabled = true;
    $("markup").disabled = true;
    $("save").hidden = false;
    $("note").textContent = "Живий режим: машина ваша";
}

async function verify_journal() {
    const journal = S.journal;
    const expected = journal.events.filter(ev => ev.t === "check").length;
    const checker = new Machine({
        profile: journal.header.profile, root: "../", journal,
        on_journal_end: "pause", snap_every_ms: 0, name: journal.header.machine,
    });
    let running = true;
    const finish = text => {
        running = false;
        $("verify_result").textContent = text;
        $("verify").disabled = false;
        checker.stop();
    };
    $("verify").disabled = true;
    checker.on("status", status => {
        if(running) $("verify_result").textContent = `Перевірка… ${Math.floor(ratio_of(status.vtime, S.duration) * PERCENT)}%`;
    });
    checker.on("end", () => finish(`Перевірено: усі ${expected} контрольних хешів збіглися`));
    checker.on("error", message => finish(`Розбіжність: ${message}`));
    checker.set_speed(SPEED_MAX);
    await checker.start();
}
