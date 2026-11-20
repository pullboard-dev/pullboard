/** @pullboard-test-input source-cell packages/state */
/** @pullboard-test-loads packages/state/light.js packages/state/src/io/engine/numbers.js */
/** @pullboard-world-pin: the clause reads the committed engines folder and engine table, because the leaf must be numbered by the real landing merge code over the real leaves. */
/** BOARD_RELEASE_CODES_ENGINE is exported by the light state door and is the newest engine when it lands [C7]. */
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
const LEAF = 'board-release-codes-engine.js';
const PLACEHOLDER = "import { unassignedEngine } from './engine-next.js';";

/**
 * A private copy of the engines folder and table as they stood when the board release codes leaf landed: its placeholder restored,
 * and any leaf numbered after it or still unnumbered left out, so the real landing merge can number it again without touching the repository.
 */
function boardAtLanding(t) {
  const { root } = privateFixtureFiles('pullboard-board-release-codes-engine-');
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
      .replace(`export const BOARD_RELEASE_CODES_ENGINE = ${landed};`, 'export const BOARD_RELEASE_CODES_ENGINE = unassignedEngine();')}`);
  }
  writeFileSync(join(root, TABLE), table);
  return root;
}

test('state.engines-board-release-codes.leaf-numbered: clause 1: BOARD_RELEASE_CODES_ENGINE is exported from packages/state/light.js and is greater than every other engine constant [C7]', t => {
  assert.equal(typeof light.BOARD_RELEASE_CODES_ENGINE, 'number', 'the light door exports BOARD_RELEASE_CODES_ENGINE');
  const root = boardAtLanding(t);
  const { assigned } = assignEngineNumbers(root);
  const mine = assigned.find(row => row.name === 'BOARD_RELEASE_CODES_ENGINE');
  assert.ok(mine, 'the landing merge numbered the board release codes leaf');
  assert.equal(light.BOARD_RELEASE_CODES_ENGINE, mine.number, 'the light door reads the number the landing merge gives');
  const others = readEngineLeaves(join(root, FOLDER)).filter(leaf => leaf.name !== 'BOARD_RELEASE_CODES_ENGINE');
  assert.ok(others.length > 100, `every other engine leaf was read (${others.length})`);
  for (const leaf of others) assert.ok(mine.number > leaf.number, `${mine.number} is above ${leaf.name} ${leaf.number}`);
  const exported = Object.entries(light).filter(([name, value]) => /_ENGINE$/u.test(name) && name !== 'BOARD_RELEASE_CODES_ENGINE' && typeof value === 'number' && value < mine.number);
  assert.ok(exported.length > 100, 'the light door exports the engines that landed before it');
});
