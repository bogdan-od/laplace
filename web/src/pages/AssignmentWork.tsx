import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import type { Assignment, SubmissionSummary } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { PendingButton } from "@/components/PendingButton";
import { describeError } from "@/lib/api";
import { socket } from "@/lib/live";
import { isOverdue } from "@/lib/my-assignments";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { cn } from "@/lib/utils";
import { machineAddresses } from "@/machine/addresses";
import type { AttemptSession } from "@/machine/attempt-session";
import { MachineTerminal } from "@/machine/MachineTerminal";
import type { FrameRecord } from "@/machine/net-monitor";
import { useAttempt } from "@/machine/use-attempt";
import { useNet } from "@/machine/use-net";
import { reportActionError } from "./work/action-error";
import { FrameTable } from "./work/FrameTable";
import { HelpControl, HelpStatus } from "./work/HelpControl";
import { HintsDialog } from "./work/HintsDialog";
import { HistoryDialog } from "./work/HistoryDialog";
import { LessonWork } from "./work/LessonWork";
import { MachineTiles } from "./work/MachineTiles";
import { RollbackMenu } from "./work/RollbackMenu";
import { SaveStatus } from "./work/SaveStatus";
import { SubmissionBlock } from "./work/SubmissionBlock";
import { SubmitDialog } from "./work/SubmitDialog";
import { TopologyDiagram } from "./work/TopologyDiagram";
import { BACK_TEXT } from "./work/texts";
import { useAsideBeside } from "./work/use-aside-beside";
import { Brief, WorkHeader } from "./work/work-layout";

/** Activities that change what the work screen shows: the grade, a comment, the answer to a request. */
const WATCHED_KINDS = new Set(["graded", "commented", "help_replied", "help_resolved", "verify_failed"]);

const MACHINE_PARAM = "m";
const FROZEN_WAIT_TEXT = "Викладач призупинив завдання. Робота почнеться, щойно він його відновить.";
const NO_FRAMES: readonly FrameRecord[] = [];

/** "/assignments/:id": the student's work on one assignment, with one machine or a topology. A lesson (`kind = lesson`) has its own screen. */
export function AssignmentWorkPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const assignment = useQuery({ ...apiQuery("GET /api/assignments/:id", { params: { id } }), enabled: valid });

  if (!valid) return <Notice title="Завдання не знайдено" />;
  if (assignment.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (assignment.error || !assignment.data) {
    return <Notice title={describeError(assignment.error)} retry={() => void assignment.refetch()} />;
  }
  if (assignment.data.kind === "lesson") return <LessonWork assignment={assignment.data} />;
  return <MachineWork assignment={assignment.data} />;
}

function Notice({ title, retry }: { title: string; retry?: () => void }) {
  return (
    <EmptyState
      title={title}
      action={
        <div className="flex gap-2">
          {retry && (
            <Button variant="outline" onClick={retry}>
              Спробувати знову
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/">{BACK_TEXT}</Link>
          </Button>
        </div>
      }
    />
  );
}

function latestSubmission(list: readonly (SubmissionSummary | null)[]): SubmissionSummary | null {
  let latest: SubmissionSummary | null = null;
  for (const item of list) {
    if (item && (latest === null || item.created_at > latest.created_at)) latest = item;
  }
  return latest;
}

/** The node picked in the address (`?m=`), the first machine when it is missing or unknown. */
function useSelectedNode(nodes: readonly string[]): [string, (node: string) => void] {
  const [params, setParams] = useSearchParams();
  const wanted = params.get(MACHINE_PARAM);
  const selected = nodes.find((node) => node === wanted) ?? nodes[0] ?? "";
  const select = useCallback(
    (node: string) =>
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(MACHINE_PARAM, node);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [selected, select];
}

function MachineWork({ assignment }: { assignment: Assignment }) {
  const { session, view } = useAttempt(assignment.id);
  const net = useNet(session);
  const [now] = useState(() => Date.now());
  const { beside, container, terminal } = useAsideBeside();
  useServerUpdates(session, assignment.id);

  const current = view.assignment ?? assignment;
  const machines = assignment.topology.machines;
  const several = machines.length > 1;
  const [selected, select] = useSelectedNode(machines.map((machine) => machine.id));
  const machine = view.machines.find((item) => item.node === selected);
  const runtime = session && machine ? session.runtime(machine.node) : undefined;
  const views = useMemo(() => new Map(view.machines.map((item) => [item.node, item])), [view.machines]);
  const latest = latestSubmission([...(view.attempt?.submissions ?? []), view.submitted]);
  const ready = session !== null && machine !== undefined && view.phase === "ready";
  const canChangeMachine = ready && !view.frozen && view.busy === null && machine.state === "live";
  const overdue = isOverdue({ ...assignment, my_status: latest ? "done" : null }, now);
  const machineLabel = several ? selected : undefined;

  return (
    <div data-testid="work-page" data-phase={view.phase} className={cn("flex min-h-[34rem] flex-col gap-3 p-4", beside ? "h-full" : "min-h-full")}>
      <WorkHeader assignment={assignment} overdue={overdue}>
        <SaveStatus status={view.saveStatus} />
      </WorkHeader>

      {view.error !== null && (
        <div role="alert" data-testid="work-error" className="flex flex-wrap items-center gap-3 rounded-lg border border-status-stuck/40 bg-status-stuck/5 px-3 py-2 text-sm">
          <span className="text-status-stuck">{view.error}</span>
          {session && view.restartNode !== null && (
            <PendingButton
              size="sm"
              pending={view.busy === "rollback"}
              disabled={view.busy !== null || view.frozen}
              data-testid="restart"
              onClick={() => void session.restartFromBeginning(view.restartNode ?? "").catch(reportActionError)}
            >
              Почати спочатку
            </PendingButton>
          )}
        </div>
      )}

      <div ref={container} data-testid="work-columns" data-beside={beside} className={cn("flex gap-4", beside ? "min-h-0 flex-1" : "flex-col")}>
        <div ref={terminal} className={cn("flex w-min max-w-full shrink-0 flex-col gap-3", beside ? "min-h-0" : "h-[34rem]")}>
          {machine && runtime ? (
            <MachineTerminal runtime={runtime} view={machine} className="min-h-80 flex-1" />
          ) : (
            <div className="flex min-h-80 flex-1 items-center justify-center rounded-lg bg-terminal text-sm text-terminal-foreground">
              {view.waitingForUnfreeze ? FROZEN_WAIT_TEXT : view.phase === "failed" ? "Машину не запущено" : "Завантаження…"}
            </div>
          )}

          {machine?.notice && (
            <p data-testid="machine-notice" className="text-[13px] text-status-work">
              {machine.notice}
            </p>
          )}
          {machine?.settingUp && machine.state === "live" && (
            <p data-testid="machine-setting-up" className="text-[13px] text-muted-foreground">
              Налаштування мережі…
            </p>
          )}
          {machine?.network === "ready" && machine.setup !== null && <AddressLine setup={machine.setup} />}

          {session && machine && (
            <div className="flex flex-wrap items-center gap-2" data-testid="actions">
              <RollbackMenu session={session} node={machine.node} machineLabel={machineLabel} disabled={!canChangeMachine} pending={view.busy === "rollback"} />
              {current.hints.length > 0 && <HintsDialog session={session} hints={current.hints} />}
              <HelpControl session={session} node={machine.node} machineLabel={machineLabel} attempt={view.attempt} busy={view.busy} unavailable={!ready} />
              <HistoryDialog session={session} view={view} />
              <div className="ml-auto">
                <SubmitDialog session={session} pending={view.busy === "submit"} disabled={!ready || view.busy !== null} />
              </div>
            </div>
          )}
        </div>

        <aside data-testid="aside" className={cn("flex min-w-0 flex-1 flex-col gap-3", beside && "min-h-0 min-w-80 overflow-y-auto")}>
          {assignment.brief.trim() !== "" && <Brief text={assignment.brief} />}
          {several && (
            <>
              <TopologyDiagram topology={assignment.topology} views={views} selected={selected} counts={net.counts} onSelect={select} />
              <MachineTiles machines={machines} views={views} selected={selected} onSelect={select} />
              <FrameTable node={selected} records={net.frames.get(selected) ?? NO_FRAMES} />
            </>
          )}
          {session && <HelpStatus session={session} attempt={view.attempt} busy={view.busy} frozen={view.frozen} named={several} />}
          {latest && <SubmissionBlock latest={latest} maxGrade={assignment.max_grade} nodes={machines.map((item) => item.id)} />}
        </aside>
      </div>
    </div>
  );
}

/** The grade, a comment or the check arrive as server messages: reload what the screen shows, no polling. */
function useServerUpdates(session: AttemptSession | null, assignmentId: number): void {
  useEffect(() => {
    if (!session) return;
    const refresh = () => {
      session.refreshAttempt().catch(() => undefined);
      void invalidateRoute("GET /api/submissions/:id");
    };
    const offs = [
      socket.on("notify", ({ activity }) => {
        if (activity.assignment_id === assignmentId || WATCHED_KINDS.has(activity.kind)) refresh();
      }),
      socket.on("submission", (message) => {
        if (message.assignment_id === assignmentId) refresh();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [session, assignmentId]);
}

function AddressLine({ setup }: { setup: string }) {
  const { mac, ips } = machineAddresses(setup);
  if (mac === null && ips.length === 0) return null;
  return (
    <p data-testid="addresses" className="flex flex-wrap gap-x-4 font-mono text-[13px] text-muted-foreground">
      {ips.length > 0 && <span>IP {ips.join(", ")}</span>}
      {mac !== null && <span>MAC {mac}</span>}
    </p>
  );
}
