import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

/** While the request runs the label is "…" and a second click is impossible. */
export function PendingButton({
  pending,
  children,
  disabled,
  ...props
}: { pending: boolean } & ComponentProps<typeof Button>) {
  return (
    <Button disabled={pending || disabled} aria-busy={pending} {...props}>
      {pending ? "…" : children}
    </Button>
  );
}
