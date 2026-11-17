/** @pullboard-test-input source-cell packages/state */
/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
/** @pullboard-world-pin: both clauses read the committed engines folder and engine table, because the leaf must be numbered by the real landing merge code over the real leaves. */
/** The recapture-submit-handoff engine leaf is numbered above SUBMIT_HANDOFF_ENGINE by the landing merge and registered in the engine table [C7,H16]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { assignEngineNumbers } from '../../src/io/engine/numbers.js';
import { readEngineLeaves } from '../../src/io/engine/numbers.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const FOLDER = 'packages/state/src/logic/engines';
const TABLE = 'packages/state/src/logic/engine/table.js';
const LEAF = 'recapture-submit-handoff-engine.js';

/** A private copy of the real engines folder and engine table, so the landing merge can number the leaf without touching the repository. */
function copyOfEngines(t) {
  const { root } = privateFixtureFiles('pullboard-recapture-engine-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/state/src/logic/engine'), { recursive: true });
  cpSync(join(ROOT, FOLDER), join(root, FOLDER), { recursive: true });
  cpSync(join(ROOT, TABLE), join(root, TABLE));
  return root;
}

test('clause 1: the recapture-submit-handoff leaf declares RECAPTURE_SUBMIT_HANDOFF_ENGINE as its landed number, 263, which the landing merge gave its unassignedEngine placeholder [C7,H16]', () => {
  const lines = readFileSync(join(ROOT, FOLDER, LEAF), 'utf8').split('\n');
  assert.ok(!lines.includes("import { unassignedEngine } from './engine-next.js';"), 'the numbered leaf no longer imports the placeholder');
  assert.deepEqual(lines.filter(line => line.startsWith('export const ')), ['export const RECAPTURE_SUBMIT_HANDOFF_ENGINE = 263;']);
  const leaf = readEngineLeaves(join(ROOT, FOLDER)).find(found => found.file === LEAF);
  assert.deepEqual([leaf.name, leaf.number], ['RECAPTURE_SUBMIT_HANDOFF_ENGINE', 263]);
});

test('clause 2: the landing merge numbers the placeholder leaf above SUBMIT_HANDOFF_ENGINE and writes it into the engine table, as the committed table shows [C7,H16]', t => {
  const committed = readFileSync(join(ROOT, TABLE), 'utf8');
  const submitHandoff = Number(/^\s*SUBMIT_HANDOFF_ENGINE: (\d+),/mu.exec(committed)[1]);
  assert.match(committed, /RECAPTURE_SUBMIT_HANDOFF_ENGINE: 263,/u, 'the committed engine table registers the leaf');
  assert.ok(263 > submitHandoff, `263 is above SUBMIT_HANDOFF_ENGINE ${submitHandoff}`);
  // The leaf as it read before landing, numbered again by the real landing code in a private copy.
  const root = copyOfEngines(t);
  writeFileSync(join(root, FOLDER, LEAF), readFileSync(join(root, FOLDER, LEAF), 'utf8')
    .replace('export const RECAPTURE_SUBMIT_HANDOFF_ENGINE = 263;', "import { unassignedEngine } from './engine-next.js';\nexport const RECAPTURE_SUBMIT_HANDOFF_ENGINE = unassignedEngine();"));
  writeFileSync(join(root, TABLE), committed.replace(/^\s*RECAPTURE_SUBMIT_HANDOFF_ENGINE: 263,\n/mu, ''));
  const { assigned, files } = assignEngineNumbers(root);
  const mine = assigned.find(row => row.name === 'RECAPTURE_SUBMIT_HANDOFF_ENGINE');
  assert.ok(mine, 'the placeholder leaf was numbered');
  assert.ok(mine.number > submitHandoff, `${mine.number} is above SUBMIT_HANDOFF_ENGINE ${submitHandoff}`);
  assert.ok(files.includes(TABLE), 'the engine table was regenerated');
  assert.match(readFileSync(join(root, TABLE), 'utf8'), new RegExp(`RECAPTURE_SUBMIT_HANDOFF_ENGINE: ${mine.number},`, 'u'));
  assert.match(readFileSync(join(root, FOLDER, LEAF), 'utf8'), new RegExp(`RECAPTURE_SUBMIT_HANDOFF_ENGINE = ${mine.number};`, 'u'));
});
