import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, GitBranch, MessageSquarePlus, Pause, Play, Scissors } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/EmptyState";
import { PcapButton } from "@/components/PcapButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/api";
import { invalidateRoute, meQuery } from "@/lib/query";
import { useIsDesktop } from "@/lib/use-media-query";
import { MachineTerminal } from "@/machine/MachineTerminal";
import { EMPTY_CLIP_RANGE, type ClipRange } from "@/machine/clip";
import { chooseFork, type ForkChoice } from "@/machine/continue-from";
import { parsePlaySource, parseStartMs, type PlaySource } from "@/machine/play-source";
import type { PlayerSession, PlayerSpeed, PlayerView } from "@/machine/player-session";
import { usePlayer } from "@/machine/use-player";
import { cn } from "@/lib/utils";
import { ClipBar } from "./ClipBar";
import { CommandList } from "./CommandList";
import { Timeline, type TimelineSpan } from "./Timeline";

const SPEEDS: readonly { speed: PlayerSpeed; label: string; id: string }[] = [
  { speed: 1, label: "1×", id: "1" },
  { speed: 4, label: "4×", id: "4" },
  { speed: 0, label: "макс", id: "max" },
];

/** "← Назад": one step back when the page has a history, the home page otherwise. */
function useBack(): () => void {
  const navigate = useNavigate();
  return () => {
    const state = window.history.state as { idx?: number } | null;
    if ((state?.idx ?? 0) > 0) void navigate(-1);
    else void navigate("/");
  };
}

export function BackButton() {
  const back = useBack();
  return (
    <Button variant="outline" size="sm" data-testid="player-back" onClick={back}>
      <ArrowLeft /> Назад
    </Button>
  );
}

function PlayerCard({ title, hint, back = true }: { title: string; hint?: string; back?: boolean }) {
  return (
    <div data-testid="player-card" className="flex flex-col gap-4 px-4 py-5 sm:px-6">
      {back && (
        <header>
          <BackButton />
        </header>
      )}
      <EmptyState title={title} {...(hint === undefined ? {} : { hint })} />
    </div>
  );
}

/** `/play/:source`: a branch, a submission machine, a library item journal or a published item. */
export function PlayerPage() {
  const { source: text = "" } = useParams();
  const source = useMemo(() => parsePlaySource(text), [text]);
  const embed = source?.kind === "embed";
  if (source === null) return <PlayerCard title="Невідоме джерело запису" hint="Адреса програвача неправильна." />;
  const screen = <PlayerScreen key={text} text={text} source={source} layout={embed ? "embed" : "page"} />;
  // Outside the shell (it has no window of its own): the published player fills the window.
  return embed ? <div className="h-screen overflow-y-auto">{screen}</div> : screen;
}

/** `/embed/:token`: the same screen as `/play/embed-<token>`, for a visitor who is not logged in. */
export function EmbedPage() {
  const { token = "" } = useParams();
  const text = `embed-${token}`;
  const source = useMemo(() => parsePlaySource(text), [text]);
  if (source === null) return <PlayerCard back={false} title="Невідоме джерело запису" hint="Адреса програвача неправильна." />;
  return (
    <div className="h-screen overflow-y-auto">
      <PlayerScreen key={text} text={text} source={source} layout="embed" />
    </div>
  );
}

function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [data-testid="terminal"]') !== null;
}

/** Space, arrows and "/" act on the player unless the focus is in a field or in the terminal. */
function useKeys(session: PlayerSession | null, enabled: boolean): void {
  useEffect(() => {
    if (!session || !enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTextTarget(event.target)) return;
      // A focused button would also "click" on Space; the player takes the key instead.
      if (event.target instanceof HTMLButtonElement) event.target.blur();
      if (event.code === "Space") session.toggle();
      else if (event.key === "ArrowRight") void session.step(1);
      else if (event.key === "ArrowLeft") void session.step(-1);
      else if (event.key === "/" || event.code === "Slash") document.querySelector<HTMLInputElement>('[data-testid="command-search"]')?.focus();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, enabled]);
}

/** Routes whose cached answers a new branch makes stale: the attempt, the requests, the tiles of the class. */
const FORK_ROUTES = [
  "GET /api/attempts/:id",
  "GET /api/assignments/:id/attempt",
  "GET /api/help",
  "GET /api/assignments/:id/students",
] as const;

/** The branch a fork made is the head of the student's work, or an answer on the student's page of the teacher. */
function useFork(session: PlayerSession | null, view: PlayerView) {
  const navigate = useNavigate();
  const [forking, setForking] = useState(false);
  const fork = async (choice: ForkChoice) => {
    const info = view.branch;
    if (!session || !info || forking) return;
    setForking(true);
    try {
      await session.fork(choice);
      await Promise.all(FORK_ROUTES.map((route) => invalidateRoute(route)));
      if (choice.kind === "reply") {
        toast.success("Відповідь надіслано");
        void navigate(`/classes/${info.classId}/assignments/${info.assignmentId}/students/${info.studentId}`);
      } else {
        void navigate(`/assignments/${info.assignmentId}`);
      }
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setForking(false);
    }
  };
  return { forking, fork };
}

/** "Коментар тут" (a teacher, a submission): a line for the text; the comment sits at the position of the player. */
function CommentForm({ session, disabled }: { session: PlayerSession | null; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const trimmed = text.trim();
    if (!session || trimmed === "") return;
    setSaving(true);
    try {
      await session.addComment(trimmed);
      setText("");
      setOpen(false);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSaving(false);
    }
  };
  if (!open) {
    return (
      <Button size="sm" variant="outline" data-testid="comment-open" disabled={disabled} onClick={() => setOpen(true)}>
        <MessageSquarePlus /> Коментар тут
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Input
        autoFocus
        data-testid="comment-text"
        aria-label="Текст коментаря"
        placeholder="Коментар до цього моменту"
        className="h-8 w-72 max-w-full"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="sm" type="submit" data-testid="comment-save" disabled={saving || disabled || text.trim() === ""}>
        Додати
      </Button>
      <Button size="sm" type="button" variant="ghost" data-testid="comment-cancel" onClick={() => setOpen(false)}>
        Скасувати
      </Button>
    </form>
  );
}

/** `?reply=<help id>` of the link "Відповісти" of a help request. */
function parseReplyId(value: string | null): number | null {
  return value !== null && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
}

/** "page": a screen of its own; "pane": one of two side by side (compare); "embed": a published player, no login. */
export type PlayerLayout = "page" | "pane" | "embed";

export interface PlayerScreenProps {
  text: string;
  source: PlaySource;
  layout?: PlayerLayout;
  /** The keys, `?t=` and `?reply=` of the address belong to this player (not to its neighbour in the compare screen). */
  ownsPage?: boolean;
  /** A panel to the right of the command list (the markup of a lesson). */
  side?: (context: { session: PlayerSession | null; view: PlayerView }) => ReactNode;
  /** Marks of the panel on the timeline. */
  spans?: readonly TimelineSpan[];
}

export function PlayerScreen({ text, source, layout = "page", ownsPage = true, side, spans }: PlayerScreenProps) {
  const [search, setSearch] = useSearchParams();
  const [startMs] = useState(() => (ownsPage ? parseStartMs(search.get("t")) : null));
  const [replyId] = useState(() => (ownsPage ? parseReplyId(search.get("reply")) : null));
  const { session, view } = usePlayer(text, source, startMs);
  useKeys(session, ownsPage);
  // A visitor of a published player is not logged in: nobody to ask.
  const me = useQuery({ ...meQuery(), enabled: layout !== "embed" }).data ?? null;
  const page = layout === "page";
  // A narrow screen keeps the font and scrolls the terminal sideways; only a pane beside another one shrinks it.
  const desktop = useIsDesktop();
  const { forking, fork } = useFork(session, view);
  const [clipping, setClipping] = useState(false);
  const [clipRange, setClipRange] = useState<ClipRange>(EMPTY_CLIP_RANGE);
  const choice =
    me === null || !page
      ? null
      : chooseFork({
          viewer: me,
          info: view.branch,
          position: view.position,
          eventCount: view.eventCount,
          commands: view.commands,
          seeking: view.seeking,
          replyId,
        });
  const canComment = page && source.kind === "submission" && me?.role === "teacher";
  const canClip = page && me?.role === "teacher" && view.clip !== null;
  const closeClip = () => {
    setClipping(false);
    setClipRange(EMPTY_CLIP_RANGE);
  };

  // The address always names the moment a paused player stands at, so a reload or a copied link comes back to it.
  const ready = view.phase === "ready" && view.machine !== null;
  useEffect(() => {
    if (!ownsPage || !ready || !view.paused || view.seeking) return;
    setSearch(
      (current) => {
        if (current.get("t") === String(view.position)) return current;
        const next = new URLSearchParams(current);
        next.set("t", String(view.position));
        return next;
      },
      { replace: true },
    );
  }, [ownsPage, ready, view.paused, view.seeking, view.position, setSearch]);

  if (view.phase === "failed") return <PlayerCard back={page} title="Не вдалося відкрити запис" hint={view.error ?? undefined} />;
  const runtime = session?.runtime() ?? null;

  return (
    <div
      data-testid="player"
      data-phase={view.phase}
      data-paused={view.paused}
      data-ended={view.ended}
      data-seeking={view.seeking}
      data-position={view.position}
      data-speed={view.speed}
      data-layout={layout}
      className={cn("flex flex-col gap-3", layout === "pane" ? "px-1 py-1 lg:h-full" : "min-h-full px-4 py-4 sm:px-6 lg:h-full")}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {page && <BackButton />}
        <div className="flex min-w-0 flex-col">
          <h1 data-testid="player-title" className="truncate font-display text-[22px] leading-tight font-bold">
            {view.title || "Запис"}
          </h1>
          <p data-testid="player-subtitle" className="truncate text-sm text-muted-foreground">
            {view.subtitle}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {canClip && (
            <Button
              size="sm"
              variant={clipping ? "default" : "outline"}
              data-testid="clip-open"
              disabled={!ready || clipping}
              onClick={() => setClipping(true)}
            >
              <Scissors /> Вирізати кліп
            </Button>
          )}
          {page && source.kind !== "embed" && (
            <PcapButton frames={ready ? view.netFrames : null} build={() => session?.pcap() ?? null} fileName={`${text}.pcap`} />
          )}
          {canComment && <CommentForm session={session} disabled={!ready || view.seeking} />}
          {choice !== null && (
            <Button
              size="sm"
              data-testid="fork"
              data-kind={choice.kind}
              disabled={!ready || choice.disabled || forking}
              onClick={() => void fork(choice)}
            >
              <GitBranch /> {choice.label}
            </Button>
          )}
          <div className="flex items-center gap-1" role="group" aria-label="Швидкість">
            {SPEEDS.map(({ speed, label, id }) => (
              <Button
                key={id}
                size="sm"
                variant={view.speed === speed ? "default" : "outline"}
                aria-pressed={view.speed === speed}
                data-testid={`speed-${id}`}
                disabled={!ready}
                onClick={() => session?.setSpeed(speed)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </header>

      {!ready || runtime === null || view.machine === null ? (
        <p className="text-sm text-muted-foreground">Завантаження…</p>
      ) : (
        <>
          {clipping && <ClipBar session={session} view={view} range={clipRange} onRange={setClipRange} onClose={closeClip} />}
          <div className={cn("flex min-h-0 flex-1", layout === "pane" ? "flex-col gap-2" : "flex-col gap-4 lg:flex-row")}>
            <div className={cn("flex min-h-0 flex-col gap-2", layout === "pane" ? "flex-1" : "shrink-0")}>
              <MachineTerminal
                runtime={runtime}
                view={view.machine}
                className="min-h-0 flex-1 max-lg:h-[26rem] max-lg:flex-none"
                shrinkToFit={layout === "pane" && desktop}
              />
              {view.notice !== null && (
                <p data-testid="player-notice" className="text-sm text-status-stuck">
                  {view.notice}
                </p>
              )}
            </div>
            <CommandList
              className={layout === "pane" ? "h-44 flex-none" : "max-lg:h-80 max-lg:flex-none"}
              marks={view.marks}
              current={view.current}
              onPick={(mark) => void session?.goToMark(mark)}
              {...(canComment && me !== null
                ? {
                    commentOwner: me.id,
                    onDeleteComment: (id: number) => void session?.deleteComment(id).catch((error: unknown) => toast.error(describeError(error))),
                  }
                : {})}
            />
            {side?.({ session, view })}
          </div>
          <div className="flex items-start gap-3">
            <Button
              size="icon"
              variant="outline"
              data-testid="play-toggle"
              aria-label={view.paused ? "Відтворити" : "Пауза"}
              onClick={() => session?.toggle()}
            >
              {view.paused ? <Play /> : <Pause />}
            </Button>
            <div className="min-w-0 flex-1">
              <Timeline
                duration={view.duration}
                position={view.position}
                marks={view.marks}
                seeking={view.seeking}
                onSeek={(ms) => void session?.seek(ms)}
                {...(clipping ? { range: { from: clipRange.startMs, to: clipRange.endMs } } : {})}
                {...(spans === undefined ? {} : { spans })}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
