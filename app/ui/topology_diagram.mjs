// Topology diagram as an SVG string: switches in the middle row, machines above and below.
// A pure function without DOM, so it can be checked in Node.

export const MACHINE_W = 130;
export const MACHINE_H = 44;
const MACHINE_GAP = 150;
export const SWITCH_W = 90;
export const SWITCH_H = 34;
const SWITCH_MIN_GAP = 200;
const MARGIN = 20;
const ROW_GAP = 90;
const LABEL_SIZE = 11;
const TITLE_SIZE = 13;
const SUB_SIZE = 10;

export function render_diagram(desc) {
    const layout = lay_out(desc);
    const lines = layout.edges.map(edge => draw_edge(edge));
    const nodes = layout.nodes.map(node => draw_node(node));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" font-family="sans-serif">${lines.join("")}${nodes.join("")}</svg>`;
}

// Coordinates of nodes and lines; the page needs `id` and `link` to tie counters and selection to the diagram.
export function lay_out(desc) {
    const switches = desc.switches ?? [];
    const links = desc.links ?? [];
    const machine_links = links.filter(link => link.machine !== undefined);
    const by_switch = new Map(switches.map(sw => [sw.id, { top: [], bottom: [] }]));
    for(const link of machine_links) {
        const sides = by_switch.get(link.switch);
        if(!sides) continue;
        const side = sides.top.length <= sides.bottom.length ? sides.top : sides.bottom;
        side.push(link);
    }
    const machines = new Map((desc.machines ?? []).map(machine => [machine.id, machine]));
    const middle_y = MARGIN + MACHINE_H + ROW_GAP;
    const nodes = [];
    const edges = [];
    const switch_pos = new Map();
    let cursor = MARGIN;
    for(const sw of switches) {
        const sides = by_switch.get(sw.id);
        const slots = Math.max(sides.top.length, sides.bottom.length, 1);
        const span = Math.max(slots * MACHINE_GAP, SWITCH_MIN_GAP);
        const x = cursor + span / 2;
        switch_pos.set(sw.id, { x, y: middle_y });
        nodes.push({ kind: "switch", id: sw.id, x, y: middle_y, title: sw.title ?? sw.id, sub: sw.id });
        place_side(sides.top, x, middle_y - ROW_GAP - MACHINE_H / 2, middle_y - SWITCH_H / 2, { machines, nodes, edges });
        place_side(sides.bottom, x, middle_y + ROW_GAP + MACHINE_H / 2, middle_y + SWITCH_H / 2, { machines, nodes, edges });
        cursor += span;
    }
    for(const link of links.filter(item => item.to !== undefined)) {
        const from = switch_pos.get(link.switch);
        const to = switch_pos.get(link.to);
        if(from && to) edges.push({ x1: from.x + SWITCH_W / 2, y1: from.y, x2: to.x - SWITCH_W / 2, y2: to.y, label: link_label(link), link });
    }
    for(const link of links.filter(item => item.uplink !== undefined)) {
        const from = switch_pos.get(link.switch);
        if(!from) continue;
        const x = cursor + MACHINE_W / 2;
        nodes.push({ kind: "uplink", id: `uplink:${link.switch}`, x, y: middle_y, title: "Інтернет", sub: String(link.uplink) });
        edges.push({ x1: from.x + SWITCH_W / 2, y1: from.y, x2: x - MACHINE_W / 2, y2: middle_y, label: link_label(link), link });
        cursor += MACHINE_GAP;
    }
    return { nodes, edges, width: cursor + MARGIN, height: 2 * (MACHINE_H + ROW_GAP) + SWITCH_H + 2 * MARGIN };
}

function place_side(links, center_x, node_y, switch_edge_y, { machines, nodes, edges }) {
    links.forEach((link, index) => {
        const x = center_x + (index - (links.length - 1) / 2) * MACHINE_GAP;
        const machine = machines.get(link.machine);
        nodes.push({ kind: "machine", id: link.machine, x, y: node_y, title: machine?.title ?? link.machine, sub: `${link.machine}, ${machine?.profile ?? "?"}` });
        const near_edge = node_y < switch_edge_y ? node_y + MACHINE_H / 2 : node_y - MACHINE_H / 2;
        edges.push({ x1: x, y1: near_edge, x2: center_x, y2: switch_edge_y, label: link_label(link), link });
    });
}

function link_label(link) {
    if(link.mode === "trunk") return `trunk ${(link.allowed ?? []).join(",")}${link.native ? `, native ${link.native}` : ""}`;
    return `access ${link.vlan}`;
}

function draw_edge({ x1, y1, x2, y2, label }) {
    const text_x = (x1 + x2) / 2;
    const text_y = (y1 + y2) / 2;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#789" stroke-width="2"/>`
        + `<text x="${text_x}" y="${text_y}" font-size="${LABEL_SIZE}" fill="#9cf" text-anchor="middle" paint-order="stroke" stroke="#111" stroke-width="4">${escape_xml(label)}</text>`;
}

function draw_node({ kind, x, y, title, sub }) {
    const wide = kind === "switch" ? SWITCH_W : MACHINE_W;
    const high = kind === "switch" ? SWITCH_H : MACHINE_H;
    const fill = { machine: "#234", switch: "#342", uplink: "#432" }[kind];
    return `<rect x="${x - wide / 2}" y="${y - high / 2}" width="${wide}" height="${high}" rx="5" fill="${fill}" stroke="#89a"/>`
        + `<text x="${x}" y="${y - 2}" font-size="${TITLE_SIZE}" fill="#eee" text-anchor="middle">${escape_xml(title)}</text>`
        + `<text x="${x}" y="${y + 12}" font-size="${SUB_SIZE}" fill="#99a" text-anchor="middle">${escape_xml(sub)}</text>`;
}

function escape_xml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
