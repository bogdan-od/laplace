import type { Topology } from "@core/net/topology.mjs";
import { machineAddresses } from "@/machine/addresses";
import type { RuntimeView } from "@/machine/machine-runtime";
import { cn } from "@/lib/utils";
import { OFFLINE_STATUS, TONE_DOT, TONE_TEXT, machineStatus, type StatusView } from "./machine-status";

export interface MachineTilesProps {
  machines: Topology["machines"];
  /** The teacher's page has no runtimes and passes just the state; the addresses need the whole view. */
  views: ReadonlyMap<string, StatusView & { network?: RuntimeView["network"]; setup?: string | null }>;
  selected: string;
  /** Every machine reads "Не в мережі" (the student of the teacher's page is away). */
  offline?: boolean;
  onSelect: (node: string) => void;
}

/** One tile per machine: name, state and, once the network is configured, its addresses. */
export function MachineTiles({ machines, views, selected, offline = false, onSelect }: MachineTilesProps) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2" data-testid="machine-tiles">
      {machines.map((machine) => {
        const view = views.get(machine.id);
        const status = offline ? OFFLINE_STATUS : machineStatus(view);
        const chosen = machine.id === selected;
        const addresses = view?.network === "ready" && typeof view.setup === "string" ? machineAddresses(view.setup) : null;
        return (
          <li key={machine.id}>
            <button
              type="button"
              aria-pressed={chosen}
              onClick={() => onSelect(machine.id)}
              data-testid="machine-tile"
              data-node={machine.id}
              data-state={offline ? "offline" : (view?.state ?? "loading")}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-1.5 text-left",
                chosen ? "border-primary ring-2 ring-primary/30" : "hover:bg-muted",
              )}
            >
              <span className="truncate font-mono text-sm font-semibold">{machine.title ?? machine.id}</span>
              <span className={cn("flex items-center gap-1.5 text-xs", TONE_TEXT[status.tone])}>
                <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[status.tone])} />
                {status.text}
              </span>
              {addresses && (
                <span data-testid="tile-addresses" className="truncate font-mono text-xs text-muted-foreground">
                  {addresses.ips.join(", ")}
                  {addresses.ips.length > 0 && addresses.mac !== null ? " · " : ""}
                  {addresses.mac}
                </span>
              )}
              {view?.network === "failed" && (
                <span data-testid="tile-network-failed" className="truncate text-xs text-status-work">
                  Мережа не налаштована
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
