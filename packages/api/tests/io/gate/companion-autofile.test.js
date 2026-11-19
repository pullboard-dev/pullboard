/** An opted-in submit with a docs companion files its untouched main failure when the pulled gate's receipt posts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { CELL_CONFIG } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import * as store from '../../../../store/index.js';
import { prepareItemPatchSubmit } from '../../../../items/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { provideCompanionInheritance } from '../../../index.js';

const FILE = 'test/affected.test.js';
const CASE = 'the affected case';

test('api.gate-companion-autofile.opted-submit-docs-companion-files: an opted-in submit with a docs companion files its untouched main failure on pull, with no runner and no wait [V4,B3,C7]', { timeout: 30_000 }, // budget: one real fixture repo and one in-process board, no runner.
t => {
  const config = { ...CELL_CONFIG, affectedTests: 'node --test', submit: { autoFileMainReds: true },
    lanes: { ...CELL_CONFIG.lanes, tests: { owns: ['test/'], specs: [] } } };
  const repo = cellRepo(t, { config, real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: repo.root });
  cellSeat(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const main = repo.commit;
  // A real docs companion: the patch is a Git diff of one new file, attached against the builder's head and composed, not committed, on that head.
  repo.put('docs/companion.md', 'After.\n');
  runFixtureGit(['add', '-N', 'docs/companion.md'], { cwd: repo.root });
  const patch = runFixtureGit(['diff', 'HEAD', '--', 'docs/companion.md'], { cwd: repo.root }) + '\n';
  runFixtureGit(['rm', '-q', '--cached', 'docs/companion.md'], { cwd: repo.root });
  rmSync(join(repo.root, 'docs'), { recursive: true, force: true });
  store.attachItemPatch(board, item.item_id, { agentId: 'coordinator', key: 'docs', commit: main, patch, author: seat.id, presubmit: true });
  const held = store.getItem(board, item.item_id);
  const tree = runFixtureGit(['rev-parse', `${main}^{tree}`], { cwd: repo.root });
  const companion = { ...prepareItemPatchSubmit(repo.root, board, held, main), receiptIds: [], phases: [] };
  // The landing cell's closure check is the board host's provider; here it answers that the companion touched no failing test's input.
  provideCompanionInheritance(() => true);
  t.after(() => provideCompanionInheritance(null));
  const job = `gate:${item.item_id}:companion`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: main, base: main, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [],
      companion } } });
  const lease = claimJob(board.db, { runner: 'r-companion', capabilities: [], now: 2 });
  // The main-receipt lookup says main fails the same case the same way, from a main-test receipt that is not in the board.
  const compareWithMain = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'main', own: [], receipt: 'main-test-1' })) });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-companion', token: lease.token,
    receipt: { version: 1, status: 1, gate: { source: main, green: false, phases: [{ role: 'proof', status: 1,
      failures: [{ file: FILE, name: CASE }], failureSignatures: ['a'.repeat(64)] }] } } }, { mode: 'pull', now: 3, compareWithMain });
  const thread = store.itemThread(board, item.item_id).map(fact => fact.text ?? '').join(' | ');
  assert.equal(posted.applied.outcome, 'review', `${JSON.stringify(posted.applied)} ${thread}`);
  const repairs = board.db.prepare("SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").all();
  assert.equal(repairs.length, 1, thread);
  assert.deepEqual(posted.applied.knownMainReworks.map(row => row.file), [FILE]);
  assert.equal(posted.applied.knownMainReworks[0].item, repairs[0].item_id);
  assert.match(thread, /filed by this submit/u);
});
