import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/api";
import { socket } from "@/lib/live";
import { BranchTree } from "@/machine/BranchTree";
import { MachineTerminal } from "@/machine/MachineTerminal";
import { buildBranchTree } from "@/machine/branch-tree";
import type { RollbackOption } from "@/machine/rollback-list";
import { useAttempt } from "@/machine/use-attempt";

const SAVE_TEXT = { saved: "збережено", saving: "зберігається…", offline: "немає зв'язку, повторюю", error: "помилка збереження" };

// Test bench for the attempt layer (not a product screen): the student's terminal, the saving state,
// the rollback / help / submit actions and the attempt tree. Reachable at /dev/attempt/:assignmentId.
export function AttemptPage() {
  const id = Number(useParams().assignmentId);
  const { session, view } = useAttempt(id);
  const [actionError, setActionError] = useState<string | null>(null);
  const [options, setOptions] = useState<{ node: string; list: RollbackOption[] } | null>(null);
  const [helpText, setHelpText] = useState("");

  useEffect(() => socket.connect(), []);

  const tree = useMemo(
    () =>
      view.attempt
        ? buildBranchTree(view.attempt.branches, {
            headIds: new Set(Object.values(view.attempt.heads)),
            commandNumbers: view.commandNumbers,
          })
        : [],
    [view.attempt, view.commandNumbers],
  );

  const run = async (job: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await job();
    } catch (error) {
      setActionError(describeError(error));
    }
  };

  const first = view.machines[0];
  const busy = view.busy !== null;

  return (
    <div className="flex flex-col gap-4 p-4 font-sans" data-testid="attempt-page" data-phase={view.phase}>
      <h1 className="text-lg">/dev/attempt/{id}</h1>
      <div className="flex flex-wrap gap-4 text-sm">
        <span data-testid="phase">{view.phase}</span>
        <span data-testid="save-status" data-status={view.saveStatus}>
          {SAVE_TEXT[view.saveStatus]}
        </span>
        {view.frozen && <span data-testid="frozen">Викладач призупинив роботу</span>}
        {view.busy && <span data-testid="busy">{view.busy}</span>}
        {view.submitted && (
          <span data-testid="submitted" data-status={view.submitted.verify_status}>
            здано: {view.submitted.verify_status}
          </span>
        )}
      </div>
      {view.error && <p data-testid="error" className="text-destructive">{view.error}</p>}
      {actionError && <p data-testid="action-error" className="text-destructive">{actionError}</p>}

      {session &&
        view.machines.map((machine) => {
          const runtime = session.runtime(machine.node);
          if (!runtime) return null;
          return (
            <section key={machine.node} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">
                {machine.title} <span className="font-mono font-normal">{machine.node}</span>
              </h2>
              <p className="text-[12px] text-muted-foreground" data-testid="machine-state" data-state={machine.state}>
                {machine.state} · мережа {machine.network} · гілка {machine.branchId ?? "-"} · подій{" "}
                {machine.sync?.saved ?? 0}
              </p>
              {machine.notice && <p className="text-[12px] text-status-work">{machine.notice}</p>}
              <MachineTerminal runtime={runtime} view={machine} className="h-96" />
            </section>
          );
        })}

      {session && first && (
        <div className="flex flex-wrap items-start gap-2">
          <Button
            variant="outline"
            disabled={busy}
            data-testid="rollback-open"
            onClick={() =>
              void run(async () => setOptions({ node: first.node, list: await session.rollbackOptions(first.node) }))
            }
          >
            Відкат…
          </Button>
          <input
            className="h-8 rounded-md border px-2 text-sm"
            value={helpText}
            onChange={(event) => setHelpText(event.target.value)}
            placeholder="Що не працює"
            data-testid="help-text"
          />
          <Button
            variant="outline"
            disabled={busy}
            data-testid="help"
            onClick={() => void run(() => session.requestHelp(first.node, helpText).then(() => setHelpText("")))}
          >
            У мене не працює
          </Button>
          <Button disabled={busy} data-testid="submit" onClick={() => void run(() => session.submit())}>
            Здати
          </Button>
        </div>
      )}

      {session && options && (
        <ul data-testid="rollback-options" className="flex flex-col gap-1 text-sm">
          {options.list.map((option) => (
            <li key={option.index}>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="rollback-option"
                data-index={option.index}
                onClick={() =>
                  void run(async () => {
                    await session.rollback(options.node, option.index);
                    setOptions(null);
                  })
                }
              >
                {option.label}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Гілки спроби</h2>
        <BranchTree nodes={tree} />
      </section>
    </div>
  );
}
