/** Every gate-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148]. @pullboard-test-input source-cell packages/gate */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { registryStrictEnabled as registryStrict } from '../../config/index.js';

const TITLE_ID = /^test\('([^':\s]+): /gmu;
const TESTS = /^test\(/gmu;

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
      ids.push(id);
      if (!known.has(id)) findings.push(`${file}: test ${id} has no registry record`);
    }
  }
  const written = new Set(ids);
  for (const id of known) if (!written.has(id)) findings.push(`registry.json: record ${id} names no test`);
  return { ids, findings };
}

/** Findings fail only in strict mode (tests.registryStrict on) and only when there is one. */
function registryOutcome(findings, strict) {
  return { fails: strict && findings.length > 0, report: findings.length === 0 ? '' : `${findings.length} unregistered: ${findings.join('; ')}` };
}

/** How many tests the files declare, counted from their own test( lines, so a case added to a checked file never leaves a typed number stale. */
function declared(files) {
  const count = files.reduce((sum, { source }) => sum + [...source.matchAll(TESTS)].length, 0);
  assert.ok(count > 0, 'the checked files declare tests');
  return count;
}

const DIR = import.meta.dirname;
const KINDS = ['cell unit', 'contract', 'journey', 'harness'];
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;

/** A registry file: registry.json, or a per-item registry-<id>.json that keeps one item's records out of the shared file. */
const REGISTRY_FILE = /^registry(?:-\d+[a-z]?)?\.json$/u;

/**
 * The records of every registry file among `names`, read through `read`, and each ID recorded in more than one file.
 * Why: every new test appending its record to one registry.json made accepted items conflict at merge; per-item files never collide.
 */
function mergeRecords(names, read) {
  const records = {};
  const duplicates = [];
  for (const name of names.filter((entry) => REGISTRY_FILE.test(entry)).sort()) {
    for (const [id, record] of Object.entries(JSON.parse(read(name)))) {
      if (Object.hasOwn(records, id)) duplicates.push(`${id} (${name})`);
      records[id] = record;
    }
  }
  return { records, duplicates };
}

/** This cell's records: fixtures/registry.json plus every fixtures/registry-<id>.json. */
function loadRecords(dir) {
  const fixtures = join(dir, 'fixtures');
  return mergeRecords(readdirSync(fixtures), (name) => readFileSync(join(fixtures, name), 'utf8'));
}

/** Every test file under this cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

test('gate.registry.complete: clause 1: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
  const { records, duplicates } = loadRecords(DIR);
  assert.deepEqual(duplicates, [], 'no ID is recorded in two registry files');
  const files = testFiles(DIR).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), 'no ID is used by two tests');
  const outcome = registryOutcome(findings, registryStrict());
  if (outcome.report) t.diagnostic(outcome.report);
  assert.equal(outcome.fails, false, outcome.report);
  for (const [id, record] of Object.entries(records)) {
    assert.match(id, ID, `${id}: a dotted lowercase ID`);
    assert.ok(Array.isArray(record.proves?.specs) && record.proves.specs.length > 0, `${id}: proves names spec ids`);
    assert.ok(typeof record.proves.claim === 'string' && record.proves.claim.length > 0, `${id}: proves has one sentence`);
    assert.ok(typeof record.why === 'string' && record.why.length > 0, `${id}: has a why`);
    assert.ok(KINDS.includes(record.kind), `${id}: kind is one of ${KINDS.join(', ')}`);
    assert.ok(Array.isArray(record.inputs) && record.inputs.length > 0, `${id}: declares its inputs`);
  }
});

test('gate.registry.first-28: clause 2: the first 28 test files through journey-parity-export-team-board.test.js each carry an ID in every test title and one record per ID [C7,U148]', () => {
  const { records } = loadRecords(DIR);
  const names = readdirSync(DIR).filter((name) => name.endsWith('.test.js')).sort();
  const first = names.slice(0, names.indexOf('journey-parity-export-team-board.test.js') + 1).filter((name) => name !== 'registry.test.js');
  assert.ok(first.length >= 27, 'the first files are present');
  const files = first.map((name) => ({ file: join(DIR, name), source: readFileSync(join(DIR, name), 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.ok(ids.length > 0);
});

test('gate.registry.io-admission-to-main: clause 1: [C7,U148] the io folders admission through main each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const folders = ['admission', 'affected', 'board', 'browser', 'changed', 'check', 'clone', 'edges', 'gui', 'journal', 'main'];
  const files = folders.flatMap((folder) => testFiles(join(DIR, 'io', folder))).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assert.ok(files.length >= 60, 'the io folders are present');
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those folders is titled with a registered ID');
  assert.ok(ids.length > 250);
});

test('gate.registry.io-c: clause 2: [C7,U148] the io top-level red-fact-text, red, relay, run-tests-no-apps, sizes, timing, trip-overhead and watchdog tests each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['red-fact-text', 'red', 'relay', 'run-tests-no-apps', 'sizes', 'timing', 'trip-overhead', 'watchdog'];
  const files = names.map((name) => join(DIR, 'io', `${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assert.equal(files.length, 8, 'the eight files are present');
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.logic-d: clause 2: [C7,U148] the logic test conversion, freeze-paths, journey-check, manifest-keep, progress and source tests each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['conversion', 'freeze-paths', 'journey-check', 'manifest-keep', 'progress', 'source/loads'];
  const files = names.map((name) => join(DIR, `logic/test/${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.logic-b: clause 2: [C7,U148] the logic b test files each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['health/red-list', 'health/runner-time', 'import-edges', 'input-coverage', 'junit-ticks', 'junit', 'literal-pins', 'load/bearing', 'markdown/allowlist', 'reporter/coverage'];
  const files = names.map((name) => join(DIR, 'logic', `${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.io-a: clause 2: [C7,U148] the io top-level a test files each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['assumptions', 'budgets', 'clone', 'edges', 'engine-lazy-door', 'imports', 'keepalive'];
  const files = names.map((name) => join(DIR, "io", name + ".test.js")).map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith("registry.json:"));
  assert.deepEqual(mine, [], "every test in those files is titled with a registered ID");
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.io-stores: clause 2: [C7,U148] the io stores test file carries an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const files = [join(DIR, 'io', 'stores.test.js')].map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in that file is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.io-moves-to-watchdog: clause 3: [C7,U148] the io folders moves through watchdog, style.test.js excepted, each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const folders = ['moves', 'paths', 'requeue', 'run', 'scripts', 'shards', 'slot', 'static', 'submit', 'sync', 'test', 'watchdog'];
  const files = folders.flatMap((folder) => testFiles(join(DIR, 'io', folder))).filter((file) => !file.endsWith('style.test.js')).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assert.ok(files.length >= 40, 'the io folders are present');
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those folders is titled with a registered ID');
  assert.ok(ids.length > 100);
});

test('gate.registry.io-b: clause 2: [C7,U148] the io top-level b test files each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['language-js-runtimes', 'language-rows', 'language-ruby', 'language-sbt-haskell-perl', 'matrix-no-apps', 'matrix', 'pull-only-callers', 'receipt-missing-cause'];
  const files = names.map((name) => join(DIR, 'io', `${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.logic-c: clause 2: [C7,U148] the logic c test files each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['logic/selection-unit', 'logic/shell-freeze-row', 'logic/shell-preload-row', 'logic/source-preparation', 'logic/static/findings', 'logic/static/idiom-spread', 'logic/static/view-timer-layout', 'logic/test-registry', 'logic/test/budget/load', 'logic/test/budget/time', 'logic/wait'];
  const files = names.map((name) => join(DIR, `${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in those files is registered');
});

test('gate.registry.top-left: clause 2: [C7,U148] the journey parity, run-tests-timeout, runner pid and io test isolation files each carry an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const names = ['journey-parity-u149-d52-2', 'journey-parity-u149-d52-6', 'journey-parity', 'run-tests-timeout', 'runner/pid', 'io/test/isolation'];
  const files = names.map((name) => join(DIR, `${name}.test.js`)).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in those files is titled with a registered ID');
  assert.equal(ids.length, declared(files), `every test declared in those files is registered (${ids.length})`);
});

test('gate.registry.logic-all: clause 1: [C7,U148] every test file under the logic folder carries an ID in every test title and one record per ID', () => {
  const { records } = loadRecords(DIR);
  const files = testFiles(join(DIR, 'logic')).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  assert.ok(files.length >= 47, 'the logic folder is present');
  const { ids, findings } = registryFindings(files, records);
  const mine = findings.filter((finding) => !finding.startsWith('registry.json:'));
  assert.deepEqual(mine, [], 'every test in the logic folder is titled with a registered ID');
  assert.equal(ids.length, declared(files), 'every test declared in the logic folder is registered');
});

test('gate.registry.per-item-files: clause 1: [C7] the registry loader returns a record kept only in a registry-<id>.json in the fixtures folder, merged with packages/gate/tests/fixtures/registry.json', () => {
  const { records } = loadRecords(DIR);
  assert.ok(records['gate.registry.per-item-files'], 'the record of this case, kept only in fixtures/registry-11950.json, is loaded');
  const shared = Object.keys(JSON.parse(readFileSync(join(DIR, 'fixtures', 'registry.json'), 'utf8')));
  assert.ok(shared.length > 0 && shared.every((id) => records[id]), 'every record of packages/gate/tests/fixtures/registry.json is loaded too');
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.two":{}}', 'notes.json': '{"a.three":{}}' };
  const merged = mergeRecords(Object.keys(files), (name) => files[name]);
  assert.deepEqual(Object.keys(merged.records).sort(), ['a.one', 'a.two'], 'registry.json and registry-<id>.json merge; another json file is no registry');
  assert.deepEqual(merged.duplicates, []);
});

test('gate.registry.duplicate-across-files: clause 2: [C7] an ID recorded in two registry files is reported as a duplicate, and gate.registry.complete fails on any duplicate', () => {
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.one":{}}' };
  assert.deepEqual(mergeRecords(Object.keys(files), (name) => files[name]).duplicates, ['a.one (registry.json)']);
});

test('gate.registry.derived-counts: clause 1: [C7] the expected test count is read from the checked files, so one more declared test raises it with no typed number to update', () => {
  const two = ["import test from 'node:test';", "test('a.one: x', () => {});", "test('a.two: y', () => {});", ''].join('\n');
  const three = `${two}test('a.three: z', () => {});\n`;
  assert.equal(declared([{ file: 'one.test.js', source: two }]), 2);
  assert.equal(declared([{ file: 'one.test.js', source: two }, { file: 'two.test.js', source: three }]), 5);
  const stores = join(DIR, 'io', 'stores.test.js');
  const source = readFileSync(stores, 'utf8');
  assert.equal(declared([{ file: stores, source }]), [...source.matchAll(TITLE_ID)].length);
});

/** The two view-lane test files left out of the whole-folder check, each with the item that holds its registration: a named exclusion that cannot grow [#10189,#10297]. */
const VIEW_LANE_EXCLUSIONS = new Map([['stable.test.js', '#10189'], ['io/static/style.test.js', '#10297']]);
/** A test title anywhere in a file, at any indent, in single or double quotes or a template literal. */
const ANY_TITLE = /^[ \t]*(?:test|it)\(\s*[`'"]([^`'":\s]+): /gmu;
/** A title written out in a quote or template; a title computed from a variable, as a generated fixture's probes do, names no ID to check. */
const ANY_TEST = /^[ \t]*(?:test|it)\(\s*[`'"]/gmu;

test('gate.registry.all: clause 1: [C7,U148,#10739] every test file under the gate tests folder, the two view-lane files excepted, carries an ID in every test title and no record names no test; an unregistered test fails only with tests.registryStrict on', (t) => {
  const { records } = loadRecords(DIR);
  const left = testFiles(DIR).filter((file) => !VIEW_LANE_EXCLUSIONS.has(relative(DIR, file)));
  assert.equal(testFiles(DIR).length - left.length, VIEW_LANE_EXCLUSIONS.size, 'exactly the named view-lane files are excluded');
  const findings = [];
  const written = new Set();
  for (const file of left) {
    const source = readFileSync(file, 'utf8');
    const found = [...source.matchAll(ANY_TITLE)].map((match) => match[1]);
    const missing = [...source.matchAll(ANY_TEST)].length - found.length;
    if (missing > 0) findings.push(`${relative(DIR, file)}: ${missing} test title(s) start without an ID and a colon`);
    for (const id of found) {
      written.add(id);
      if (!Object.hasOwn(records, id)) findings.push(`${relative(DIR, file)}: test ${id} has no registry record`);
    }
  }
  const excluded = [...VIEW_LANE_EXCLUSIONS.keys()].map((name) => readFileSync(join(DIR, name), 'utf8'));
  for (const id of Object.keys(records)) {
    if (!written.has(id) && !excluded.some((source) => source.includes(`${id}:`))) findings.push(`registry.json: record ${id} names no test`);
  }
  assert.ok(left.length >= 150, 'the gate tests folder is present');
  const outcome = registryOutcome(findings, registryStrict());
  if (outcome.report) t.diagnostic(outcome.report);
  assert.equal(outcome.fails, false, outcome.report);
  assert.deepEqual(findings, [], 'every gate test is titled with a registered ID');
});
