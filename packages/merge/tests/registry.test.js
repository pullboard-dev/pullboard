/** Every merge-cell test carries a stable ID in its own title and one complete record, never derived from its path [C7,U148,#9396]. @pullboard-test-input source-cell packages/merge */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryFindings } from '../../verify/index.js';
import { registryOutcome } from '../../verify/index.js';
import { registryStrict } from '../../verify/index.js';

const DIR = import.meta.dirname;
const KINDS = ['cell unit', 'contract', 'journey', 'harness'];
const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/u;

/** Every test file under this cell's tests folder, nested folders included. */
function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith('.test.js') ? [join(dir, entry.name)] : []));
}

test('merge.registry.complete: clause 1: [C7,U148] every registered test has a stable ID and one complete record; an unregistered test is reported and fails only with tests.registryStrict on', (t) => {
  const records = JSON.parse(readFileSync(join(DIR, 'registry.json'), 'utf8'));
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
