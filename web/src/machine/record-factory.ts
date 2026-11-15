// The real wiring of a `RecordSession`, as `lesson-factory.ts` does for a lesson.

import { Machine } from "@core/machine/machine.mjs";
import { random_mac } from "@core/net/mac.mjs";
import { api } from "@/lib/api";
import { MachineHub } from "./hub";
import { RecordSession, type RecordDeps } from "./record-session";

function realDeps(): RecordDeps {
  return {
    api,
    createMachine: (options) => new Machine(options),
    loadImagesRoot: async () => (await api("GET /api/images")).root,
    randomMac: random_mac,
  };
}

export const recordHub = new MachineHub<RecordSession>();

export const recordKey = (itemId: number): string => `record:${itemId}`;

export function acquireRecord(itemId: number): RecordSession {
  const session = recordHub.acquire(recordKey(itemId), () => new RecordSession(itemId, realDeps()));
  session.start();
  return session;
}

export function releaseRecord(itemId: number): void {
  recordHub.release(recordKey(itemId));
}
