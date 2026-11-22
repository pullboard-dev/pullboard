/** pullboard show <id> --compact prints an item's queued relay moves with review paths as a nested path tree, and leaves show --json and the sealed outbox as they were (GitHub #35) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { outboxFile } from '../../../../packages/link/index.js';
import { pathTree } from '../../../../packages/outbox/index.js';
import { readBoardKey } from '../../../../packages/keys/index.js';
import { readOutbox } from '../../../../packages/outbox/index.js';
import { writeOutbox } from '../../../../packages/outbox/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const SHA = 'b'.repeat(40);
const PREFIX = 'packages/example/src/features/review/validation/literal-paths';
const PATHS = ['acceptance.js', 'candidate.js', 'coverage.js', 'freshness.js', 'replay.js', 'validation.js'].map(name => `${PREFIX}/${name}`);
/**
 * Open the sealed outbox with the board key under the fixture's own home, let `change` edit its document, and seal it
 * back with the cell's own writer when `write` is on. In-process: PULLBOARD_HOME names the fixture's home only while
 * the key is read, then is put back.
 */
async function withSealedOutbox(box, change, { write = true } = {}) {
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const saved = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  let key;
  try { key = readBoardKey(board); } finally { if (saved === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = saved; }
  const file = outboxFile(box.linkFile);
  const changed = change(await readOutbox(file, key, board));
  if (write) await writeOutbox(file, key, board, changed);
  return changed;
}

/**
 * A linked board with the outbox on, one item added before the outage, and a withdraw of it queued while the relay
 * is down. A real verify move needs a gated submit; the queued move gets a verify review's sealed paths through the
 * outbox's own writer instead, which is the same sealed shape the relay replays.
 */
async function queuedReview(t) {
  const box = await relayClientFixture(t);
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), relay: { outbox: true } }, null, 2) + '\n');
  runFixtureGit(['add', 'pullboard.json'], { cwd: box.root, env: box.env });
  runFixtureSetupGit(['commit', '-q', '-m', 'chore(config): queue relay moves while the relay is down'], { cwd: box.root, env: box.env });
  await box.link();
  const id = (await box.cliLocal('add', box.lane, 'Queued while the relay is down')).document.item.item_id;
  await box.stopRelay();
  const withdrawn = await box.cliLocal('withdraw', String(id), 'withdrawn while the relay is down');
  assert.equal(withdrawn.code, 0, JSON.stringify(withdrawn.document));
  await withSealedOutbox(box, (document) => {
    const entry = document.moves.at(-1);
    entry.move.args = [...entry.move.args, { review: { commit: SHA, head: SHA, trunk: SHA, paths: PATHS } }];
    return document;
  });
  return { box, id, sealed: () => readFileSync(outboxFile(box.linkFile)) };
}

test('cli.show.compact-prints-path-tree: clause 1: pullboard show <id> --compact prints each of the item\'s queued moves with review.pathTree in place of review.paths [C7]', async (t) => {
  const { box, id } = await queuedReview(t);
  const shown = await box.cliLocal('show', String(id), '--compact');
  assert.equal(shown.code, 0, shown.failure);
  assert.equal(shown.document.item, id);
  assert.equal(shown.document.queuedMoves.length, 1, 'the one queued move of this item');
  const review = shown.document.queuedMoves[0].move.args.at(-1).review;
  assert.deepEqual(review, { commit: SHA, head: SHA, trunk: SHA, pathTree: pathTree(PATHS) }, 'the review paths print as the nested tree');
  assert.equal(shown.document.queuedMoves[0].move.operation, 'withdraw');
});

test('cli.show.compact-json-unchanged: clause 2: pullboard show <id> --json prints the same output as before the change [C7]', async (t) => {
  const { box, id } = await queuedReview(t);
  const shown = await box.cliLocal('show', String(id));
  assert.equal(shown.code, 0, shown.failure);
  assert.equal(shown.document.queuedMoves, undefined, '--json alone adds no compact view');
  assert.doesNotMatch(JSON.stringify(shown.document), /pathTree/u, '--json alone prints no path tree');
  assert.deepEqual(shown.document.relayPending.map(move => Object.keys(move).sort()), [['actor', 'id', 'item', 'operation', 'queuedAt']],
    'the pending move keeps its key-free summary, as before');
  assert.deepEqual((await withSealedOutbox(box, (document) => document, { write: false })).moves.at(-1).move.args.at(-1).review.paths, PATHS,
    'the exact flat paths stay in the stored move for drill-down');
});

test('cli.show.compact-leaves-outbox-unchanged: clause 3: after show <id> --compact the sealed relay outbox file is byte-identical to before, so the relay format is unchanged [C7]', async (t) => {
  const { box, id, sealed } = await queuedReview(t);
  const before = sealed();
  const shown = await box.cliLocal('show', String(id), '--compact');
  assert.equal(shown.code, 0, shown.failure);
  assert.ok(before.equals(sealed()), 'the sealed outbox is byte-identical');
});
