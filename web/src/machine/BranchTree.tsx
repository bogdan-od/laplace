import type { ReactNode } from "react";
import { CornerDownRight } from "lucide-react";
import { Link } from "react-router";
import type { Branch } from "@shared/api";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { flattenTree, type TreeNode } from "./branch-tree";

export interface BranchTreeProps {
  nodes: readonly TreeNode[];
  className?: string;
  /** Where a click on the branch label goes (the player); without it the label is plain text. */
  hrefFor?: (branch: Branch) => string;
  /** Something at the end of a row, for example "Продовжити з відповіді". */
  action?: (node: TreeNode) => ReactNode;
}

const INDENT_PX = 16;

/** The attempt as a tree of branches: one row per branch, indented by depth. */
export function BranchTree({ nodes, className, hrefFor, action }: BranchTreeProps) {
  const rows = flattenTree(nodes);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Гілок ще немає</p>;
  return (
    <ul data-testid="branch-tree" className={cn("flex flex-col text-sm", className)}>
      {rows.map((row) => {
        const { branch, label, head, depth } = row;
        const text = <span className={cn(head && "font-semibold")}>{label}</span>;
        return (
          <li
            key={branch.id}
            data-testid="branch"
            data-branch={branch.id}
            data-kind={branch.kind}
            data-head={head}
            style={{ paddingLeft: depth * INDENT_PX }}
            className="flex items-center gap-2 py-1"
          >
            {depth > 0 && <CornerDownRight aria-hidden className="-mr-1 size-3.5 text-muted-foreground" />}
            <span aria-hidden className={cn("size-2 rounded-full", head ? "bg-status-work" : "bg-status-idle")} />
            {hrefFor ? (
              <Link to={hrefFor(branch)} className="hover:underline">
                {text}
              </Link>
            ) : (
              text
            )}
            <span className="font-mono text-[12px] text-muted-foreground">{branch.node}</span>
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {plural(branch.event_count, "подія", "події", "подій")}
            </span>
            {head && (
              <span className="text-[12px] text-muted-foreground" title="З цієї гілки студент працює далі">
                поточна
              </span>
            )}
            {action?.(row)}
          </li>
        );
      })}
    </ul>
  );
}
