import { describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@shared/ws";
import { MeshRoom } from "./room-adapter";
import type { RoomSocket } from "./room-link";

function fakeSocket() {
  const handlers = new Map<string, Set<(message: never) => void>>();
  const sent: ClientMessage[] = [];
  const socket = {
    on: (type: string, handler: (message: never) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
    send: (message: ClientMessage) => (sent.push(message), true),
    join: () => undefined,
    leave: () => undefined,
  } as unknown as RoomSocket;
  const receive = (type: string, message: object) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, ...message } as never);
  };
  return { socket, sent, receive, handlers };
}

describe("MeshRoom", () => {
  it("keeps id and the member list from joined and peer events", () => {
    const { socket, receive } = fakeSocket();
    const room = new MeshRoom(socket);
    const onJoined = vi.fn();
    room.on("joined", onJoined);

    receive("joined", { id: "p2", role: "student", peers: [{ id: "p1", role: "student", name: "A" }], frozen: false });
    receive("peer-joined", { id: "p3", role: "student", name: "B" });
    receive("peer-left", { id: "p1" });

    expect(room.id).toBe("p2");
    expect([...room.peers.keys()]).toEqual(["p3"]);
    expect(onJoined).toHaveBeenCalledTimes(1);
  });

  it("passes signals and frames to the handlers and sends them back with a valid peer id", () => {
    const { socket, sent, receive } = fakeSocket();
    const room = new MeshRoom(socket);
    const onFrame = vi.fn();
    room.on("frame", onFrame);
    receive("frame", { from: "p1", data: "AAA=" });

    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ data: "AAA=" }));
    expect(room.send({ type: "frame", to: "p1", data: "AAA=" })).toBe(true);
    expect(room.send({ type: "signal", to: "evil", data: {} })).toBe(false);
    expect(sent).toEqual([{ type: "frame", to: "p1", data: "AAA=" }]);
  });

  it("stops listening on dispose", () => {
    const { socket, receive } = fakeSocket();
    const room = new MeshRoom(socket);
    const onSignal = vi.fn();
    room.on("signal", onSignal);
    room.dispose();
    receive("signal", { from: "p1", data: {} });

    expect(onSignal).not.toHaveBeenCalled();
  });
});
