import type { Topology } from "@shared/api";
import { TopologyDiagram } from "@/pages/work/TopologyDiagram";
import { CONTROL_CLASS } from "./controls";

const NO_VIEWS = new Map<string, never>();
const NO_SELECTION = "";
const ROWS = 18;

/**
 * The scheme of the topology; for a task also the editor of its text (format `v86-topology/1`). The scheme follows the
 * last text without errors, the messages of the current text stand under the field.
 */
export function TopologyBlock({
  topology,
  text,
  problems,
  editable,
  onChange,
}: {
  /** The last description without errors. */
  topology: Topology;
  text: string;
  problems: readonly string[];
  editable: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className={editable ? "grid gap-4 md:grid-cols-2" : ""} data-testid="topology-block">
      <div className="flex items-start justify-center" data-testid="topology-scheme">
        {topology.links.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="scheme-empty">
            Без комутатора - схеми немає
          </p>
        ) : (
          <TopologyDiagram topology={topology} views={NO_VIEWS} selected={NO_SELECTION} quiet onSelect={() => undefined} />
        )}
      </div>
      {editable && (
        <div className="flex flex-col gap-2">
          <textarea
            className={`${CONTROL_CLASS} font-mono text-[13px]`}
            rows={ROWS}
            spellCheck={false}
            aria-label="Опис топології"
            data-testid="topology-text"
            value={text}
            onChange={(event) => onChange(event.target.value)}
          />
          {problems.length > 0 && (
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-destructive" data-testid="topology-problems">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
