/** @pullboard-test-input source-cell packages/verify */
/** Every verify-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryFindings } from '../index.js';
import { registryOutcome } from '../index.js';
import { registryStrict } from '../index.js';

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

/** This cell's records: tests/registry.json plus every fixtures/registry-<id>.json. */
function loadRecords(dir) {
  const fixtures = join(dir, 'fixtures');
  const names = ['registry.json', ...readdirSync(fixtures).filter((name) => name !== 'registry.json')];
  return mergeRecords(names, (name) => readFileSync(name === 'registry.json' ? join(dir, name) : join(fixtures, name), 'utf8'));
}

/** Every test file under this cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

test('verify.registry.complete: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
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

test('verify.registry.per-item-files: clause 1: [C7] the registry loader returns a record kept only in a registry-<id>.json in the fixtures folder, merged with packages/verify/tests/registry.json', () => {
  const { records } = loadRecords(DIR);
  assert.ok(records['verify.registry.per-item-files'], 'the record of this case, kept only in fixtures/registry-11956.json, is loaded');
  const shared = Object.keys(JSON.parse(readFileSync(join(DIR, 'registry.json'), 'utf8')));
  assert.ok(shared.length > 0 && shared.every((id) => records[id]), 'every record of packages/verify/tests/registry.json is loaded too');
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.two":{}}', 'notes.json': '{"a.three":{}}' };
  const merged = mergeRecords(Object.keys(files), (name) => files[name]);
  assert.deepEqual(Object.keys(merged.records).sort(), ['a.one', 'a.two'], 'registry.json and registry-<id>.json merge; another json file is no registry');
  assert.deepEqual(merged.duplicates, []);
});

test('verify.registry.duplicate-across-files: clause 2: [C7] an ID recorded in two registry files is reported as a duplicate, and verify.registry.complete fails on any duplicate', () => {
  const files = { 'registry.json': '{"a.one":{}}', 'registry-12.json': '{"a.one":{}}' };
  assert.deepEqual(mergeRecords(Object.keys(files), (name) => files[name]).duplicates, ['a.one (registry.json)']);
});
