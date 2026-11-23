import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useBlocker, useNavigate } from "react-router";
import { toast } from "sonner";
import type { Assignment, LibraryItem, Topology } from "@shared/api";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { apiQuery, invalidateRoute, queryClient } from "@/lib/query";
import { deleteWithUndo } from "@/lib/undo";
import { MAX_BRIEF_CHARS } from "@shared/limits";
import { AssignItemDialog } from "./AssignItemDialog";
import { ChecksEditor } from "./ChecksEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { CONTROL_CLASS } from "./controls";
import { HintsEditor } from "./HintsEditor";
import { formOf, formProblem, isDirty, patchBody, type ItemForm } from "./item-form";
import { ItemHeader } from "./ItemHeader";
import { LessonBlock } from "./LessonBlock";
import { MachinesBlock } from "./MachinesBlock";
import { PublishDialog } from "./PublishDialog";
import { TopologyBlock } from "./TopologyBlock";
import { lostJournalNodes, parseTopologyText } from "./topology-text";

function Block({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** The page of one item; the form lives here and is saved with one button. */
export function ItemScreen({ item }: { item: LibraryItem }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<ItemForm>(() => formOf(item));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [assigned, setAssigned] = useState<Assignment | null>(null);
  const [losing, setLosing] = useState<string[] | null>(null);

  const edited = item.kind !== "clip";
  const dirty = edited && isDirty(form, item);
  const problem = formProblem(form, item);
  const draft = useMemo(() => parseTopologyText(form.topology), [form.topology]);
  // The scheme and the checks follow the last text without errors.
  const [shown, setShown] = useState<Topology>(item.topology);
  if (draft.topology !== null && draft.topology !== shown) setShown(draft.topology);
  const blocker = useBlocker(dirty && !leaving);

  useEffect(() => {
    if (leaving) void navigate("/library");
  }, [leaving, navigate]);

  const store = (next: LibraryItem) => {
    queryClient.setQueryData(apiQuery("GET /api/library/:id", { params: { id: item.id } }).queryKey, next);
    void invalidateRoute("GET /api/library");
  };

  /** The server deletes the journals of machines that left the topology: ask before that. */
  const requestSave = () => {
    const topology = patchBody(form, item).topology;
    const lost = topology ? lostJournalNodes(item.journals, topology) : [];
    if (lost.length > 0) setLosing(lost);
    else void save();
  };

  const save = async () => {
    setLosing(null);
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api("PATCH /api/library/:id", { params: { id: item.id }, body: patchBody(form, item) });
      store(updated);
      setForm(formOf(updated));
      toast.success("Збережено");
    } catch (error) {
      setSaveError(describeError(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(false);
    const removed = await deleteWithUndo({
      message: "Предмет видалено",
      remove: () => api("DELETE /api/library/:id", { params: { id: item.id } }),
      restore: () => api("POST /api/library/:id/restore", { params: { id: item.id } }),
      refresh: () => void invalidateRoute("GET /api/library"),
      restoredMessage: "Предмет відновлено",
    });
    if (removed) setLeaving(true);
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 sm:px-6 py-6" data-testid="item-page" data-item={item.id} data-kind={item.kind}>
      <ItemHeader item={item} onItem={store} onAssign={() => setAssigning(true)} onPublish={() => setPublishing(true)} onDelete={() => setDeleting(true)} />

      {assigned !== null && (
        <div role="status" data-testid="assigned-notice" className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 text-sm">
          <span>Завдання видано</span>
          <Link to={`/classes/${assigned.class_id}?a=${assigned.id}`} data-testid="assigned-link" className="text-primary hover:underline">
            Відкрити в класі {assigned.class_name}
          </Link>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setAssigned(null)}>
            Закрити
          </Button>
        </div>
      )}

      {item.kind !== "clip" && (
        <Block title="Умова" testId="brief-block">
          <textarea
            className={`${CONTROL_CLASS} min-h-32`}
            aria-label="Умова"
            data-testid="brief"
            maxLength={MAX_BRIEF_CHARS}
            value={form.brief}
            onChange={(event) => setForm({ ...form, brief: event.target.value })}
          />
        </Block>
      )}

      <Block title="Топологія" testId="topology-card">
        <TopologyBlock
          topology={shown}
          text={form.topology}
          problems={draft.problems}
          editable={item.kind === "task"}
          onChange={(topology) => setForm({ ...form, topology })}
        />
      </Block>

      <Block title="Машини" testId="machines-card">
        <MachinesBlock item={item} dirty={dirty} onItem={store} />
      </Block>

      {item.kind === "task" && (
        <>
          <Block title="Підказки" testId="hints-block">
            <HintsEditor rows={form.hints} onChange={(hints) => setForm({ ...form, hints })} />
          </Block>
          <Block title="Команди перевірки" testId="checks-block">
            <ChecksEditor machines={shown.machines} rows={form.checks} onChange={(checks) => setForm({ ...form, checks })} />
          </Block>
        </>
      )}

      {item.kind === "lesson" && (
        <Block title="Урок" testId="lesson-card">
          <LessonBlock item={item} />
        </Block>
      )}

      {edited && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3" data-testid="save-bar">
          <PendingButton pending={saving} disabled={!dirty || problem !== null} onClick={requestSave} data-testid="save">
            Зберегти
          </PendingButton>
          {dirty && (
            <span className="text-sm text-muted-foreground" data-testid="unsaved">
              Є незбережені зміни
            </span>
          )}
          {(problem ?? saveError) && (
            <span className="text-[13px] text-destructive" data-testid="save-problem">
              {problem ?? saveError}
            </span>
          )}
        </div>
      )}

      {item.kind === "task" && (
        <AssignItemDialog
          item={item}
          open={assigning}
          onOpenChange={setAssigning}
          onAssigned={(assignment) => {
            setAssigning(false);
            setAssigned(assignment);
          }}
        />
      )}
      {item.kind !== "task" && <PublishDialog item={item} open={publishing} onOpenChange={setPublishing} onItem={store} />}
      <ConfirmDialog
        open={deleting}
        title="Видалити предмет?"
        text={`"${item.title}" зникне з бібліотеки. Видані завдання залишаться в класах.`}
        confirm="Видалити"
        cancel="Скасувати"
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(false)}
        testId="delete-dialog"
      />
      <ConfirmDialog
        open={losing !== null}
        title="Видалити журнали?"
        text={`Журнали машин ${(losing ?? []).join(", ")} буде видалено`}
        confirm="Зберегти"
        cancel="Скасувати"
        onConfirm={() => void save()}
        onCancel={() => setLosing(null)}
        testId="journals-lost-dialog"
      />
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Є незбережені зміни"
        text="Якщо піти зараз, зміни в умові, топології, підказках і перевірках буде втрачено."
        confirm="Піти без збереження"
        cancel="Залишитися"
        onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
        onCancel={() => blocker.state === "blocked" && blocker.reset()}
        testId="leave-dialog"
      />
    </div>
  );
}
