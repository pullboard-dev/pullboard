/** @pullboard-test-input apps/view/tests/** */
/** Every view-app test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148,#10620]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryStrictEnabled as registryStrict } from '../../../packages/config/index.js';

/** An ID is dotted (view.area.slug); other `word:` titles in this wide cell are not IDs. */
const TITLE_ID = /^[ \t]*test\(['`]([a-z][a-z0-9]*(?:\.[a-z$][a-z0-9${}-]*)+): /gmu;
const TESTS = /^[ \t]*test\(/gmu;

/** Inlined from the verify cell's registryFindings: a cell test may not import another cell's front door; a later item holds the shared check (rg4). */
function registryFindings(files, records) {
  const ids = [];
  const findings = [];
  const known = new Set(Object.keys(records));
  for (const { file, source } of files) {
    const found = [...source.matchAll(TITLE_ID)].map((match) => match[1]);
    const missing = [...source.matchAll(TESTS)].length - found.length;
    if (missing > 0) findings.push(`${file}: ${missing} test title(s) start without an ID and a colon`);
    for (const id of found) {
      // A looped test names its ID with ${kind}; it stands for every record that fits the template.
      const hits = id.includes('${') ? [...known].filter((key) => new RegExp(`^${id.replaceAll('.', '\\.').replace(/\$\{[^}]*\}/gu, '[a-z0-9-]+')}$`, 'u').test(key)) : [id];
      if (hits.length === 0 || !hits.every((hit) => known.has(hit))) findings.push(`${file}: test ${id} has no registry record`);
      ids.push(...hits);
    }
  }
  const written = new Set(ids);
  for (const id of known) if (!written.has(id)) findings.push(`registry: record ${id} names no test`);
  return { ids, findings };
}

/** Findings fail only in strict mode (tests.registryStrict on) and only when there is one. */
function registryOutcome(findings, strict) {
  return { fails: strict && findings.length > 0, report: findings.length === 0 ? '' : `${findings.length} unregistered: ${findings.join('; ')}` };
}

const DIR = import.meta.dirname;
const KINDS = ['cell unit', 'contract', 'journey', 'harness'];
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;

/** Every test file under this cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

/** Each slice keeps its records in its own registry*.json so parallel slices never conflict. */
function loadRecords() {
  return Object.assign({}, ...readdirSync(join(DIR, 'fixtures')).filter((name) => /^registry(?:-\d+)?\.json$/u.test(name)).sort().map((name) => JSON.parse(readFileSync(join(DIR, 'fixtures', name), 'utf8'))));
}

test('view.stable.reads-every-test: clause 1: [C7,U148] the check reads every test file under apps/view/tests, reports an unregistered test, fails a file that already carries an ID only when it leaves a test out, and fails the rest only with tests.registryStrict on', (t) => {
  const records = loadRecords();
  const files = testFiles(DIR).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assert.ok(files.length > 100, 'the view app has its test files to check');
  const { ids, findings } = registryFindings(files, records);
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), 'no ID is used by two tests');
  // A file that already carries an ID title is covered: it may not leave one test without an ID or record, strict mode or not.
  const covered = files.filter(({ source }) => /^[ \t]*test\(['`][a-z][a-z0-9]*(?:\.[a-z$][a-z0-9${}-]*)+: /mu.test(source));
  assert.ok(covered.length > 0, 'a slice of the view tests is covered');
  const uncoveredInCovered = findings.filter((finding) => covered.some(({ file }) => finding.startsWith(`${file}:`)));
  assert.deepEqual(uncoveredInCovered, [], 'a covered file leaves a test without an ID or record');
  const outcome = registryOutcome(findings, registryStrict());
  if (outcome.report) t.diagnostic(outcome.report);
  assert.equal(outcome.fails, false, outcome.report);
});

test('view.stable.records-complete: clause 2: [C7,U148] every registered view test has a dotted lowercase ID and one complete record naming specs, one claim sentence, a why, a kind and its inputs', () => {
  const records = loadRecords();
  assert.ok(Object.keys(records).length > 90, 'the registry holds the covered slices');
  for (const [id, record] of Object.entries(records)) {
    assert.match(id, ID, `${id}: a dotted lowercase ID`);
    assert.ok(Array.isArray(record.proves?.specs) && record.proves.specs.length > 0, `${id}: proves names spec ids`);
    assert.ok(typeof record.proves.claim === 'string' && record.proves.claim.length > 0, `${id}: proves has one sentence`);
    assert.ok(typeof record.why === 'string' && record.why.length > 0, `${id}: has a why`);
    assert.ok(KINDS.includes(record.kind), `${id}: kind is one of ${KINDS.join(', ')}`);
    assert.ok(Array.isArray(record.inputs) && record.inputs.length > 0, `${id}: declares its inputs`);
  }
});

test('view.stable.logic-render-summary-registered: clause 1: [C7,U148,#10638] every test under logic render and summary, cockpit, doctrine, needs-door and state-door carries a view.<area>.<slug> title ID and a record', () => {
  const records = loadRecords();
  const slice = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') })).filter(({ file }) => /^(?:logic\/(?:render|summary)\/|cockpit\/|doctrine\.test\.js$|needs-door\.test\.js$|state-door\.test\.js$)/u.test(file.slice(DIR.length + 1)));
  assert.ok(slice.length > 0, 'the slice has test files');
  const { findings } = registryFindings(slice, records);
  assert.deepEqual(findings.filter((finding) => !finding.startsWith('registry:')), [], 'a test in the slice lacks an ID or a record');
});

test('view.stable.io-rest-registered: clause 1: [C7,U148,#10641] every test under io dashboard, live, page, palette, pipeline and roadmap carries a view.<area>.<slug> title ID and a record', () => {
  const records = loadRecords();
  const slice = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') })).filter(({ file }) => /^io\/(?:dashboard|live|page|palette|pipeline|roadmap)\//u.test(file.slice(DIR.length + 1)));
  assert.ok(slice.length > 0, 'the slice has test files');
  const { findings } = registryFindings(slice, records);
  assert.deepEqual(findings.filter((finding) => !finding.startsWith('registry:')), [], 'a test in the slice lacks an ID or a record');
});

test('view.stable.io-top-cost-counts-registered: clause 1: [C7,U148,#10640] every test under io top-level files, cost and counts carries a view.<area>.<slug> title ID and a record', () => {
  const records = loadRecords();
  const slice = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') })).filter(({ file }) => /^io\/(?:[^/]+\.test\.js|cost\/|counts\/)/u.test(file.slice(DIR.length + 1)));
  assert.ok(slice.length > 0, 'the slice has test files');
  const { findings } = registryFindings(slice, records);
  assert.deepEqual(findings.filter((finding) => !finding.startsWith('registry:')), [], 'a test in the slice lacks an ID or a record');
});

test('view.stable.logic-rest-registered: clause 1: [C7,U148,#10636] every test under logic top-level files, page, panel and pipeline carries a view.<area>.<slug> title ID and a record', () => {
  const records = loadRecords();
  const slice = testFiles(DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') })).filter(({ file }) => /^logic\/(?:[^/]+\.test\.js|page\/|panel\/|pipeline\/)/u.test(file.slice(DIR.length + 1)));
  assert.ok(slice.length > 0, 'the slice has test files');
  const { findings } = registryFindings(slice, records);
  assert.deepEqual(findings.filter((finding) => !finding.startsWith('registry:')), [], 'a test in the slice lacks an ID or a record');
});

test('view.stable.sees-looped-and-indented-tests: clause 1: [C7,U148,#10645] the check counts an indented or template-titled test, needs a record for it, and expands a kind template to its records', () => {
  const looped = "for (const kind of ['a']) {\n  test(`view.x.reads-as-${kind}: reads ${kind}`, () => {});\n}\n";
  const none = registryFindings([{ file: 'x.test.js', source: looped }], {});
  assert.equal(none.findings.length, 1, 'a looped test without a record is reported');
  const some = registryFindings([{ file: 'x.test.js', source: looped }], { 'view.x.reads-as-a': {}, 'view.x.reads-as-b': {} });
  assert.deepEqual(some.findings, [], 'a template ID is covered by its records');
  assert.deepEqual(some.ids, ['view.x.reads-as-a', 'view.x.reads-as-b']);
  const bare = registryFindings([{ file: 'y.test.js', source: "  test('no id here', () => {});\n" }], {});
  assert.equal(bare.findings.length, 1, 'an indented test without an ID is counted');
});
