import type { SyncStatus } from "@/machine/journal-sync";
import { cn } from "@/lib/utils";

const TEXT: Record<SyncStatus, string> = {
  saved: "Збережено",
  saving: "Зберігаємо…",
  offline: "Немає зв'язку - зміни збережуться, щойно з'явиться мережа",
  error: "Не вдалося зберегти зміни",
};

const TONE: Record<SyncStatus, string> = {
  saved: "text-muted-foreground",
  saving: "text-muted-foreground",
  offline: "text-status-work",
  error: "text-status-stuck",
};

/** The saving state of the work, in the header. */
export function SaveStatus({ status }: { status: SyncStatus }) {
  return (
    <span data-testid="save-status" data-status={status} className={cn("text-[13px]", TONE[status])}>
      {TEXT[status]}
    </span>
  );
}
