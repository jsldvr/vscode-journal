import * as assert from "assert";
import { groupEntriesByYearMonth } from "../entryGrouping";
import { BlogEntry } from "../types";

function entry(date: string, title = date): BlogEntry {
  return { title, date, path: `${date}.md`, tags: [] };
}

suite("entryGrouping", () => {
  test("groups entries into years sorted descending, months sorted ascending", () => {
    const groups = groupEntriesByYearMonth([
      entry("2025-03-01 10:00:00"),
      entry("2026-01-15 10:00:00"),
      entry("2025-01-05 10:00:00"),
      entry("2026-06-20 10:00:00"),
    ]);

    assert.deepStrictEqual(
      groups.map((g) => g.year),
      ["2026", "2025"]
    );
    assert.deepStrictEqual(
      groups[0].months.map((m) => m.month),
      [0, 5]
    );
    assert.strictEqual(groups[0].months[0].label, "January");
    assert.deepStrictEqual(
      groups[1].months.map((m) => m.month),
      [0, 2]
    );
  });

  test("entries within a month keep their input order", () => {
    const first = entry("2026-01-10 10:00:00", "first");
    const second = entry("2026-01-05 10:00:00", "second");
    const groups = groupEntriesByYearMonth([first, second]);

    assert.deepStrictEqual(
      groups[0].months[0].entries.map((e) => e.title),
      ["first", "second"]
    );
  });

  test("an empty entry list produces no groups", () => {
    assert.deepStrictEqual(groupEntriesByYearMonth([]), []);
  });
});
