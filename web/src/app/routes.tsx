import { lazy, Suspense } from "react";
import type { RouteObject } from "react-router";
import { AssignmentWorkPage } from "@/pages/AssignmentWork";
import { CalendarPage } from "@/pages/calendar/CalendarPage";
import { ClassPage } from "@/pages/class/ClassPage";
import { HomePage } from "@/pages/Home";
import { ItemPage } from "@/pages/library/ItemPage";
import { LessonPreviewPage } from "@/pages/library/LessonPreviewPage";
import { LibraryPage } from "@/pages/library/LibraryPage";
import { MarkupPage } from "@/pages/library/MarkupPage";
import { RecordPage } from "@/pages/library/RecordPage";
import { JoinPage } from "@/pages/Join";
import { LoginPage } from "@/pages/Login";
import { NotFoundPage } from "@/pages/NotFound";
import { ComparePage } from "@/pages/play/ComparePage";
import { EmbedPage, PlayerPage } from "@/pages/play/PlayerPage";
import { RegisterPage } from "@/pages/Register";
import { SettingsPage } from "@/pages/Settings";
import { ReviewPage } from "@/pages/review/ReviewPage";
import { StudentPage } from "@/pages/student/StudentPage";
import { PlayEntry, SignedInLayout, TeacherOnly } from "./guards";
import type { RouteHandle } from "./Shell";

// Dev-only pages: present in `vite dev` and in builds made with VITE_DEV_PAGES=1. The lazy imports
// sit inside the function so that a normal build drops their chunks.
const showDevPages = import.meta.env.DEV || import.meta.env.VITE_DEV_PAGES === "1";

function devRoutes(): RouteObject[] {
  const ReplayPage = lazy(() => import("@/dev/ReplayPage").then((m) => ({ default: m.ReplayPage })));
  const AttemptPage = lazy(() => import("@/dev/AttemptPage").then((m) => ({ default: m.AttemptPage })));
  const MockPage = lazy(() => import("@/dev/MockPage").then((m) => ({ default: m.MockPage })));
  return [
    {
      path: "/dev/replay",
      element: (
        <Suspense fallback={null}>
          <ReplayPage />
        </Suspense>
      ),
    },
    {
      path: "/dev/attempt/:assignmentId",
      element: (
        <Suspense fallback={null}>
          <AttemptPage />
        </Suspense>
      ),
    },
    {
      path: "/dev/mock",
      element: (
        <Suspense fallback={null}>
          <MockPage />
        </Suspense>
      ),
    },
  ];
}

const list: RouteHandle = { nav: "list" };
const work: RouteHandle = { nav: "work" };
// The teacher's page of one student, the recording of a broken state, the markup and preview of a lesson and the player
// have their own back link and no menu.
const bare: RouteHandle = { nav: "work", bare: true };

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  { path: "/join/:code", element: <JoinPage /> },
  // The embeddable player needs neither the shell nor a login.
  { path: "/embed/:token", element: <EmbedPage /> },
  // The recording of a published item opens without a login too (`/play/embed-<token>`); the rest is behind it.
  { path: "/play/:source", element: <PlayEntry />, children: [{ index: true, element: <PlayerPage />, handle: bare }] },
  ...(showDevPages ? devRoutes() : []),
  {
    element: <SignedInLayout />,
    children: [
      { path: "/", element: <HomePage />, handle: list },
      { path: "/settings", element: <SettingsPage />, handle: list },
      { path: "/assignments/:id", element: <AssignmentWorkPage />, handle: work },
      {
        element: <TeacherOnly />,
        children: [
          { path: "/compare", element: <ComparePage />, handle: bare },
          { path: "/review", element: <ReviewPage />, handle: list },
          { path: "/calendar", element: <CalendarPage />, handle: list },
          { path: "/library", element: <LibraryPage />, handle: list },
          { path: "/library/:id", element: <ItemPage />, handle: work },
          { path: "/library/:id/record", element: <RecordPage />, handle: bare },
          { path: "/library/:id/markup", element: <MarkupPage />, handle: bare },
          { path: "/library/:id/preview", element: <LessonPreviewPage />, handle: bare },
          { path: "/classes/:id", element: <ClassPage />, handle: work },
          { path: "/classes/:cid/assignments/:aid/students/:uid", element: <StudentPage />, handle: bare },
        ],
      },
      { path: "*", element: <NotFoundPage />, handle: list },
    ],
  },
];
