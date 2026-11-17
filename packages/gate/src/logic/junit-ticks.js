/** Match a JUnit report's cases to an item's [test] clauses, deciding which to tick and which a failing case blocks [C7]. */

/** The clause number a case name starts with ("clause 3: ..."), or null when it names none. */
function clauseOf(name) {
  const match = /^clause\s+(\d+)\s*:/iu.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Which [test] clauses a report proves. `cases` is the `cases` list junitCases returns; `clauses` is a list of
 * `{ number, kind }`. Why: a clause whose named cases all passed is proved by the report; a failing case blocks its
 * clause and is named; a clause with no case in the report is left alone, neither ticked nor failed, and skipped
 * cases prove nothing. Pure: no I/O.
 */
export function junitClauseTicks(cases, clauses) {
  const ticked = [];
  const failed = [];
  for (const clause of clauses) {
    if (clause.kind !== 'test') continue;
    const mine = cases.filter(row => clauseOf(row.name) === clause.number);
    if (!mine.length) continue;
    const bad = mine.filter(row => row.outcome === 'fail');
    if (bad.length) { for (const row of bad) failed.push({ number: clause.number, name: row.name }); continue; }
    if (mine.every(row => row.outcome === 'pass')) ticked.push(clause.number);
  }
  return { ticked, failed };
}
