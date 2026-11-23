import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import type { Assignment, StudentProgress } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { ApiFailure, describeError } from "@/lib/api";
import { apiQuery, invalidateRoute, queryKey } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { TeacherRoomView } from "@/machine/use-teacher-room";
import { useTeacherRoom } from "@/machine/use-teacher-room";
import { MachineTiles } from "@/pages/work/MachineTiles";
import { TopologyDiagram } from "@/pages/work/TopologyDiagram";
import { AttemptTree } from "./AttemptTree";
import { attemptTrees } from "./attempt-view";
import { HelpList } from "./HelpList";
import { StudentHeader } from "./StudentHeader";
import { StudentTerminals } from "./StudentTerminals";
import { SubmissionList } from "./SubmissionList";
import { SubmissionPanel } from "./SubmissionPanel";
import { terminalColumn } from "./terminal-column";
import { useCommandNumbers } from "./use-command-numbers";

const ATTEMPT_POLL_MS = 15_000;

function Unavailable({ title, hint, classId }: { title: string; hint: string; classId?: number }) {
  return (
    <EmptyState
      title={title}
      hint={hint}
      action={
        <Button asChild variant="outline">
          <Link to={classId === undefined ? "/" : `/classes/${classId}`}>{classId === undefined ? "На головну" : "До класу"}</Link>
        </Button>
      }
    />
  );
}

function Loading() {
  return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
}

/** The teacher's page of one student in one assignment: header, live terminals, scheme, attempt, help, submissions. */
export function StudentPage() {
  const params = useParams();
  const classId = Number(params["cid"]);
  const assignmentId = Number(params["aid"]);
  const userId = Number(params["uid"]);
  const valid = [classId, assignmentId, userId].every(Number.isInteger);
  const assignment = useQuery({ ...apiQuery("GET /api/assignments/:id", { params: { id: assignmentId } }), enabled: valid });
  const roster = useQuery({ ...apiQuery("GET /api/assignments/:id/students", { params: { id: assignmentId } }), enabled: valid });
  const room = useTeacherRoom(valid ? assignmentId : null);

  if (!valid) return <Unavailable title="Студента не знайдено" hint="Адреса неправильна." />;
  if (assignment.isPending) return <Loading />;
  if (assignment.error) {
    const missing = assignment.error instanceof ApiFailure && (assignment.error.status === 404 || assignment.error.status === 403);
    return missing ? (
      <Unavailable title="Завдання не знайдено" hint="Його вилучено або у вас немає до нього доступу." />
    ) : (
      <EmptyState title={describeError(assignment.error)} action={<Button onClick={() => void assignment.refetch()}>Спробувати знову</Button>} />
    );
  }
  if (assignment.data.class_id !== classId) {
    return <Unavailable title="Завдання не знайдено" hint="Воно належить іншому класу." classId={classId} />;
  }
  const students: readonly StudentProgress[] = room.state.loaded ? room.state.students : (roster.data ?? []);
  const student = students.find((item) => item.user_id === userId);
  if (!student) {
    if (roster.isPending && !room.state.loaded) return <Loading />;
    return <Unavailable title="Студента не знайдено" hint="Його немає в цьому класі." classId={classId} />;
  }
  return <StudentScreen classId={classId} assignment={assignment.data} student={student} room={room} />;
}

interface StudentScreenProps {
  classId: number;
  assignment: Assignment;
  student: StudentProgress;
  room: TeacherRoomView;
}

function StudentScreen({ classId, assignment, student, room }: StudentScreenProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const [chosen, setChosen] = useState<string | null>(null);
  const attemptId = student.attempt_id;
  const attempt = useQuery({
    ...apiQuery("GET /api/attempts/:id", { params: { id: attemptId ?? 0 } }),
    enabled: attemptId !== null,
    refetchInterval: ATTEMPT_POLL_MS,
  });

  // The room's `tile` says the student did something: reload the attempt (new branch, help request, submission).
  const activity = [student.status, student.commands, student.rollbacks, student.open_help?.id ?? 0, student.latest_submission?.id ?? 0].join("/");
  useEffect(() => {
    if (attemptId === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKey("GET /api/attempts/:id", { params: { id: attemptId } }) });
  }, [queryClient, attemptId, activity]);

  const refresh = async () => {
    await Promise.all([
      attemptId === null ? undefined : queryClient.invalidateQueries({ queryKey: queryKey("GET /api/attempts/:id", { params: { id: attemptId } }) }),
      invalidateRoute("GET /api/assignments/:id/students"),
      invalidateRoute("GET /api/classes/:id"),
      invalidateRoute("GET /api/classes"),
      invalidateRoute("GET /api/review"),
      invalidateRoute("GET /api/submissions/:id"),
    ]);
  };

  const machines = assignment.topology.machines;
  const machine = chosen ?? machines[0]?.id ?? "";
  const several = machines.length > 1;
  const present = room.state.online[student.user_id] !== undefined;
  const column = terminalColumn(room.state.joined, present);
  const commandNumbers = useCommandNumbers(assignment, attempt.data);
  const trees = useMemo(
    () => (attempt.data ? attemptTrees(attempt.data, machines.map((item) => item.id), commandNumbers) : []),
    [attempt.data, machines, commandNumbers],
  );
  const views = useMemo(() => new Map(machines.map((item) => [item.id, { state: "live" as const, percent: 100 }])), [machines]);
  const submissionParam = Number(search.get("submission"));
  const submission = Number.isInteger(submissionParam) && submissionParam > 0 ? submissionParam : null;
  const closePanel = () =>
    setSearch((current) => {
      const next = new URLSearchParams(current);
      next.delete("submission");
      return next;
    });

  return (
    <div data-testid="student-page" data-student={student.user_id} className="flex flex-col gap-4 px-4 sm:px-6 py-5">
      <StudentHeader classId={classId} assignmentId={assignment.id} assignmentTitle={assignment.title} student={student} />
      {attemptId === null ? (
        <div data-testid="not-started" className="max-w-xl rounded-lg border bg-card p-5">
          <p className="text-base">Завдання ще не відкрито.</p>
          <p className="text-muted-foreground">Тут з'являться термінал і хід спроби, коли студент почне роботу.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          {column !== "none" && (
            <div className="flex w-[48rem] max-w-full flex-col gap-2">
              {several && (
                <p className="text-sm text-muted-foreground">
                  Машина <span className="font-mono font-semibold text-foreground">{machine}</span>
                </p>
              )}
              {column === "connecting" || !room.room ? (
                <p className="text-sm text-muted-foreground">Підключення до кімнати…</p>
              ) : (
                <StudentTerminals room={room.room} userId={student.user_id} machine={machine} />
              )}
            </div>
          )}
          <aside data-testid="student-aside" className={cn("flex min-w-80 flex-1 flex-col gap-4", column === "none" && "max-w-5xl")}>
            {column === "none" && (
              <p data-testid="offline" className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="size-2 rounded-full bg-muted-foreground/40" />
                Студента зараз немає в мережі
              </p>
            )}
            {several && (
              <>
                <TopologyDiagram topology={assignment.topology} views={views} selected={machine} offline={!present} onSelect={setChosen} />
                <MachineTiles machines={machines} views={views} selected={machine} offline={!present} onSelect={setChosen} />
              </>
            )}
            <HelpList help={attempt.data?.help ?? []} onResolved={refresh} />
            {attempt.data && <AttemptTree trees={trees} />}
            <SubmissionList submissions={attempt.data?.submissions ?? []} maxGrade={assignment.max_grade} selected={submission} />
            {submission !== null && (
              <SubmissionPanel
                key={submission}
                submissionId={submission}
                attemptId={attemptId}
                assignment={assignment}
                refresh={refresh}
                onClose={closePanel}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
