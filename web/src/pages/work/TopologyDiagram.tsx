import { useMemo, type KeyboardEvent } from "react";
import type { Topology } from "@core/net/topology.mjs";
import { MACHINE_H, MACHINE_W, SWITCH_H, SWITCH_W, lay_out, type DiagramEdge, type DiagramNode } from "@core/ui/topology_diagram.mjs";
import { linkKey } from "@/machine/net-monitor";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OFFLINE_STATUS, QUIET_STATUS, TONE_BOX, machineStatus, type StatusView } from "./machine-status";

const LABEL_SIZE = 11;
const TITLE_SIZE = 13;
const SUB_SIZE = 10;
const HALO = 4;

export interface TopologyDiagramProps {
  topology: Topology;
  /** The views of the machines the session has created, by node id. */
  views: ReadonlyMap<string, StatusView>;
  selected: string;
  /** Frames per link, by `linkKey`; without it the links show no frame counts (the teacher's page has none). */
  counts?: ReadonlyMap<string, number>;
  /** Every machine reads "Не в мережі" (the student of the teacher's page is away). */
  offline?: boolean;
  /** No machine runs (the editor of a topology): the boxes carry no state word. */
  quiet?: boolean;
  onSelect: (node: string) => void;
}

/** The scheme of the topology: the boxes by the layout of `topology_diagram.mjs`, the machines are buttons. */
export function TopologyDiagram({ topology, views, selected, counts, offline = false, quiet = false, onSelect }: TopologyDiagramProps) {
  const layout = useMemo(() => lay_out(topology), [topology]);
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{ width: layout.width, maxWidth: "100%" }}
      className="mx-auto h-auto"
      role="group"
      aria-label="Схема мережі"
      data-testid="diagram"
    >
      {layout.edges.map((edge) => (
        <Edge key={linkKey(edge.link)} edge={edge} count={counts && (counts.get(linkKey(edge.link)) ?? 0)} />
      ))}
      {layout.nodes.map((node) =>
        node.kind === "machine" ? (
          <MachineBox key={node.id} node={node} view={views.get(node.id)} offline={offline} quiet={quiet} selected={node.id === selected} onSelect={onSelect} />
        ) : (
          <StaticBox key={node.id} node={node} />
        ),
      )}
    </svg>
  );
}

function Edge({ edge, count }: { edge: DiagramEdge; count: number | undefined }) {
  const x = (edge.x1 + edge.x2) / 2;
  const y = (edge.y1 + edge.y2) / 2;
  const key = linkKey(edge.link);
  return (
    <g data-testid="link" data-link={key} data-count={count}>
      <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} className="stroke-muted-foreground/60" strokeWidth={2} />
      <text x={x} y={y - 2} fontSize={LABEL_SIZE} textAnchor="middle" className="fill-primary stroke-background" strokeWidth={HALO} paintOrder="stroke">
        {edge.label}
      </text>
      {count !== undefined && (
        <text
          x={x}
          y={y + LABEL_SIZE + 1}
          fontSize={LABEL_SIZE}
          textAnchor="middle"
          className="fill-foreground stroke-background tabular-nums"
          strokeWidth={HALO}
          paintOrder="stroke"
          data-testid="link-count"
        >
          {plural(count, "кадр", "кадри", "кадрів")}
        </text>
      )}
    </g>
  );
}

interface MachineBoxProps {
  node: DiagramNode;
  view: StatusView | undefined;
  offline: boolean;
  quiet: boolean;
  selected: boolean;
  onSelect: (node: string) => void;
}

function MachineBox({ node, view, offline, quiet, selected, onSelect }: MachineBoxProps) {
  const status = quiet ? QUIET_STATUS : offline ? OFFLINE_STATUS : machineStatus(view);
  const choose = () => onSelect(node.id);
  const onKey = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    choose();
  };
  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={status.text === "" ? node.title : `${node.title}: ${status.text}`}
      onClick={choose}
      onKeyDown={onKey}
      className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-ring"
      data-testid="diagram-machine"
      data-node={node.id}
      data-selected={selected}
    >
      <rect
        x={node.x - MACHINE_W / 2}
        y={node.y - MACHINE_H / 2}
        width={MACHINE_W}
        height={MACHINE_H}
        rx={5}
        strokeWidth={selected ? 3 : 1}
        className={cn(TONE_BOX[status.tone], selected && "fill-primary/20 stroke-primary")}
      />
      <text x={node.x} y={node.y - 2} fontSize={TITLE_SIZE} textAnchor="middle" className="fill-foreground font-mono">
        {node.title}
      </text>
      <text x={node.x} y={node.y + 12} fontSize={SUB_SIZE} textAnchor="middle" className="fill-muted-foreground">
        {status.text}
      </text>
    </g>
  );
}

function StaticBox({ node }: { node: DiagramNode }) {
  const wide = node.kind === "switch" ? SWITCH_W : MACHINE_W;
  const high = node.kind === "switch" ? SWITCH_H : MACHINE_H;
  return (
    <g>
      <rect x={node.x - wide / 2} y={node.y - high / 2} width={wide} height={high} rx={5} className="fill-muted stroke-border" />
      <text
        x={node.x}
        y={node.sub !== node.title ? node.y - 2 : node.y}
        fontSize={TITLE_SIZE}
        textAnchor="middle"
        dominantBaseline={node.sub !== node.title ? undefined : "central"}
        className={cn("fill-foreground", node.kind === "switch" && "font-mono")}
      >
        {node.title}
      </text>
      {node.sub !== node.title && (
        <text x={node.x} y={node.y + 12} fontSize={SUB_SIZE} textAnchor="middle" className="fill-muted-foreground">
          {node.sub}
        </text>
      )}
    </g>
  );
}
