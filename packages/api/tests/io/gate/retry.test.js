/** A sharded gate red only in cases new against main reruns just those files once before the red applies, behind a port off by default [C7,P7,#11712]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { headTree } from '../../../../git/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { shardJobs } from '../../../index.js';
import { retryNewReds } from '../../../src/io/gate/retry.js';

const FILES = ['web/a.test.js', 'web/b.test.js', 'web/c.test.js', 'web/d.test.js'];
const ENVIRONMENT = { node: process.version, platform: process.platform, arch: process.arch };
const RED = { file: 'web/a.test.js', name: 'loads under load' };
/** The main-receipt lookup of a board whose main has a receipt for each file and fails none of its cases: every red case is new. */
const NEW_AGAINST_MAIN = ({ cases }) => ({ classes: [...new Set(cases.map(row => row.file))].map(file => ({ file, owner: 'item', own: [], receipt: null, job: null })) });

const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0 }] } });
const red = (head, failures = [RED]) => ({ version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1, failures, tail: 'not ok' }] } });

/**
 * A claimed item whose gate passed its check and offered four shards. Shards post in order: the first with `first`, the
 * others green. The last post's result comes back as `last`.
 */
function shardedGate(t, { first = head => red(head), options = {} } = {}) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit, tree = headTree(repo.root);
  const parent = `gate:${item.item_id}:retry`;
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { entry: 'gate.js', data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-gate', capabilities: [], now: 2 });
  const gate = { version: 1, source: head, green: false, environment: ENVIRONMENT, phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: 'node --test' },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES } };
  const sharded = boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'r-gate', token: lease.token, receipt: { status: 0, gate } }, { mode: 'pull', now: 3, ...options });
  assert.equal(sharded.applied.outcome, 'sharded', JSON.stringify(sharded.applied));
  let last = null;
  sharded.applied.shards.forEach((shard, index) => {
    const at = 10 * (index + 1);
    const claimed = claimJob(board.db, { runner: `r-${at}`, capabilities: [], now: at });
    assert.equal(claimed?.job, shard);
    const receipt = index === 0 ? first(head) : green(head);
    last = boardJobQueueCall(board, { action: 'receipt', job: shard, runner: `r-${at}`, token: claimed.token, receipt }, { mode: 'pull', now: at + 1, ...options }).applied;
  });
  /** Pull the retry shard, if one was offered, and post its receipt. */
  const rerun = receipt => {
    const claimed = claimJob(board.db, { runner: 'r-retry', capabilities: [], now: 100 });
    if (!claimed) return null;
    return { job: claimed.job, applied: boardJobQueueCall(board, { action: 'receipt', job: claimed.job, runner: 'r-retry', token: claimed.token, receipt: receipt(head) }, { mode: 'pull', now: 101, ...options }).applied };
  };
  return { board, item, parent, head, last, rerun, seat };
}

const ON = { retryNewRedsOnce: true, compareWithMain: NEW_AGAINST_MAIN };

test('api.gate-retry.offers-one-retry-shard: clause 1: a red whose every case is new against main offers one retry shard carrying only the failing files [C7,P7,#11712]', t => {
  const f = shardedGate(t, { options: {} });
  const compared = { cases: [{ phase: 'proof', file: 'web/a.test.js', name: 'x', onMain: false }, { phase: 'proof', file: 'web/b.test.js', name: 'y', onMain: false }] };
  const result = retryNewReds(f.board, { parent: f.parent, combined: {}, compared });
  assert.deepEqual(result, { retried: true });
  const retry = shardJobs(f.board.db, f.parent).filter(row => row.job_id === `${f.parent}:shard:retry`);
  assert.equal(retry.length, 1, 'one retry job');
  const request = JSON.parse(f.board.db.prepare("SELECT job_step_payload AS p FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(retry[0].job_id).p).request;
  assert.deepEqual(request.input.data.shard.files, ['web/a.test.js', 'web/b.test.js']);
  assert.equal(request.input.data.shard.command, "node --test './web/a.test.js' './web/b.test.js'");
});

test('api.gate-retry.second-call-does-not-retry: clause 1: a second call, a case on main or unknown, or more than three failing files offers no retry [C7,P7,#11712]', t => {
  const f = shardedGate(t, { options: {} });
  const one = onMain => ({ cases: [{ phase: 'proof', file: 'web/a.test.js', name: 'x', onMain }] });
  assert.deepEqual(retryNewReds(f.board, { parent: f.parent, combined: {}, compared: one(true) }), { retried: false });
  assert.deepEqual(retryNewReds(f.board, { parent: f.parent, combined: {}, compared: one(null) }), { retried: false });
  assert.deepEqual(retryNewReds(f.board, { parent: f.parent, combined: {}, compared: { cases: FILES.map(file => ({ phase: 'proof', file, name: 'x', onMain: false })) } }), { retried: false }, 'four files');
  assert.deepEqual(retryNewReds(f.board, { parent: f.parent, combined: {}, compared: one(false) }), { retried: true });
  assert.deepEqual(retryNewReds(f.board, { parent: f.parent, combined: {}, compared: one(false) }), { retried: false }, 'the second call');
});

test('api.gate-retry.green-retry-settles-review: clause 2: a green retry shard settles the gate review, replacing the red shard, and notes the retried files [C7,P7,#11712]', t => {
  const f = shardedGate(t, { options: ON });
  assert.equal(f.last.outcome, 'retrying', JSON.stringify(f.last));
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'claimed', 'nothing applied yet');
  assert.equal(f.board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'note:shards.settled'").get(f.parent).n, 0, 'no settled note while retrying');
  const retry = f.rerun(head => ({ ...green(head), gate: { ...green(head).gate, shard: { files: ['web/a.test.js'] } } }));
  assert.equal(retry.job, `${f.parent}:shard:retry`);
  assert.equal(retry.applied.outcome, 'review', JSON.stringify(retry.applied));
  assert.equal(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
  const notes = store.events(f.board, { itemId: f.item.item_id }).filter(row => /rerun once by the board/u.test(row.event_detail ?? ''));
  assert.equal(notes.length, 1, 'one note fact');
  assert.match(notes[0].event_detail, /web\/a\.test\.js/u);
});

test('api.gate-retry.red-retry-keeps-red: clause 2: a red retry shard applies the original red unchanged and offers no second retry [C7,P7,#11712]', t => {
  const f = shardedGate(t, { options: ON });
  assert.equal(f.last.outcome, 'retrying');
  const retry = f.rerun(head => red(head));
  assert.equal(retry.applied.outcome, 'red', JSON.stringify(retry.applied));
  assert.notEqual(store.getItem(f.board, f.item.item_id).item_status, 'submitted', 'the red did not submit the item');
  assert.equal(shardJobs(f.board.db, f.parent).filter(row => row.job_id.endsWith(':shard:retry')).length, 1, 'only the one retry');
});

test('api.gate-retry.port-off-red-applies: clause 3: with the port off the same red applies at once and no retry job exists [C7,P7,#11712]', t => {
  const f = shardedGate(t, { options: { compareWithMain: NEW_AGAINST_MAIN } });
  assert.equal(f.last.outcome, 'red', JSON.stringify(f.last));
  assert.equal(shardJobs(f.board.db, f.parent).filter(row => row.job_id.endsWith(':shard:retry')).length, 0);
});
