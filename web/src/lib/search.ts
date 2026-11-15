import { BookOpen, ClipboardList, GraduationCap, Users } from "lucide-react";
import type { SearchResult } from "@shared/api";

export interface Hit {
  key: string;
  /** Position in the whole keyboard-navigable list, across groups. */
  index: number;
  label: string;
  detail: string;
  href: string;
}

export interface Group {
  title: string;
  icon: typeof Users;
  hits: Hit[];
}

/** The server groups results; each group becomes a titled list, all of them one keyboard-navigable list. */
export function groupsOf(result: SearchResult | undefined): Group[] {
  if (!result) return [];
  const groups: Group[] = [
    {
      title: "Класи",
      icon: Users,
      hits: result.classes.map((c) => ({ key: `c${c.id}`, index: 0, label: c.name, detail: "", href: `/classes/${c.id}` })),
    },
    {
      title: "Студенти",
      icon: GraduationCap,
      hits: result.students.map((s) => ({
        key: `s${s.class_id}-${s.user_id}`,
        index: 0,
        label: s.name,
        detail: s.class_name,
        href: `/classes/${s.class_id}?tab=students`,
      })),
    },
    {
      title: "Завдання",
      icon: ClipboardList,
      hits: result.assignments.map((a) => ({
        key: `a${a.id}`,
        index: 0,
        label: a.title,
        detail: a.class_name,
        href: `/classes/${a.class_id}?a=${a.id}`,
      })),
    },
    {
      title: "Бібліотека",
      icon: BookOpen,
      hits: result.library.map((l) => ({ key: `l${l.id}`, index: 0, label: l.title, detail: "", href: `/library/${l.id}` })),
    },
  ];
  const shown = groups.filter((group) => group.hits.length > 0);
  let index = 0;
  for (const group of shown) {
    for (const hit of group.hits) hit.index = index++;
  }
  return shown;
}
