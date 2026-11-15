import type { LmsGrade } from "@shared/api";

/** The one line under the grade form about the LMS gradebook; null when the student did not come through LTI. */
export function lmsLine(lms: LmsGrade | null): string | null {
  if (lms === null) return null;
  switch (lms.status) {
    case "sent":
      return "LMS: оцінку передано";
    case "failed":
      return lms.error === null ? "LMS: не передано" : `LMS: не передано - ${lms.error}`;
    case "pending":
      return "LMS: оцінка передається…";
  }
}
