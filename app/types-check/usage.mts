// Type-level check of the .d.mts files: every module is imported and every exported function and every public
// Machine method is called the way real callers call it. This file is only compiled,
// never run. Lines marked @ts-expect-error must fail to compile.
import { AgentChannel, encode_request, parse_response } from "../machine/agent_channel.mjs";
import type { AgentResult } from "../machine/agent_channel.mjs";
import { Machine, SNAPSHOT_BYTES_MAX } from "../machine/machine.mjs";
import type { EndInfo, MachineEvents, MachineOptions } from "../machine/machine.mjs";
import type { WorkerMessage, WorkerRequest, WorkerReplies } from "../machine/worker_protocol.mjs";
import { NO_REST_DIGEST, create_machine, ram_digest, state_digest } from "../core/engine.mjs";
import type { EngineMachine, MachineStatus } from "../core/engine.mjs";
import { CHUNK, chunk_hashes, digest_of_hashes, hash_bytes, hash_text } from "../core/digest.mjs";
import { HOST_NAN_SIGNS, host_nan } from "../core/host_nan.mjs";
import {
    FORMAT, JOURNAL_LIMITS, MAX_INSTR_PER_MS, MIN_INSTR_PER_MS, SERIAL_PORTS, START_INSTR_PER_MS,
    check_journal_strict, check_lesson, commands, duration_ms, event_times, journal_digest, read_journal,
} from "../core/journal.mjs";
import type { Journal, JournalCommand, JournalEvent, LessonMark } from "../core/journal.mjs";
import { decode_snapshot, encode_snapshot, materialize, read_snapshot } from "../core/snapfile.mjs";
import type { Snapshot } from "../core/snapfile.mjs";
import { Backoff, CONNECT_TIMEOUT_MS } from "../net/backoff.mjs";
import { from_base64, to_base64 } from "../net/base64.mjs";
import { read_relay_url } from "../net/config.mjs";
import { MAX_FRAME_LEN, MIN_FRAME_LEN, frame_ok, mac_key } from "../net/frame.mjs";
import { random_mac } from "../net/mac.mjs";
import { Mesh } from "../net/mesh.mjs";
import { Relay } from "../net/relay.mjs";
import { Room, number_of } from "../net/room.mjs";
import {
    MAX_FIELD_CHARS, TASK_KINDS, clean_group, clean_machine, clean_machines, clean_task_kind, is_field_id,
} from "../net/room_fields.mjs";
import { Router } from "../net/router.mjs";
import { Switch } from "../net/switch.mjs";
import {
    MAX_MACHINES, MIN_MACHINES, TOPOLOGY_FORMAT, build_topology, fill_setup, validate_topology,
} from "../net/topology.mjs";
import type { PortMode, Topology, TopologyLink, TopologyMachine, TopologySwitch } from "../net/topology.mjs";
import {
    CHECK_TIMEOUT_MS, checked_journals, has_journals, launch_topology, save_topology_journals,
} from "../net/topology_journals.mjs";
import {
    GUEST_SETUP_LINES, PROFILES, SESSION_ENTROPY_BYTES, boot_snapshot_path, date_command, fresh_session_input,
    lab_net_command, net_setup_command, session_command,
} from "../profiles.mjs";
import type { Profile, ProfileName } from "../profiles.mjs";
import { LessonRun } from "../ui/lesson_run.mjs";

const DEFAULT_PROFILE: ProfileName = "buildroot";

// Pure helpers

export function journal_helpers(json: unknown, bytes: Uint8Array): void {
    const journal: Journal = read_journal(json);
    const strict: Journal = check_journal_strict(json, { max_events: 10 });
    check_journal_strict(json);
    const total: number = duration_ms(journal);
    const times: Float64Array = event_times(strict);
    const found: JournalCommand[] = commands(journal.events);
    const first = found[0];
    if(first) {
        const label: string = `${times[first.start]} ${first.text} ${first.by} ${first.port} ${first.uncertain} ${first.index}`;
        void label;
    }
    const digest: string = journal_digest(journal);
    check_lesson(journal.header.lesson, journal.events.length);
    const marks: LessonMark[] = journal.header.lesson ?? [];
    for(const mark of marks) {
        if(mark.t === "note") void mark.at;
        else void [mark.from, mark.to];
    }
    void [total, digest, FORMAT, SERIAL_PORTS, START_INSTR_PER_MS, MIN_INSTR_PER_MS, MAX_INSTR_PER_MS];
    void [JOURNAL_LIMITS.max_events, CHUNK, hash_bytes(bytes), hash_text("x"), digest_of_hashes(chunk_hashes(bytes))];
    void [HOST_NAN_SIGNS, host_nan()];
}

export function event_union(events: JournalEvent[]): number {
    let sum = 0;
    for(const ev of events) {
        if(ev.t === "clock") sum += ev.extra;
        else if(ev.t === "rate") sum += ev.per_ms;
        else if(ev.t === "serial") sum += ev.data.length + (ev.p ?? 0);
        else if(ev.t === "net") sum += ev.data.length;
        else sum += ev.h.length + ev.m.length;
    }
    return sum;
}

export async function snapshot_helpers(gz: Uint8Array): Promise<void> {
    const snap = await read_snapshot(gz);
    const full = materialize(snap, hash => hash_bytes(new Uint8Array(0)) === hash ? null : undefined);
    const decoded = await decode_snapshot(gz);
    const encoded: Uint8Array = await encode_snapshot(snap);
    const as_engine: Snapshot = snap;
    void [full.mem, full.blob("h"), decoded.hashes, encoded, as_engine.clock.vtime];
}

export function profile_helpers(): void {
    const profile: Profile = PROFILES[DEFAULT_PROFILE];
    const config = profile.config("../");
    void [config.memory_size, config.cmdline, profile.title, profile.prompt];
    void [boot_snapshot_path("../", DEFAULT_PROFILE), net_setup_command(1), fresh_session_input(), date_command(Date.now())];
    void [session_command(Date.now(), new Uint8Array(SESSION_ENTROPY_BYTES)), GUEST_SETUP_LINES.join("")];
    void [lab_net_command({ mac: random_mac(), n: null, internet: false }), lab_net_command({ mac: "02:00:00:00:00:01", n: 3, internet: true })];
}

// One live machine: start, input, rollback

export async function lab_usage(journal: Journal | null, task: Journal | null, name: string): Promise<void> {
    const options: MachineOptions = journal === null
        ? { profile: DEFAULT_PROFILE, root: "../", journal, on_journal_end: "live", snap_every_ms: 15000, check_every_ms: 10000, name }
        : { profile: journal.header.profile, root: "../", journal, on_journal_end: "live", snap_every_ms: 15000, check_every_ms: 10000, name };
    const machine = new Machine(options);
    machine.on("serial", bytes => void bytes.length);
    machine.on("reset", () => void 0);
    machine.on("status", status => {
        const mode: string = status.mode === "live" ? "live" : "replay";
        void [mode, status.vtime / 1000, status.total, status.ended, machine.recovering];
    });
    machine.on("recovering", () => void 0);
    machine.on("recovered", () => void 0);
    machine.on("end", () => void 0);
    machine.on("error", message => void message.length);
    machine.on("truncated", index => void (index + 1));
    machine.set_speed(0);
    const router = new Router(machine);
    const relay_url = await read_relay_url(new URLSearchParams(location.search));
    if(relay_url !== null) router.attach_relay(new Relay(relay_url, frame => router.from_relay(frame)));
    const reply = await machine.start();
    if(reply.status.mode === "live") void reply.rate0.per_ms;
    if(task === null) await machine.begin_session();
    void machine.mirror.slice(0);
    const checked: Journal = await machine.checked_journal();
    const plain: Journal = await machine.journal();
    const times = event_times(plain);
    const own = commands(plain.events).filter(command => command.by === "student");
    for(const command of own) void times[command.start];
    await machine.rollback(0);
    const outcome: AgentResult | null = await machine.run_setup("ifconfig\n");
    void [checked, outcome?.rc];
    machine.type("ls\r");
    machine.type("ls\r", "teacher", 2);
    machine.net_in(new Uint8Array(60));
    machine.stop();
}

// Topology and topology journals

export async function topology_usage(desc: Topology, journals_text: string): Promise<void> {
    const problems: string[] = validate_topology(JSON.parse(journals_text));
    if(problems.length > 0) return;
    const created: Machine[] = [];
    const net = build_topology(desc, {
        create_machine: (machine_desc: TopologyMachine) => {
            const machine = new Machine({
                profile: machine_desc.profile, root: "../", journal: null, on_journal_end: "live",
                snap_every_ms: 15000, check_every_ms: 0, name: machine_desc.id, max_bytes: SNAPSHOT_BYTES_MAX,
            });
            created.push(machine);
            return machine;
        },
        relay: null,
    });
    const first: Machine | undefined = net.machines.get("pc1");
    first?.pause();
    net.teardown();
    const journals = has_journals(desc) ? desc.journals : {};
    const machines: Map<string, Machine> = net.machines;
    await launch_topology(machines, new Set(Object.keys(journals)), {
        start: machine => machine.start(),
        on_phase: phase => void phase.length,
    });
    const saved = await save_topology_journals(desc, machines);
    const all: Journal[] = await checked_journals(machines, { timeout_ms: CHECK_TIMEOUT_MS });
    void [saved.journals, all, fill_setup("ifconfig eth0 hw ether {mac}", random_mac()), TOPOLOGY_FORMAT, MIN_MACHINES, MAX_MACHINES];
    const mode: PortMode = "trunk";
    const links: TopologyLink[] = desc.links;
    for(const link of links) {
        if(link.uplink !== undefined) void link.switch;
        else if(link.to !== undefined) void link.allowed;
        else void [link.machine, link.mode === "access" ? link.vlan : link.native];
    }
    const switches: TopologySwitch[] = desc.switches;
    void [mode, switches];
}

// Player: replay and seeking

export async function player_usage(journal: Journal): Promise<void> {
    const machine = new Machine({
        profile: journal.header.profile, root: "../", journal, on_journal_end: "pause",
        snap_every_ms: 15000, check_every_ms: 10000, name: journal.header.machine, timeline_only: true,
    });
    machine.on("status", status => void [status.paused, status.next, status.total, machine.snapshots.map(snap => snap.vtime)]);
    machine.on("end", (info: EndInfo) => void info.vtime);
    machine.on("teacher_output", bytes => void bytes.byteLength);
    machine.on("net_out", frame => void frame.length);
    await machine.start();
    const reached: number | null = await machine.seek(1000);
    void reached;
    machine.pause();
    machine.resume();
    machine.set_speed(1);
    machine.limit(10, true);
    await machine.play_segment({ from: 0, stop: 10, live_at_stop: false });
    await machine.go_live();
    const header = machine.header_now();
    void [header.parent?.event, machine.user_paused, machine.status?.vtime, machine.live_from];
    const run = new LessonRun(machine, { ...journal, header: { ...journal.header, lesson: [] } }, live => void live);
    await run.begin();
    teacher_usage(machine);
}

// Teacher terminal and the system channel

function teacher_usage(machine: Machine): void {
    machine.teacher_input("ls\r");
    void machine.system("uname", { timeout_ms: 5000 }).then(result => void [result.rc, result.output]);
    void machine.check({ pause: true }).then(index => void index.toFixed());
    void machine.worker_stalled();
    void machine.started.then(() => void 0);
    const events: MachineEvents["recovered"] = { events: 3 };
    void events;
}

export async function room_usage(machine: Machine): Promise<void> {
    const room = new Room({ room: "r1", role: "student", name: "ann", machines: ["pc1"] });
    const teacher = new Room({ room: "r1", role: "teacher", name: "t" });
    room.on("joined", message => void [message.id, message.peers.map(peer => peer.role), message.reports.length]);
    room.on("peer-joined", message => void [message.role === "teacher", message.machines]);
    room.on("input", message => machine.type(message.data, "teacher"));
    room.on("task", message => void [message.journal_id, message.kind]);
    room.on("state", message => void message.state);
    teacher.on("serial", message => void [from_base64(message.data), message.full, message.machine]);
    teacher.on("report", message => void [message.kind, message.journal_id, message.group, message.note]);
    await room.connect();
    room.send({ type: "serial", machine: "pc1", data: to_base64(new Uint8Array(1)), full: true });
    room.send({ type: "input", to: "p1", machine: "pc1", data: "x" });
    room.send({ type: "report", ref: "a", journal_id: "j", kind: "submit", note: "", machine: "pc1", group: "g" });
    room.send({ type: "task", journal_id: "j", kind: "topology" });
    const n = number_of(room.id ?? "p1");
    const mesh = new Mesh(room, machine);
    mesh.addEventListener("change", () => void [mesh.peer_count, mesh.server_count, n]);
    const router = new Router(machine);
    router.attach_mesh(mesh);
    void [room.peers.get("p1")?.name, room.task_kind, room.reports, room.state, room.is_open];
}

export function net_helpers(frame: Uint8Array): void {
    const switch_ = new Switch();
    const port = switch_.add_port(out => void out.length);
    const trunk = switch_.add_port(out => void out.length, { mode: "trunk", allowed: [10, 20], native: 10 });
    const access = switch_.add_port(out => void out.length, { mode: "access", vlan: 20 });
    port.receive(frame);
    switch_.remove_port(trunk);
    switch_.remove_port(access);
    const backoff = new Backoff();
    void [backoff.next(), backoff.reset(), CONNECT_TIMEOUT_MS, MIN_FRAME_LEN, MAX_FRAME_LEN, frame_ok(frame), mac_key(frame, 6)];
    void [MAX_FIELD_CHARS, TASK_KINDS, is_field_id("a"), clean_machine(1), clean_group("g"), clean_machines(["a"]), clean_task_kind("x")];
    void [port.id];
}

// app/machine: agent channel, worker protocol, engine

export function agent_usage(bytes: Uint8Array): void {
    const channel = new AgentChannel(text => void text.length, { stalled: () => false });
    void channel.request("uname", 1000).then(result => void result.output);
    channel.feed(bytes);
    channel.reject_all(new Error("stop"));
    void [encode_request("id", "cmd"), parse_response("@res 1 0 ")?.rc];
}

export function worker_protocol_usage(message: WorkerMessage, reply: WorkerReplies["journal"]): WorkerRequest[] {
    if(message.op === "done") void message.value;
    else if(message.op === "status") void [message.status.vtime, message.log?.from];
    else if(message.op === "end") void message.events;
    else if(message.op === "error") void [message.id, message.message];
    void reply.events.length;
    return [
        { op: "type", id: 1, data: "x", by: "system", port: 1 },
        { op: "check", id: 2, pause: true },
        { op: "run_until", id: 3, target: 100 },
        { op: "journal", id: 4 },
        { op: "speed", x: 0 },
    ];
}

export async function engine_usage(config: ReturnType<Profile["config"]>): Promise<void> {
    const m: EngineMachine = create_machine({ config, seed: 1, events: [], next: 0, snapshot: null, on_journal_end: "live" });
    await m.ready;
    m.on("status", (status: MachineStatus) => void status.waiting);
    m.on("snapshot", snap => void snap.clock.next);
    m.type("ls\r", "teacher", 2);
    m.net_in(new Uint8Array(60));
    m.set_speed(1);
    m.go_live();
    const index: number = await m.check({ pause: false });
    void [index, NO_REST_DIGEST, ram_digest(), state_digest(), m.state_digest(), m.vtime(), m.instructions(), m.stalled(), m.status().mode];
    void [await m.run_until(10), await m.snapshot(), await m.snapshot_after_event(0)];
}

// Calls that must not compile

// @ts-expect-error unknown journal event type
export const bad_event: JournalEvent = { c: 0, w: 0, t: "mouse", x: 1 };

// @ts-expect-error a serial event without data
export const serial_without_data: JournalEvent = { c: 0, w: 0, t: "serial" };

export function bad_calls(machine: Machine): void {
    // @ts-expect-error Machine has no such method
    machine.reboot();
    // @ts-expect-error unknown Machine event name
    machine.on("exploded", () => void 0);
}

// @ts-expect-error topology without machines
export const no_machines: Topology = { format: "v86-topology/1", switches: [], links: [] };

// @ts-expect-error unknown profile name
export const bad_profile: ProfileName = "freebsd";

export type { MachineEvents };
