import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/** A yes/no question; the buttons get `${testId}-cancel` and `${testId}-confirm`. */
export function ConfirmDialog({
  open,
  title,
  text,
  confirm,
  cancel,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  text: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid={testId}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{text}</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} data-testid={`${testId}-cancel`}>
            {cancel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid={`${testId}-confirm`}>
            {confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
