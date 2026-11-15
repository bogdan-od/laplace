import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { socket } from "@/lib/live";
import { EMPTY_ROOM, TeacherRoom, type TeacherRoomSnapshot } from "./teacher-room";


const NO_SUBSCRIPTION = () => () => undefined;
const EMPTY = () => EMPTY_ROOM;

export interface TeacherRoomView {
  state: TeacherRoomSnapshot;
  /** false when the connection is down and nothing was sent. */
  freeze: (frozen: boolean) => boolean;
  /** For the big terminal of a student (serial history, live bytes, typing); null while no assignment is open. */
  room: TeacherRoom | null;
}

/** Joins the room of the assignment while the page is open; leaves when the assignment changes or the page closes. */
export function useTeacherRoom(assignmentId: number | null): TeacherRoomView {
  // The constructor does nothing but remember its options, so a discarded memo costs nothing.
  const room = useMemo(
    () =>
      assignmentId === null
        ? null
        : new TeacherRoom({
            socket,
            assignmentId,
            fetchStudents: (id) => api("GET /api/assignments/:id/students", { params: { id } }),
          }),
    [assignmentId],
  );
  useEffect(() => {
    room?.start();
    return () => room?.dispose();
  }, [room]);
  const state = useSyncExternalStore(room?.subscribe ?? NO_SUBSCRIPTION, room?.getSnapshot ?? EMPTY, EMPTY);
  return { state, freeze: (frozen) => room?.freeze(frozen) ?? false, room };
}
