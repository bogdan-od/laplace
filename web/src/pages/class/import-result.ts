import type { ImportedStudent, ImportResult } from "@shared/api";

/** Rows "name TAB login TAB password": pastes into Excel as three columns. */
export function importedToTsv(created: readonly ImportedStudent[]): string {
  return created.map((student) => [student.name, student.login, student.password].join("\t")).join("\n");
}

export function importSummary(result: ImportResult): string {
  const added = `Додано студентів: ${result.created.length}`;
  return result.errors.length === 0 ? added : `${added}. Рядків із помилкою: ${result.errors.length}`;
}
