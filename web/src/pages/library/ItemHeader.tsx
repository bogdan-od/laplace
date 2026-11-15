import { useState } from "react";
import { Globe, Send, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { LibraryItem } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, describeError } from "@/lib/api";
import { checkTitle } from "@/lib/validate";
import { MAX_TITLE_CHARS } from "@shared/limits";
import { KIND_LABEL } from "./library-list";

/** The title is edited in place and saved on its own (Enter or leaving the field). */
function TitleField({ item, onItem }: { item: LibraryItem; onItem: (item: LibraryItem) => void }) {
  const [draft, setDraft] = useState(item.title);

  const commit = async () => {
    const title = draft.trim();
    if (title === item.title) {
      setDraft(item.title);
      return;
    }
    const problem = checkTitle(title, "назву");
    if (problem) {
      toast.error(problem);
      setDraft(item.title);
      return;
    }
    try {
      const updated = await api("PATCH /api/library/:id", { params: { id: item.id }, body: { title } });
      onItem(updated);
      setDraft(updated.title);
    } catch (error) {
      toast.error(describeError(error));
      setDraft(item.title);
    }
  };

  return (
    <input
      value={draft}
      maxLength={MAX_TITLE_CHARS}
      aria-label="Назва"
      data-testid="item-title"
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-display text-[26px] leading-tight font-bold outline-none hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(item.title);
      }}
    />
  );
}

export function ItemHeader({
  item,
  onItem,
  onAssign,
  onPublish,
  onDelete,
}: {
  item: LibraryItem;
  onItem: (item: LibraryItem) => void;
  onAssign: () => void;
  onPublish: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Link to="/library" data-testid="item-back" className="text-sm text-muted-foreground hover:underline">
        ← Бібліотека
      </Link>
      <div className="flex items-center gap-3">
        <Badge variant="secondary" data-testid="item-kind" data-kind={item.kind}>
          {KIND_LABEL[item.kind]}
        </Badge>
        <TitleField item={item} onItem={onItem} />
        {item.kind === "task" ? (
          <Button onClick={onAssign} data-testid="item-assign">
            <Send /> Видати класу
          </Button>
        ) : (
          <Button onClick={onPublish} data-testid="item-publish">
            <Globe /> {item.embed_token === null ? "Опублікувати" : "Опубліковано"}
          </Button>
        )}
        <Button variant="outline" onClick={onDelete} data-testid="item-delete">
          <Trash2 /> Видалити
        </Button>
      </div>
    </div>
  );
}
