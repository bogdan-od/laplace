import { useMemo } from "react";
import { parseFrame, type FrameInfo } from "@/lib/frames";
import { FRAME_LOG_LIMIT, type FrameRecord } from "@/machine/net-monitor";
import { cn } from "@/lib/utils";

export interface FrameTableProps {
  node: string;
  /** The frames of the machine, the oldest first. */
  records: readonly FrameRecord[];
}

interface Row {
  record: FrameRecord;
  info: FrameInfo;
}

const MS_IN_SECOND = 1000;

/** The last frames of one machine in the manner of tcpdump, the newest on top. Long lines scroll sideways. */
export function FrameTable({ node, records }: FrameTableProps) {
  const rows = useMemo<Row[]>(() => records.map((record) => ({ record, info: parseFrame(record.bytes) })).reverse(), [records]);
  return (
    <section data-testid="frames" data-node={node} className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        Кадри <span className="font-mono">{node}</span>
        <span className="text-xs font-normal text-muted-foreground">
          останні {FRAME_LOG_LIMIT}, час від відкриття сторінки
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Кадрів ще немає</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded border">
          <table className="w-max min-w-full font-mono text-xs whitespace-nowrap">
            <thead className="sticky top-0 bg-muted text-left font-sans text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-right font-medium">Час, с</th>
                <th className="px-1 py-1 font-medium" aria-label="Напрямок" />
                <th className="px-2 py-1 font-medium">Відправник</th>
                <th className="px-2 py-1 font-medium">Одержувач</th>
                <th className="px-2 py-1 font-medium">VLAN</th>
                <th className="px-2 py-1 font-medium">Кадр</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ record, info }, index) => (
                <tr key={index} data-testid="frame-row" data-protocol={info.protocol} data-dir={record.dir} className="border-t">
                  <td className="px-2 py-0.5 text-right tabular-nums">{(record.t / MS_IN_SECOND).toFixed(3)}</td>
                  <td className="px-1 py-0.5">{record.dir === "out" ? "→" : "←"}</td>
                  <td className="px-2 py-0.5">{info.src ?? "-"}</td>
                  <td className="px-2 py-0.5">{info.dst ?? "-"}</td>
                  <td className="px-2 py-0.5 tabular-nums">{info.vlan ?? ""}</td>
                  <td className={cn("px-2 py-0.5", info.damaged && "text-status-stuck")}>{info.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
