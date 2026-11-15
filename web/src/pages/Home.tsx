import { Navigate } from "react-router";
import { useMe } from "@/lib/session";
import { MyAssignmentsPage } from "./MyAssignments";

/** "/": a teacher goes to the review list, a student sees their tasks. */
export function HomePage() {
  const me = useMe();
  if (me.data?.role === "teacher") return <Navigate to="/review" replace />;
  return <MyAssignmentsPage />;
}
