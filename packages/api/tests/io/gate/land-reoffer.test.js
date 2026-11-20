/** A settled land job starts the lander again when line settings batch landings, so items accepted meanwhile go out together; the line defaults change nothing [C7,#12185]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';
import { provideLandingStart } from '../../../index.js';

const STAMP = '2026-11-19T12:00:00.000Z';
const CONFIG = { trunk: { remote: '/trunk.git' } };
const TRUNK = 'b'.repeat(40);

/**
 * A real repo's file board with item 7 accepted (frozen at the pace asked; steady freezes no pace), the line settings
 * asked, and one land job for item 7 offered and claimed by a runner, ready for its receipt.
 */
function claimedLanding(t, { line = {}, pace = null } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const commit = repo.commit;
  // A red receipt returns its item as the coordinator and tells its builder, so both are registered seats.
  store.board_ensureCoordinator(board, repo.root);
  const builder = cellSeat(board, { lane: 'core', path: `${repo.root}/seat` }).id;
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(commit, 'd'.repeat(64), commit, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner=?, item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by=?, item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(commit, builder, JSON.stringify(pace ? { pace } : {}), 'd'.repeat(64), builder);
  board.db.exec('DELETE FROM temp.moving');
  for (const [key, value] of Object.entries(line)) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`line_setting:${key}`, JSON.stringify(value));
  const job = offerLandingJob(board.db, { items: [{ id: 7, commit, ref: 'refs/pullboard/land/7' }], expect: commit, config: CONFIG });
  const lease = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  assert.equal(lease?.job, job.id, 'the runner pulls the offered land job');
  return { board, repo, job, lease };
}

/** Provide a starter that records each request, as `pullboard serve` provides its lander; reset when the test ends. */
function recordingStarter(t) {
  const calls = [];
  provideLandingStart(request => { calls.push(request); });
  t.after(() => provideLandingStart(null));
  return calls;
}

/** Post the land receipt on the serve request path, then wait for the starter's turn; returns the answer and what the board now holds. */
async function post({ board, job, lease }, receipt) {
  const answer = boardJobQueueCall(board, { action: 'receipt', job: job.id, runner: 'r-land', token: lease.token, receipt }, { mode: 'pull', now: 3 });
  // The starter runs from an immediate the apply queued, in a microtask of that turn; the next immediate runs after it.
  await new Promise(resolve => setImmediate(resolve));
  const events = board.db.prepare('SELECT event_kind AS kind, item_id AS item FROM event ORDER BY event_id').all().map(row => ({ ...row }));
  const item = { ...board.db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = 7').get() };
  return { answer, events, item };
}

const LANDED = { version: 1, status: 0, outcome: 'landed', trunk: TRUNK, landed: [7], already: [] };
const STOPPED = { version: 1, status: 1, outcome: 'red', detail: 'web/a.test.js: case failed on the merged tree' };

test('api.gate.land-reoffer.starts-after-settle: clause 1: with line.landingBatchSize above 1, a landed receipt posted through boardJobQueueCall merges the item and then calls the served landing starter once with the board root [C7,#12185]', async t => {
  const calls = recordingStarter(t);
  const landing = claimedLanding(t, { line: { landingBatchSize: 4 }, pace: 'sprint' });
  const { answer, events, item } = await post(landing, LANDED);
  assert.deepEqual(answer.applied?.merged, [7], JSON.stringify(answer));
  assert.equal(item.item_merged_commit, TRUNK);
  assert.ok(events.some(row => row.kind === 'main-moved'), 'main-moved is written before the start');
  assert.deepEqual(calls, [{ root: landing.repo.root, item: null }], 'the lander is started once, for every waiting item');
});

test('api.gate.land-reoffer.starts-after-stopped-job: clause 1: with line.collisionFreeBatch on, a stopped (red) land job receipt returns the item and calls the served landing starter once [C7,#12185]', async t => {
  const calls = recordingStarter(t);
  const landing = claimedLanding(t, { line: { collisionFreeBatch: true } });
  const { answer, item } = await post(landing, STOPPED);
  assert.deepEqual(answer.applied?.returned, [7], JSON.stringify(answer));
  assert.notEqual(item.item_status, 'verified', 'the red job returned its item');
  assert.equal(calls.length, 1, 'the settled job starts the lander once');
  assert.equal(calls[0].root, landing.repo.root);
});

test('api.gate.land-reoffer.defaults-unchanged: clause 2: with the line defaults (and with landingBatchSize 1), landed and stopped receipts call no starter and write the same board rows as with no starter at all, for steady and sprint items alike [C7,#12185]', async t => {
  for (const pace of [null, 'sprint']) {
    for (const line of [{}, { landingBatchSize: 1, collisionFreeBatch: false }]) {
      for (const receipt of [LANDED, STOPPED]) {
        const plain = await post(claimedLanding(t, { line, pace }), receipt);
        const calls = recordingStarter(t);
        const served = await post(claimedLanding(t, { line, pace }), receipt);
        provideLandingStart(null);
        const what = `${pace ?? 'steady'} ${JSON.stringify(line)} ${receipt.outcome}`;
        assert.deepEqual(calls, [], `${what}: no starter call`);
        assert.deepEqual(served.events, plain.events, `${what}: the same events`);
        assert.deepEqual(served.item, plain.item, `${what}: the same item row`);
        assert.deepEqual(served.answer.applied, plain.answer.applied, `${what}: the same answer`);
      }
    }
  }
});
