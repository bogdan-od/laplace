import { Machine, SNAPSHOT_BYTES_MAX } from "../machine/machine.mjs";
import { read_relay_url } from "../net/config.mjs";
import { random_mac } from "../net/mac.mjs";
import { Relay } from "../net/relay.mjs";
import { build_topology, fill_setup, validate_topology } from "../net/topology.mjs";
import { $, save_journal, show_error, report_errors } from "./common.mjs";
import { has_journals, launch_topology, save_topology_journals } from "../net/topology_journals.mjs";
import { read_journal } from "../core/journal.mjs";
import { shell_ready } from "./network.mjs";
import { render_diagram } from "./topology_diagram.mjs";
import { PROFILES } from "../profiles.mjs";
import { checked_topology_url, join_topology_room, room_machine_ids, wire_topology_reports } from "./topology_room.mjs";

const SNAP_EVERY_MS = 15000;
const TERM_COLS = 80;
const TERM_ROWS = 20;
const NAME_PATTERN = /^[\w-]+$/;
const DEFAULT_NAME = "student";
const DEFAULT_TITLE = "топологія";
const PHASE_TEXT = { replay: "повтор журналів...", live: "живий режим" };

const params = new URLSearchParams(location.search);

report_errors(start_topology);

async function start_topology() {
    const { desc, name } = await load_topology();
    const problems = validate_topology(desc);
    if(problems.length > 0) return show_problems(problems);
    const room_name = params.get("room");
    if(room_name) room_machine_ids(desc);
    document.title = `${desc.title ?? name}: топологія`;
    $("title").textContent = desc.title ?? name;
    $("diagram").innerHTML = render_diagram(desc);
    const started = [];
    const budgets = snapshot_budgets(desc.machines);
    const relay = await open_relay(desc);
    const journals = has_journals(desc) ? desc.journals : {};
    const net = build_topology(desc, {
        create_machine: machine_desc => create_machine(machine_desc, budgets.get(machine_desc.id), started, journals[machine_desc.id]),
        relay: relay?.adapter ?? null,
    });
    window.topology = { desc, relay: relay?.relay ?? null, ...net };
    window.machines = [...net.machines.values()];
    // The room connects before the machines start: the mirror does not see output that appeared earlier.
    if(room_name) {
        window.topology.room = join_topology_room(net.machines, { room_name, name: params.get("name") || DEFAULT_NAME });
        wire_topology_reports(net.machines, window.topology.room);
    }
    // Machines start one by one: each unpacks the boot snapshot, and all at once may not fit in the tab's memory.
    const configured = Promise.all(started.map(item => item.configured));
    $("save_task").onclick = () => report_errors(async () => save_journal(await save_topology_journals(desc, net.machines), name));
    if(Object.keys(journals).length === 0) {
        for(const item of started) await item.start();
        window.topology.ready = configured;
        return;
    }
    // Task journals: machines with a journal replay it, then all go live together.
    const by_machine = new Map(started.map(item => [item.machine, item]));
    const ready = launch_topology(net.machines, new Set(Object.keys(journals)), {
        start: machine => by_machine.get(machine).start(),
        on_phase: phase => { window.topology.phase = phase; $("phase").textContent = PHASE_TEXT[phase]; },
    });
    window.topology.ready = ready.then(() => configured);
    ready.catch(e => show_error(e.message));
}

// The relay is needed only by a topology with an uplink; the adapter gives build_topology a send/on_frame interface.
async function open_relay(desc) {
    if(!desc.links.some(link => link.uplink !== undefined)) return null;
    const url = await read_relay_url(params);
    if(url === null) return null;
    const adapter = { send: frame => relay.send(frame), on_frame: null };
    const relay = new Relay(url, frame => adapter.on_frame?.(frame));
    const show = () => { $("uplink").textContent = relay.is_open ? `інтернет: ${relay.host}` : "інтернет: відключено, перепідключаюсь"; };
    relay.addEventListener("change", show);
    show();
    return { relay, adapter };
}

// Description from ?topology=<name> (a file in topologies/) or from ?topology_url=/journals/<id> (handed out by the
// teacher).
async function load_topology() {
    const url = params.get("topology_url");
    if(url !== null) return { desc: await fetch_json(checked_topology_url(url), "Опис топології"), name: DEFAULT_TITLE };
    const name = params.get("topology") ?? "";
    if(!NAME_PATTERN.test(name)) throw new Error("Вкажіть топологію: ?topology=<ім'я>, наприклад router-on-a-stick");
    return { desc: await fetch_json(`topologies/${name}.json`, `Топологію ${name}`), name };
}

async function fetch_json(url, what) {
    const response = await fetch(url);
    if(!response.ok) throw new Error(`${what} не знайдено (${response.status})`);
    return response.json();
}

function show_problems(problems) {
    const list = $("problems");
    for(const problem of problems) {
        const item = document.createElement("li");
        item.textContent = problem;
        list.append(item);
    }
    show_error("Опис топології містить помилки, машини не запущено");
}

// The total limit of snapshot chunks is split in proportion to guest memory: the chunks of the Alpine boot snapshot
// (≈150 MB)
// do not fit into an equal third, and then only one fresh snapshot would be left for rollback.
function snapshot_budgets(machines) {
    const memory = machine => PROFILES[machine.profile].config("").memory_size;
    const total = machines.reduce((sum, machine) => sum + memory(machine), 0);
    return new Map(machines.map(machine => [machine.id, Math.floor(SNAPSHOT_BYTES_MAX * memory(machine) / total)]));
}

function create_machine(machine_desc, max_bytes, started, journal) {
    const { id, profile, setup } = machine_desc;
    const box = add_box(machine_desc);
    const machine = new Machine({
        profile, root: "../", journal: journal ? read_journal(journal) : null, on_journal_end: journal ? "pause" : "live",
        snap_every_ms: SNAP_EVERY_MS, check_every_ms: 0, name: id,
        max_bytes,
    });
    machine.on("error", show_error);
    attach_terminal(machine, box.terminal);
    box.save.onclick = () => report_errors(async () => save_journal(await machine.journal(), id));
    // A machine with a journal already has its setup in the journal: neither `\n` nor setup is typed.
    const ready = journal ? Promise.resolve() : shell_ready(machine, profile);
    const configured = ready.then(() => { if(setup && !journal) machine.run_setup(fill_setup(setup, random_mac())); });
    started.push({
        machine,
        configured,
        start: async () => {
            await machine.start();
            if(!journal) machine.begin_session();
        },
    });
    return machine;
}

function add_box({ id, title, profile }) {
    const box = document.createElement("div");
    box.className = "machine";
    const label = document.createElement("div");
    label.textContent = `${title ?? id} (${id}, ${PROFILES[profile].title})`;
    const terminal = document.createElement("div");
    const save = document.createElement("button");
    save.textContent = "Зберегти журнал";
    box.append(label, terminal, save);
    $("machines").append(box);
    return { terminal, save };
}

function attach_terminal(machine, element) {
    const term = new Terminal({ cols: TERM_COLS, rows: TERM_ROWS, convertEol: false });
    term.open(element);
    term.onData(data => machine.type(data));
    machine.on("serial", bytes => term.write(bytes));
    machine.on("reset", () => term.reset());
}
