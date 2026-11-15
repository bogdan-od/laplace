import { Switch } from "./switch.mjs";
import { PROFILES } from "../profiles.mjs";

export const TOPOLOGY_FORMAT = "v86-topology/1";
export const MIN_MACHINES = 1;
export const MAX_MACHINES = 6;
const VLAN_MIN = 1;
const VLAN_MAX = 4094;
const UPLINK_RELAY = "relay";

const is_object = value => typeof value === "object" && value !== null && !Array.isArray(value);
const is_vlan = value => Number.isInteger(value) && value >= VLAN_MIN && value <= VLAN_MAX;

// Validates a topology description. Returns an array of messages in Ukrainian with the `id`s
// of the offending nodes; an empty array means the description is valid. Never throws on garbage input.
export function validate_topology(desc) {
    if(!is_object(desc)) return ["Опис топології має бути об'єктом JSON"];
    const errors = [];
    if(desc.format !== TOPOLOGY_FORMAT) {
        errors.push(`Невідомий формат опису: "${desc.format}", очікується "${TOPOLOGY_FORMAT}"`);
    }
    const machines = list_field(desc, "machines", errors);
    const switches = list_field(desc, "switches", errors);
    const links = list_field(desc, "links", errors);
    const ids = check_nodes(machines, switches, errors);
    if(machines.length < MIN_MACHINES || machines.length > MAX_MACHINES) {
        errors.push(`Кількість машин: від ${MIN_MACHINES} до ${MAX_MACHINES}, зараз ${machines.length}`);
    }
    const link_counts = new Map();
    let uplinks = 0;
    links.forEach((link, index) => {
        if(!is_object(link)) return errors.push(`Зв'язок №${index + 1} має бути об'єктом`);
        if(link.uplink !== undefined) uplinks++;
        check_link(link, index + 1, ids, link_counts, errors);
    });
    if(uplinks > 1) errors.push(`Зв'язків uplink може бути не більше одного, зараз ${uplinks}`);
    for(const machine of machines) {
        if(!is_object(machine) || !is_known_id(machine.id) || !ids.machines.has(machine.id)) continue;
        const count = link_counts.get(machine.id) ?? 0;
        if(count > 1) errors.push(`Машина "${machine.id}": має бути не більше одного з'єднання, зараз ${count}`);
    }
    check_switch_cycles(links, ids.switches, errors);
    if(desc.journals !== undefined) check_journals(desc.journals, ids.machines, errors);
    return errors;
}

function check_journals(journals, machine_ids, errors) {
    if(!is_object(journals)) return errors.push(`Поле "journals" має бути об'єктом {id машини: журнал}`);
    for(const [id, journal] of Object.entries(journals)) {
        if(!machine_ids.has(id)) errors.push(`Журнал для "${id}": такої машини в описі немає`);
        else if(!is_object(journal)) errors.push(`Журнал машини "${id}" має бути об'єктом`);
    }
}

function list_field(desc, name, errors) {
    if(Array.isArray(desc[name])) return desc[name];
    errors.push(`Поле "${name}" має бути масивом`);
    return [];
}

const is_known_id = id => typeof id === "string" && id !== "";

// Collects the ids of machines and switches (one namespace); checks the profiles.
function check_nodes(machines, switches, errors) {
    const ids = { machines: new Set(), switches: new Set() };
    const seen = new Set();
    const register = (node, kind, target) => {
        if(!is_object(node) || !is_known_id(node.id)) {
            errors.push(`${kind} без правильного id (потрібен непорожній рядок)`);
            return false;
        }
        if(seen.has(node.id)) errors.push(`Повторений id "${node.id}": id машин і комутаторів не можуть збігатися`);
        else target.add(node.id);
        seen.add(node.id);
        return true;
    };
    for(const machine of machines) {
        if(!register(machine, "Машина", ids.machines)) continue;
        if(!Object.hasOwn(PROFILES, machine.profile)) {
            errors.push(`Машина "${machine.id}": невідомий профіль "${machine.profile}"`);
        }
        if(machine.setup !== undefined && typeof machine.setup !== "string") {
            errors.push(`Машина "${machine.id}": setup має бути рядком`);
        }
    }
    for(const sw of switches) register(sw, "Комутатор", ids.switches);
    return ids;
}

function check_link(link, number, ids, link_counts, errors) {
    const kinds = ["machine", "to", "uplink"].filter(field => link[field] !== undefined);
    if(kinds.length !== 1) {
        return errors.push(`Зв'язок №${number}: потрібне рівно одне з полів machine, to, uplink`);
    }
    const [kind] = kinds;
    const label = describe_link(link, number);
    if(!ids.switches.has(link.switch)) {
        errors.push(`${label}: комутатор "${link.switch}" не існує`);
    }
    if(kind === "machine") {
        if(!ids.machines.has(link.machine)) errors.push(`${label}: машина "${link.machine}" не існує`);
        else link_counts.set(link.machine, (link_counts.get(link.machine) ?? 0) + 1);
    } else if(kind === "to") {
        if(!ids.switches.has(link.to)) errors.push(`${label}: комутатор "${link.to}" не існує`);
    } else if(link.uplink !== UPLINK_RELAY) {
        errors.push(`${label}: невідомий uplink "${link.uplink}", підтримується "${UPLINK_RELAY}"`);
    }
    check_port_options(link, label, kind === "to", errors);
}

function describe_link(link, number) {
    if(link.machine !== undefined) return `З'єднання машини "${link.machine}"`;
    if(link.to !== undefined) return `З'єднання комутаторів "${link.switch}" і "${link.to}"`;
    return `Зв'язок uplink №${number}`;
}

function check_port_options(link, label, trunk_only, errors) {
    if(trunk_only && link.mode !== "trunk") {
        return errors.push(`${label}: між комутаторами дозволений тільки режим "trunk"`);
    }
    if(link.mode === "access") {
        if(!is_vlan(link.vlan)) errors.push(`${label}: VLAN має бути цілим від ${VLAN_MIN} до ${VLAN_MAX}, зараз ${JSON.stringify(link.vlan)}`);
    } else if(link.mode === "trunk") {
        check_trunk(link, label, errors);
    } else {
        errors.push(`${label}: режим має бути "access" або "trunk", зараз ${JSON.stringify(link.mode)}`);
    }
}

function check_trunk(link, label, errors) {
    const { allowed, native } = link;
    if(!Array.isArray(allowed) || allowed.length === 0) {
        return errors.push(`${label}: у trunk потрібен непорожній список allowed`);
    }
    const bad = allowed.filter(vlan => !is_vlan(vlan));
    if(bad.length > 0) {
        errors.push(`${label}: у allowed є неправильні VLAN ${JSON.stringify(bad)} (потрібні цілі від ${VLAN_MIN} до ${VLAN_MAX})`);
    }
    if(native !== undefined && native !== null && !allowed.includes(native)) {
        errors.push(`${label}: native ${JSON.stringify(native)} не входить до allowed`);
    }
}

// There is no STP, so a cycle in the switch graph floods forever. The disjoint-set
// union catches both a self-loop and a double link between a pair.
function check_switch_cycles(links, switch_ids, errors) {
    const parent = new Map([...switch_ids].map(id => [id, id]));
    const find = id => {
        while(parent.get(id) !== id) id = parent.get(id);
        return id;
    };
    for(const link of links) {
        if(!is_object(link) || link.to === undefined) continue;
        if(!switch_ids.has(link.switch) || !switch_ids.has(link.to)) continue;
        const a = find(link.switch);
        const b = find(link.to);
        if(a === b) {
            errors.push(`З'єднання комутаторів "${link.switch}" і "${link.to}" утворює цикл (STP немає, кадри ходили б по колу)`);
        } else {
            parent.set(a, b);
        }
    }
}

// Substitutes the MAC into the setup command; the page calls `random_mac`, so that this module stays deterministic.
export function fill_setup(setup, mac) {
    return setup.replaceAll("{mac}", () => mac);
}

function port_options(link) {
    if(link.mode === "access") return { mode: "access", vlan: link.vlan };
    return { mode: "trunk", allowed: link.allowed, native: link.native ?? null };
}

// Builds the network from a validated description.
//   create_machine(machine_desc) is the machine factory; a machine has `net_in(frame)` and `on("net_out", fn)`
//     (optionally `off(name, fn)`).
//   relay is an optional object: `relay.send(frame)` sends a frame outside, and frames from outside
//     arrive through `relay.on_frame = fn`. Without a relay the uplink link is silently skipped.
// Returns { switches, machines, ports, teardown }.
export function build_topology(desc, { create_machine, relay = null }) {
    const switches = new Map(desc.switches.map(sw => [sw.id, new Switch()]));
    const machines = new Map(desc.machines.map(machine => [machine.id, create_machine(machine)]));
    const ports = [];
    const cleanups = [];
    let active = true;
    // After teardown, late frames are dropped: the port has already been removed from the switch.
    const guarded = fn => frame => { if(active) fn(frame); };
    const attach = (sw_id, send, link) => {
        const sw = switches.get(sw_id);
        const port = sw.add_port(guarded(send), port_options(link));
        ports.push(port);
        cleanups.push(() => sw.remove_port(port));
        return port;
    };

    for(const link of desc.links) {
        if(link.machine !== undefined) {
            const machine = machines.get(link.machine);
            const port = attach(link.switch, frame => machine.net_in(frame), link);
            const on_out = guarded(frame => port.receive(frame));
            machine.on("net_out", on_out);
            cleanups.push(() => machine.off?.("net_out", on_out));
        } else if(link.to !== undefined) {
            const ends = [null, null];
            ends[0] = attach(link.switch, frame => ends[1].receive(frame), link);
            ends[1] = attach(link.to, frame => ends[0].receive(frame), link);
        } else if(relay !== null) {
            const port = attach(link.switch, frame => relay.send(frame), link);
            relay.on_frame = guarded(frame => port.receive(frame));
            cleanups.push(() => { relay.on_frame = null; });
        }
    }

    const teardown = () => {
        active = false;
        cleanups.splice(0).reverse().forEach(cleanup => cleanup());
        ports.length = 0;
    };
    return { switches, machines, ports, teardown };
}
