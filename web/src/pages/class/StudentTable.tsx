import { Link, useNavigate } from "react-router";
import type { StudentProgress } from "@shared/api";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { screenOf, type TeacherRoomSnapshot } from "@/machine/teacher-room";
import { StudentStatus } from "./StatusBits";
import { agoText, sortStudents, studentHref, workMinutes } from "./student-view";

function Grade({ student, maxGrade, href }: { student: StudentProgress; maxGrade: number; href: string }) {
  const grade = student.latest_submission?.grade ?? null;
  if (grade !== null) {
    return (
      <span className="font-semibold tabular-nums">
        {grade}
        <span className="font-normal text-muted-foreground">/{maxGrade}</span>
      </span>
    );
  }
  if (student.status === "done") {
    return (
      <Button size="xs" variant="outline" asChild>
        <Link to={href} onClick={(event) => event.stopPropagation()}>
          Оцінити
        </Link>
      </Button>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

function Caption({ student, room, machine }: { student: StudentProgress; room: TeacherRoomSnapshot; machine: string }) {
  if (student.open_help) {
    return <div className="mt-0.5 truncate text-[13px] text-status-stuck">{student.open_help.text}</div>;
  }
  if (student.last_command) {
    const name = screenOf(room, student.user_id)?.machine || machine;
    return (
      <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
        {name}:~# {student.last_command}
      </div>
    );
  }
  const text = student.status === "idle" ? "Завдання ще не відкрито" : "Команд ще немає";
  return <div className="mt-0.5 text-[13px] text-muted-foreground">{text}</div>;
}

function Sub({ student, now }: { student: StudentProgress; now: number }) {
  if (student.open_help) return <>{agoText(student.open_help.created_at, now)}</>;
  if (student.latest_submission) return <>о {formatClock(student.latest_submission.created_at)}</>;
  return <> </>;
}

export function StudentTable({
  students,
  room,
  classId,
  assignmentId,
  machine,
  maxGrade,
  now,
}: {
  students: readonly StudentProgress[];
  room: TeacherRoomSnapshot;
  classId: number;
  assignmentId: number;
  machine: string;
  maxGrade: number;
  now: number;
}) {
  const navigate = useNavigate();
  return (
    <div data-testid="student-table" className="min-w-0 flex-1 rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Студент</TableHead>
            <TableHead className="w-36">Стан</TableHead>
            <TableHead className="w-20 text-right">Початок</TableHead>
            <TableHead className="w-20 text-right">Час, хв</TableHead>
            <TableHead className="w-20 text-right">Команд</TableHead>
            <TableHead className="w-20 text-right">Відкатів</TableHead>
            <TableHead className="w-24 text-right">Оцінка</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortStudents(students).map((student) => {
            const href = studentHref(classId, assignmentId, student);
            return (
              <TableRow
                key={student.user_id}
                data-testid="student-row"
                data-student={student.user_id}
                data-status={student.status}
                onClick={() => void navigate(href)}
                className={cn("cursor-pointer", student.status === "stuck" && "bg-status-stuck/5")}
              >
                <TableCell className="max-w-0 align-top">
                  <Link to={href} className="font-medium hover:underline">
                    {student.name}
                  </Link>
                  <Caption student={student} room={room} machine={machine} />
                </TableCell>
                <TableCell className="align-top">
                  <StudentStatus status={student.status} />
                  <div className="text-[13px] text-muted-foreground">
                    <Sub student={student} now={now} />
                  </div>
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {student.started_at === null ? "-" : formatClock(student.started_at)}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">{workMinutes(student) || "-"}</TableCell>
                <TableCell className="text-right align-top tabular-nums">{student.commands || "-"}</TableCell>
                <TableCell className="text-right align-top tabular-nums">{student.rollbacks || "-"}</TableCell>
                <TableCell className="text-right align-top">
                  <Grade student={student} maxGrade={maxGrade} href={href} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
