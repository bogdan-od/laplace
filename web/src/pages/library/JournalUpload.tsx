import { useRef, useState, type ChangeEvent } from "react";
import type { Journal } from "@core/core/journal.mjs";
import type { JournalRole, LibraryItem } from "@shared/api";
import { MAX_JOURNAL_BYTES } from "@shared/limits";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { MAX_JOURNAL_MB, parseJournalFile } from "./journal-file";

/** "Завантажити з файлу" of one journal: the file is checked here, the server checks it again. */
export function JournalUpload({
  item,
  node,
  role,
  exists,
  onItem,
}: {
  item: LibraryItem;
  node: string;
  role: JournalRole;
  exists: boolean;
  onItem: (item: LibraryItem) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState<Journal | null>(null);

  const send = async (journal: Journal) => {
    setReplacing(null);
    setBusy(true);
    setError(null);
    try {
      onItem(await api("PUT /api/library/:id/journals/:node", { params: { id: item.id, node }, query: { role }, body: journal }));
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    if (file.size > MAX_JOURNAL_BYTES) {
      setError(`Файл завеликий: не більше ${MAX_JOURNAL_MB} МБ`);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("Не вдалося прочитати файл");
      return;
    }
    const parsed = parseJournalFile(text);
    if (parsed.journal === null) setError(parsed.error);
    else if (exists) setReplacing(parsed.journal);
    else await send(parsed.journal);
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        data-testid="journal-file"
        onChange={(event) => void pick(event)}
      />
      <Button size="sm" variant="outline" disabled={busy} data-testid="journal-upload" onClick={() => input.current?.click()}>
        Завантажити з файлу
      </Button>
      {error !== null && (
        <p className="w-full text-[13px] text-destructive" data-testid="journal-file-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={replacing !== null}
        title="Замінити журнал?"
        text="Наявний журнал цієї машини буде замінено вмістом файлу."
        confirm="Замінити"
        cancel="Скасувати"
        onConfirm={() => replacing && void send(replacing)}
        onCancel={() => setReplacing(null)}
        testId="journal-replace-dialog"
      />
    </>
  );
}
