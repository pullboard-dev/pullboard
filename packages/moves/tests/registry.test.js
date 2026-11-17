/** Every moves-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148,#10045]. @pullboard-test-input source-cell packages/moves */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryStrictEnabled as registryStrict } from '../../config/index.js';

const TITLE_ID = /^test\('([^':\s]+): /gmu;
const TESTS = /^test\(/gmu;
/** Template literals hold fixture projects whose own test( lines are data, not this cell's tests. */
const TEMPLATES = new RegExp('\\x60[^\\x60]*\\x60', 'gu');

/** Inlined from the verify cell's registryFindings: a cell test may not import another cell's front door; a later item holds the shared check (rg4). */
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

/** Every test file under this cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

/** Reads registry.json and every registry.m<N>.json beside it and merges them; an ID defined in two files fails, so slices land in parallel without a JSON conflict. */
function mergedRecords(dir) {
  const names = readdirSync(dir).filter((name) => name === 'registry.json' || /^registry\.m\d+\.json$/u.test(name)).sort();
  const records = {};
  for (const name of names) {
    for (const [id, record] of Object.entries(JSON.parse(readFileSync(join(dir, name), 'utf8')))) {
      assert.ok(!(id in records), `${id}: defined in two registry files (second is ${basename(name)})`);
      records[id] = record;
    }
  }
  return records;
}

test('moves.registry.complete: clause 1: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
  const records = mergedRecords(join(DIR, 'fixtures'));
  const files = testFiles(DIR).sort().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  const { ids, findings } = registryFindings(files, records);
  const registered = ids.filter((id) => id in records);
  assert.deepEqual([...new Set(registered)].sort(), registered.slice().sort(), 'no registered ID is used by two tests (an unregistered duplicate is reported until its slice registers it)');
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
