/** Two items that each add an unnumbered engine land in either order and take the next numbers in that order [B3,R3]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { settleLand } from './settle.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';

/** An unlanded engine leaf, as an item adds one under #1101. */
function unlandedLeaf(name) {
  // A comment line ends with the placeholder too: only the export line itself may be rewritten.
  return `/**\n * The ${name} feature's engine, written until it lands as\n * ${name.toUpperCase()}_ENGINE = unassignedEngine();\n */\nimport { unassignedEngine } from './engine-next.js';\nexport const ${name.toUpperCase()}_ENGINE = unassignedEngine();\n`;
}

/** The engine number a leaf holds at a commit, or null when the leaf is not there or not yet numbered. */
function numberAt(box, commit, name) {
  const shown = box.tryGit(box.repo, 'show', `${commit}:packages/state/src/logic/engines/${name}-engine.js`);
  return shown.status === 0 ? Number(/= (\d+);/u.exec(shown.stdout)?.[1] ?? NaN) : null;
}

/**
 * Land two engine-adding items, accepted in `order`, and check each took the next number in landing order inside its
 * own merge, that the documented move engine follows, and that the landed board still replays.
 *
 * @param {object} helpers - land.test.js's own project, item, verdict and output helpers.
 * @param {number[]} order - The verdict order; the pulled land job chooses its own landing order, which the numbers follow.
 */
export async function landEnginesInOrder({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, order) {
  const box = landProject();
  // The trunk already has one landed engine, and its documented move engine; the fixture lane owns src/ too.
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns = [...new Set([...config.lanes.web.owns, 'src/', 'docs/', 'packages/state/src/logic/engines/'])];
  writeFileSync(join(box.repo, 'pullboard.json'), `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  mkdirSync(join(box.repo, 'docs'), { recursive: true });
  mkdirSync(join(box.repo, 'packages/state/src/logic/engines'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/state/src/logic/engines', 'base-engine.js'), '/** The landed base engine. */\nexport const BASE_ENGINE = 80;\n');
  // The project's own engine file, which is not Pullboard's: landing must neither fail on it nor change it.
  const game = '/** The project\'s game engine. */\nexport class GameEngine {}\nexport const SPEED = 3;\n';
  writeFileSync(join(box.repo, 'src/game-engine.js'), game);
  writeFileSync(join(box.repo, 'docs', 'formats.md'), '| Format | Version |\n| --- | --- |\n| `move engine` | `80` | the fixture |\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: a landed engine and its documented number');
  const names = ['alpha', 'beta'];
  const entries = names.map((name, index) => {
    const entry = itemWorktree(box, index + 1);
    mkdirSync(join(entry.path, 'packages/state/src/logic/engines'), { recursive: true });
    writeFileSync(join(entry.path, 'packages/state/src/logic/engines', `${name}-engine.js`), unlandedLeaf(name));
    return submitItem(box, entry);
  });
  for (const index of order) acceptItem(box, entries[index]);
  const base = box.git(box.repo, 'rev-parse', 'main');
  const result = await settleLand(box, json(box, box.repo, 'land')); // plain pulled land job: one offer lands both in verdict order
  // The pulled land job numbers both leaves in one landing and picks its own order, so the claim is the numbers, not their per-merge order.
  assert.deepEqual([...result.landed].sort((a, b) => a - b), entries.map((entry) => entry.item).sort((a, b) => a - b), 'the train lands both items');
  const numbers = names.map((name) => numberAt(box, result.batch.tip, name));
  assert.deepEqual([...numbers].sort((a, b) => a - b), [81, 82], `the two leaves took the next two numbers: ${numbers}`);
  for (const entry of entries) assert.ok(json(box, box.repo, 'show', String(entry.item)).item_merged_commit, `#${entry.item} has its merged receipt`);
  assert.match(box.git(box.repo, 'show', `${result.batch.tip}:docs/formats.md`), /\| `move engine` \| `82` \|/u, 'the documented move engine follows the highest landed number');
  const landed = box.git(box.repo, 'show', `${result.batch.tip}:packages/state/src/logic/engines/alpha-engine.js`);
  assert.match(landed, /^export const ALPHA_ENGINE = \d+;$/mu, 'the export line itself names its number');
  assert.ok(!landed.includes("from './engine-next.js'"), 'a landed leaf no longer imports the placeholder');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), base);
  assert.equal(box.git(box.repo, 'show', `${result.batch.tip}:src/game-engine.js`) + '\n', game, 'the project\'s own engine file is untouched');
  // The landed board replays: its events import into a fresh board unchanged.
  const document = onBoard(box, (board) => exportBoard(board));
  const replayed = openBoard(join(box.dir, 'replayed.sqlite'));
  try {
    importBoard(replayed, document);
    assert.deepEqual(exportBoard(replayed).tables.event.map((event) => event.event_id), document.tables.event.map((event) => event.event_id));
  } finally { store.closeBoard(replayed); }
}
