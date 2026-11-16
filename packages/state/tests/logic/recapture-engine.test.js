/** @pullboard-test-loads packages/state/src/io/engine/numbers.js */
/** @pullboard-world-pin: both clauses read the committed engines folder and engine table, because the leaf must be numbered by the real landing merge code over the real leaves. */
/** The recapture-submit-handoff engine leaf is numbered above SUBMIT_HANDOFF_ENGINE by the landing merge and registered in the engine table [C7,H16]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
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

test('clause 1: the recapture-submit-handoff leaf declares RECAPTURE_SUBMIT_HANDOFF_ENGINE with the unassignedEngine placeholder, so landing numbers it [C7,H16]', () => {
  const lines = readFileSync(join(ROOT, FOLDER, LEAF), 'utf8').split('\n');
  assert.ok(lines.includes("import { unassignedEngine } from './engine-next.js';"), 'it imports the placeholder from engine-next.js');
  assert.deepEqual(lines.filter(line => line.startsWith('export const ')), ['export const RECAPTURE_SUBMIT_HANDOFF_ENGINE = unassignedEngine();']);
  const leaf = readEngineLeaves(join(ROOT, FOLDER)).find(found => found.file === LEAF);
  assert.equal(leaf.name, 'RECAPTURE_SUBMIT_HANDOFF_ENGINE');
});

test('clause 2: the landing merge numbers the leaf above SUBMIT_HANDOFF_ENGINE and writes it into the engine table [C7,H16]', t => {
  const root = copyOfEngines(t);
  const before = readFileSync(join(root, TABLE), 'utf8');
  const submitHandoff = Number(/SUBMIT_HANDOFF_ENGINE: (\d+),/u.exec(before)[1]);
  const { assigned, files } = assignEngineNumbers(root);
  const mine = assigned.find(row => row.name === 'RECAPTURE_SUBMIT_HANDOFF_ENGINE');
  assert.ok(mine, 'the placeholder leaf was numbered');
  assert.ok(mine.number > submitHandoff, `${mine.number} is above SUBMIT_HANDOFF_ENGINE ${submitHandoff}`);
  assert.ok(files.includes(TABLE), 'the engine table was regenerated');
  assert.match(readFileSync(join(root, TABLE), 'utf8'), new RegExp(`RECAPTURE_SUBMIT_HANDOFF_ENGINE: ${mine.number},`, 'u'));
  assert.match(readFileSync(join(root, FOLDER, LEAF), 'utf8'), new RegExp(`RECAPTURE_SUBMIT_HANDOFF_ENGINE = ${mine.number};`, 'u'));
});
