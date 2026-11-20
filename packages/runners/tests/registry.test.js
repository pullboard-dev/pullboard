/** @pullboard-test-input packages/runners/tests/fixtures/registry.json */
/** Every runners-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148,#9939]. @pullboard-test-input source-cell packages/runners */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** The runners cell sits below config in plan order, so its test cannot read tests.registryStrict; this cell is fully registered, so it is always strict (as the queue cell's registry test is) [C7,#9939]. */
const STRICT = true;
const TITLE_ID = /^test\('([^':\s]+): /gmu;
const TESTS = /^test\(/gmu;

/** Inlined from the verify cell's registryFindings: a cell test may not import another cell's front door; a later item holds the shared check (rg4). */
/** Template literals hold fixture projects whose own test( lines are data, not this cell's tests. */
const TEMPLATES = new RegExp('\x60[^\x60]*\x60', 'gu');

function registryFindings(files, records) {
  const ids = [];
  const findings = [];
  const known = new Set(Object.keys(records));
  for (const { file, source } of files) {
    const code = source.replace(TEMPLATES, '');
    const found = [...code.matchAll(TITLE_ID)].map((match) => match[1]);
    const missing = [...code.matchAll(TESTS)].length - found.length;
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

test('runners.registry.complete: clause 1: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
  const { records, duplicates } = loadRecords(DIR);
  assert.deepEqual(duplicates, [], 'no ID is recorded in two registry files');
  const files = testFiles(DIR).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), 'no ID is used by two tests');
  const outcome = registryOutcome(findings, STRICT);
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

test('runners.registry.per-item-files: clause 1: [C7] the registry loader returns a record kept only in a registry-<id>.json in the fixtures folder, merged with packages/runners/tests/fixtures/registry.json', () => {
  const { records } = loadRecords(DIR);
  assert.ok(records['runners.registry.per-item-files'], 'the record of this case, kept only in fixtures/registry-11952.json, is loaded');
  const shared = Object.keys(JSON.parse(readFileSync(join(DIR, 'fixtures', 'registry.json'), 'utf8')));
  assert.ok(shared.length > 0 && shared.every((id) => records[id]), 'every record of packages/runners/tests/fixtures/registry.json is loaded too');
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.two":{}}', 'notes.json': '{"a.three":{}}' };
  const merged = mergeRecords(Object.keys(files), (name) => files[name]);
  assert.deepEqual(Object.keys(merged.records).sort(), ['a.one', 'a.two'], 'registry.json and registry-<id>.json merge; another json file is no registry');
  assert.deepEqual(merged.duplicates, []);
});

test('runners.registry.duplicate-across-files: clause 2: [C7] an ID recorded in two registry files is reported as a duplicate, and runners.registry.complete fails on any duplicate', () => {
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.one":{}}' };
  assert.deepEqual(mergeRecords(Object.keys(files), (name) => files[name]).duplicates, ['a.one (registry.json)']);
});
