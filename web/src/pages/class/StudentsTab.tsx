import { useState } from "react";
import { FileUp, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import type { ClassDetail, Member } from "@shared/api";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { AssistantDialog } from "./AssistantDialog";
import { ImportDialog } from "./ImportDialog";
import { groupMembers, lastSeenText } from "./member-view";
import { RemoveMemberDialog } from "./RemoveMemberDialog";

const ROLE_TEXT: Record<Member["role"], string> = { student: "Студент", assistant: "Асистент" };

function MemberMenu({ member, onRemove }: { member: Member; onRemove: (member: Member) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label="Дії" data-testid="member-menu">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={() => onRemove(member)} data-testid="member-remove">
          <Trash2 /> Видалити
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row of the table on a narrow screen: the same fields, one card per member. */
function MemberCards({
  title,
  members,
  now,
  canRemove,
  onRemove,
}: {
  title?: string;
  members: readonly Member[];
  now: number;
  canRemove: boolean;
  onRemove: (member: Member) => void;
}) {
  return (
    <>
      {title && (
        <li className="bg-muted/40 px-3 py-2 text-[13px] font-semibold text-muted-foreground">
          {title}
          <span className="ml-2 font-normal">{members.length}</span>
        </li>
      )}
      {members.map((member) => (
        <li key={member.user_id} data-testid="member-card" data-member={member.user_id} className="flex items-start gap-2 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">
              <span className="mr-1.5 text-muted-foreground tabular-nums">{member.number ?? "-"}</span>
              {member.name}
            </span>
            <span className="font-mono text-[13px]">{member.login}</span>
            <span className="text-[13px] text-muted-foreground">
              {ROLE_TEXT[member.role]} · останній вхід {lastSeenText(member.last_seen_at, now)} · у класі з {formatDate(member.joined_at, now)}
            </span>
          </div>
          {canRemove && <MemberMenu member={member} onRemove={onRemove} />}
        </li>
      ))}
    </>
  );
}

function MemberRows({
  members,
  now,
  canRemove,
  onRemove,
}: {
  members: readonly Member[];
  now: number;
  canRemove: boolean;
  onRemove: (member: Member) => void;
}) {
  return members.map((member) => (
    <TableRow key={member.user_id} data-testid="member-row" data-member={member.user_id} data-role={member.role}>
      <TableCell className="text-right tabular-nums text-muted-foreground">{member.number ?? "-"}</TableCell>
      <TableCell className="font-medium">{member.name}</TableCell>
      <TableCell className="font-mono text-[13px]">{member.login}</TableCell>
      <TableCell>{ROLE_TEXT[member.role]}</TableCell>
      <TableCell className="text-muted-foreground">{lastSeenText(member.last_seen_at, now)}</TableCell>
      <TableCell className="text-muted-foreground">{formatDate(member.joined_at, now)}</TableCell>
      <TableCell className="text-right">
        {canRemove && <MemberMenu member={member} onRemove={onRemove} />}
      </TableCell>
    </TableRow>
  ));
}

function GroupHeading({ title, count }: { title: string; count: number }) {
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={7} className="text-[13px] font-semibold text-muted-foreground">
        {title}
        <span className="ml-2 font-normal">{count}</span>
      </TableCell>
    </TableRow>
  );
}

/** A table on a wide screen, cards on a narrow one. */
function MemberList({
  assistants,
  students,
  now,
  isOwner,
  onRemove,
}: {
  assistants: readonly Member[];
  students: readonly Member[];
  now: number;
  isOwner: boolean;
  onRemove: (member: Member) => void;
}) {
  return (
    <>
      <div className="hidden rounded-lg border bg-card md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-14 text-right">№</TableHead>
              <TableHead>ПІБ</TableHead>
              <TableHead>Логін</TableHead>
              <TableHead className="w-28">Роль</TableHead>
              <TableHead className="w-40">Останній вхід</TableHead>
              <TableHead className="w-36">У класі з</TableHead>
              <TableHead className="w-14" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assistants.length > 0 && <GroupHeading title="Асистенти" count={assistants.length} />}
            <MemberRows members={assistants} now={now} canRemove={isOwner} onRemove={onRemove} />
            {assistants.length > 0 && <GroupHeading title="Студенти" count={students.length} />}
            <MemberRows members={students} now={now} canRemove onRemove={onRemove} />
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y rounded-lg border bg-card md:hidden">
        {assistants.length > 0 && <MemberCards title="Асистенти" members={assistants} now={now} canRemove={isOwner} onRemove={onRemove} />}
        <MemberCards {...(assistants.length > 0 ? { title: "Студенти" } : {})} members={students} now={now} canRemove onRemove={onRemove} />
      </ul>
    </>
  );
}

/** Buttons follow the server's table of rights: assistants can import and remove students, only the owner manages assistants. */
export function StudentsTab({ klass, now }: { klass: ClassDetail; now: number }) {
  const [importing, setImporting] = useState(false);
  const [addingAssistant, setAddingAssistant] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const isOwner = klass.my_role === "owner";
  const { students, assistants } = groupMembers(klass.members);

  return (
    <div className="flex flex-col gap-4 px-4 sm:px-6 py-5" data-testid="students-tab">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-bold">Студенти й асистенти</h2>
        <span className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setImporting(true)} data-testid="import-open">
            <FileUp /> Імпорт з CSV
          </Button>
          {isOwner && (
            <Button variant="outline" onClick={() => setAddingAssistant(true)} data-testid="assistant-open">
              <UserPlus /> Додати асистента
            </Button>
          )}
        </span>
      </div>
      {klass.members.length === 0 ? (
        <EmptyState
          title="У класі ще немає студентів"
          hint="Імпортуйте список із CSV або надішліть студентам посилання-запрошення."
        />
      ) : (
        <MemberList assistants={assistants} students={students} now={now} isOwner={isOwner} onRemove={setRemoving} />
      )}
      <ImportDialog classId={klass.id} open={importing} onOpenChange={setImporting} />
      <AssistantDialog classId={klass.id} open={addingAssistant} onOpenChange={setAddingAssistant} />
      <RemoveMemberDialog classId={klass.id} member={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
