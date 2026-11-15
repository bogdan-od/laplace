import { Room } from "../net/room.mjs";
import { clean_machines } from "../net/room_fields.mjs";
import { checked_journals } from "../net/topology_journals.mjs";
import { $, report_errors } from "./common.mjs";
import { ReportQueue, upload_journal } from "./report_queue.mjs";
import { mirror_serial, send_history, show_task, type_teacher_input } from "./room_mode.mjs";
import { show_room_state } from "./room_state.mjs";

const TOPOLOGY_KIND = "topology";

// Address of the topology description handed out by the teacher: only a /journals/<id> path of this same server.
const TOPOLOGY_URL_RE = /^\/journals\/[\w-]+$/;

export function checked_topology_url(url) {
    if(!TOPOLOGY_URL_RE.test(url)) throw new Error("topology_url: дозволено лише шлях виду /journals/<id>");
    return url;
}

// Machine ids must pass the room protocol check, otherwise the server rejects the whole list.
export function room_machine_ids(desc) {
    const ids = clean_machines(desc.machines.map(machine => machine.id));
    if(ids === null) throw new Error("Ідентифікатори машин не підходять для кімнати (літери, цифри, _ і -, до 64 символів, без повторів)");
    return ids;
}

// One Room per page: all the student's machines join the room together; output and input are told apart by the machine
// field.
// Call before machine.start(): the mirror does not see output that appeared earlier.
export function join_topology_room(machines, options) {
    const room = new Room({ room: options.room_name, role: "student", name: options.name, machines: [...machines.keys()] });
    const mirrors = new Map();
    for(const [id, machine] of machines) {
        const mirror = mirror_serial(machine, { machine: id });
        mirror.room = room;
        mirrors.set(id, mirror);
    }
    const send_all_history = () => mirrors.forEach(send_history);
    show_room_state(room, $("bar"));
    room.on("joined", () => {
        send_all_history();
        show_topology_task(room.task, room.task_kind, options);
    });
    room.on("peer-joined", msg => msg.role === "teacher" && send_all_history());
    room.on("input", msg => {
        const machine = machines.get(msg.machine);
        if(machine) type_teacher_input(machine, msg.data);
    });
    room.on("task", msg => show_topology_task(msg.journal_id, msg.kind, options));
    room.connect();
    return room;
}

// On the topology page "Почати" exists only for a new topology description; journals are opened by lab.html.
function show_topology_task(journal_id, kind, options) {
    show_task(kind === TOPOLOGY_KIND ? journal_id : null, options, kind);
}

// "У мене не працює" and "Здати": each machine gets its own journal and its own report; all reports of one click
// share a group, so the teacher sees them as one submission.
export function wire_topology_reports(machines, room) {
    const reports = new ReportQueue({ upload: upload_journal, on_link: () => {} });
    reports.attach(room);
    $("room_buttons").hidden = false;
    $("problem").onclick = () => report_errors(() => send_reports(reports, machines, "problem"));
    $("submit").onclick = () => report_errors(() => send_reports(reports, machines, "submit"));
}

async function send_reports(reports, machines, kind) {
    $("note").textContent = "";
    const journals = await checked_journals(machines);
    const group = crypto.randomUUID();
    const ids = [...machines.keys()];
    for(const [index, journal] of journals.entries()) await reports.add(kind, journal, { machine: ids[index], group });
}
