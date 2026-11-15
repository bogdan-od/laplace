import { useState } from "react";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { plural } from "@/lib/format";
import type { AttemptSession } from "@/machine/attempt-session";
import type { HintSlot } from "@shared/api";
import { reportActionError } from "./action-error";

/** "-2 бали" */
function penaltyText(penalty: number): string {
  return `-${plural(penalty, "бал", "бали", "балів")}`;
}

export function HintsDialog({ session, hints }: { session: AttemptSession; hints: readonly HintSlot[] }) {
  const [confirming, setConfirming] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  const open = async (index: number) => {
    setOpening(index);
    try {
      await session.openHint(index);
      setConfirming(null);
    } catch (error) {
      reportActionError(error);
    } finally {
      setOpening(null);
    }
  };

  return (
    <Dialog onOpenChange={() => setConfirming(null)}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="hints-open">
          Підказка
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="hints-dialog">
        <DialogTitle>Підказки</DialogTitle>
        <DialogDescription>Відкрита підказка зменшує оцінку на вказаний штраф.</DialogDescription>
        <ol className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
          {hints.map((hint) => (
            <li key={hint.index} data-testid="hint" data-hint={hint.index} className="flex flex-col gap-1.5 rounded-lg border p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">Підказка {hint.index + 1}</span>
                {hint.text === null && <span className="text-muted-foreground tabular-nums">{penaltyText(hint.penalty)}</span>}
              </div>
              {hint.text !== null ? (
                <p className="text-sm whitespace-pre-wrap" data-testid="hint-text">
                  {hint.text}
                </p>
              ) : confirming === hint.index ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">Оцінка зменшиться на {penaltyText(hint.penalty).slice(1)}. Відкрити?</span>
                  <PendingButton
                    size="sm"
                    pending={opening === hint.index}
                    onClick={() => void open(hint.index)}
                    data-testid="hint-confirm"
                  >
                    Так, відкрити
                  </PendingButton>
                  <Button size="sm" variant="ghost" disabled={opening !== null} onClick={() => setConfirming(null)}>
                    Скасувати
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => setConfirming(hint.index)}
                  data-testid="hint-open"
                >
                  Відкрити
                </Button>
              )}
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
