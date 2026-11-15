/**
 * What is red now, read only from recorded ledger rows (test_result), never from a live test run [P7,C7,U152].
 *
 * A file is red when its newest recorded row for a command and context class is a fail. A later pass at a different
 * input key clears it, because the file's inputs changed and the new row is the newer record. Why: the red-now page and
 * gate states had no single source, so each could rerun tests to learn what a ledger row already said.
 *
 * @param {Array<{file: string, command: string, context: string, status: string, inputKey: string, commit?: string|null, at: number}>} rows - Ledger rows as `testResults` returns them, in any order.
 * @param {{ command?: string }} [options]
 * @returns {Array<{file: string, inputKey: string, context: string, commit: string|null, at: number}>} Red files, sorted by file then context.
 */
export function redNow(rows, { command = 'proof' } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('redNow reads ledger rows only: pass the test_result rows');
  const newest = new Map();
  for (const row of rows) {
    if (row.command !== command) continue;
    const key = `${row.file}\0${row.context}`;
    const seen = newest.get(key);
    if (!seen || row.at > seen.at) newest.set(key, row);
  }
  return [...newest.values()].filter(row => row.status === 'fail')
    .map(({ file, inputKey, context, commit = null, at }) => ({ file, inputKey, context, commit, at }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.context.localeCompare(b.context));
}
