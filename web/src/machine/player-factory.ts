// The real wiring of a `PlayerSession`, as `lesson-factory.ts` does for a lesson.

import { Machine } from "@core/machine/machine.mjs";
import { api } from "@/lib/api";
import { MachineHub } from "./hub";
import type { PlaySource } from "./play-source";
import { PlayerSession, type PlayerDeps } from "./player-session";

/** The memory the machine of the player may keep for its snapshots. */
const SNAPSHOT_BYTES = 256 << 20;

function realDeps(): PlayerDeps {
  return {
    api,
    createMachine: (options) => new Machine(options),
    loadImagesRoot: async () => (await api("GET /api/images")).root,
    snapshotBytes: SNAPSHOT_BYTES,
  };
}

export const playerHub = new MachineHub<PlayerSession>();

/** The start moment is part of the key: a link with another `?t=` must not reuse a session that is still being released. */
export const playerKey = (text: string, startMs: number | null): string => `play:${text}:${startMs ?? ""}`;

export function acquirePlayer(text: string, source: PlaySource, startMs: number | null): PlayerSession {
  const session = playerHub.acquire(playerKey(text, startMs), () => new PlayerSession(source, realDeps(), startMs));
  session.start();
  return session;
}

export function releasePlayer(text: string, startMs: number | null): void {
  playerHub.release(playerKey(text, startMs));
}
