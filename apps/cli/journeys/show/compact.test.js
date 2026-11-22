/** pullboard show <id> --compact prints an item's queued relay moves with review paths as a nested path tree, and leaves show --json and the sealed outbox as they were (GitHub #35) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { outboxFile } from '../../../../packages/link/index.js';
import { pathTree } from '../../../../packages/outbox/index.js';
import { runFixtureExecFile } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const SHA = 'b'.repeat(40);
const PREFIX = 'packages/example/src/features/review/validation/literal-paths';
const PATHS = ['acceptance.js', 'candidate.js', 'coverage.js', 'freshness.js', 'replay.js', 'validation.js'].map(name => `${PREFIX}/${name}`);
const OUTBOX = fileURLToPath(new URL('../../../../packages/outbox/index.js', import.meta.url));
const KEYS = fileURLToPath(new URL('../../../../packages/keys/index.js', import.meta.url));

/**
 * Open the sealed outbox with the board key under the fixture's own home, let `change` edit its document, and seal it
 * back with the cell's own writer. Runs in a child so the key directory follows the fixture's environment.
 */
function withSealedOutbox(box, change, { write = true } = {}) {
  const source = `const [{ readOutbox, writeOutbox }, { readBoardKey }] = await Promise.all([import(${JSON.stringify(OUTBOX)}), import(${JSON.stringify(KEYS)})]);
const [file, board, write] = process.argv.slice(1);
const key = readBoardKey(board);
const document = await readOutbox(file, key, board);
const changed = (${change.toString()})(document, ${JSON.stringify({ SHA, PATHS })});
if (write === 'write') await writeOutbox(file, key, board, changed);
process.stdout.write(JSON.stringify(changed));`;
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const out = runFixtureExecFile(process.execPath, ['--input-type=module', '-e', source, outboxFile(box.linkFile), board, write ? 'write' : 'read'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  return JSON.parse(out);
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
  withSealedOutbox(box, (document, { SHA: sha, PATHS: paths }) => {
    const entry = document.moves.at(-1);
    entry.move.args = [...entry.move.args, { review: { commit: sha, head: sha, trunk: sha, paths } }];
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
  assert.deepEqual(withSealedOutbox(box, (document) => document, { write: false }).moves.at(-1).move.args.at(-1).review.paths, PATHS,
    'the exact flat paths stay in the stored move for drill-down');
});

test('cli.show.compact-leaves-outbox-unchanged: clause 3: after show <id> --compact the sealed relay outbox file is byte-identical to before, so the relay format is unchanged [C7]', async (t) => {
  const { box, id, sealed } = await queuedReview(t);
  const before = sealed();
  const shown = await box.cliLocal('show', String(id), '--compact');
  assert.equal(shown.code, 0, shown.failure);
  assert.ok(before.equals(sealed()), 'the sealed outbox is byte-identical');
});
