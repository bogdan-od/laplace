import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { LibraryItem } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, describeError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { CONTROL_CLASS } from "./controls";
import { embedAddress, iframeCode } from "./embed-code";

export function PublishDialog({
  item,
  open,
  onOpenChange,
  onItem,
}: {
  item: LibraryItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The item with its new `embed_token`. */
  onItem: (item: LibraryItem) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = item.embed_token;

  const run = async (job: () => Promise<LibraryItem>) => {
    setPending(true);
    setError(null);
    try {
      onItem(await job());
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setPending(false);
    }
  };

  const publish = () =>
    run(async () => {
      const info = await api("POST /api/library/:id/embed", { params: { id: item.id } });
      return { ...item, embed_token: info.token };
    });

  const revoke = () =>
    run(async () => {
      await api("DELETE /api/library/:id/embed", { params: { id: item.id } });
      toast.success("Публікацію скасовано");
      return { ...item, embed_token: null };
    });

  const address = token === null ? null : embedAddress(token, globalThis.location.origin);
  const code = address === null ? null : iframeCode(address);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="publish-dialog">
        <DialogTitle>Опублікувати</DialogTitle>
        <DialogDescription>Журнал стане доступним усім, хто має посилання.</DialogDescription>
        {address === null || code === null ? (
          <PendingButton pending={pending} className="self-end" data-testid="publish-submit" onClick={() => void publish()}>
            Опублікувати
          </PendingButton>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Посилання</span>
              <div className="flex gap-2">
                <Input readOnly value={address} aria-label="Посилання" data-testid="embed-link" />
                <Button variant="outline" data-testid="copy-link" onClick={() => void copyText(address, "Посилання скопійовано")}>
                  <Copy /> Скопіювати
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Код для сайту</span>
              <textarea readOnly rows={3} value={code} aria-label="Код для сайту" data-testid="embed-code" className={`${CONTROL_CLASS} font-mono`} />
              <Button variant="outline" className="self-start" data-testid="copy-code" onClick={() => void copyText(code, "Код скопійовано")}>
                <Copy /> Скопіювати
              </Button>
            </div>
            <PendingButton variant="destructive" pending={pending} className="self-end" data-testid="unpublish" onClick={() => void revoke()}>
              Скасувати публікацію
            </PendingButton>
          </div>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
