import { invalidateRoute } from "@/lib/query";

/** After the roster changes: the class (header count, members), the lists of students of its assignments, the journal. */
export function refreshClassData(): Promise<unknown> {
  return Promise.all([
    invalidateRoute("GET /api/classes/:id"),
    invalidateRoute("GET /api/classes"),
    invalidateRoute("GET /api/assignments/:id/students"),
    invalidateRoute("GET /api/classes/:id/activity"),
  ]);
}
