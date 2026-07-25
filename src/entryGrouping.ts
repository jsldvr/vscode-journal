import * as moment from "moment";
import { BlogEntry } from "./types";

export interface MonthGroup {
  month: number;
  label: string;
  entries: BlogEntry[];
}

export interface YearGroup {
  year: string;
  months: MonthGroup[];
}

// Groups entries into Year -> Month buckets, both sorted descending by
// year and ascending by month number. Entries within a month keep the
// order they arrived in (callers pass listEntries()'s date-DESC order).
// Pure and vscode-free so it can be unit tested and reused by any
// renderer (webview or otherwise) without a TreeItem dependency.
export function groupEntriesByYearMonth(entries: BlogEntry[]): YearGroup[] {
  const grouped = new Map<string, Map<number, BlogEntry[]>>();

  for (const entry of entries) {
    const date = moment(entry.date);
    const year = date.year().toString();
    const month = date.month();
    if (!grouped.has(year)) {
      grouped.set(year, new Map());
    }
    const byMonth = grouped.get(year)!;
    if (!byMonth.has(month)) {
      byMonth.set(month, []);
    }
    byMonth.get(month)!.push(entry);
  }

  return Array.from(grouped.keys())
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
    .map((year) => {
      const byMonth = grouped.get(year)!;
      const months = Array.from(byMonth.keys())
        .sort((a, b) => a - b)
        .map((month) => ({
          month,
          label: moment().month(month).format("MMMM"),
          entries: byMonth.get(month)!,
        }));
      return { year, months };
    });
}
