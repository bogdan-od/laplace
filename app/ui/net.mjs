import { Machine } from "../machine/machine.mjs";
import { Switch } from "../net/switch.mjs";
import { PROFILES, net_setup_command } from "../profiles.mjs";
import { $, profile_name, save_journal, show_error, report_errors } from "./common.mjs";

const MIN_MACHINES = 2;
const MAX_MACHINES = 6;
const DEFAULT_MACHINES = 2;
const DEFAULT_PROFILE = "buildroot";
const TERM_COLS = 80;
const TERM_ROWS = 20;
const PROMPT_TAIL_CHARS = 4096;

const params = new URLSearchParams(location.search);

report_errors(start_net);

async function start_net() {
    const count = Number(params.get("machines") ?? DEFAULT_MACHINES);
    if(!Number.isInteger(count) || count < MIN_MACHINES || count > MAX_MACHINES) {
        throw new Error(`Кількість машин: від ${MIN_MACHINES} до ${MAX_MACHINES}`);
    }
    const profile = profile_name(params.get("profile") ?? DEFAULT_PROFILE);
    const net = new Switch();
    const machines = Array.from({ length: count }, (_, index) => create_machine(index + 1, profile, net));
    window.machines = machines;
    await Promise.all(machines.map(machine => machine.start()));
    machines.forEach(machine => machine.begin_session());
}

function create_machine(n, profile, net) {
    const box = add_box(n);
    const machine = new Machine({
        profile, root: "../", journal: null, on_journal_end: "live",
        snap_every_ms: 0, check_every_ms: 0, name: `machine${n}`,
    });
    const port = net.add_port(frame => machine.net_in(frame));
    machine.on("net_out", frame => port.receive(frame));
    machine.on("error", show_error);
    attach_terminal(machine, box.terminal);
    setup_when_shell(machine, n, profile);
    box.save.onclick = () => report_errors(async () => save_journal(await machine.journal(), `machine${n}`));
    return machine;
}

function add_box(n) {
    const box = document.createElement("div");
    box.className = "machine";
    const label = document.createElement("div");
    label.textContent = `Машина ${n}, 10.0.0.${n}`;
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

function setup_when_shell(machine, n, profile) {
    const decoder = new TextDecoder();
    const prompt = PROFILES[profile].prompt;
    let tail = "";
    let done = false;
    machine.on("serial", bytes => {
        if(done) return;
        tail = (tail + decoder.decode(bytes, { stream: true })).slice(-PROMPT_TAIL_CHARS);
        if(!tail.includes(prompt)) return;
        done = true;
        machine.run_setup(net_setup_command(n));
    });
}
