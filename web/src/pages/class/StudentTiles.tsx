import { Link } from "react-router";
import type { StudentProgress } from "@shared/api";
import { cn } from "@/lib/utils";
import { screenOf, type TeacherRoomSnapshot } from "@/machine/teacher-room";
import { StudentStatus } from "./StatusBits";
import { commandsText, rollbacksText, sortStudents, studentHref, workMinutes } from "./student-view";

const TILE_LINES = 3;

function TerminalLines({ lines, empty }: { lines: readonly string[]; empty: string }) {
  const first = lines.findIndex((line) => line !== "");
  if (first === -1) {
    return (
      <div className="flex h-[58px] items-center justify-center border-y bg-muted text-[13px] text-muted-foreground">{empty}</div>
    );
  }
  return (
    <pre
      data-testid="tile-terminal"
      className="h-[58px] overflow-hidden border-y bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-[1.4] text-foreground"
    >
      {lines.slice(first).slice(-TILE_LINES).map((line, index) => (
        <div key={index} className="overflow-hidden text-ellipsis whitespace-pre">
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function tileLines(student: StudentProgress, room: TeacherRoomSnapshot, defaultMachine: string): { machine: string; lines: readonly string[] } {
  const screen = screenOf(room, student.user_id);
  if (screen && screen.lines.length > 0) return { machine: screen.machine || defaultMachine, lines: screen.lines };
  // Not in the room: the last command is all the server knows.
  const machine = screen?.machine || defaultMachine;
  return { machine, lines: student.last_command ? [`${machine}:~# ${student.last_command}`] : [] };
}

function TileFooter({ student, machine, maxGrade }: { student: StudentProgress; machine: string; maxGrade: number }) {
  if (student.open_help) return <span className="truncate text-status-stuck">{student.open_help.text}</span>;
  if (student.status === "idle") return <span> </span>;
  const grade = student.latest_submission?.grade ?? null;
  return (
    <>
      <span className="font-mono text-foreground">{machine}</span>
      <span>{commandsText(student.commands)}</span>
      {student.rollbacks > 0 && <span>{rollbacksText(student.rollbacks)}</span>}
      <span className="ml-auto tabular-nums">
        {grade === null ? (
          `${workMinutes(student)} хв`
        ) : (
          <span className="font-semibold text-foreground">
            {grade}/{maxGrade}
          </span>
        )}
      </span>
    </>
  );
}

function Tile({
  student,
  href,
  room,
  machine,
  maxGrade,
}: {
  student: StudentProgress;
  href: string;
  room: TeacherRoomSnapshot;
  machine: string;
  maxGrade: number;
}) {
  const shown = tileLines(student, room, machine);
  const online = room.online[student.user_id] !== undefined;
  return (
    <Link
      to={href}
      data-testid="student-tile"
      data-student={student.user_id}
      data-status={student.status}
      data-online={online}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border bg-card hover:border-ring",
        student.status === "stuck" && "border-status-stuck/50",
      )}
    >
      <div className="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1.5">
        <span className="truncate font-medium" title={student.name}>{student.name}</span>
        <span className="shrink-0 text-[13px]">
          <StudentStatus status={student.status} />
        </span>
      </div>
      {student.status === "idle" ? (
        <div className="flex h-[58px] items-center justify-center border-y bg-muted text-[13px] text-muted-foreground">
          Завдання ще не відкрито
        </div>
      ) : (
        <TerminalLines lines={shown.lines} empty={online ? "Виводу ще немає" : "Студента немає в кімнаті"} />
      )}
      <div className="flex h-8 items-center gap-3 px-3 text-[13px] text-muted-foreground">
        <TileFooter student={student} machine={shown.machine} maxGrade={maxGrade} />
      </div>
    </Link>
  );
}

export function StudentTiles({
  students,
  room,
  classId,
  assignmentId,
  machine,
  maxGrade,
}: {
  students: readonly StudentProgress[];
  room: TeacherRoomSnapshot;
  classId: number;
  assignmentId: number;
  /** The machine to name on a tile when the student's own console did not say which one it is. */
  machine: string;
  maxGrade: number;
}) {
  return (
    <div
      data-testid="student-tiles"
      className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 px-6 py-4"
    >
      {sortStudents(students).map((student) => (
        <Tile
          key={student.user_id}
          student={student}
          href={studentHref(classId, assignmentId, student)}
          room={room}
          machine={machine}
          maxGrade={maxGrade}
        />
      ))}
    </div>
  );
}
