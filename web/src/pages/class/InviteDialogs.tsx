import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import type { ClassDetail } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, describeError } from "@/lib/api";
import { queryClient, queryKey } from "@/lib/query";
import { copyInviteLink, inviteLink } from "./invite-link";

const QR_SIZE_PX = 240;

export function QrDialog({ code, open, onOpenChange }: { code: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [image, setImage] = useState<string | null>(null);
  const link = inviteLink(code);
  useEffect(() => {
    if (!open) return;
    let current = true;
    QRCode.toDataURL(link, { width: QR_SIZE_PX, margin: 1 })
      .then((url) => current && setImage(url))
      .catch(() => current && setImage(null));
    return () => {
      current = false;
    };
  }, [open, link]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="qr-dialog" className="items-center text-center">
        <DialogTitle>Запрошення до класу</DialogTitle>
        <DialogDescription>Студент наводить камеру на код або відкриває посилання.</DialogDescription>
        {image ? (
          <img src={image} width={QR_SIZE_PX} height={QR_SIZE_PX} alt={`QR-код посилання ${link}`} data-testid="qr-image" />
        ) : (
          <div style={{ width: QR_SIZE_PX, height: QR_SIZE_PX }} className="bg-muted" />
        )}
        <p data-testid="qr-link" className="font-mono text-sm break-all select-all">
          {link}
        </p>
        <Button variant="outline" onClick={() => void copyInviteLink(code)}>
          Скопіювати посилання
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function NewCodeDialog({
  classId,
  open,
  onOpenChange,
}: {
  classId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const renew = async () => {
    setPending(true);
    try {
      const updated: ClassDetail = await api("POST /api/classes/:id/invite", { params: { id: classId } });
      queryClient.setQueryData(queryKey("GET /api/classes/:id", { params: { id: classId } }), updated);
      toast.success(`Новий код запрошення: ${updated.invite_code ?? ""}`);
      onOpenChange(false);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-code-dialog">
        <DialogTitle>Створити новий код?</DialogTitle>
        <DialogDescription>
          Старе посилання перестане працювати: хто ще не приєднався, потребуватиме нового коду. Студенти, які вже в класі, лишаються.
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Скасувати
          </Button>
          <PendingButton pending={pending} onClick={() => void renew()} data-testid="new-code-confirm">
            Створити новий код
          </PendingButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
