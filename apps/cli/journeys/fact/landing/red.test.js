/** @pullboard-test-input source-tree */
/** Under landing.splitRed a red pair is not bisected: the batch ends blocked and its items land one at a time, the red one returning to its builder [C7]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** Run one real landing pass; return its lines, the last batch record and each item's status, verdict and merge. */
function landOnce(box, ids) {
  const source = [
    `import * as store from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/store/index.js')).href)};`,
    `import { openBoard } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../lib/index.js')).href)};`,
    `import { loadConfig } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/config/index.js')).href)};`,
    `import { runLandingBatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../runner/index.js')).href)};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, idList] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let error = null; try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", automatic: true, write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (caught) { error = { code: caught.code, message: caught.message }; }',
    'const items = Object.fromEntries(idList.split(",").map(id => { const item = store.getItem(board, Number(id)); return [id, { status: item.item_status, verdict: item.item_verdict, merged: item.item_merged_commit }]; }));',
    'const batch = board.db.prepare("SELECT event_detail FROM event WHERE event_kind=\'landing_batch\' ORDER BY event_id DESC LIMIT 1").get();',
    'console.log(JSON.stringify({ error, lines, items, batch: batch ? JSON.parse(batch.event_detail).batch : null }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, ids.join(',')], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('a red pair ends blocked as LAND_SPLIT with no culprit, then its green item lands alone and its red item returns to its builder [C7]', () => {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = 'landing-fixture';
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { manualOverride: true, publish: 'separate', perItem: false, splitRed: true } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: split red batches');
  const green = itemWorktree(box, 1);
  const red = itemWorktree(box, 2);
  // The red item's own submit gate is suppressed, as the bisect suite does, so the landing gate is the first to see it.
  box.env.LAND_SUPPRESS_RED = '1';
  submitItem(box, green, 'PASS\n');
  acceptItem(box, green);
  submitItem(box, red, 'RED\n');
  acceptItem(box, red);
  delete box.env.LAND_SUPPRESS_RED;
  const ids = [green.item, red.item];
  const first = landOnce(box, ids);
  if (process.env.SPLIT_RED_DUMP) writeFileSync(process.env.SPLIT_RED_DUMP, JSON.stringify(first, null, 1));
  assert.equal(first.error, null, JSON.stringify(first));
  assert.equal(first.batch.state, 'blocked', JSON.stringify({ batch: first.batch, items: first.items, lines: first.lines }));
  assert.equal(first.batch.refusal?.code, 'LAND_SPLIT', JSON.stringify(first.batch.refusal));
  assert.deepEqual(first.batch.culprits ?? [], [], 'no culprit is named without a bisect');
  assert.ok(first.lines.some(line => line.startsWith('LAND_SPLIT: the batch of 2 is red')), first.lines.join('\n'));
  for (const id of ids) assert.equal(first.items[id].status, 'verified', `#${id} stays accepted: ${JSON.stringify(first.items[id])}`);
  // The next passes take one item at a time: the green one lands, the red one goes back to its builder with evidence.
  // The cap halves per red batch (4, 2, 1), so a pair may split once more before the items go one at a time; no pass
  // ever bisects: every blocked batch is a LAND_SPLIT with no culprit.
  const outcomes = {};
  for (let pass = 0; pass < 4 && !(outcomes.landed && outcomes.returned); pass += 1) {
    const result = landOnce(box, ids);
    if (process.env.SPLIT_RED_DUMP) writeFileSync(`${process.env.SPLIT_RED_DUMP}.${pass}`, JSON.stringify(result, null, 1));
    assert.equal(result.error, null, JSON.stringify(result));
    if (result.batch?.state === 'blocked' && (result.batch.items ?? []).length > 1) {
      assert.equal(result.batch.refusal?.code, 'LAND_SPLIT', `a red pair splits again rather than bisecting: ${JSON.stringify(result.batch.refusal)}`);
      assert.deepEqual(result.batch.culprits ?? [], []);
    }
    assert.ok(!result.lines.some(line => /^gate (local-)?split-/u.test(line)), `no bisect half ran: ${result.lines.join('\n')}`);
    if (result.items[green.item].merged) outcomes.landed = true;
    if (result.items[red.item].status === 'open') outcomes.returned = true;
  }
  assert.ok(outcomes.landed, 'the green item landed on its own gate');
  assert.ok(outcomes.returned, 'the red item returned to its builder without a bisect');
});
