/** The test-registry check: which tests lack a stable ID or a record, reported and failing only in strict mode [C7,U148,#8374]. */

const TITLE_ID = /^test\('([^':\s]+): /gmu;
const TESTS = /^test\(/gmu;

/**
 * Compare the test IDs written in test files against the registry's records.
 * The check is a pure report so a new test never blocks ordinary work before the registry rule is approved.
 *
 * @param {{ file: string, source: string }[]} files every test file of the cell with its text
 * @param {Record<string, unknown>} records the registry records by test ID
 * @returns {{ ids: string[], findings: string[] }} `ids` lists every ID written in a title; each finding names the file or record at fault
 */
export function registryFindings(files, records) {
  const ids = [];
  const findings = [];
  const known = new Set(Object.keys(records));
  for (const { file, source } of files) {
    const found = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    const missing = [...source.matchAll(TESTS)].length - found.length;
    if (missing > 0) findings.push(`${file}: ${missing} test title(s) start without an ID and a colon`);
    for (const id of found) {
      ids.push(id);
      if (!known.has(id)) findings.push(`${file}: test ${id} has no registry record`);
    }
  }
  const written = new Set(ids);
  for (const id of known) if (!written.has(id)) findings.push(`registry.json: record ${id} names no test`);
  return { ids, findings };
}

/**
 * Whether the findings fail the check: only when strict (tests.registryStrict on) and there is at least one.
 *
 * @param {string[]} findings
 * @param {boolean} strict
 * @returns {{ fails: boolean, report: string }} `report` is empty when nothing was found
 */
export function registryOutcome(findings, strict) {
  const report = findings.length === 0 ? '' : `${findings.length} unregistered: ${findings.join('; ')}`;
  return { fails: strict && findings.length > 0, report };
}
