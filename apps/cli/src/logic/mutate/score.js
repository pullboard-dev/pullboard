/** The mutation score per test kind, written onto an item and read back for pullboard show; report only, nothing gates on it [C7]. */

/** The kinds in the order they print. */
const KINDS = ['cell unit', 'contract', 'harness', 'journey'];

/** The fact text prefix that marks a mutation score. */
const PREFIX = 'mutation score ';

/**
 * The kind of one test file: journey under a journeys folder, contract when the name has contract, harness when it has harness or fixture, else cell unit.
 *
 * @param {string} file test path relative to its cell
 * @returns {'journey'|'contract'|'harness'|'cell unit'}
 */
export function testKind(file) {
  const path = String(file).replace(/\\/gu, '/');
  if (/(?:^|\/)journeys\//u.test(path)) return 'journey';
  const name = path.split('/').pop();
  if (/contract/u.test(name)) return 'contract';
  if (/harness|fixture/u.test(name)) return 'harness';
  return 'cell unit';
}

/**
 * The share of seeded faults each kind of test caught: a fault counts as caught for a kind when any test file of that kind caught it.
 * Why per kind: a cheap cell unit that catches what a slow journey catches shows which kind is worth its cost.
 *
 * @param {{tests: {file: string}[], faults: {caughtBy?: string[]}[]}} report a mutate report
 * @returns {{kind: string, caught: number, seeded: number}[]} one row per kind that has a test, in print order
 */
export function score(report) {
  const kindOf = new Map((report.tests ?? []).map((test) => [test.file, testKind(test.file)]));
  const seeded = (report.faults ?? []).length;
  return KINDS.filter((kind) => [...kindOf.values()].includes(kind)).map((kind) => ({
    kind,
    seeded,
    caught: report.faults.filter((fault) => (fault.caughtBy ?? []).some((file) => kindOf.get(file) === kind)).length,
  }));
}

/** The fact text for a cell's score, e.g. `mutation score packages/x: cell unit 3/5, contract 1/5`. */
export function scoreText(cell, rows) {
  return `${PREFIX}${cell}: ${rows.map((row) => `${row.kind} ${row.caught}/${row.seeded}`).join(', ')}`;
}

/** The lines `pullboard show` prints: the latest mutation score fact per cell, from an item's thread. */
export function mutationScoreLines(thread) {
  const latest = new Map();
  for (const entry of thread ?? []) {
    if (entry.type === 'fact' && entry.kind === 'measurement' && String(entry.text).startsWith(PREFIX)) latest.set(String(entry.text).slice(PREFIX.length).split(':')[0], entry.text);
  }
  return [...latest.values()].map((text) => `mutation score (report only): ${text.slice(PREFIX.length)}`);
}
