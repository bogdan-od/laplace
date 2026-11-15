import { useState } from "react";
import { GitBranch, History } from "lucide-react";
import { toast } from "sonner";
import type { HelpRequest } from "@shared/api";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HELP_STATE_TEXT, helpState, sortHelp, type HelpState } from "./attempt-view";
import { useHelpMoment } from "./use-help-moment";

const STATE_TONE: Record<HelpState, string> = {
  open: "text-status-stuck",
  replied: "text-status-work",
  closed: "text-muted-foreground",
};

export interface HelpListProps {
  help: readonly HelpRequest[];
  /** Called after a request was closed: the page reloads what depends on it. */
  onResolved: () => Promise<void>;
}

/** The help requests of the student in this assignment. Both buttons open the player at the moment; "Відповісти" there offers the reply. */
export function HelpList({ help, onResolved }: HelpListProps) {
  const [closing, setClosing] = useState<number | null>(null);
  const { opening, open: openMoment } = useHelpMoment();

  const close = async (id: number) => {
    setClosing(id);
    try {
      await api("POST /api/help/:id/resolve", { params: { id } });
      await onResolved();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setClosing(null);
    }
  };

  return (
    <section data-testid="help-section" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Запити допомоги</h2>
      {help.length === 0 ? (
        <p className="rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">Запитів допомоги немає</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sortHelp(help).map((item) => {
            const state = helpState(item);
            return (
              <li
                key={item.id}
                data-testid="help-item"
                data-state={state}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border bg-card p-3",
                  state === "open" && "border-status-stuck/40 bg-status-stuck/5",
                )}
              >
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="text-muted-foreground tabular-nums">{formatWhen(item.created_at)}</span>
                  <span data-testid="help-state" className={cn("font-medium", STATE_TONE[state])}>
                    {HELP_STATE_TEXT[state]}
                  </span>
                  <span className="ml-auto font-mono text-muted-foreground">{item.node}</span>
                </div>
                <p className="text-base">{item.text}</p>
                <div className="flex flex-wrap gap-2">
                  {item.resolved_at === null && (
                    <Button size="sm" data-testid="help-close" disabled={closing === item.id} onClick={() => void close(item.id)}>
                      Закрити
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="help-moment"
                    disabled={opening === item.id}
                    onClick={() => void openMoment(item, false)}
                  >
                    <History /> Переглянути момент
                  </Button>
                  <span title={item.reply_branch_id === null ? undefined : "На цей запит уже надано відповідь"}>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="help-reply"
                      disabled={opening === item.id || item.reply_branch_id !== null}
                      onClick={() => void openMoment(item, true)}
                    >
                      <GitBranch /> Відповісти
                    </Button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
