// The real wiring of an `AttemptSession`: the core `Machine`, the API client, the shared socket, the page events.
// Components get a session through `useAttemptSession`; tests build `AttemptSession` with their own deps.

import { Machine } from "@core/machine/machine.mjs";
import { random_mac } from "@core/net/mac.mjs";
import { api } from "@/lib/api";
import { socket } from "@/lib/live";
import { AttemptSession, type PageEvents, type SessionDeps } from "./attempt-session";
import { MachineHub } from "./hub";

/** The memory all machines of the page may keep for their snapshots. */
const SNAPSHOT_BYTES = 256 << 20;

const pageEvents: PageEvents = {
  subscribe(handlers) {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") handlers.hidden();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onPageHide = () => handlers.pagehide();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  },
};

export function realDeps(): SessionDeps {
  return {
    api,
    createMachine: (options) => new Machine(options),
    loadImagesRoot: async () => (await api("GET /api/images")).root,
    socket,
    page: pageEvents,
    randomMac: random_mac,
    snapshotBytes: SNAPSHOT_BYTES,
  };
}

export const attemptHub = new MachineHub<AttemptSession>();

export const attemptKey = (assignmentId: number): string => `attempt:${assignmentId}`;

export function acquireAttempt(assignmentId: number): AttemptSession {
  const session = attemptHub.acquire(attemptKey(assignmentId), () => new AttemptSession(assignmentId, realDeps()));
  session.start();
  return session;
}

export function releaseAttempt(assignmentId: number): void {
  attemptHub.release(attemptKey(assignmentId));
}
