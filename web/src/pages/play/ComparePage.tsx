import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState";
import { parsePlaySource, type PlaySource } from "@/machine/play-source";
import { BackButton, PlayerScreen } from "./PlayerPage";

interface Side {
  text: string;
  source: PlaySource;
}

function readSide(text: string | null): Side | null {
  const source = text === null ? null : parsePlaySource(text);
  return text === null || source === null ? null : { text, source };
}

/** `/compare?a=<source>&b=<source>`: two players side by side; the keys and `?t=` belong to the left one. */
export function ComparePage() {
  const [search] = useSearchParams();
  const a = search.get("a");
  const b = search.get("b");
  const left = useMemo(() => readSide(a), [a]);
  const right = useMemo(() => readSide(b), [b]);

  if (left === null || right === null) {
    return <EmptyState title="Невідомі записи для порівняння" hint="Адреса має вигляд /compare?a=…&b=…" />;
  }
  return (
    <div data-testid="compare" className="flex h-full flex-col gap-2 px-6 py-3">
      <header className="flex items-center gap-3">
        <BackButton />
        <h1 className="font-display text-[22px] leading-tight font-bold">Порівняння з еталоном</h1>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <div data-testid="compare-left" className="min-h-0 min-w-0">
          <PlayerScreen key={left.text} text={left.text} source={left.source} layout="pane" />
        </div>
        <div data-testid="compare-right" className="min-h-0 min-w-0">
          <PlayerScreen key={right.text} text={right.text} source={right.source} layout="pane" ownsPage={false} />
        </div>
      </div>
    </div>
  );
}
