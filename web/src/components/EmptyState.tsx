import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** An empty screen always says what to do next. */
export function EmptyState({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 px-6 py-12 text-center", className)}>
      <p className="font-medium">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
