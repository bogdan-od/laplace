import { useState } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { AttemptSession } from "@/machine/attempt-session";
import { reportActionError } from "./action-error";

export function SubmitDialog({ session, pending, disabled }: { session: AttemptSession; pending: boolean; disabled: boolean }) {
  const [opened, setOpened] = useState(false);

  const submit = async () => {
    setOpened(false);
    try {
      await session.submit();
      toast.success("Роботу здано");
    } catch (error) {
      reportActionError(error);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={setOpened}>
      <DialogTrigger asChild>
        <PendingButton pending={pending} disabled={disabled} data-testid="submit-open">
          Здати
        </PendingButton>
      </DialogTrigger>
      <DialogContent data-testid="submit-dialog">
        <DialogTitle>Здати роботу?</DialogTitle>
        <DialogDescription>Роботу буде надіслано на перевірку. Працювати далі можна й після здачі.</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpened(false)}>
            Скасувати
          </Button>
          <Button onClick={() => void submit()} data-testid="submit-confirm">
            Здати
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
