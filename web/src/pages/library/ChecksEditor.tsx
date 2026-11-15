import { Plus, Trash2 } from "lucide-react";
import type { Topology } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_CHECKS, MAX_COMMAND_CHARS, MAX_TITLE_CHARS } from "@shared/limits";
import type { CheckRow } from "./item-form";
import { orphanChecks } from "./topology-text";

/** The commands the teacher runs on a machine of a submission, grouped by machine. */
export function ChecksEditor({
  machines,
  rows,
  onChange,
}: {
  machines: Topology["machines"];
  rows: CheckRow[];
  onChange: (rows: CheckRow[]) => void;
}) {
  const orphans = orphanChecks(rows, machines);
  const update = (row: CheckRow, patch: Partial<CheckRow>) => onChange(rows.map((entry) => (entry === row ? { ...entry, ...patch } : entry)));
  return (
    <div className="flex flex-col gap-4" data-testid="checks-editor">
      {machines.map((machine) => {
        const own = rows.filter((row) => row.node === machine.id);
        return (
          <div key={machine.id} className="flex flex-col gap-2" data-testid="checks-machine" data-node={machine.id}>
            <p className="text-sm font-medium">
              {machines.length > 1 ? <span className="font-mono">{machine.id}</span> : machine.title ?? machine.id}
            </p>
            {own.length === 0 && <p className="text-sm text-muted-foreground">Команд перевірки ще немає.</p>}
            {own.map((row, index) => (
              <div key={index} data-testid="check-row" className="flex items-start gap-2">
                <Input
                  className="w-56"
                  placeholder="Назва перевірки"
                  aria-label="Назва перевірки"
                  maxLength={MAX_TITLE_CHARS}
                  data-testid="check-title"
                  value={row.title}
                  onChange={(event) => update(row, { title: event.target.value })}
                />
                <Input
                  className="flex-1 font-mono"
                  placeholder="Команда, напр. ping -c1 10.0.0.2"
                  aria-label="Команда, напр. ping -c1 10.0.0.2"
                  maxLength={MAX_COMMAND_CHARS}
                  data-testid="check-command"
                  value={row.command}
                  onChange={(event) => update(row, { command: event.target.value })}
                />
                <Button size="icon-sm" variant="ghost" aria-label="Видалити перевірку" onClick={() => onChange(rows.filter((entry) => entry !== row))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              data-testid="check-add"
              disabled={rows.length >= MAX_CHECKS}
              onClick={() => onChange([...rows, { node: machine.id, title: "", command: "" }])}
            >
              <Plus /> Додати команду
            </Button>
          </div>
        );
      })}
      {orphans.map((row, index) => (
        <div key={`orphan-${index}`} className="flex flex-col gap-1" data-testid="check-orphan" data-node={row.node}>
          <p className="text-[13px] text-destructive">Машини "{row.node}" немає в топології</p>
          <div className="flex items-center gap-2">
            <span className="w-56 truncate text-sm">{row.title || row.command}</span>
            <span className="flex-1 truncate font-mono text-sm">{row.command}</span>
            <Button size="icon-sm" variant="ghost" aria-label="Видалити перевірку" data-testid="check-orphan-delete" onClick={() => onChange(rows.filter((entry) => entry !== row))}>
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
