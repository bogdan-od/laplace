import { useMemo } from "react";
import { PendingButton } from "@/components/PendingButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { AttemptSession, AttemptView } from "@/machine/attempt-session";
import { BranchTree } from "@/machine/BranchTree";
import { branchHref, buildBranchTree } from "@/machine/branch-tree";
import { reportActionError } from "./action-error";

export interface HistoryDialogProps {
  session: AttemptSession;
  view: AttemptView;
}

/** "Історія": the attempt as a tree of branches; a click on a branch opens its playback. */
export function HistoryDialog({ session, view }: HistoryDialogProps) {
  const { attempt } = view;
  const groups = useMemo(() => {
    if (!attempt) return [];
    const headIds = new Set(Object.values(attempt.heads));
    const known = view.assignment?.topology.machines.map((machine) => machine.id) ?? [];
    const nodes = [...new Set([...known, ...attempt.branches.map((branch) => branch.node)])];
    return nodes.map((node) => ({
      node,
      tree: buildBranchTree(
        attempt.branches.filter((branch) => branch.node === node),
        { headIds, commandNumbers: view.commandNumbers },
      ),
    }));
  }, [attempt, view.assignment, view.commandNumbers]);
  const continued = new Set(
    (attempt?.branches ?? []).filter((branch) => branch.kind === "continue").map((branch) => branch.parent_id),
  );

  return (
    // Autosave moves event counts on the server without touching `view.attempt`: refresh on open.
    <Dialog onOpenChange={(open) => open && void session.refreshAttempt().catch(reportActionError)}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="history-open">
          Історія
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl" data-testid="history-dialog">
        <DialogTitle>Історія спроби</DialogTitle>
        <DialogDescription>Усі гілки вашої роботи{groups.length > 1 ? ", по машинах" : ""}. Відкат нічого не стирає: стара гілка лишається тут.</DialogDescription>
        <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto">
          {groups.length === 0 && <BranchTree nodes={[]} />}
          {groups.map(({ node, tree }) => (
            <section key={node} data-testid="history-machine" data-node={node}>
              {groups.length > 1 && <h3 className="mb-1 font-mono text-sm font-semibold">{node}</h3>}
              <BranchTree
                nodes={tree}
                hrefFor={(branch) => branchHref(branch.id)}
                action={({ branch }) =>
                  branch.kind === "reply" && !continued.has(branch.id) ? (
                    <PendingButton
                      size="xs"
                      variant="outline"
                      className="ml-auto"
                      pending={view.busy === "continue"}
                      disabled={view.busy !== null || view.frozen}
                      data-testid="tree-continue"
                      onClick={() => void session.continueFromReply(branch.node, branch.id).catch(reportActionError)}
                    >
                      Продовжити з відповіді
                    </PendingButton>
                  ) : null
                }
              />
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
