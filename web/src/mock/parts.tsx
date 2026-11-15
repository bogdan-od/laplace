import { Check, CircleAlert, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  STATUS_LABEL_MANY,
  STATUS_ORDER,
  countByStatus,
  type MarkKind,
  type Status,
  type Student,
} from "./data";

const DOT: Record<Status, string> = {
  stuck: "bg-status-stuck",
  work: "bg-status-work",
  done: "bg-status-done",
  idle: "bg-status-idle",
};

const TEXT: Record<Status, string> = {
  stuck: "text-status-stuck",
  work: "text-status-work",
  done: "text-status-done",
  idle: "text-muted-foreground",
};

export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} ${one}`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)} />;
}

export function StatusLabel({ status }: { status: Status }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", TEXT[status])}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusSummary({ big = false }: { big?: boolean }) {
  const counts = countByStatus();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-sm bg-muted">
        {STATUS_ORDER.map((s) => (
          <div key={s} className={DOT[s]} style={{ width: `${(counts[s] / total) * 100}%` }} />
        ))}
      </div>
      <div className={cn("flex flex-wrap gap-x-5 gap-y-1", big ? "text-base" : "text-sm")}>
        {STATUS_ORDER.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <StatusDot status={s} />
            <span className="font-semibold tabular-nums">{counts[s]}</span>
            <span className="text-muted-foreground">{STATUS_LABEL_MANY[s]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}


export function TerminalLines({
  lines,
  tone = "dark",
  className,
}: {
  lines: string[];
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "overflow-hidden px-2.5 py-2 font-mono text-[12px] leading-[1.45]",
        tone === "dark" ? "bg-terminal text-terminal-foreground" : "bg-muted text-foreground",
        className,
      )}
    >
      {lines.map((l, i) => (
        <div key={i} className="overflow-hidden text-ellipsis whitespace-pre">
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export function toMinutes(clock: string): number {
  const [h = 0, m = 0] = clock.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

type EventKind = Exclude<MarkKind, "cmd">;

const EVENT_LOOK: Record<EventKind, { fill: string; Icon: typeof Check; title: string }> = {
  rollback: { fill: "fill-status-work", Icon: RotateCcw, title: "Відкат" },
  help: { fill: "fill-status-stuck", Icon: CircleAlert, title: "\"У мене не працює\"" },
  submit: { fill: "fill-status-done", Icon: Check, title: "Здано" },
};

/*
 * Circle and icon are one SVG on purpose. As two elements (a rounded span with an <svg> inside)
 * the browser snaps the icon to whole pixels but draws the circle at the fractional position
 * the bar gives it, so every mark ended up off-centre by up to half a pixel in its own direction.
 */
export function EventMark({ kind, className }: { kind: EventKind; className?: string }) {
  const { fill, Icon } = EVENT_LOOK[kind];
  return (
    <svg viewBox="0 0 24 24" className={cn("block size-6", className)} aria-hidden>
      <circle cx={12} cy={12} r={12} className="fill-card" />
      <circle cx={12} cy={12} r={10} className={fill} />
      <Icon x={6} y={6} width={12} height={12} color="white" strokeWidth={2.75} />
    </svg>
  );
}

const BAR_TINT: Record<Status, string> = {
  stuck: "bg-status-stuck/25",
  work: "bg-status-work/25",
  done: "bg-status-done/25",
  idle: "bg-status-idle/25",
};

/*
 * One attempt on a shared time axis [from, from + span] (minutes on the clock).
 * The bar covers the time the student worked; only meaningful events get a mark,
 * commands are drawn as ticks only when asked (the detail page has room for them).
 */
export function AttemptBar({
  student,
  from,
  span,
  commands = false,
}: {
  student: Student;
  from: number;
  span: number;
  commands?: boolean;
}) {
  const pct = (minutes: number) => `${(minutes / span) * 100}%`;
  if (!student.started) {
    return (
      <div className="relative h-5 w-full">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      </div>
    );
  }
  const start = toMinutes(student.started) - from;
  const submit = student.marks.find((m) => m.kind === "submit");
  const length = submit ? submit.at : student.minutes;
  return (
    <div className="relative h-5 w-full">
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      <div
        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-sm", BAR_TINT[student.status])}
        style={{ left: pct(start), width: pct(length) }}
      />
      {commands &&
        student.marks
          .filter((m) => m.kind === "cmd")
          .map((m, i) => (
            <span
              key={`c${i}`}
              className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-foreground/35"
              style={{ left: pct(start + m.at) }}
            />
          ))}
      {student.marks.map((m, i) =>
        m.kind === "cmd" ? null : (
          <span
            key={i}
            title={`${EVENT_LOOK[m.kind].title} о ${fromMinutes(from + start + m.at)}`}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: pct(start + m.at) }}
          >
            <EventMark kind={m.kind} />
          </span>
        ),
      )}
    </div>
  );
}

const NODE_POS: Record<string, [number, number]> = {
  r1: [150, 22],
  sw1: [150, 78],
  pc1: [50, 134],
  pc2: [150, 134],
  srv: [250, 134],
};

const LINKS: [string, string, string][] = [
  ["r1", "sw1", "trunk 10,20"],
  ["sw1", "pc1", "VLAN 10"],
  ["sw1", "pc2", "VLAN 20"],
  ["sw1", "srv", "VLAN 10"],
];

export function TopologyMini({ focus, broken }: { focus?: string; broken?: string }) {
  return (
    <svg viewBox="0 0 300 160" className="w-full font-mono text-[11px]">
      {LINKS.map(([a, b, label]) => {
        const [x1, y1] = NODE_POS[a] ?? [0, 0];
        const [x2, y2] = NODE_POS[b] ?? [0, 0];
        return (
          <g key={a + b}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-border" strokeWidth={1.5} />
            <text
              x={x1 + (x2 - x1) * 0.62 + (x2 > x1 ? 8 : x2 < x1 ? -8 : 6)}
              y={y1 + (y2 - y1) * 0.62 - 4}
              className="fill-muted-foreground text-[9px]"
              textAnchor={x2 > x1 ? "start" : x2 < x1 ? "end" : "start"}
            >
              {label}
            </text>
          </g>
        );
      })}
      {Object.entries(NODE_POS).map(([id, [x, y]]) => {
        const isSwitch = id.startsWith("sw");
        return (
          <g key={id}>
            <rect
              x={x - 22}
              y={y - 11}
              width={44}
              height={22}
              rx={isSwitch ? 2 : 3}
              className={cn(
                "fill-card stroke-[1.5]",
                id === focus ? "stroke-primary" : "stroke-input",
                id === broken && "stroke-status-stuck",
              )}
              strokeDasharray={isSwitch ? "3 2" : undefined}
            />
            <text x={x} y={y + 4} textAnchor="middle" className="fill-foreground">
              {id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
