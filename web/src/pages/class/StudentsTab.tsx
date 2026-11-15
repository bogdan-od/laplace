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
        {canRemove && (
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
        )}
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

/** Buttons follow the server's table of rights: assistants can import and remove students, only the owner manages assistants. */
export function StudentsTab({ klass, now }: { klass: ClassDetail; now: number }) {
  const [importing, setImporting] = useState(false);
  const [addingAssistant, setAddingAssistant] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const isOwner = klass.my_role === "owner";
  const { students, assistants } = groupMembers(klass.members);

  return (
    <div className="flex flex-col gap-4 px-6 py-5" data-testid="students-tab">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-lg font-bold">Студенти й асистенти</h2>
        <span className="ml-auto flex gap-2">
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
        <div className="rounded-lg border bg-card">
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
              <MemberRows members={assistants} now={now} canRemove={isOwner} onRemove={setRemoving} />
              {assistants.length > 0 && <GroupHeading title="Студенти" count={students.length} />}
              <MemberRows members={students} now={now} canRemove onRemove={setRemoving} />
            </TableBody>
          </Table>
        </div>
      )}
      <ImportDialog classId={klass.id} open={importing} onOpenChange={setImporting} />
      <AssistantDialog classId={klass.id} open={addingAssistant} onOpenChange={setAddingAssistant} />
      <RemoveMemberDialog classId={klass.id} member={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}
