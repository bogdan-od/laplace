import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { AssignmentSummary, ClassDetail, StudentProgress } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { api, ApiFailure, describeError } from "@/lib/api";
import { apiQuery } from "@/lib/query";
import type { TeacherRoomSnapshot } from "@/machine/teacher-room";
import { useTeacherRoom } from "@/machine/use-teacher-room";
import { AssignDialog } from "./AssignDialog";
import { chosenAssignment } from "./assignment-choice";
import { ActivityTab } from "./ActivityTab";
import { AnalyticsView } from "./AnalyticsView";
import { ClassAside } from "./ClassAside";
import { ClassHeader, type ClassView } from "./ClassHeader";
import { sectionOf, withSection, type ClassSection } from "./class-section";
import { GradesTab } from "./GradesTab";
import { StudentsTab } from "./StudentsTab";
import { StudentTable } from "./StudentTable";
import { StudentTiles } from "./StudentTiles";

const CLOCK_TICK_MS = 30_000;
const FALLBACK_MAX_GRADE = 100;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Unavailable({ title, hint }: { title: string; hint: string }) {
  return (
    <EmptyState
      title={title}
      hint={hint}
      action={
        <Button asChild variant="outline">
          <Link to="/">На головну</Link>
        </Button>
      }
    />
  );
}

export function ClassPage() {
  const params = useParams();
  const classId = Number(params["id"]);
  const klass = useQuery({ ...apiQuery("GET /api/classes/:id", { params: { id: classId } }), enabled: Number.isInteger(classId) });
  if (!Number.isInteger(classId)) return <Unavailable title="Клас не знайдено" hint="Адреса неправильна." />;
  if (klass.isPending) return <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>;
  if (klass.error) {
    const missing = klass.error instanceof ApiFailure && (klass.error.status === 404 || klass.error.status === 403);
    return missing ? (
      <Unavailable title="Клас не знайдено" hint="Його вилучено або у вас немає до нього доступу." />
    ) : (
      <EmptyState
        title={describeError(klass.error)}
        action={<Button onClick={() => void klass.refetch()}>Спробувати знову</Button>}
      />
    );
  }
  if (klass.data.my_role === "student") {
    return <Unavailable title="Ця сторінка доступна лише викладачам" hint="Ваші завдання на головній сторінці." />;
  }
  return <ClassScreen classId={classId} klass={klass.data} />;
}

function viewOf(param: string | null): ClassView {
  return param === "table" || param === "analytics" ? param : "tiles";
}

function ClassScreen({ classId, klass }: { classId: number; klass: ClassDetail }) {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const now = useNow();
  const [assigning, setAssigning] = useState(false);
  const [checking, setChecking] = useState(false);

  const selected = useMemo(
    () => chosenAssignment(klass.assignments, search.get("a"), now),
    [klass.assignments, search, now],
  );
  const selectedId = selected?.id ?? null;
  const section = sectionOf(search.get("tab"));
  const view = viewOf(search.get("view"));

  const setSection = (next: ClassSection) => setSearch(withSection(search, next), { replace: true });

  const setParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    setSearch(next, { replace: true });
  };

  // The address always names the assignment on screen, so a copied link opens the same tab.
  useEffect(() => {
    if (selectedId !== null && search.get("a") !== String(selectedId)) {
      const next = new URLSearchParams(search);
      next.set("a", String(selectedId));
      setSearch(next, { replace: true });
    }
  }, [selectedId, search, setSearch]);

  const detail = useQuery({
    ...apiQuery("GET /api/assignments/:id", { params: { id: selectedId ?? 0 } }),
    enabled: selectedId !== null && section === "assignments",
  });
  // The terminals are only needed while the assignments are on screen.
  const room = useTeacherRoom(section === "assignments" ? selectedId : null);
  const { state } = room;

  const checkAll = async () => {
    if (selectedId === null) return;
    setChecking(true);
    try {
      const { queued } = await api("POST /api/assignments/:id/check-all", { params: { id: selectedId } });
      toast.success(`У черзі: ${queued}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setChecking(false);
    }
  };

  const freeze = () => {
    if (!room.freeze(!state.frozen)) toast.error("Немає зв'язку з кімнатою. Спробуйте за мить.");
  };

  const machine = detail.data?.topology.machines[0]?.id ?? "";
  const maxGrade = selected?.max_grade ?? FALLBACK_MAX_GRADE;
  const online = Object.keys(state.online).length;

  const assignDialog = (
    <AssignDialog
      classId={classId}
      open={assigning}
      onOpenChange={setAssigning}
      onAssigned={(assignment) => {
        setAssigning(false);
        const next = new URLSearchParams(search);
        next.set("a", String(assignment.id));
        void navigate({ search: `?${next}` }, { replace: true });
      }}
    />
  );

  return (
    <div data-testid="class-page" data-assignment={selectedId ?? ""}>
      <ClassHeader
        klass={klass}
        selected={selected}
        now={now}
        brief={detail.data?.brief}
        students={state.students}
        online={online}
        view={view}
        section={section}
        onSection={setSection}
        actions={{ frozen: state.frozen, canFreeze: state.joined, onFreeze: freeze, onCheckAll: () => void checkAll(), checking }}
        onSelect={(id) => setParams({ a: String(id) })}
        onAssign={() => setAssigning(true)}
        onView={(next) => setParams({ view: next })}
      />
      {section === "students" && <StudentsTab klass={klass} now={now} />}
      {section === "activity" && <ActivityTab klass={klass} now={now} />}
      {section === "grades" && <GradesTab classId={classId} assignments={klass.assignments} />}
      {section === "assignments" &&
        (selected === null || selectedId === null ? (
          <EmptyState
            title="У цьому класі ще немає завдань"
            hint="Видайте перше завдання з бібліотеки, і тут з'являться студенти."
            action={<Button onClick={() => setAssigning(true)}>Видати завдання</Button>}
          />
        ) : (
          <StudentsBody
            classId={classId}
            assignmentId={selectedId}
            view={view}
            room={state}
            others={klass.assignments.filter((assignment) => assignment.id !== selectedId)}
            machine={machine}
            maxGrade={maxGrade}
            now={now}
            onPick={(id) => setParams({ a: String(id) })}
            error={state.loadError}
          />
        ))}
      {assignDialog}
    </div>
  );
}

function StudentsBody({
  classId,
  assignmentId,
  view,
  room,
  others,
  machine,
  maxGrade,
  now,
  onPick,
  error,
}: {
  classId: number;
  assignmentId: number;
  view: ClassView;
  room: TeacherRoomSnapshot;
  others: AssignmentSummary[];
  machine: string;
  maxGrade: number;
  now: number;
  onPick: (assignmentId: number) => void;
  error: unknown;
}) {
  const students: readonly StudentProgress[] = room.students;
  if (view === "analytics") {
    const idleIds = room.loaded ? new Set(students.filter((s) => s.status === "idle").map((s) => s.user_id)) : undefined;
    return <AnalyticsView classId={classId} assignmentId={assignmentId} maxGrade={maxGrade} idleIds={idleIds} />;
  }
  if (!room.loaded) {
    return error ? (
      <EmptyState title={describeError(error)} hint="Оновіть сторінку або спробуйте за мить." />
    ) : (
      <p className="p-6 text-sm text-muted-foreground">Завантаження…</p>
    );
  }
  if (students.length === 0) {
    return (
      <EmptyState
        title="У класі ще немає студентів"
        hint={"Надішліть студентам посилання-запрошення: кнопка \"Скопіювати\" біля коду вгорі."}
      />
    );
  }
  if (view === "tiles") {
    return <StudentTiles students={students} room={room} classId={classId} assignmentId={assignmentId} machine={machine} maxGrade={maxGrade} />;
  }
  return (
    <div className="flex flex-col gap-6 px-4 py-5 sm:px-6 lg:flex-row">
      <StudentTable students={students} room={room} classId={classId} assignmentId={assignmentId} machine={machine} maxGrade={maxGrade} now={now} />
      <ClassAside students={students} others={others} classId={classId} assignmentId={assignmentId} now={now} onPick={onPick} />
    </div>
  );
}
