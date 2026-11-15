import { useEffect, useState } from "react";
import { Check, Clock, Play, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ASSIGNMENT, type Student } from "./data";
import { plural } from "./parts";

const CHECKS = [
  {
    machine: "pc2",
    command: "ping -c 2 192.168.10.10",
    output: "2 packets transmitted, 2 received, 0% packet loss",
  },
  {
    machine: "r1",
    command: "cat /proc/net/vlan/config",
    output: "eth0.10 | 10 | eth0\neth0.20 | 20 | eth0",
  },
  {
    machine: "r1",
    command: "ip -br addr show eth0.20",
    output: "eth0.20@eth0     UP     192.168.20.1/24",
  },
];

const CHECK_EVERY_SECONDS = 10;

type RunState = { phase: "idle" } | { phase: "running"; percent: number } | { phase: "done" };

function useFakeRun(initiallyDone: boolean): [RunState, () => void] {
  const [state, setState] = useState<RunState>(initiallyDone ? { phase: "done" } : { phase: "idle" });
  useEffect(() => {
    if (state.phase !== "running") return;
    const timer = setTimeout(() => {
      const next = state.percent + 9;
      setState(next >= 100 ? { phase: "done" } : { phase: "running", percent: next });
    }, 120);
    return () => clearTimeout(timer);
  }, [state]);
  return [state, () => setState({ phase: "running", percent: 0 })];
}

function CheckList({ ran }: { ran: boolean }) {
  return (
    <ol className="flex flex-col divide-y rounded-md border">
      {CHECKS.map((c) => (
        <li key={c.command} className="flex gap-3 px-3 py-2">
          <span className="w-8 shrink-0 font-mono text-[13px] text-muted-foreground">{c.machine}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-mono text-[13px]">{c.command}</span>
            {ran && (
              <pre className="font-mono text-[12px] whitespace-pre-wrap text-muted-foreground">{c.output}</pre>
            )}
          </div>
          {ran && <Check className="size-4 shrink-0 text-status-done" strokeWidth={3} />}
        </li>
      ))}
    </ol>
  );
}

export function SubmissionPanel({ s }: { s: Student }) {
  const graded = s.grade !== undefined;
  const [run, start] = useFakeRun(graded);
  const checkpoints = s.minutes * (60 / CHECK_EVERY_SECONDS);

  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-semibold">Здано о {s.submittedAt}</h2>
        <p className="flex items-center gap-2 text-sm text-status-done">
          <ShieldCheck className="size-4 shrink-0" />
          Журнал цілий: сервер повторив сесію,{" "}
          {plural(checkpoints, "контрольна точка збіглася", "контрольні точки збіглися", "контрольних точок збіглися")}
        </p>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="size-4 shrink-0" />
          Журнал надходив на сервер частинами з {s.started} до {s.submittedAt}, а не одним файлом наприкінці
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Перевірка</h3>
          <span className="text-[13px] text-muted-foreground">
            Сервер відтворює машини студента і виконує на них ваші команди
          </span>
          {run.phase === "idle" && (
            <Button size="sm" className="ml-auto" onClick={start}>
              <Play /> Запустити перевірку
            </Button>
          )}
        </div>
        {run.phase === "running" && (
          <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
            <Progress value={run.percent} className="h-1.5 w-60" />
            Повторюємо журнал: {run.percent}%
          </div>
        )}
        <CheckList ran={run.phase === "done"} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Оцінка</h3>
        <div className="flex max-w-xl flex-col gap-3">
          <label className="flex items-center gap-2">
            <Input defaultValue={s.grade ?? ""} className="w-14 text-center tabular-nums" />
            <span className="text-muted-foreground">з {ASSIGNMENT.maxGrade}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-muted-foreground">Коментар студенту, необов'язково</span>
            <textarea
              defaultValue={graded ? "Знайдено неправильний VLAN на r1 і виправлено без перезавантаження." : ""}
              rows={3}
              className="resize-y rounded-md border border-input bg-card px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring"
            />
          </label>
          <div>
            <Button variant={graded ? "outline" : "default"}>{graded ? "Оновити оцінку" : "Зберегти оцінку"}</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
