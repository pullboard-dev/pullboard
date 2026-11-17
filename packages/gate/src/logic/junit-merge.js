import { junitCases } from './junit.js';

/** Merge several JUnit reports into one case list, naming each report it cannot read; Maven and Gradle write one file per class [C7]. */
export function junitCasesAll(reports) {
  const list = Array.isArray(reports) ? [...reports].sort((a, b) => String(a?.path).localeCompare(String(b?.path))) : [];
  if (list.length === 0) return { cases: [], unreadable: [], reason: 'JUNIT_NONE' };
  const cases = [];
  const unreadable = [];
  for (const report of list) {
    const read = junitCases(report?.xml);
    if (read.reason) unreadable.push({ path: report?.path, reason: read.reason });
    else cases.push(...read.cases);
  }
  return { cases, unreadable, reason: null };
}
