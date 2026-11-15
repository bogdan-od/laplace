import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { AttemptSession, ActionName } from "@/machine/attempt-session";
import type { Attempt } from "@shared/api";
import { MAX_TEXT_CHARS } from "@shared/limits";
import { reportActionError } from "./action-error";
import { helpState } from "./help-state";

export interface HelpControlProps {
  session: AttemptSession;
  /** The machine the request is about. */
  node: string;
  /** Shown in the button when the task has several machines. */
  machineLabel?: string;
  attempt: Attempt | null;
  busy: ActionName | null;
  /** The machine is not up (still loading, or its saved journal did not replay): there is nothing to ask about yet. */
  unavailable: boolean;
}

/** "У мене не працює" for one machine; no button while that machine has a request the teacher has not closed. */
export function HelpControl({ session, node, machineLabel, attempt, busy, unavailable }: HelpControlProps) {
  if (helpState(attempt).openNodes.has(node)) return null;
  return <HelpDialog session={session} node={node} machineLabel={machineLabel} pending={busy === "help"} disabled={busy !== null || unavailable} />;
}

export interface HelpStatusProps {
  session: AttemptSession;
  attempt: Attempt | null;
  busy: ActionName | null;
  /** The journal-changing "continue from the reply" is off while the teacher has frozen the work. */
  frozen: boolean;
  /** Name the machines in the texts: the task has several. */
  named: boolean;
}

/** Where the request stands: sent, or answered with a way to go on from the answer. */
export function HelpStatus({ session, attempt, busy, frozen, named }: HelpStatusProps) {
  const { openNodes, reply } = helpState(attempt);
  if (openNodes.size === 0 && reply === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="help-status">
      {reply?.reply_branch_id != null && (
        <>
          <span data-testid="help-replied" className="text-sm font-medium text-status-done">
            Викладач відповів{named && <> (<span className="font-mono">{reply.node}</span>)</>}
          </span>
          <PendingButton
            variant="outline"
            size="sm"
            pending={busy === "continue"}
            disabled={busy !== null || frozen}
            data-testid="continue-from-reply"
            onClick={() => {
              if (reply.reply_branch_id !== null) void session.continueFromReply(reply.node, reply.reply_branch_id).catch(reportActionError);
            }}
          >
            Продовжити з відповіді
          </PendingButton>
        </>
      )}
      {openNodes.size > 0 && (
        <span data-testid="help-sent" className="text-sm text-status-done">
          Запит надіслано викладачу{named && <> (<span className="font-mono">{[...openNodes].join(", ")}</span>)</>}
        </span>
      )}
    </div>
  );
}

interface HelpDialogProps {
  session: AttemptSession;
  node: string;
  machineLabel: string | undefined;
  pending: boolean;
  disabled: boolean;
}

function HelpDialog({ session, node, machineLabel, pending, disabled }: HelpDialogProps) {
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState("");
  const trimmed = text.trim();

  const send = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed === "") return;
    setOpened(false);
    try {
      await session.requestHelp(node, trimmed);
      setText("");
      toast.success("Запит надіслано викладачу");
    } catch (error) {
      setOpened(true);
      reportActionError(error);
    }
  };

  return (
    <Dialog open={opened} onOpenChange={setOpened}>
      <DialogTrigger asChild>
        <PendingButton variant="outline" pending={pending} disabled={disabled} data-testid="help-open">
          У мене не працює
          {machineLabel !== undefined && <span className="font-mono">{machineLabel}</span>}
        </PendingButton>
      </DialogTrigger>
      <DialogContent data-testid="help-dialog">
        <DialogTitle>У мене не працює</DialogTitle>
        <DialogDescription>
          Опишіть, що саме не виходить
          {machineLabel !== undefined && <> на машині <span className="font-mono">{machineLabel}</span></>}. Викладач побачить цей момент вашої роботи.
        </DialogDescription>
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_TEXT_CHARS}
            rows={5}
            autoFocus
            data-testid="help-text"
            aria-label="Опис проблеми"
            className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {text.length} / {MAX_TEXT_CHARS}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpened(false)}>
                Скасувати
              </Button>
              <Button type="submit" disabled={trimmed === ""} data-testid="help-send">
                Надіслати
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
