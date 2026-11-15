import { useState } from "react";
import { PendingButton } from "@/components/PendingButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AttemptSession } from "@/machine/attempt-session";
import type { RollbackOption } from "@/machine/rollback-list";
import { reportActionError } from "./action-error";

export interface RollbackMenuProps {
  session: AttemptSession;
  node: string;
  /** Shown in the button when the task has several machines. */
  machineLabel?: string;
  disabled: boolean;
  pending: boolean;
}

/** "Відкотити": the places to go back to are read from the journal when the list opens. */
export function RollbackMenu({ session, node, machineLabel, disabled, pending }: RollbackMenuProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RollbackOption[] | null>(null);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setOptions(null);
    session.rollbackOptions(node).then(setOptions, (error: unknown) => {
      setOpen(false);
      reportActionError(error);
    });
  };

  const rollback = (index: number) => {
    session.rollback(node, index).catch(reportActionError);
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <PendingButton variant="outline" pending={pending} disabled={disabled} data-testid="rollback-open">
          Відкотити
          {machineLabel !== undefined && <span className="font-mono">{machineLabel}</span>}
        </PendingButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" data-testid="rollback-menu">
        {options === null && <p className="px-1.5 py-1 text-sm text-muted-foreground">Завантаження…</p>}
        {options?.map((option) => (
          <DropdownMenuItem
            key={option.index}
            data-testid="rollback-option"
            data-index={option.index}
            onSelect={() => rollback(option.index)}
            className={option.text === undefined ? undefined : "font-mono text-[13px]"}
          >
            <span className="truncate">{option.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
