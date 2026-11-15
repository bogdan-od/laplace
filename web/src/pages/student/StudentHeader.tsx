import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import type { StudentProgress } from "@shared/api";
import { Button } from "@/components/ui/button";
import { StudentStatus } from "@/pages/class/StatusBits";

export interface StudentHeaderProps {
  classId: number;
  assignmentId: number;
  assignmentTitle: string;
  student: StudentProgress;
}

export function StudentHeader({ classId, assignmentId, assignmentTitle, student }: StudentHeaderProps) {
  return (
    <header data-testid="student-header" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button asChild variant="outline" size="sm">
        <Link to={`/classes/${classId}?a=${assignmentId}`} data-testid="back-to-class">
          <ArrowLeft /> Клас
        </Link>
      </Button>
      <div className="flex flex-col">
        <h1 data-testid="student-name" className="font-display text-[26px] leading-tight font-bold">
          {student.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          <span data-testid="student-number">№ {student.number}</span>
          <span data-testid="student-assignment" className="ml-2">{assignmentTitle}</span>
        </p>
      </div>
      <div className="ml-auto text-sm" data-testid="student-status">
        <StudentStatus status={student.status} />
      </div>
    </header>
  );
}
