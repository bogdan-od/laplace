import { GitBranch, History, LayoutGrid, MonitorUp, Network, Pause, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  ASSIGNMENT,
  CLASS_INFO,
  OTHER_ASSIGNMENTS,
  STUDENTS,
  sortedStudents,
  type Student,
} from "./data";
import {
  AttemptBar,
  EventMark,
  StatusLabel,
  StatusSummary,
  TerminalLines,
  fromMinutes,
  plural,
  toMinutes,
} from "./parts";

const LESSON_FROM = toMinutes(ASSIGNMENT.liveSince);
const LESSON_SPAN = 50;

export type ClassView = "table" | "tiles";

const studentHref = (s: Student) => `#s/${s.id}`;

function PageHeader({ view }: { view: ClassView }) {
  return (
    <div className="flex flex-col gap-4 border-b bg-card px-6 pt-4 pb-4">
      <div className="text-sm text-muted-foreground">
        Класи / <span className="text-foreground">{CLASS_INFO.name}</span>
        <span className="ml-2">{CLASS_INFO.subject}</span>
        <span className="ml-3">{CLASS_INFO.students} студентів, код запрошення </span>
        <span className="font-mono text-foreground">{CLASS_INFO.invite}</span>
      </div>
      <div className="flex items-start gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-display text-[26px] leading-tight font-bold">{ASSIGNMENT.title}</h1>
          <p className="max-w-3xl text-muted-foreground">{ASSIGNMENT.brief}</p>
          <p className="text-sm">
            Термін: {ASSIGNMENT.due}
            <span className="ml-4 inline-flex items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              Живе заняття з {ASSIGNMENT.liveSince}, триває {ASSIGNMENT.liveMinutes} хв
            </span>
          </p>
        </div>
        <div className="ml-auto flex shrink-0 gap-2">
          <Button variant="outline">
            <Network /> Схема
          </Button>
          <Button variant="outline">
            <MonitorUp /> Показати мій термінал
          </Button>
          <Button variant="outline">
            <Pause /> Заморозити всіх
          </Button>
        </div>
      </div>
      <div className="flex items-end gap-6">
        <div className="flex-1">
          <StatusSummary />
        </div>
        <div className="flex rounded-md border p-0.5 text-sm">
          <a
            href="#"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1",
              view === "table" ? "bg-secondary font-medium" : "text-muted-foreground",
            )}
          >
            <Rows3 className="size-3.5" /> Таблиця
          </a>
          <a
            href="#tiles"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1",
              view === "tiles" ? "bg-secondary font-medium" : "text-muted-foreground",
            )}
          >
            <LayoutGrid className="size-3.5" /> Термінали
          </a>
        </div>
      </div>
    </div>
  );
}

function Grade({ s }: { s: Student }) {
  if (s.grade !== undefined) {
    return (
      <span className="font-semibold tabular-nums">
        {s.grade}
        <span className="font-normal text-muted-foreground">/{ASSIGNMENT.maxGrade}</span>
      </span>
    );
  }
  if (s.status === "done") {
    return (
      <Button size="xs" variant="outline">
        Оцінити
      </Button>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

function StudentTable() {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Студент</TableHead>
          <TableHead className="w-28">Стан</TableHead>
          <TableHead className="w-16 text-right">Початок</TableHead>
          <TableHead className="w-16 text-right">Час, хв</TableHead>
          <TableHead className="w-16 text-right">Команд</TableHead>
          <TableHead className="w-16 text-right">Відкатів</TableHead>
          <TableHead className="h-auto w-72 py-1.5">
            <div className="flex items-center gap-3">
              Хід спроби
              <span className="ml-auto inline-flex items-center gap-1">
                <EventMark kind="rollback" /> відкат
              </span>
              <span className="inline-flex items-center gap-1">
                <EventMark kind="help" /> допомога
              </span>
              <span className="inline-flex items-center gap-1">
                <EventMark kind="submit" /> здано
              </span>
            </div>
            <div className="relative mt-0.5 h-4 text-[12px] tabular-nums">
              {[0, 15, 30, 45].map((m) => (
                <span
                  key={m}
                  className={cn("absolute", m > 0 && "-translate-x-1/2")}
                  style={{ left: `${(m / LESSON_SPAN) * 100}%` }}
                >
                  {fromMinutes(LESSON_FROM + m)}
                </span>
              ))}
            </div>
          </TableHead>
          <TableHead className="w-20 text-right">Оцінка</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedStudents().map((s) => (
          <TableRow
            key={s.id}
            onClick={() => (location.hash = studentHref(s))}
            className={cn("cursor-pointer", s.status === "stuck" && "bg-status-stuck/5")}
          >
            <TableCell className="max-w-0 align-top">
              <a href={studentHref(s)} className="font-medium hover:underline">
                {s.name}
              </a>
              {s.help ? (
                <div className="mt-0.5 truncate text-[13px] text-status-stuck">{s.help.text}</div>
              ) : s.lastCommand ? (
                <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
                  {s.machine}:~# {s.lastCommand}
                </div>
              ) : (
                <div className="mt-0.5 text-[13px] text-muted-foreground">Завдання ще не відкрито</div>
              )}
            </TableCell>
            <TableCell className="align-top">
              <StatusLabel status={s.status} />
              <div className="text-[13px] text-muted-foreground">
                {s.help ? s.help.ago : s.submittedAt ? `о ${s.submittedAt}` : " "}
              </div>
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">{s.started ?? "-"}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{s.minutes || "-"}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{s.commands || "-"}</TableCell>
            <TableCell className="text-right align-top tabular-nums">{s.rollbacks || "-"}</TableCell>
            <TableCell className="align-top">
              <AttemptBar student={s} from={LESSON_FROM} span={LESSON_SPAN} />
            </TableCell>
            <TableCell className="text-right align-top">
              <Grade s={s} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Aside() {
  const asking = STUDENTS.filter((s) => s.help);
  return (
    <aside className="flex w-80 shrink-0 flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Просять допомоги <span className="ml-2 font-normal text-muted-foreground">{asking.length}</span></h2>
        {asking.map((s) => (
          <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-status-stuck/30 bg-card p-3">
            <div className="flex items-baseline justify-between">
              <a href={studentHref(s)} className="font-medium hover:underline">
                {s.name}
              </a>
              <span className="text-[13px] text-muted-foreground">{s.help?.ago}</span>
            </div>
            <p className="text-[13px]">{s.help?.text}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline">
                <History /> Повтор з {s.help?.moment}
              </Button>
              <Button size="sm" variant="outline">
                <GitBranch /> Відповісти гілкою
              </Button>
            </div>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Інші завдання класу</h2>
        <div className="flex flex-col divide-y rounded-lg border bg-card">
          {OTHER_ASSIGNMENTS.map((a) => (
            <div key={a.title} className="flex flex-col gap-0.5 px-3 py-2.5">
              <span className="font-medium">{a.title}</span>
              <span className="text-[13px] text-muted-foreground">
                Здали {a.done} з {a.total}
                {a.avg !== null && <>, середня {a.avg}</>}, термін {a.due}
              </span>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

function Tile({ s }: { s: Student }) {
  return (
    <a
      href={studentHref(s)}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card hover:border-ring",
        s.status === "stuck" && "border-status-stuck/50",
      )}
    >
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5 pb-2">
        <span className="truncate font-medium">{s.name}</span>
        <span className="shrink-0 text-[13px]">
          <StatusLabel status={s.status} />
        </span>
      </div>
      {s.status === "idle" ? (
        <div className="flex h-[78px] items-center justify-center border-y bg-muted text-[13px] text-muted-foreground">
          Завдання ще не відкрито
        </div>
      ) : (
        <TerminalLines lines={s.terminal} tone="light" className="h-[78px] border-y" />
      )}
      <div className="flex items-center gap-3 px-3 py-2 text-[13px] text-muted-foreground">
        {s.help ? (
          <span className="truncate text-status-stuck">{s.help.text}</span>
        ) : s.status === "idle" ? (
          <span> </span>
        ) : (
          <>
            <span className="font-mono text-foreground">{s.machine}</span>
            <span>{plural(s.commands, "команда", "команди", "команд")}</span>
            {s.rollbacks > 0 && <span>{plural(s.rollbacks, "відкат", "відкати", "відкатів")}</span>}
            <span className="ml-auto tabular-nums">
              {s.grade !== undefined ? (
                <span className="font-semibold text-foreground">
                  {s.grade}/{ASSIGNMENT.maxGrade}
                </span>
              ) : (
                `${s.minutes} хв`
              )}
            </span>
          </>
        )}
      </div>
    </a>
  );
}

export function ClassPage({ view }: { view: ClassView }) {
  return (
    <div>
      <PageHeader view={view} />
      {view === "table" ? (
        <div className="flex gap-6 px-6 py-5">
          <div className="min-w-0 flex-1 rounded-lg border bg-card">
            <StudentTable />
          </div>
          <Aside />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 px-6 py-5">
          {sortedStudents().map((s) => (
            <Tile key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
