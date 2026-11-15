import { describe, expect, test } from "vitest";
import type { ImportResult } from "@shared/api";
import { importedToTsv, importSummary } from "./import-result";

const result: ImportResult = {
  created: [
    { name: "Ткачук Мирослава", login: "tkachuk", number: 1, password: "ABCDEFGH23" },
    { name: "Бондаренко Андрій", login: "bondarenko", number: 2, password: "JKLMNPQR45" },
  ],
  errors: [{ line: 4, message: "Порожнє ім'я" }],
};

describe("importedToTsv", () => {
  test("one line per student, tab-separated name, login, password", () => {
    expect(importedToTsv(result.created)).toBe("Ткачук Мирослава\ttkachuk\tABCDEFGH23\nБондаренко Андрій\tbondarenko\tJKLMNPQR45");
  });
  test("nothing created gives an empty string", () => {
    expect(importedToTsv([])).toBe("");
  });
});

describe("importSummary", () => {
  test("counts students and error lines", () => {
    expect(importSummary(result)).toBe("Додано студентів: 2. Рядків із помилкою: 1");
  });
  test("no errors: only the students", () => {
    expect(importSummary({ created: result.created.slice(0, 1), errors: [] })).toBe("Додано студентів: 1");
  });
});
