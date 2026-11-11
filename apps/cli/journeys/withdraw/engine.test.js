/** Ordered withdrawal preserves old reopen meanings and binds immutable review identities [V2,V6,H16]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import { VERDICT_WITHDRAW_ENGINE } from '../../../../packages/state/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Obtain an accepted snapshot through actual joined Git checkouts and native submission/review. */
function acceptedSnapshot(context = false) {
  const box = e2e.project();
  if (context) {
    assert.equal(e2e.commitFile(box, box.repo, 'web/page.html', '<header>Old</header>\n' + '\n'.repeat(8) + '<h1>Start</h1>\n', 'test(web): establish a private review base [G1]').status, 0);
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  }
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Withdrawal engine fixture', '--specs', 'G1', '--criterion', 'The page renders.').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', context ? '<header>Old</header>\n' + '\n'.repeat(8) + '<h1>Page</h1>\n' : '<h1>Page</h1>', 'feat(web): page [G1]').status, 0);
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'api/reviewer');
  assert.equal(fixtureJoin(box.run, reviewer, context ? 'web' : 'api').code, 0);
  assert.equal(box.run(reviewer, 'next', '--verify', '1').code, 0);
  box.git(reviewer, 'switch', '-q', '--detach', box.git(box.web, 'rev-parse', 'HEAD'));
  const accepted = box.run(reviewer, 'verify', '1', 'accept', '--note', 'native private check passed', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return context ? { box, reviewer, snapshot: exportBoard(board) } : exportBoard(board); } finally { store.closeBoard(board); }
}

test('withdrawal true is engine-fenced while false retains historical reopen meaning [V2,V6,H16]', t => {
  const snapshot = acceptedSnapshot(), directory = mkdtempSync(join(tmpdir(), 'pullboard-withdraw-engine-'));
  const boards = ['false', 'old-true', 'current'].map(name => {
    const board = openBoard(join(directory, name + '.sqlite'));
    importBoard(board, snapshot);
    return board;
  });
  t.after(() => { for (const board of boards) store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const receipt = { sequence: 1, at: new Date().toISOString(), kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
  const ordinary = prepareEngineMove(boards[0], 'reopen', [1, { agentId: 'coordinator', note: 'ordinary correction', withdrawVerdict: false }],
    { id: 'legacy-false', actor: 'coordinator' });
  const oldResult = applyRelayMove(boards[0], { ...ordinary, engine: VERDICT_WITHDRAW_ENGINE - 1 }, receipt);
  assert.equal(oldResult.error.code, 'LANDING_FAILURE_REQUIRED');
  assert.equal(store.getItem(boards[0], 1).item_status, 'verified');
  assert.equal(store.verdictsFor(boards[0], 1)[0].withdrawn, undefined);
  const withdraw = prepareEngineMove(boards[1], 'reopen', [1, { agentId: 'coordinator', note: 'recorded ruling missed', withdrawVerdict: true }],
    { id: 'withdraw-current', actor: 'coordinator' });
  const before = exportBoard(boards[1]);
  assert.throws(() => applyRelayMove(boards[1], { ...withdraw, engine: VERDICT_WITHDRAW_ENGINE - 1 }, receipt), error => error.code === 'RELAY_MOVE' && /introduced in engine/u.test(error.message));
  assert.deepEqual(exportBoard(boards[1]), before, 'an impossible older tag refuses before any row or cursor changes');
  const mixed = { ...withdraw, args: [1, { ...withdraw.args[1], cause: 'conflict:src/example.js' }], engine: VERDICT_WITHDRAW_ENGINE - 1 };
  assert.throws(() => applyRelayMove(boards[1], mixed, receipt), error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(boards[1]), before, 'an older mixed cause+withdrawal tag also refuses before row or cursor changes');

  const current = applyRelayMove(boards[2], withdraw, receipt);
  assert.equal(current.error, undefined, JSON.stringify(current));
  assert.equal(store.getItem(boards[2], 1).item_status, 'open');
  assert.equal(store.verdictsFor(boards[2], 1)[0].withdrawn, true);
  const after = exportBoard(boards[2]);
  applyRelayMove(boards[2], withdraw, receipt);
  assert.deepEqual(exportBoard(boards[2]), after, 'a duplicate ordered withdrawal does not add another event');
});

test('the API carries withdrawal as a boolean without changing note boundaries [A2,H16]', () => {
  assert.deepEqual(moveArgs({ verb: 'reopen', item: 7, args: { 'withdraw-verdict': true, note: 'a note --conflict literal' } }),
    ['reopen', '7', '--note=a note --conflict literal', '--withdraw-verdict', '--json', '--']);
  assert.throws(() => moveArgs({ verb: 'reopen', item: 7, args: { 'withdraw-verdict': 'true', note: 'why' } }), /BAD_REQUEST/u);
});


test('withdrawing the latest accept never revives an earlier accept of the same commit [V2,V6,H16]', t => {
  const { box, reviewer } = acceptedSnapshot(true);
  const trunk = e2e.commitFile(box, box.repo, 'web/page.html', '<header>Old</header>\n' + '\n'.repeat(8) + '<h1>Trunk</h1>\n', 'fix(web): move the private review trunk [G1]');
  assert.equal(trunk.status, 0, trunk.stderr);
  // The trunk rewrites the line the item changed, so the old verdict is stale; the reviewer seals a resolved head.
  box.git(reviewer, 'merge', '-q', '--no-edit', '-X', 'ours', 'main');
  const reviewed = box.run(reviewer, 'verify', '1', 'accept', '--note', 'the actual new trunk composition passes', '--json');
  assert.equal(reviewed.code, 0, reviewed.err + reviewed.out);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const rows = board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(1);
  assert.equal(rows.length, 2, 'two genuine native reviews bind the same submitted commit to successive trunks');
  assert.equal(rows[0].verdict_commit, rows[1].verdict_commit);
  const withdrawn = box.run(reviewer, 'reopen', '1', '--withdraw-verdict', '--note', 'withdraw the latest interpretation', '--json');
  assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
  assert.equal(store.acceptedVerdict(board, store.getItem(board, 1)), undefined,
    'withdrawal of the latest current acceptance must not resurrect the older one');
  assert.deepEqual(board.db.prepare('SELECT * FROM verdict WHERE item_id = ? ORDER BY verdict_id').all(1), rows);
  box.git(box.web, 'merge', '-q', '--no-edit', '-X', 'ours', 'main');
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(e2e.commitFile(box, box.web, 'web/page.html', '<h1>Corrected</h1>', 'fix(web): honor the clarified interpretation [G1]').status, 0);
  assert.equal(box.run(box.web, 'submit', '1').code, 0);
  box.git(reviewer, 'switch', '-q', '--detach', box.git(box.web, 'rev-parse', 'HEAD'));
  assert.equal(box.run(reviewer, 'next', '--verify', '1').code, 0);
  const fresh = box.run(reviewer, 'verify', '1', 'accept', '--note', 'the corrected new submission passes', '--json');
  assert.equal(fresh.code, 0, fresh.err + fresh.out);
  const current = store.acceptedVerdict(board, store.getItem(board, 1));
  assert.ok(current.verdict_id > rows[1].verdict_id);
  assert.equal(current.withdrawn, undefined, 'a genuine later acceptance becomes current normally');
});
