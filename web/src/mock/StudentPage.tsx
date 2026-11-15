import { Bell, GitBranch, History, Keyboard, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ASSIGNMENT, CLASS_INFO, STATUS_LABEL, STATUS_ORDER, STUDENTS, type Student } from "./data";
import { SubmissionPanel } from "./SubmissionPanel";
import { AttemptBar, EventMark, toMinutes, StatusDot, StatusLabel, TerminalLines, TopologyMini } from "./parts";

function StudentList({ selected }: { selected: string }) {
  return (
    <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r bg-card">
      {STATUS_ORDER.map((status) => {
        const group = STUDENTS.filter((s) => s.status === status);
        return (
          <section key={status}>
            <h3 className="sticky top-0 flex items-center gap-1.5 border-b bg-muted px-4 py-1.5 text-[13px] font-medium text-muted-foreground">
              <StatusDot status={status} />
              {STATUS_LABEL[status]}
              <span className="font-normal">{group.length}</span>
            </h3>
            {group.map((s) => (
              <a
                key={s.id}
                href={`#s/${s.id}`}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 border-b px-4 py-2",
                  s.id === selected ? "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-muted",
                )}
              >
                <span className="font-medium">{s.name}</span>
                <span className="w-full truncate font-mono text-[12px] text-muted-foreground">
                  {s.lastCommand || "-"}
                </span>
              </a>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-base font-medium tabular-nums">{value}</span>
    </div>
  );
}

const EVENT_TEXT = {
  rollback: "Відкат",
  help: "\"У мене не працює\"",
  submit: "Здано",
} as const;

function clockAt(start: string, minutes: number): string {
  const [h = 0, m = 0] = start.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function AttemptEvents({ s }: { s: Student }) {
  if (!s.started) return null;
  let commands = 0;
  const rows: { time: string; text: string; tone: string }[] = [
    { time: s.started, text: "Відкрито завдання", tone: "" },
  ];
  for (const m of s.marks) {
    if (m.kind === "cmd") {
      commands += 1;
      continue;
    }
    const text = m.kind === "rollback" ? `${EVENT_TEXT.rollback} до команди ${commands}` : EVENT_TEXT[m.kind];
    const tone = { rollback: "text-status-work", help: "text-status-stuck", submit: "text-status-done" }[m.kind];
    rows.push({ time: clockAt(s.started, m.at), text, tone });
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Події</h2>
      <ol className="flex flex-col divide-y rounded-lg border bg-card text-sm">
        {rows.map((r, i) => (
          <li key={i} className="flex gap-3 px-3 py-1.5">
            <span className="text-[13px] leading-5 text-muted-foreground tabular-nums">{r.time}</span>
            <span className={r.tone}>{r.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Legend({ bar, label }: { bar: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={bar} /> {label}
    </span>
  );
}

function NotStarted({ s }: { s: Student }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[26px] leading-tight font-bold">{s.name}</h1>
        <div className="text-sm">
          <StatusLabel status={s.status} />
        </div>
      </div>
      <div className="flex max-w-xl flex-col items-start gap-3 rounded-lg border bg-card p-5">
        <p className="text-base">Завдання ще не відкрито.</p>
        <p className="text-muted-foreground">
          У класі з 3 листопада, останній вхід у систему 10 листопада. Термін здачі:{" "}
          {ASSIGNMENT.due}.
        </p>
        <Button variant="outline">
          <Bell /> Надіслати нагадування
        </Button>
      </div>
    </div>
  );
}

function StudentDetail({ s }: { s: Student }) {
  const live = s.status === "work" || s.status === "stuck";
  const started = s.started;
  if (!started) return <NotStarted s={s} />;
  // The axis spans exactly the attempt: up to now for a live one, up to the hand-in otherwise.
  const span = Math.max(s.marks.find((m) => m.kind === "submit")?.at ?? s.minutes, 1);
  const ticks = [0, 1, 2, 3].map((i) => Math.round((span * i) / 3));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      <div className="flex items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-[26px] leading-tight font-bold">{s.name}</h1>
          <div className="text-sm">
            <StatusLabel status={s.status} />
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {live && (
            <>
              <Button variant="outline">
                <Keyboard /> Підключитися до терміналу
              </Button>
              <Button variant="outline">
                <Pause /> Заморозити
              </Button>
            </>
          )}
          {s.status !== "idle" && (
            <Button variant="outline">
              <History /> Повтор спроби
            </Button>
          )}
        </div>
      </div>

      {s.help && (
        <div className="flex items-start gap-4 rounded-lg border border-status-stuck/40 bg-status-stuck/5 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-status-stuck">
              "У мене не працює", {s.help.ago}, момент {s.help.moment}
            </span>
            <p className="text-base">{s.help.text}</p>
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            <Button size="sm" variant="outline">
              <History /> Повтор з {s.help.moment}
            </Button>
            <Button size="sm">
              <GitBranch /> Відповісти гілкою
            </Button>
          </div>
        </div>
      )}

      {s.status === "done" && <SubmissionPanel key={s.id} s={s} />}

      <div className="grid grid-cols-4 gap-4 rounded-lg border bg-card px-4 py-3">
        <Fact label="Початок" value={s.started ?? "-"} />
        <Fact label="Час у завданні" value={s.minutes ? `${s.minutes} хв` : "-"} />
        <Fact label="Команд" value={String(s.commands)} />
        <Fact label="Відкатів" value={String(s.rollbacks)} />
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Хід спроби</h2>
        <div className="rounded-lg border bg-card px-4 pt-3 pb-2.5">
          <AttemptBar student={s} from={toMinutes(started)} span={span} commands />
          <div className="mt-1 flex justify-between text-[12px] text-muted-foreground tabular-nums">
            {ticks.map((m) => (
              <span key={m}>{clockAt(started, m)}</span>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-[12px] text-muted-foreground">
            <Legend bar="h-2 w-px bg-foreground/40" label="команда" />
            <span className="inline-flex items-center gap-1.5">
              <EventMark kind="rollback" /> відкат
            </span>
            <span className="inline-flex items-center gap-1.5">
              <EventMark kind="help" /> допомога
            </span>
            <span className="inline-flex items-center gap-1.5">
              <EventMark kind="submit" /> здано
            </span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-[1fr_320px] gap-4">
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Термінал <span className="font-mono font-normal text-muted-foreground">{s.machine}</span>
            {live && (
              <span className="inline-flex items-center gap-1.5 font-normal text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" /> наживо
              </span>
            )}
            {s.status === "done" && (
              <span className="font-normal text-muted-foreground">стан на момент здачі</span>
            )}
          </h2>
          {s.status === "idle" ? (
            <div className="rounded-lg border bg-muted p-6 text-center text-muted-foreground">
              Завдання ще не відкрито
            </div>
          ) : (
            <TerminalLines lines={s.history ?? s.terminal} className="rounded-lg py-3" />
          )}
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Схема</h2>
          <div className="rounded-lg border bg-card p-3">
            <TopologyMini focus={s.machine} />
          </div>
          <AttemptEvents s={s} />
        </section>
      </div>
    </div>
  );
}

export function StudentPage({ id }: { id: string }) {
  const student = STUDENTS.find((s) => s.id === id) ?? STUDENTS[0];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b bg-card px-6 py-2 text-sm text-muted-foreground">
        Класи /{" "}
        <a href="#" className="hover:text-foreground">
          {CLASS_INFO.name}
          <span className="ml-2">{CLASS_INFO.subject}</span>
        </a>{" "}
        /{" "}
        <a href="#" className="hover:text-foreground">
          {ASSIGNMENT.title}
        </a>{" "}
        / <span className="text-foreground">{student?.name}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <StudentList selected={student?.id ?? ""} />
        {student && <StudentDetail s={student} />}
      </div>
    </div>
  );
}
