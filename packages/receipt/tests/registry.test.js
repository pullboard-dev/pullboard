/** @pullboard-test-input packages/receipt/tests/** */
/** Every receipt-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const DIR = import.meta.dirname;
const KINDS = ['cell unit', 'contract', 'journey', 'harness'];
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;

/** The test IDs written in this cell's test files: the word before the first colon of each test title. */
function idsInTests() {
  const ids = [];
  for (const file of readdirSync(DIR).filter((name) => name.endsWith('.test.js')).sort()) {
    const source = readFileSync(join(DIR, file), 'utf8');
    const found = [...source.matchAll(/^test\('([^':\s]+): /gmu)].map((match) => match[1]);
    assert.equal(found.length, [...source.matchAll(/^test\(/gmu)].length, `${file}: every test title starts with its ID and a colon`);
    ids.push(...found);
  }
  return ids;
}

test('receipt.registry.complete: [C7,U148] every test has a stable ID and exactly one complete record, and no record is orphaned', () => {
  const records = JSON.parse(readFileSync(join(DIR, 'registry.json'), 'utf8'));
  const ids = idsInTests();
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort(), 'no ID is used by two tests');
  assert.deepEqual(Object.keys(records).sort(), ids.slice().sort(), 'tests and records match one to one');
  for (const [id, record] of Object.entries(records)) {
    assert.match(id, ID, `${id}: a dotted lowercase ID`);
    assert.ok(Array.isArray(record.proves?.specs) && record.proves.specs.length > 0, `${id}: proves names spec ids`);
    assert.ok(typeof record.proves.claim === 'string' && record.proves.claim.length > 0, `${id}: proves has one sentence`);
    assert.ok(typeof record.why === 'string' && record.why.length > 0, `${id}: has a why`);
    assert.ok(KINDS.includes(record.kind), `${id}: kind is one of ${KINDS.join(', ')}`);
    assert.ok(Array.isArray(record.inputs) && record.inputs.length > 0, `${id}: declares its inputs`);
  }
});
