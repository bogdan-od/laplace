import type { Topology, TopologyLink } from "../net/topology.mjs";

export interface DiagramNode {
    kind: "machine" | "switch" | "uplink";
    /** Machine or switch id; `uplink:<switch>` for the exit to the outside. */
    id: string;
    /** Centre of the box. */
    x: number;
    y: number;
    title: string;
    sub: string;
}

export interface DiagramEdge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** `access 10`, `trunk 10,20`. */
    label: string;
    /** The link of the description this line draws. */
    link: TopologyLink;
}

export interface DiagramLayout {
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    width: number;
    height: number;
}

export const MACHINE_W: number;
export const MACHINE_H: number;
export const SWITCH_W: number;
export const SWITCH_H: number;

/** Coordinates of the boxes and lines of the diagram: switches in the middle row, machines above and below. */
export function lay_out(desc: Pick<Topology, "machines" | "switches" | "links">): DiagramLayout;
/** The same diagram as an SVG string. */
export function render_diagram(desc: Pick<Topology, "machines" | "switches" | "links">): string;
