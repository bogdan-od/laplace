import { useState } from "react";
import { ChartColumn, CircleCheckBig, Copy, GraduationCap, LayoutGrid, Pause, Play, Plus, QrCode, RefreshCw, Rows3 } from "lucide-react";
import { Link } from "react-router";
import type { AssignmentSummary, ClassDetail, StudentProgress } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { formatDue, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AssignmentPicker } from "./AssignmentPicker";
import type { ClassSection } from "./class-section";
import { copyInviteLink } from "./invite-link";
import { NewCodeDialog, QrDialog } from "./InviteDialogs";
import { SectionTabs } from "./SectionTabs";
import { StatusSummary } from "./StatusBits";

export type ClassView = "tiles" | "table" | "analytics";

function InviteBar({ klass }: { klass: ClassDetail }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const code = klass.invite_code;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
      <span data-testid="class-crumb">
        <Link to="/" className="hover:underline">
          Класи
        </Link>{" "}
        / <span className="text-foreground">{klass.name}</span>
        {klass.subject && <span className="ml-2">{klass.subject}</span>}
      </span>
      <span data-testid="class-students">{plural(klass.students, "студент", "студенти", "студентів")}</span>
      {code !== null && (
        <>
          <span className="inline-flex items-center gap-2">
            код запрошення
            <code data-testid="invite-code" className="rounded-md border bg-muted px-2 py-0.5 font-mono text-[13px] tracking-wider text-foreground">
              {code}
            </code>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void copyInviteLink(code)}
              data-testid="copy-invite"
              title="Скопіювати посилання-запрошення"
            >
              <Copy /> Скопіювати
            </Button>
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setQrOpen(true)} data-testid="show-qr">
              <QrCode /> QR-код
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRenewOpen(true)} data-testid="new-code">
              <RefreshCw /> Новий код
            </Button>
          </span>
          <QrDialog code={code} open={qrOpen} onOpenChange={setQrOpen} />
          <NewCodeDialog classId={klass.id} open={renewOpen} onOpenChange={setRenewOpen} />
        </>
      )}
    </div>
  );
}

function AssignmentBar({
  assignments,
  selected,
  now,
  onSelect,
  onAssign,
}: {
  assignments: readonly AssignmentSummary[];
  selected: AssignmentSummary | null;
  now: number;
  onSelect: (id: number) => void;
  onAssign: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {selected !== null && <AssignmentPicker assignments={assignments} selected={selected} now={now} onSelect={onSelect} />}
      <Button size="sm" variant="outline" onClick={onAssign} data-testid="assign" className="ml-auto shrink-0">
        <Plus /> Видати завдання
      </Button>
    </div>
  );
}

export interface AssignmentActions {
  frozen: boolean;
  canFreeze: boolean;
  onFreeze: () => void;
  onCheckAll: () => void;
  checking: boolean;
}

function AssignmentInfo({
  assignment,
  brief,
  online,
  total,
  actions,
}: {
  assignment: AssignmentSummary;
  brief: string | undefined;
  online: number;
  total: number;
  actions: AssignmentActions;
}) {
  return (
    <div className="flex items-start gap-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 data-testid="assignment-title" className="font-display text-[26px] leading-tight font-bold">
          {assignment.title}
        </h1>
        {brief && <p className="max-w-3xl text-muted-foreground">{brief}</p>}
        <p className="text-sm">
          <span data-testid="assignment-due">{assignment.due_at === null ? "Без терміну" : `Термін: ${formatDue(assignment.due_at)}`}</span>
          {online > 0 && (
            <>
              <span data-testid="room-online" className="ml-4 inline-flex items-center gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />У кімнаті {online} з {total}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
        <Button variant="outline" asChild>
          <Link to={`/assignments/${assignment.id}`} data-testid="try-as-student">
            <GraduationCap /> Спробувати як студент
          </Link>
        </Button>
        {assignment.kind === "task" && (
          <PendingButton variant="outline" pending={actions.checking} onClick={actions.onCheckAll} data-testid="check-all">
            <CircleCheckBig /> Перевірити всі здачі
          </PendingButton>
        )}
        <Button variant="outline" disabled={!actions.canFreeze} onClick={actions.onFreeze} data-testid="freeze" data-frozen={actions.frozen}>
          {actions.frozen ? <Play /> : <Pause />}
          {actions.frozen ? "Розморозити" : "Заморозити всіх"}
        </Button>
      </div>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ClassView; onChange: (view: ClassView) => void }) {
  const item = (value: ClassView, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      data-testid={`view-${value}`}
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1",
        view === value ? "bg-secondary font-medium" : "text-muted-foreground",
      )}
    >
      {icon} {label}
    </button>
  );
  return (
    <div className="flex rounded-md border p-0.5 text-sm">
      {item("tiles", "Термінали", <LayoutGrid className="size-3.5" />)}
      {item("table", "Таблиця", <Rows3 className="size-3.5" />)}
      {item("analytics", "Аналітика", <ChartColumn className="size-3.5" />)}
    </div>
  );
}

export function ClassHeader({
  klass,
  selected,
  now,
  brief,
  students,
  online,
  view,
  section,
  actions,
  onSection,
  onSelect,
  onAssign,
  onView,
}: {
  klass: ClassDetail;
  selected: AssignmentSummary | null;
  now: number;
  brief: string | undefined;
  students: readonly StudentProgress[];
  online: number;
  view: ClassView;
  section: ClassSection;
  actions: AssignmentActions;
  onSection: (section: ClassSection) => void;
  onSelect: (id: number) => void;
  onAssign: () => void;
  onView: (view: ClassView) => void;
}) {
  return (
    <div data-testid="class-header" className="flex flex-col gap-4 border-b bg-card px-6 pt-4 pb-4">
      <InviteBar klass={klass} />
      <SectionTabs section={section} onSelect={onSection} />
      {section === "assignments" && (
        <AssignmentBar assignments={klass.assignments} selected={selected} now={now} onSelect={onSelect} onAssign={onAssign} />
      )}
      {section === "assignments" && selected && (
        <>
          <AssignmentInfo assignment={selected} brief={brief} online={online} total={students.length} actions={actions} />
          <div className="flex items-end gap-6">
            <div className="flex-1">
              <StatusSummary students={students} />
            </div>
            <ViewToggle view={view} onChange={onView} />
          </div>
        </>
      )}
    </div>
  );
}
