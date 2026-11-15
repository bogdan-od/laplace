import { useEffect, useRef, useState } from "react";
import { Check, Play, X } from "lucide-react";
import { toast } from "sonner";
import type { CheckCommand, CheckResult, CheckRun } from "@shared/api";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { socket } from "@/lib/live";
import { cn } from "@/lib/utils";
import { mergeRun, runFinished, runSummary } from "./submission-view";

export interface CheckRunBlockProps {
  submissionId: number;
  /** The last run the server has stored (`Submission.check_runs`). */
  saved: CheckRun | null;
  /** The teacher's commands of the task: shown before and during a run. */
  checks: readonly CheckCommand[];
  /** Called when a run ends, so the page reloads the submission. */
  onSettled: () => void;
}

interface Row {
  node: string;
  title: string;
  command: string;
  result: CheckResult | null;
}

function rowsOf(checks: readonly CheckCommand[], run: CheckRun | null): Row[] {
  const results = run?.results ?? [];
  const rows: Row[] = results.map((result) => ({ node: result.node, title: result.title, command: result.command, result }));
  return rows.concat(checks.slice(results.length).map((check) => ({ ...check, result: null })));
}

/** The teacher's commands run on the machines the server rebuilds from the journal; output arrives command by command. */
export function CheckRunBlock({ submissionId, saved, checks, onSettled }: CheckRunBlockProps) {
  const [live, setLive] = useState<CheckRun | null>(null);
  const [starting, setStarting] = useState(false);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  const run = mergeRun(live, saved);
  const idle = runFinished(run) && !starting;

  useEffect(
    () =>
      socket.on("check-run", (message) => {
        if (message.run.submission_id !== submissionId) return;
        setLive((current) => mergeRun(current, message.run));
        if (runFinished(message.run)) settled.current();
      }),
    [submissionId],
  );

  const start = async () => {
    setStarting(true);
    try {
      const started = await api("POST /api/submissions/:id/check-runs", { params: { id: submissionId } });
      setLive((current) => mergeRun(current, started));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section data-testid="check-section" data-run-status={run?.status ?? "none"} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold">Перевірка</h3>
        <span className="text-[13px] text-muted-foreground">Сервер відтворює машини студента і виконує на них ваші команди</span>
        <Button size="sm" className="ml-auto" data-testid="check-start" disabled={!idle || checks.length === 0} onClick={() => void start()}>
          <Play /> {run === null ? "Запустити перевірку" : "Запустити ще раз"}
        </Button>
      </div>
      {checks.length === 0 && <p className="text-[13px] text-muted-foreground">У завданні немає команд перевірки</p>}
      {run !== null && (
        <p data-testid="check-summary" className={cn("text-sm font-medium", run.status === "failed" && "text-status-stuck")}>
          {runSummary(run, checks.length)}
        </p>
      )}
      {checks.length > 0 && (
        <ol data-testid="check-list" className="flex flex-col divide-y rounded-md border">
          {rowsOf(checks, run).map((row, index) => (
            <li key={index} data-testid="check-item" data-rc={row.result?.rc ?? "none"} className="flex gap-3 px-3 py-2">
              <span className="w-8 shrink-0 font-mono text-[13px] text-muted-foreground">{row.node}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-mono text-[13px] break-all">{row.command}</span>
                {row.result !== null && row.result.output !== "" && (
                  <pre data-testid="check-output" className="font-mono text-[12px] whitespace-pre-wrap break-all text-muted-foreground">
                    {row.result.output}
                  </pre>
                )}
              </div>
              {row.result !== null &&
                (row.result.rc === 0 ? (
                  <Check className="size-4 shrink-0 text-status-done" strokeWidth={3} />
                ) : (
                  <X className="size-4 shrink-0 text-status-stuck" strokeWidth={3} />
                ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
