import { useCallback, useSyncExternalStore } from "react";
import type { PlaySource } from "./play-source";
import { acquirePlayer, playerHub, playerKey, releasePlayer } from "./player-factory";
import { INITIAL_PLAYER_VIEW, type PlayerSession, type PlayerView } from "./player-session";

/** The player session of an address (`/play/<text>`) and its view; created and released like `useLesson` does it. */
export function usePlayer(
  text: string,
  source: PlaySource,
  startMs: number | null,
): { session: PlayerSession | null; view: PlayerView } {
  const subscribe = useCallback(
    (listener: () => void) => {
      const off = acquirePlayer(text, source, startMs).subscribe(listener);
      return () => {
        off();
        releasePlayer(text, startMs);
      };
    },
    [text, source, startMs],
  );
  const getSnapshot = useCallback(() => playerHub.peek(playerKey(text, startMs))?.getSnapshot() ?? INITIAL_PLAYER_VIEW, [text, startMs]);
  const view = useSyncExternalStore(subscribe, getSnapshot, () => INITIAL_PLAYER_VIEW);
  return { session: playerHub.peek(playerKey(text, startMs)) ?? null, view };
}
