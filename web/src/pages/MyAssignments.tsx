import { useState, type SubmitEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeError } from "@/lib/api";
import { formatDue } from "@/lib/format";
import type { MyAssignment } from "@shared/api";
import { isOverdue, sortMyAssignments } from "@/lib/my-assignments";
import { apiQuery } from "@/lib/query";
import { cn } from "@/lib/utils";

const KIND_TEXT = { task: "Завдання", lesson: "Урок" } as const;

/** "/" for a student: the assignments of all classes in one table. */
export function MyAssignmentsPage() {
  // Classes only tell "no class yet" (the invite code field) from "no assignments yet".
  const classes = useQuery(apiQuery("GET /api/classes"));
  const assignments = useQuery(apiQuery("GET /api/me/assignments"));
  const [now] = useState(() => Date.now());

  const heading = <h1 className="font-display text-[26px] leading-tight font-bold">Мої завдання</h1>;
  const failure = classes.error ?? assignments.error;
  let body;
  if (failure) {
    body = (
      <EmptyState
        title={describeError(failure)}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void classes.refetch();
              void assignments.refetch();
            }}
          >
            Спробувати знову
          </Button>
        }
      />
    );
  } else if (!classes.data || !assignments.data) {
    body = <p className="text-sm text-muted-foreground">Завантаження…</p>;
  } else if (classes.data.length === 0) {
    body = <JoinByCode />;
  } else {
    const items = assignments.data;
    body = items.length === 0 ? (
      <div className="rounded-lg border bg-card">
        <EmptyState title="Завдань поки немає" hint="Коли викладач видасть завдання, воно з'явиться тут." />
      </div>
    ) : (
      <AssignmentTable items={sortMyAssignments(items, now)} now={now} />
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 sm:px-6 py-6">
      {heading}
      {body}
    </div>
  );
}

/** The row of the table on a narrow screen: the same fields, one card per assignment. */
function AssignmentCard({ item, now }: { item: MyAssignment; now: number }) {
  return (
    <li data-testid="assignment-card" data-assignment={item.id} className="flex flex-col gap-1 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <Link to={`/assignments/${item.id}`} className="min-w-0 font-medium hover:underline">
          {item.title}
        </Link>
        <span className="ml-auto shrink-0 tabular-nums">{item.my_grade === null ? "-" : `${item.my_grade} з ${item.max_grade}`}</span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {item.class_name} · {KIND_TEXT[item.kind]}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatusLabel status={item.my_status ?? "idle"} kind={item.kind} />
        {item.frozen && <span className="font-medium text-status-work">Призупинено</span>}
        <span className={cn("ml-auto tabular-nums", isOverdue(item, now) ? "text-status-stuck" : "text-muted-foreground")}>
          {item.due_at === null ? "Без строку" : formatDue(item.due_at, now)}
        </span>
      </div>
    </li>
  );
}

export function AssignmentTable({ items, now }: { items: MyAssignment[]; now: number }) {
  const navigate = useNavigate();
  return (
    <>
      <ul className="divide-y rounded-lg border bg-card md:hidden">
        {items.map((item) => (
          <AssignmentCard key={item.id} item={item} now={now} />
        ))}
      </ul>
      <div className="hidden rounded-lg border bg-card md:block">
        <Table data-testid="my-assignments">
          <TableHeader>
            <TableRow>
              <TableHead>Назва</TableHead>
              <TableHead>Клас</TableHead>
              <TableHead>Вид</TableHead>
              <TableHead>Строк</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Оцінка</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={item.id}
                data-testid="assignment-row"
                data-assignment={item.id}
                className="cursor-pointer"
                onClick={() => void navigate(`/assignments/${item.id}`)}
              >
                <TableCell className="font-medium">
                  <Link to={`/assignments/${item.id}`} onClick={(event) => event.stopPropagation()} className="hover:underline">
                    {item.title}
                  </Link>
                </TableCell>
                <TableCell>{item.class_name}</TableCell>
                <TableCell>{KIND_TEXT[item.kind]}</TableCell>
                <TableCell className={cn("tabular-nums", isOverdue(item, now) && "text-status-stuck")}>
                  {item.due_at === null ? "Без строку" : formatDue(item.due_at, now)}
                </TableCell>
                <TableCell>
                  <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusLabel status={item.my_status ?? "idle"} kind={item.kind} />
                    {item.frozen && (
                      <span data-testid="frozen-mark" className="font-medium text-status-work">
                        Призупинено
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.my_grade === null ? "-" : `${item.my_grade} з ${item.max_grade}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/** A student without a class: the invitation code (or the whole link) leads to /join/:code. */
function JoinByCode() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = code.trim().split("/").filter(Boolean).at(-1);
    if (value) void navigate(`/join/${encodeURIComponent(value)}`);
  };
  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-5">
      <p className="text-sm text-muted-foreground">
        Ви ще не в жодному класі. Введіть код запрошення від викладача.
      </p>
      <Field label="Код запрошення" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" />
      <Button type="submit" disabled={code.trim() === ""} className="self-start">
        Приєднатися
      </Button>
    </form>
  );
}
