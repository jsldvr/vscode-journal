import * as assert from "assert";
import * as fc from "fast-check";
import { groupEntriesByYearMonth } from "../../src/entryGrouping";
import { BlogEntry } from "../../src/types";

interface GeneratedDate {
  year: number;
  month: number;
  day: number;
}

const GENERATED_DATE = fc.record({
  year: fc.integer({ min: 2000, max: 2099 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }),
});

function entry(value: GeneratedDate, index: number): BlogEntry {
  const month = value.month.toString().padStart(2, "0");
  const day = value.day.toString().padStart(2, "0");
  const date = `${value.year}-${month}-${day} 12:00:00`;
  return {
    title: `entry-${index}`,
    date,
    path: `${index}.md`,
    tags: [],
  };
}

suite("entry grouping properties", () => {
  test("grouping preserves every entry once and keeps groups sorted", () => {
    fc.assert(
      fc.property(fc.array(GENERATED_DATE, { maxLength: 250 }), (dates) => {
        const entries = dates.map(entry);
        const groups = groupEntriesByYearMonth(entries);
        const groupedEntries = groups.flatMap((group) =>
          group.months.flatMap((month) => month.entries)
        );

        assert.deepStrictEqual(
          groupedEntries.map((item) => item.path).sort(),
          entries.map((item) => item.path).sort()
        );

        const years = groups.map((group) => Number(group.year));
        assert.deepStrictEqual(years, [...years].sort((a, b) => b - a));
        for (const group of groups) {
          const months = group.months.map((month) => month.month);
          assert.deepStrictEqual(months, [...months].sort((a, b) => a - b));
        }
      })
    );
  });

  test("entries in the same bucket retain their original order", () => {
    fc.assert(
      fc.property(fc.array(GENERATED_DATE, { maxLength: 250 }), (dates) => {
        const entries = dates.map(entry);
        const groups = groupEntriesByYearMonth(entries);

        for (const group of groups) {
          for (const month of group.months) {
            const expected = entries
              .filter((item) => item.date.startsWith(`${group.year}-`))
              .filter(
                (item) => Number(item.date.slice(5, 7)) - 1 === month.month
              );
            assert.deepStrictEqual(month.entries, expected);
          }
        }
      })
    );
  });
});
