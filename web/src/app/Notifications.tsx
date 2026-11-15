import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, describeError } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { apiQuery, invalidateRoute } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { Role } from "@shared/api";
import { activityHref, activityText } from "@/lib/activity";

const POLL_MS = 30_000;
const BADGE_CAP = 99;

export function NotificationsBell({ role }: { role: Role }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Items newer than this id were unread when the list was opened; they stay highlighted while it is open.
  const [readUpTo, setReadUpTo] = useState<number | null>(null);
  const list = useQuery({ ...apiQuery("GET /api/notifications"), refetchInterval: POLL_MS });
  const unread = list.data?.unread ?? 0;
  const items = list.data?.items ?? [];

  const toggle = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setReadUpTo(null);
      return;
    }
    const newest = items[0];
    if (unread === 0 || !newest) return;
    // Items are ordered newest first; the first `unread` of them are the unread ones.
    const firstRead = items[unread];
    setReadUpTo(firstRead ? firstRead.id : 0);
    api("POST /api/notifications/read", { body: { up_to: newest.id } })
      .then(() => invalidateRoute("GET /api/notifications"))
      .catch(() => {
        // Marking is retried the next time the list is opened.
      });
  };

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Сповіщення"
          className="relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[11px] leading-4 text-primary-foreground tabular-nums">
              {unread > BADGE_CAP ? `${BADGE_CAP}+` : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <p className="border-b px-4 py-2.5 font-semibold">Сповіщення</p>
        <div className="max-h-96 overflow-y-auto">
          {list.error ? (
            <p className="px-4 py-6 text-center text-sm text-destructive">{describeError(list.error)}</p>
          ) : items.length === 0 ? (
            <EmptyState
              className="py-8"
              title="Сповіщень поки немає"
              hint={"Тут з'являться здачі, запити \"не працює\", оцінки й коментарі."}
            />
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  void navigate(activityHref(item, role));
                }}
                className={cn(
                  "flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-muted",
                  readUpTo !== null && item.id > readUpTo && "bg-primary/8",
                )}
              >
                <span>{activityText(item)}</span>
                <span className="text-[13px] text-muted-foreground tabular-nums">{formatWhen(item.at)}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
