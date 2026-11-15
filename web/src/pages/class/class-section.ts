export type ClassSection = "assignments" | "students" | "activity" | "grades";

export const SECTIONS: readonly { value: ClassSection; label: string }[] = [
  { value: "assignments", label: "Завдання" },
  { value: "students", label: "Студенти" },
  { value: "activity", label: "Журнал дій" },
  { value: "grades", label: "Оцінки" },
];

/** `?tab=students|activity|grades`; no parameter or an unknown one is the assignments. */
export function sectionOf(param: string | null): ClassSection {
  return param === "students" || param === "activity" || param === "grades" ? param : "assignments";
}

/** The query string after switching the section: `?tab=` is dropped for the default one, `?a=` and the rest stay. */
export function withSection(search: URLSearchParams, section: ClassSection): URLSearchParams {
  const next = new URLSearchParams(search);
  if (section === "assignments") next.delete("tab");
  else next.set("tab", section);
  return next;
}
