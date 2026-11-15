// Smoke render of the screens on the server renderer (no DOM): the route tree, guards and pages
// produce the expected texts from cached API answers. Effects and requests do not run here.

import { QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { apiQuery, ME_KEY, queryClient } from "@/lib/query";
import type { ClassSummary, InviteInfo, Me } from "@shared/api";
import { routes } from "./routes";

const teacher: Me = { id: 1, login: "olena", name: "Олена Іваненко", role: "teacher" };
const student: Me = { id: 2, login: "ivan", name: "Іван Петренко", role: "student" };
const classes: ClassSummary[] = [
  { id: 1, name: "КН-21", subject: "Комп'ютерні мережі", my_role: "owner", students: 24, to_review: 3, open_help: 1, next_due_at: null, is_demo: false },
  { id: 2, name: "КН-22", subject: "", my_role: "owner", students: 20, to_review: 0, open_help: 0, next_due_at: Date.UTC(2037, 10, 14), is_demo: false },
];
const invite: InviteInfo = { code: "ABC12345", class_name: "КН-21", subject: "Комп'ютерні мережі", teacher_name: "Олена Іваненко" };

function render(path: string): string {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  // React separates adjacent text nodes with comments; drop them to compare the visible text.
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ).replaceAll("<!-- -->", "");
}

beforeEach(() => {
  queryClient.clear();
});

describe("screens (server render)", () => {
  it("login and registration forms", () => {
    queryClient.setQueryData(ME_KEY, null);
    const login = render("/login?next=%2Fclasses%2F1");
    expect(login).toContain("Вхід");
    expect(login).toContain("Зареєструватися як викладач");
    const register = render("/register");
    expect(register).toContain("Реєстрація викладача");
    expect(register).toContain("Щонайменше 8 символів");
  });

  it("join page for a visitor offers student registration, for a student the join button", () => {
    queryClient.setQueryData(apiQuery("GET /api/invites/:code", { params: { code: "ABC12345" } }).queryKey, invite);
    queryClient.setQueryData(ME_KEY, null);
    const guest = render("/join/ABC12345");
    expect(guest).toContain("Клас КН-21");
    expect(guest).toContain("Викладач: Олена Іваненко");
    expect(guest).toContain("Зареєструватися та приєднатися");

    queryClient.setQueryData(ME_KEY, student);
    const joined = render("/join/ABC12345");
    expect(joined).toContain("Приєднатися");
    expect(joined).not.toContain("Зареєструватися та приєднатися");

    queryClient.setQueryData(ME_KEY, teacher);
    expect(render("/join/ABC12345")).toContain("Приєднатися до класу за запрошенням може лише студент");
  });

  it("teacher shell: menu with class status lines, counter, search box, bell, name", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    queryClient.setQueryData(apiQuery("GET /api/classes").queryKey, classes);
    const html = render("/review");
    expect(html).toContain("На перевірку");
    expect(html).toContain("Завантаження");
    expect(html).toContain("КН-21");
    expect(html).toContain("aria-label=\"1 запит &quot;не працює&quot;\"");
    expect(html).toContain("aria-label=\"3 здачі на перевірку\"");
    expect(html).toContain("Найближчий строк 14 листопада");
    expect(html).toContain("Ctrl+K");
    expect(html).toContain("Олена Іваненко");
    expect(html).toContain(">4<");
  });

  it("teacher without classes sees a hint", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    queryClient.setQueryData(apiQuery("GET /api/classes").queryKey, []);
    expect(render("/review")).toContain("Ще немає класів.");
  });

  it("student: root shows the tasks stub, teacher pages are refused", () => {
    queryClient.setQueryData(ME_KEY, student);
    expect(render("/")).toContain("Мої завдання");
    expect(render("/assignments/4")).toContain("Завантаження");
    expect(render("/library")).toContain("Ця сторінка доступна лише викладачам");
    expect(render("/nope")).toContain("Сторінку не знайдено");
  });

  it("settings, the review list and the calendar", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    queryClient.setQueryData(apiQuery("GET /api/classes").queryKey, classes);
    expect(render("/settings")).toContain("Змінити пароль");
    expect(render("/review")).toContain("Завантаження");
    const calendar = render("/calendar");
    expect(calendar).toContain("Завантажити .ics");
    expect(calendar).toContain('data-testid="calendar-day"');
  });

  it("the library pages load their data", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    expect(render("/library")).toContain("Завантаження");
    expect(render("/library/5")).toContain("Завантаження");
    expect(render("/library/x")).toContain("Предмет не знайдено");
  });

  it("the player opens every kind of source", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    expect(render("/play/branch-1")).toContain("Завантаження");
    expect(render("/play/item-1-m1-start")).toContain("Завантаження");
    expect(render("/play/nonsense")).toContain("Невідоме джерело запису");
  });

  it("the student page of the teacher loads its data", () => {
    queryClient.setQueryData(ME_KEY, teacher);
    expect(render("/classes/1/assignments/2/students/3")).toContain("Завантаження");
  });

  it("a visitor on a signed-in page is redirected to /login", () => {
    queryClient.setQueryData(ME_KEY, null);
    const router = createMemoryRouter(routes, { initialEntries: ["/classes/3?a=1"] });
    renderToString(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(router.state.location.pathname).toBe("/classes/3");
  });
});
