import { useState } from "react";
import { toast } from "sonner";
import type { Member } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { refreshClassData } from "./class-refresh";

export function RemoveMemberDialog({
  classId,
  member,
  onClose,
}: {
  classId: number;
  member: Member | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="remove-dialog">{member && <RemoveForm classId={classId} member={member} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function RemoveForm({ classId, member, onClose }: { classId: number; member: Member; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStudent = member.role === "student";

  const remove = async () => {
    setPending(true);
    try {
      await api("DELETE /api/classes/:id/members/:userId", { params: { id: classId, userId: member.user_id } });
      await refreshClassData();
      toast.success(`Вилучено з класу: ${member.name}`);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <DialogTitle>{isStudent ? "Видалити студента з класу?" : "Видалити асистента з класу?"}</DialogTitle>
      <DialogDescription>
        {member.name} ({member.login}) більше не матиме доступу до класу{isStudent && " і зникне зі списків студентів"}.
      </DialogDescription>
      {error && <p className="text-[13px] text-destructive" data-testid="remove-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Скасувати
        </Button>
        <PendingButton variant="destructive" pending={pending} onClick={() => void remove()} data-testid="remove-confirm">
          Видалити
        </PendingButton>
      </div>
    </>
  );
}
