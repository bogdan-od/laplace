import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_HINTS, MAX_TEXT_CHARS } from "@shared/limits";
import { CONTROL_CLASS } from "./controls";
import { moveRow, type HintRow } from "./item-form";

/** The hints of a task in the order a student opens them; each has a penalty taken from the grade. */
export function HintsEditor({ rows, onChange }: { rows: HintRow[]; onChange: (rows: HintRow[]) => void }) {
  const update = (index: number, patch: Partial<HintRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-3" data-testid="hints-editor">
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Підказок ще немає.</p>}
      {rows.map((row, index) => (
        <div key={index} data-testid="hint-row" className="flex items-start gap-2">
          <span className="w-5 pt-1.5 text-sm text-muted-foreground">{index + 1}.</span>
          <textarea
            className={`${CONTROL_CLASS} min-h-16 flex-1`}
            aria-label={`Текст підказки ${index + 1}`}
            data-testid="hint-text"
            maxLength={MAX_TEXT_CHARS}
            value={row.text}
            onChange={(event) => update(index, { text: event.target.value })}
          />
          <label className="flex items-center gap-1.5 pt-1 text-sm text-muted-foreground">
            Штраф
            <Input
              type="number"
              min={0}
              className="w-20"
              data-testid="hint-penalty"
              value={row.penalty}
              onChange={(event) => update(index, { penalty: event.target.value })}
            />
          </label>
          <Button size="icon-sm" variant="ghost" aria-label="Вгору" disabled={index === 0} onClick={() => onChange(moveRow(rows, index, -1))}>
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Вниз" disabled={index === rows.length - 1} onClick={() => onChange(moveRow(rows, index, 1))}>
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Видалити підказку" data-testid="hint-delete" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        data-testid="hint-add"
        disabled={rows.length >= MAX_HINTS}
        onClick={() => onChange([...rows, { text: "", penalty: "0" }])}
      >
        <Plus /> Додати підказку
      </Button>
    </div>
  );
}
