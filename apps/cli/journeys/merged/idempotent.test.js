/** pullboard merged records an item once: a second call names the existing record and a failure after the write is not a refusal [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { claim } from '../../../../packages/store/index.js';
import { merged } from '../../../../packages/store/index.js';
import { register } from '../../../../packages/store/index.js';
import { reserveReview } from '../../../../packages/store/index.js';
import { verify } from '../../../../packages/store/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { recordedMerge } from '../../src/io/commands/merged.js';
import {
  BIN,
  machine,
  project,
} from '../../tests/fixtures/cockpit/machine.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** A real project whose item 1 is verified and already recorded as merged with the head commit. */
function mergedItem(t) {
  const box = machine(), alpha = project(box, 'merged-once');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'A merged-once fixture item', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
    run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => closeBoard(board));
  const reviewer = register(board, { lane: 'tests', path: join(box.dir, 'merged-reviewer'), parentDigest: 'b'.repeat(64) });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  const frozen = { text: '{"rows":[]}', digest: 'merged-once-synthetic-acceptance' };
  claim(board, 1, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head, freeze: () => frozen });
  submitFixture(board, 1, { agentId: 'web-1', commit: head, tree });
  reserveReview(board, 1, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
  verify(board, 1, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest, policy: 'any', familyPolicy: 'off',
    note: 'Synthetic fixture, not review assurance.', review: { commit: head, head, trunk: head, paths: [] } });
  merged(board, 1, { agentId: 'coordinator', commit: head });
  const count = () => events(board).filter(event => event.event_kind === 'merged' && event.item_id === 1).length;
  return { box, alpha, board, head, count, run: (...args) => runFixtureChild(process.execPath, [BIN, ...args], { cwd: alpha.repo, env: box.env, encoding: 'utf8' }) };
}

test('clause 1: a second merged for an item already merged appends nothing and names the record, and a different commit is refused naming both [C7]', t => {
  const { box, alpha, head, count, run } = mergedItem(t);
  assert.equal(count(), 1);
  const again = run('merged', '1', head);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`#1 is already merged as ${head.slice(0, 12)}; nothing recorded`, 'u'));
  assert.equal(count(), 1, 'no second merged event');
  box.git(alpha.repo, 'commit', '-q', '--allow-empty', '-m', 'chore(fixture): a different commit');
  const other = box.git(alpha.repo, 'rev-parse', 'HEAD');
  const refused = run('merged', '1', other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /MERGED_ALREADY/u);
  assert.ok((refused.stdout + refused.stderr).includes(head) && (refused.stdout + refused.stderr).includes(other), 'the refusal names both commits');
  assert.equal(count(), 1);
});

test('clause 2: recordedMerge answers from the item alone, so a retry after a failed follow-up step never reaches the write [C7]', () => {
  assert.equal(recordedMerge({ item_id: 7, item_merged_commit: null }, 'a'.repeat(40)), null, 'an unmerged item is recorded normally');
  assert.deepEqual(recordedMerge({ item_id: 7, item_merged_commit: 'a'.repeat(40) }, 'a'.repeat(40)), { commit: 'a'.repeat(40) });
  assert.throws(() => recordedMerge({ item_id: 7, item_merged_commit: 'a'.repeat(40) }, 'b'.repeat(40)), error => error.code === 'MERGED_ALREADY'
    && error.message.includes('a'.repeat(40)) && error.message.includes('b'.repeat(40)));
});
