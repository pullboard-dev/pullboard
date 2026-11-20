/** @pullboard-test-input source-cell packages/state */
/** @pullboard-test-loads packages/state/light.js packages/state/src/io/engine/numbers.js */
/** @pullboard-world-pin: the clause reads the committed engines folder and engine table, because the leaf must be numbered by the real landing merge code over the real leaves. */
/** REVIEW_RELEASE_TWICE_ENGINE is exported by the light state door, and the landing merge numbers it above every landed engine and lists it in the engine table [C7]. */
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import * as light from '../../../light.js';
import { assignEngineNumbers } from '../../../src/io/engine/numbers.js';
import { readEngineLeaves } from '../../../src/io/engine/numbers.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const FOLDER = 'packages/state/src/logic/engines';
const TABLE = 'packages/state/src/logic/engine/table.js';
const LEAF = 'review-release-twice-engine.js';
const NAME = 'REVIEW_RELEASE_TWICE_ENGINE';
const PLACEHOLDER = "import { unassignedEngine } from './engine-next.js';";

/**
 * A private copy of the engines folder and table as they stood when this leaf landed: its placeholder restored,
 * and any leaf numbered after it left out, so the real landing merge can number it again without touching the repository.
 */
function boardAtLanding(t) {
  const { root } = privateFixtureFiles('pullboard-review-release-twice-engine-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/state/src/logic/engine'), { recursive: true });
  cpSync(join(ROOT, FOLDER), join(root, FOLDER), { recursive: true });
  let table = readFileSync(join(ROOT, TABLE), 'utf8');
  const landed = readEngineLeaves(join(root, FOLDER)).find(leaf => leaf.file === LEAF).number;
  if (landed !== null) {
    for (const leaf of readEngineLeaves(join(root, FOLDER))) {
      if (leaf.number === null && leaf.file !== LEAF) { rmSync(join(root, FOLDER, leaf.file)); continue; }
      if (leaf.number === null || leaf.number < landed) continue;
      table = table.replace(new RegExp(`^\\s*${leaf.name}: ${leaf.number},\\n`, 'mu'), '');
      if (leaf.file !== LEAF) rmSync(join(root, FOLDER, leaf.file));
    }
    writeFileSync(join(root, FOLDER, LEAF), `${PLACEHOLDER}\n${readFileSync(join(root, FOLDER, LEAF), 'utf8')
      .replace(`export const ${NAME} = ${landed};`, `export const ${NAME} = unassignedEngine();`)}`);
  }
  writeFileSync(join(root, TABLE), table);
  return root;
}

test('state.logic-engines-review-release-twice-engine.clause-1-review-release-twice-engine-is-numbered: clause 1: REVIEW_RELEASE_TWICE_ENGINE is exported from packages/state/light.js, numbered above every other engine and listed in the engine table [C7]', t => {
  assert.equal(typeof light[NAME], 'number', `the light door exports ${NAME}`);
  const root = boardAtLanding(t);
  const { assigned } = assignEngineNumbers(root);
  const mine = assigned.find(row => row.name === NAME);
  assert.ok(mine, 'the landing merge numbered the leaf');
  assert.equal(light[NAME], mine.number, 'the light door reads the number the landing merge gives');
  const others = readEngineLeaves(join(root, FOLDER)).filter(leaf => leaf.name !== NAME);
  assert.ok(others.length > 100, `every other engine leaf was read (${others.length})`);
  for (const leaf of others) assert.ok(mine.number > leaf.number, `${mine.number} is above ${leaf.name} ${leaf.number}`);
  const table = readFileSync(join(root, TABLE), 'utf8');
  assert.match(table, new RegExp(`^ {2}${NAME}: ${mine.number},$`, 'mu'), 'the engine table lists the leaf with its number');
});

test('state.logic-engines-review-release-twice-engine.clause-1-history-snapshot-matches-the-table: clause 1: the landing merge writes a history snapshot that lists the engines the table lists [C7]', t => {
  const { root, write, read } = privateFixtureFiles('pullboard-review-release-twice-history-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(`${FOLDER}/base-engine.js`, 'export const BASE_ENGINE = 80;\n');
  write(`${FOLDER}/${LEAF}`, `${PLACEHOLDER}\nexport const ${NAME} = unassignedEngine();\n`);
  write(TABLE, 'export const ENGINE_NUMBERS = Object.freeze({\n});\n');
  write('packages/state/data/history/legacy.json', '{"version":1}\n');
  write('packages/moves/src/logic/moves/example.js', 'export default { operation: "fixture", engine: 80 };\n');
  const { assigned, files } = assignEngineNumbers(root);
  assert.deepEqual(assigned, [{ name: NAME, number: 81 }], 'numbered one above the highest landed engine');
  const table = read(TABLE).toString('utf8');
  assert.match(table, new RegExp(`^ {2}${NAME}: 81,$`, 'mu'), 'the engine table lists the leaf with its number');
  const snapshot = files.find(file => file.startsWith('packages/state/data/history/') && !file.endsWith('legacy.json'));
  assert.ok(snapshot, 'the merge wrote a history snapshot');
  const record = JSON.parse(readFileSync(join(root, snapshot), 'utf8'));
  assert.deepEqual([record.engine, record.name], [81, NAME]);
  const rows = [...table.matchAll(/^ {2}([A-Z0-9_]+_ENGINE): (\d+),$/gmu)].map(row => [row[1], Number(row[2])]);
  assert.deepEqual(record.engines.map(engine => [engine.name, engine.number]).sort(), rows.sort(), 'the snapshot lists the engines the table lists');
});
