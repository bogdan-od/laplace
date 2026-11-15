import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { ItemKind, JournalRole, LibraryItem } from "@shared/api";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { formatGuestTime } from "@/machine/player-marks";
import { JournalUpload } from "./JournalUpload";

const ROLE_LABEL: Record<JournalRole, string> = { start: "Стартовий журнал", reference: "Еталонний журнал" };
const KB = 1024;

function rolesOf(kind: ItemKind): JournalRole[] {
  return kind === "task" ? ["start", "reference"] : ["start"];
}

function sizeText(bytes: number): string {
  return bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} КБ` : `${(bytes / (KB * KB)).toFixed(1)} МБ`;
}

/**
 * Per machine of the topology: its start and reference journals, with a way to open, load from a file or remove each.
 * `dirty`: the form has unsaved changes, so the recording (which reads the saved topology) waits.
 */
export function MachinesBlock({ item, dirty, onItem }: { item: LibraryItem; dirty: boolean; onItem: (item: LibraryItem) => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (node: string, role: JournalRole) => {
    setBusy(`${node}-${role}`);
    try {
      onItem(await api("DELETE /api/library/:id/journals/:node", { params: { id: item.id, node }, query: { role } }));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="machines-block">
      {item.kind === "clip" && item.clip_from_ms !== null && (
        <p className="text-sm" data-testid="clip-from">
          Кліп з <span className="font-mono">{formatGuestTime(item.clip_from_ms)}</span>
        </p>
      )}
      {item.topology.machines.map((machine) => (
        <div key={machine.id} className="flex flex-col gap-1.5" data-testid="machine-row" data-node={machine.id}>
          <p className="text-sm font-medium">
            {machine.title ?? machine.id} <span className="font-mono text-muted-foreground">{machine.id}</span>
          </p>
          {rolesOf(item.kind).map((role) => {
            const journal = item.journals.find((entry) => entry.node === machine.id && entry.role === role);
            return (
              <div key={role} className="flex flex-wrap items-center gap-3 text-sm" data-testid="journal-row" data-role={role}>
                <span className="w-44 text-muted-foreground">{ROLE_LABEL[role]}</span>
                <span data-testid="journal-state" data-has={journal ? "yes" : "no"} className="w-24">
                  {journal ? `є, ${sizeText(journal.size)}` : "немає"}
                </span>
                {journal && (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/play/item-${item.id}-${machine.id}-${role}`} data-testid="journal-view">
                        Переглянути
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="journal-delete"
                      disabled={busy === `${machine.id}-${role}`}
                      onClick={() => void remove(machine.id, role)}
                    >
                      Видалити
                    </Button>
                  </>
                )}
                <JournalUpload item={item} node={machine.id} role={role} exists={journal !== undefined} onItem={onItem} />
              </div>
            );
          })}
        </div>
      ))}
      {item.kind === "task" && (
        <div className="flex items-center gap-3 border-t pt-3">
          {dirty ? (
            <Button variant="outline" disabled data-testid="record-start">
              Записати початковий стан
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link to={`/library/${item.id}/record`} data-testid="record-start">
                Записати початковий стан
              </Link>
            </Button>
          )}
          {dirty && (
            <span className="text-[13px] text-muted-foreground" data-testid="record-hint">
              Спершу збережіть зміни
            </span>
          )}
        </div>
      )}
    </div>
  );
}
