import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { JournalRole } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/api";
import { apiQuery, invalidateRoute, queryClient } from "@/lib/query";
import { cn } from "@/lib/utils";
import { MachineTerminal } from "@/machine/MachineTerminal";
import { savePlan } from "@/machine/record-plan";
import { useRecord } from "@/machine/use-record";
import { MachineTiles } from "@/pages/work/MachineTiles";
import { TopologyDiagram } from "@/pages/work/TopologyDiagram";
import { useAsideBeside } from "@/pages/work/use-aside-beside";
import { ConfirmDialog } from "./ConfirmDialog";

/** "/library/:id/record": the machines of a task run live; the teacher breaks them and saves the journals. */
export function RecordPage() {
  const id = Number(useParams()["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <EmptyState
        title="Предмет не знайдено"
        hint="Адреса неправильна."
        action={
          <Button asChild variant="outline">
            <Link to="/library">До бібліотеки</Link>
          </Button>
        }
      />
    );
  }
  return <Recording itemId={id} />;
}

function Recording({ itemId }: { itemId: number }) {
  const navigate = useNavigate();
  const { session, view } = useRecord(itemId);
  const { beside, container, terminal } = useAsideBeside();
  const [picked, setPicked] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [replacing, setReplacing] = useState<JournalRole | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const item = view.item;
  const machines = item?.topology.machines ?? [];
  const several = machines.length > 1;
  const selected = machines.find((candidate) => candidate.id === picked)?.id ?? machines[0]?.id ?? "";
  const machine = view.machines.find((candidate) => candidate.node === selected);
  const runtime = session && machine ? session.runtime(machine.node) : undefined;
  const views = useMemo(() => new Map(view.machines.map((candidate) => [candidate.node, candidate])), [view.machines]);
  const live = view.phase === "ready" && view.machines.length > 0 && view.machines.every((candidate) => candidate.state === "live");
  const backTo = `/library/${itemId}`;

  const run = async (role: JournalRole) => {
    if (!session) return;
    setReplacing(null);
    setSaveError(null);
    try {
      const saved = await session.save(role);
      queryClient.setQueryData(apiQuery("GET /api/library/:id", { params: { id: itemId } }).queryKey, saved.item);
      void invalidateRoute("GET /api/library");
      toast.success(`Збережено журнали: ${saved.count}`);
      void navigate(backTo);
    } catch (error) {
      setSaveError(describeError(error));
    }
  };

  const request = (role: JournalRole) => {
    if (item && savePlan(item, role).replaced.length > 0) setReplacing(role);
    else void run(role);
  };

  const leave = () => {
    if (session?.hasInput()) setLeaving(true);
    else void navigate(backTo);
  };

  const problem = saveError ?? view.error;

  return (
    <div data-testid="record-page" data-phase={view.phase} className={cn("flex min-h-[34rem] flex-col gap-3 p-4", beside ? "h-full" : "min-h-full")}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button size="sm" variant="outline" onClick={leave} data-testid="record-exit">
          Вийти
        </Button>
        <h1 className="font-display text-[22px] leading-tight font-bold">Запис початкового стану</h1>
        {item && <span className="text-sm text-muted-foreground">{item.title}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          <PendingButton pending={view.saving} disabled={!live || view.saving} onClick={() => request("start")} data-testid="record-save-start">
            Зберегти як стартовий стан
          </PendingButton>
          <PendingButton pending={view.saving} variant="outline" disabled={!live || view.saving} onClick={() => request("reference")} data-testid="record-save-reference">
            Зберегти як еталон
          </PendingButton>
        </span>
      </header>

      {problem !== null && (
        <div role="alert" data-testid="record-error" className="rounded-lg border border-status-stuck/40 bg-status-stuck/5 px-3 py-2 text-sm text-status-stuck">
          {problem}
        </div>
      )}

      <div ref={container} data-testid="work-columns" data-beside={beside} className={cn("flex gap-4", beside ? "min-h-0 flex-1" : "flex-col")}>
        <div ref={terminal} className={cn("flex w-min max-w-full shrink-0 flex-col gap-3", beside ? "min-h-0" : "h-[34rem]")}>
          {machine && runtime ? (
            <MachineTerminal runtime={runtime} view={machine} className="min-h-80 flex-1" />
          ) : (
            <div className="flex min-h-80 flex-1 items-center justify-center rounded-lg bg-terminal text-sm text-terminal-foreground">
              {view.phase === "failed" ? "Машину не запущено" : "Завантаження…"}
            </div>
          )}
          {machine?.notice && (
            <p data-testid="machine-notice" className="text-[13px] text-status-work">
              {machine.notice}
            </p>
          )}
        </div>

        <aside data-testid="aside" className={cn("flex min-w-0 flex-1 flex-col gap-3", beside && "min-h-0 min-w-80 overflow-y-auto")}>
          <p className="text-sm text-muted-foreground">
            Налаштуйте машини й збережіть їх як стартовий стан або як еталон. Поки ви не збережете, нічого не записується.
          </p>
          {item && several && (
            <>
              <TopologyDiagram topology={item.topology} views={views} selected={selected} onSelect={setPicked} />
              <MachineTiles machines={machines} views={views} selected={selected} onSelect={setPicked} />
            </>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={replacing !== null}
        title="Замінити журнали?"
        text="Наявні журнали буде замінено"
        confirm="Замінити"
        cancel="Скасувати"
        onConfirm={() => replacing && void run(replacing)}
        onCancel={() => setReplacing(null)}
        testId="record-replace-dialog"
      />
      <ConfirmDialog
        open={leaving}
        title="Вийти з запису?"
        text="Записане буде втрачено"
        confirm="Вийти"
        cancel="Залишитися"
        onConfirm={() => void navigate(backTo)}
        onCancel={() => setLeaving(false)}
        testId="record-leave-dialog"
      />
    </div>
  );
}
