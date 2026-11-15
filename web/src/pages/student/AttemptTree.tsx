import { Link } from "react-router";
import { formatWhen, plural } from "@/lib/format";
import { BranchTree } from "@/machine/BranchTree";
import { branchHref } from "@/machine/branch-tree";
import { isSingleBranch, sharedStamp, type MachineTree } from "./attempt-view";

export interface AttemptTreeProps {
  trees: readonly MachineTree[];
}

/** The attempt as a tree of branches, read-only; a branch opens in the player. A machine without forks is one line. */
export function AttemptTree({ trees }: AttemptTreeProps) {
  const shared = sharedStamp(trees);
  return (
    <section data-testid="attempt-tree" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Дерево спроби</h2>
      {shared && (
        <p data-testid="tree-stamp" className="text-[12px] text-muted-foreground">
          {shared.author}, <span className="tabular-nums">{shared.when}</span>
        </p>
      )}
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        {trees.map(({ node, tree }) => {
          const single = isSingleBranch(tree) ? tree[0] : undefined;
          if (single) {
            const { branch } = single;
            return (
              <div key={node} data-node={node} data-testid="branch-flat" className="flex items-center gap-2 text-sm">
                <Link to={branchHref(branch.id)} className="font-mono hover:underline">
                  {node}
                </Link>
                <span className="text-muted-foreground tabular-nums">{plural(branch.event_count, "подія", "події", "подій")}</span>
                {!shared && (
                  <span className="ml-auto text-[12px] text-muted-foreground">
                    {branch.author.name}, <span className="tabular-nums">{formatWhen(branch.created_at)}</span>
                  </span>
                )}
              </div>
            );
          }
          return (
            <div key={node} data-node={node}>
              {trees.length > 1 && <h3 className="mb-1 font-mono text-sm font-semibold">{node}</h3>}
              <BranchTree
                nodes={tree}
                hrefFor={(branch) => branchHref(branch.id)}
                action={({ branch }) => (
                  <span className="ml-auto text-[12px] text-muted-foreground">
                    {branch.author.name}, <span className="tabular-nums">{formatWhen(branch.created_at)}</span>
                  </span>
                )}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
