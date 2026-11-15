import { useId, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

/** A labelled input with its error under it; the error belongs to this field only. */
export function Field({
  label,
  error,
  hint,
  ...input
}: { label: string; error?: string | undefined; hint?: string } & Omit<ComponentProps<typeof Input>, "id">) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} {...input} />
      {error ? (
        <p id={errorId} className="text-[13px] text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
