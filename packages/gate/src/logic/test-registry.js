/** The new-test rule: an added test carries a stable ID and a record, and an added journey names a user path [C7,U148]. */

// Duplicated from packages/verify/src/logic/registry.js (TITLE_ID, TESTS): cells do not import each other's src, so a later item merges the two.
const TITLE_ID = /^test\('([^':\s]+): /gmu;
const TESTS = /^test\(/gmu;
// The caller passes only test files; the folder alone tells a journey from a cell test, and fixture helpers are skipped.
const JOURNEY = /^apps\/[^/]+\/journeys\/.+\.js$/u;
const TEST_FILE = /^(?:packages|apps)\/[^/]+\/tests\/(?!fixtures\/).+\.js$/u;

/** The cell folder a test file belongs to, such as packages/spec or apps/cli. */
function cellOf(file) {
  const [root, name] = file.split('/');
  return `${root}/${name}`;
}

/**
 * Findings for the test files a change adds. A modified test file is never passed in, so it never earns a finding. Pure: the
 * caller reads the files, the registry records and golden.json. Each finding names the file and the one next step.
 *
 * - an added journey that no golden.json path names: name the user path in golden.json or turn the journey into a cheaper test;
 * - an added test whose cell has no tests/registry.json: add the cell's registry first;
 * - an added test whose title has no ID, or whose ID has no record: write the ID and its record.
 *
 * @param {{ added: { path: string, text: string }[], registeredCells: string[], records: Record<string, unknown>, golden: { file: string }[] }} input
 *   `registeredCells` lists the cell dirs that hold tests/registry.json; `records` holds every registered ID; `golden` is golden.json's paths list.
 * @returns {{ file: string, code: string, message: string, next: string }[]}
 */
export function unregisteredNewTests({ added = [], registeredCells = [], records = {}, golden = [] } = {}) {
  const findings = [];
  const named = new Set(golden.map(entry => entry.file));
  const cells = new Set(registeredCells);
  const known = new Set(Object.keys(records));
  for (const { path, text } of added) {
    if (JOURNEY.test(path)) {
      if (!named.has(path)) findings.push({ file: path, code: 'JOURNEY_NO_PATH', message: `${path}: a new journey names no golden user path`, next: `add a path for ${path} to packages/gate/data/tests/golden.json, or write the test as a cheaper kind` });
      continue;
    }
    if (!TEST_FILE.test(path)) continue;
    const cell = cellOf(path);
    if (!cells.has(cell)) {
      findings.push({ file: path, code: 'CELL_NO_REGISTRY', message: `${path}: its cell ${cell} has no tests/registry.json`, next: `create ${cell}/tests/registry.json with one record for each test in ${path}` });
      continue;
    }
    const ids = [...text.matchAll(TITLE_ID)].map(match => match[1]);
    const missing = [...text.matchAll(TESTS)].length - ids.length;
    if (missing > 0) findings.push({ file: path, code: 'TEST_NO_ID', message: `${path}: ${missing} test title(s) start without an ID and a colon`, next: `start each title with a dotted ID such as ${cell.split('/')[1]}.area.claim: and add its record to ${cell}/tests/registry.json` });
    for (const id of ids) if (!known.has(id)) findings.push({ file: path, code: 'ID_NO_RECORD', message: `${path}: test ${id} has no registry record`, next: `add a record for ${id} to ${cell}/tests/registry.json` });
  }
  return findings;
}
