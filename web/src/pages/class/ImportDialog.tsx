import { useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import type { ImportResult } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, describeError } from "@/lib/api";
import { refreshClassData } from "./class-refresh";
import { importedToTsv, importSummary } from "./import-result";

const FORMAT_HINT =
  "Кожен рядок: \"ПІБ\" або \"ПІБ;логін\" (роздільник ; або ,). Якщо логіну немає, його створить сервер. Порожні рядки та рядок-заголовок \"ПІБ\" пропускаються.";
const EXAMPLE = "Ткачук Мирослава\nБондаренко Андрій;bondarenko";

export function ImportDialog({ classId, open, onOpenChange }: { classId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="import-dialog" className="max-w-2xl">
        <DialogTitle>Імпорт з CSV</DialogTitle>
        <DialogDescription>{FORMAT_HINT}</DialogDescription>
        <ImportForm classId={classId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImportForm({ classId, onDone }: { classId: number; onDone: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setText(await file.text());
      setError(null);
    } catch {
      setError("Не вдалося прочитати файл.");
    }
  };

  const submit = async () => {
    if (text.trim() === "") {
      setError("Введіть хоча б один рядок або виберіть файл.");
      return;
    }
    setPending(true);
    try {
      setResult(await api("POST /api/classes/:id/import", { params: { id: classId }, body: { csv: text } }));
      await refreshClassData();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  if (result) return <ImportOutcome result={result} onDone={onDone} />;
  return (
    <div className="flex flex-col gap-3">
      <textarea
        data-testid="import-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        rows={8}
        placeholder={EXAMPLE}
        aria-label="Список студентів"
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Або файл:
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void readFile(event)} data-testid="import-file" className="text-sm" />
      </label>
      {error && <p className="text-[13px] text-destructive">{error}</p>}
      <PendingButton pending={pending} onClick={() => void submit()} className="self-end" data-testid="import-submit">
        Імпортувати
      </PendingButton>
    </div>
  );
}

function ImportOutcome({ result, onDone }: { result: ImportResult; onDone: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(importedToTsv(result.created));
      toast.success("Список скопійовано");
    } catch {
      toast.error("Не вдалося скопіювати. Виділіть таблицю й скопіюйте вручну.");
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="import-result">
      <p className="text-sm font-medium">{importSummary(result)}</p>
      {result.created.length > 0 && (
        <>
          <p className="rounded-md bg-status-stuck/10 px-3 py-2 text-[13px] text-status-stuck" data-testid="import-warning">
            Паролі показано лише зараз і більше не відображатимуться. Скопіюйте або збережіть їх, перш ніж закрити вікно.
          </p>
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            <Table data-testid="import-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>ПІБ</TableHead>
                  <TableHead>Логін</TableHead>
                  <TableHead>Пароль</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.created.map((student) => (
                  <TableRow key={student.login} data-testid="import-row">
                    <TableCell>{student.name}</TableCell>
                    <TableCell className="font-mono">{student.login}</TableCell>
                    <TableCell className="font-mono">{student.password}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {result.errors.length > 0 && (
        <ul className="text-[13px] text-destructive" data-testid="import-errors">
          {result.errors.map((failure) => (
            <li key={failure.line}>
              Рядок {failure.line}: {failure.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        {result.created.length > 0 && (
          <Button variant="outline" onClick={() => void copy()} data-testid="import-copy">
            Скопіювати все
          </Button>
        )}
        <Button onClick={onDone} data-testid="import-done">
          Готово
        </Button>
      </div>
    </div>
  );
}
