// Launching and recording a topology from a set of journals (no DOM). Machines are objects with the Machine interface:
// start(), on(name, fn), set_speed(x), go_live(), check({ pause }), journal(), resume(), status.
import { TOPOLOGY_FORMAT } from "./topology.mjs";

const SPEED_MAX = 0;
export const has_journals = desc => desc.journals !== undefined && Object.keys(desc.journals).length > 0;

// Starts all machines one by one. Machines with a journal (keys of `replayed`) replay it at maximum speed
// and pause at the end (Machine with on_journal_end: "pause"); they neither receive nor send live frames,
// because in replay mode the engine ignores net_in and emits no net_out. When the last one reaches the end,
// go_live() is called on all of them in one tick. Machines without a journal are live from the start and do not wait
// for the switch.
// An error or divergence of any machine during replay rejects the promise: nobody goes live.
export async function launch_topology(machines, replayed, { start = machine => machine.start(), on_phase = () => {} } = {}) {
    const replaying = [...replayed].map(id => [id, machines.get(id)]);
    const arrivals = replaying.map(([id, machine]) => arrival(id, machine));
    for(const [, machine] of replaying) machine.set_speed(SPEED_MAX);
    on_phase("replay");
    // A start failure of one machine must not leave an unhandled rejection in `arrivals`.
    const failed = Promise.race(arrivals.map(item => item.failure));
    failed.catch(() => {});
    for(const machine of machines.values()) await Promise.race([start(machine), failed]);
    await Promise.race([Promise.all(arrivals.map(item => item.reached)), failed]);
    const live = replaying.map(([, machine]) => machine.go_live());
    await Promise.all(live);
    on_phase("live");
}

// reached: the machine got to the end of its journal (the "end" event);
// failure: rejects if an error happened before that.
function arrival(id, machine) {
    let arrived = false;
    let reached_now, fail_now;
    const reached = new Promise(resolve => { reached_now = resolve; });
    const failure = new Promise((_, reject) => { fail_now = reject; });
    machine.on("end", () => { arrived = true; reached_now(); });
    machine.on("error", message => {
        if(!arrived) fail_now(new Error(`Машина "${id}": повтор журналу зупинено: ${message}`));
    });
    return { reached, failure };
}

// How long to wait for the check answer from all machines. A live machine that stays silent is declared broken by
// Machine
// after SILENCE_MS (15 s) anyway, so waiting longer is pointless: all the other machines would stay paused just as
// long.
export const CHECK_TIMEOUT_MS = 15000;

// Journals of all machines, each ending with a check. All machines pause in the tick of their check, and only
// then are the journals taken: no machine sends a frame after the end of its journal while another one is still
// running.
// Then only the machines that were not paused before the call are resumed (as `Machine.checked_journal` does), and the
// same
// happens on an error or a timeout. A machine that did not answer within `timeout_ms` gets resume when its check
// finally executes (an earlier resume could get lost: the pause is set in the tick of the check).
export async function checked_journals(machines, { timeout_ms = CHECK_TIMEOUT_MS } = {}) {
    const items = [...machines].map(([id, machine]) => {
        const item = { id, machine, was_paused: machine.user_paused ?? false, answered: false };
        item.check = Promise.resolve(machine.check({ pause: true }));
        item.check.then(() => { item.answered = true; }, () => { item.answered = true; });
        return item;
    });
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(resolve, timeout_ms, TIMED_OUT); });
    try {
        const outcome = await Promise.race([Promise.allSettled(items.map(item => item.check)), expired]);
        if(outcome === TIMED_OUT) throw silent_machines_error(items, timeout_ms);
        const failed = outcome.find(result => result.status === "rejected");
        if(failed) throw failed.reason;
        return await Promise.all(items.map(item => item.machine.journal()));
    } finally {
        clearTimeout(timer);
        for(const item of items) {
            if(!item.was_paused) item.machine.resume();
        }
    }
}

const TIMED_OUT = Symbol("timed out");

function silent_machines_error(items, timeout_ms) {
    const silent = items.filter(item => !item.answered);
    for(const item of silent) {
        if(!item.was_paused) item.check.then(() => item.machine.resume(), () => {});
    }
    const names = silent.map(item => `"${item.id}"`).join(", ");
    return new Error(`Машина ${names} не відповіла на перевірку за ${timeout_ms / 1000} с: журнали не зняті, решту машин відновлено`);
}

// Saves the task: the journals of all machines, each ending with a check (the replay will verify them).
// Returns the topology description with the `journals` field.
export async function save_topology_journals(desc, machines) {
    const ids = [...machines.keys()];
    const journals = await checked_journals(machines);
    return { ...desc, format: TOPOLOGY_FORMAT, journals: Object.fromEntries(ids.map((id, i) => [id, journals[i]])) };
}
