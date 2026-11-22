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
import { applyShardReceipt } from '../../../src/io/gate.js';
import { offeredStep } from '../../../src/io/gate.js';
import { postedReceipt } from '../../../src/io/gate.js';
import { jobQueueCall } from '../../../src/io/jobs.js';
import { endJob } from '../../../../jobs/index.js';

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

test('api.gate-owner.retry-dispatches-authenticated-owner: clause 1: a routed fixture failure retries only its selected wrapper and retains the defining fixture separately [C7]', t => {
  const f = shardedGate(t, { options: {} });
  const owner = FILES[0], source = 'tests/fixtures/shared.js';
  const result = retryNewReds(f.board, { parent: f.parent, combined: {}, compared: { cases: [{ phase: 'proof', file: owner, caseFile: source,
    name: 'shared case [C7]', signature: 'b'.repeat(64), shard: `${f.parent}:shard:1`, attempt: 1, head: f.head, onMain: false }] } });
  assert.deepEqual(result, { retried: true });
  const retry = shardJobs(f.board.db, f.parent).find(row => row.job_id === `${f.parent}:shard:retry`);
  const request = JSON.parse(f.board.db.prepare("SELECT job_step_payload AS p FROM job_step WHERE job_step_job = ? AND job_step_name = 'offered' AND job_step_seq = 0").get(retry.job_id).p).request;
  assert.deepEqual(request.input.data.shard.files, [owner], 'the retry selects the authenticated owner only');
  assert.equal(request.input.data.shard.command, `node --test './${owner}'`, 'the fixture is never dispatched');
});

/** A native-shaped shard receipt; cancellation deliberately has no complete failure or outcome account. */
function recoveryReceipt(head, selection, result = 'green') {
  const status = result === 'green' ? 0 : 1;
  const phase = { role: 'proof', status, signal: null, sha256: 'a'.repeat(64), bytes: 100,
    tail: result === 'unknown' ? '# pass 2\n# fail 1\n# cancelled 1' : status ? '# pass 2\n# fail 1\n# cancelled 0' : '# pass 3\n# fail 0\n# cancelled 0',
    ...(result === 'unknown' ? { failures: null, errors: [{ file: selection.files[0], name: 'cancelled child', message: 'cancelled' }] }
      : result === 'red' ? { failures: [{ file: selection.files[0], name: 'retained red [C7]' }], failureSignatures: ['b'.repeat(64)] } : {}) };
  return { version: 1, status, gate: { kind: 'shard', main: head, source: head, green: !status,
    shard: { index: selection.index, of: selection.of, files: selection.files }, phases: [phase], environment: ENVIRONMENT } };
}

/** A real claimed board and authenticated parent/shard posts, leaving the last apply to the caller. */
function recoveryGate(t, results = ['unknown', 'green', 'green', 'green']) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Recover one incomplete proof' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id), head = repo.commit, tree = headTree(repo.root);
  const parent = `gate:${item.item_id}:incomplete`;
  const trusted = { run: ['true'], commits: [head], input: { main: head, entry: 'gate.js', data: { main: head, source: head } },
    submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } };
  offerJob(board.db, { id: parent, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1, request: trusted });
  const lease = claimJob(board.db, { runner: 'parent-runner', capabilities: [], now: 2 });
  const receipt = { status: 0, gate: { source: head, main: head, green: false, environment: ENVIRONMENT,
    phases: [{ role: 'check', status: 0 }], analysis: { proofFiles: FILES, proofCommand: 'node --test' },
    proofPlan: { runner: 'node --test', cores: 1, files: FILES, account: true, timing: FILES, needs: { browser: [FILES[0]], gui: [] } } } };
  const first = boardJobQueueCall(board, { action: 'receipt', job: parent, runner: 'parent-runner', token: lease.token, receipt }, { mode: 'pull', now: 3 });
  assert.equal(first.applied.outcome, 'sharded');
  const originals = first.applied.shards;
  originals.forEach((job, index) => {
    const runner = `original-${index}`, at = 10 + index * 10;
    const claim = claimJob(board.db, { runner, capabilities: [], now: at });
    assert.equal(claim.job, job);
    const selection = offeredStep(board.db, job).request.input.data.shard;
    jobQueueCall(board.db, { action: 'receipt', job, runner, token: claim.token, receipt: recoveryReceipt(head, selection, results[index]) }, { mode: 'pull', now: at + 1 });
  });
  const snapshots = originals.map(job => JSON.stringify(postedReceipt(board.db, job)));
  const apply = (mode = 'pull') => applyShardReceipt(board, { job: originals.at(-1) }, { shardRecoveryMode: mode, receiptNow: 90, settleOnMainReceipt: true, compareWithMain: NEW_AGAINST_MAIN });
  const replacement = `${parent}:shard:unknown:1`;
  const post = (result = 'green', change = receipt => receipt) => {
    const runner = 'replacement-runner';
    const claim = claimJob(board.db, { runner, capabilities: [], now: 100 });
    assert.equal(claim?.job, replacement, 'only the incomplete shard is re-offered');
    const selection = offeredStep(board.db, replacement).request.input.data.shard;
    const body = { action: 'receipt', job: replacement, runner, token: claim.token, receipt: change(recoveryReceipt(head, selection, result)) };
    const answer = boardJobQueueCall(board, body, { mode: 'pull', now: 101, settleOnMainReceipt: true, compareWithMain: NEW_AGAINST_MAIN });
    return { answer, body, claim };
  };
  const intact = () => originals.forEach((job, index) => assert.equal(JSON.stringify(postedReceipt(board.db, job)), snapshots[index], 'original receipt remains intact'));
  return { board, item, head, tree, parent, originals, replacement, apply, post, intact };
}

test('api.gate-recovery.single-cancelled-shard: clause 1: one completed cancelled unaccounted shard gets one ordinary exact-selection replacement pinned to parent attempts, candidate tree and trusted tooling [C7,P7]', t => {
  const f = recoveryGate(t);
  assert.equal(f.apply().outcome, 'recovering');
  const original = offeredStep(f.board.db, f.originals[0]);
  const offered = offeredStep(f.board.db, f.replacement);
  const request = structuredClone(offered.request), binding = request.input.data.shard.recovery;
  delete request.input.data.shard.recovery;
  assert.deepEqual(request, original.request, 'command, full selection, trusted run, entry, main, timing, account and capability plan unchanged');
  assert.equal(request.input.data.checkTiming, true);
  assert.equal(request.input.data.shard.account, true);
  assert.equal(request.input.data.shard.plan.browser, true);
  assert.deepEqual(offered.needs, original.needs, 'normal admission needs preserved');
  assert.equal(binding.parent, f.parent);
  assert.equal(binding.parentAttempt, postedReceipt(f.board.db, f.parent).attempt);
  assert.equal(binding.original, f.originals[0]);
  assert.equal(binding.originalAttempt, postedReceipt(f.board.db, f.originals[0]).attempt);
  assert.equal(binding.candidate, f.head);
  assert.equal(binding.main, f.head);
  assert.equal(binding.tree, f.tree);
  assert.equal(f.apply().outcome, 'waiting', 'delayed receipt cannot settle');
  assert.equal(shardJobs(f.board.db, f.parent).length, f.originals.length + 1, 'one offer even on repeated apply');
  const { answer } = f.post();
  assert.equal(answer.applied.outcome, 'review', JSON.stringify(answer.applied));
  assert.equal(answer.applied.recovery.reason, 'replacement-complete-green');
  f.intact();
});

test('api.gate-recovery.mixed-red-green-preserved: clause 2: complete red and green siblings survive a green or complete red replacement and ordinary comparison keeps the parent red [C7,P7]', t => {
  for (const result of ['green', 'red']) {
    const f = recoveryGate(t, ['unknown', 'red', 'green', 'green']);
    assert.equal(f.apply().outcome, 'recovering');
    const { answer } = f.post(result);
    assert.equal(answer.applied.outcome, 'red', JSON.stringify(answer.applied));
    assert.equal(answer.applied.recovery.reason, `replacement-complete-${result}`);
    assert.notEqual(store.getItem(f.board, f.item.item_id).item_status, 'submitted');
    const facts = store.events(f.board, { itemId: f.item.item_id }).map(row => row.event_detail).join('\n');
    assert.match(facts, /web\/b\.test\.js/u, 'the sibling red was retained');
    if (result === 'red') assert.match(facts, /web\/a\.test\.js/u, 'complete replacement red was compared too');
    f.intact();
  }
});

test('api.gate-recovery.invalid-terminal-replacements: clause 2: unknown, cancelled, missing, refused and foreign replacement evidence leaves the original unproved [C7,P7]', t => {
  for (const kind of ['unknown', 'cancelled', 'missing', 'refused', 'foreign-head', 'foreign-main', 'foreign-files']) {
    const f = recoveryGate(t);
    assert.equal(f.apply().outcome, 'recovering');
    let applied;
    if (kind === 'missing') {
      endJob(f.board.db, f.replacement, 'abandoned', { detail: 'replacement ended without proof' }, { now: 100 });
      applied = f.apply();
    } else {
      const { answer } = f.post(kind === 'unknown' ? 'unknown' : 'green', receipt => {
        if (kind === 'cancelled') { receipt.status = 1; receipt.gate.green = false; receipt.gate.phases[0].status = null; receipt.gate.phases[0].signal = 'SIGTERM'; }
        if (kind === 'refused') receipt.gate.error = 'TEST_SELECTION_UNVERIFIED';
        if (kind === 'foreign-head') receipt.gate.source = 'e'.repeat(40);
        if (kind === 'foreign-main') receipt.gate.main = 'e'.repeat(40);
        if (kind === 'foreign-files') receipt.gate.shard.files = ['web/foreign.test.js'];
        return receipt;
      });
      applied = answer.applied;
    }
    assert.notEqual(applied.outcome, 'review', `${kind}: ${JSON.stringify(applied)}`);
    assert.notEqual(store.getItem(f.board, f.item.item_id).item_status, 'submitted', kind);
    assert.equal(shardJobs(f.board.db, f.parent).length, f.originals.length + 1, 'no repeated replacement');
    f.intact();
  }
});

test('api.gate-recovery.duplicate-and-stale-custody: clause 2: duplicate native receipt does not reapply, wrong token is refused, and superseded parent cannot use a delayed replacement [C7,P7]', t => {
  const f = recoveryGate(t);
  assert.equal(f.apply().outcome, 'recovering');
  const runner = 'foreign-runner';
  assert.throws(() => boardJobQueueCall(f.board, { action: 'receipt', job: f.replacement, runner, token: 'wrong', receipt: {} }, { mode: 'pull', now: 99 }), error => error.code === 'JOB_LEASE_MOVED');
  const { answer, body } = f.post('unknown');
  assert.notEqual(answer.applied.outcome, 'review');
  const again = boardJobQueueCall(f.board, body, { mode: 'pull', now: 102 });
  assert.equal(again.recorded, false, 'duplicate native post is not reapplied');
  f.intact();
  const stale = recoveryGate(t);
  assert.equal(stale.apply().outcome, 'recovering');
  offerJob(stale.board.db, { id: `${stale.parent}:newer`, kind: 'gate', item: stale.item.item_id, candidate: stale.head, base: stale.head, now: 99 });
  const delayed = stale.post();
  assert.equal(delayed.answer.applied.outcome, 'stale');
  assert.notEqual(store.getItem(stale.board, stale.item.item_id).item_status, 'submitted');
  stale.intact();
});

test('api.gate-recovery.unsupported-and-incomplete: clause 3: unsupported queue mode or split store and multiple unknown shards offer no replacement [C7,P7]', t => {
  const mode = recoveryGate(t);
  assert.throws(() => boardJobQueueCall(mode.board, { action: 'claim', runner: 'push-runner' }, { mode: 'push' }), error => error.code === 'JOBS_NOT_PULL');
  mode.apply('push');
  assert.equal(shardJobs(mode.board.db, mode.parent).length, mode.originals.length);
  const split = recoveryGate(t);
  split.board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(store.RUNS_STORE_KEY, '1');
  split.apply();
  assert.equal(shardJobs(split.board.db, split.parent).length, split.originals.length);
  const two = recoveryGate(t, ['unknown', 'unknown', 'green', 'green']);
  assert.notEqual(two.apply().outcome, 'recovering');
  assert.equal(shardJobs(two.board.db, two.parent).length, two.originals.length);
});

test('api.gate-recovery.emits-identities-and-final-reason: clause 3: native recovery notes name original and replacement with final reason, without trusted request or token payload [C7,P7]', t => {
  const f = recoveryGate(t);
  assert.equal(f.apply().outcome, 'recovering');
  const { claim, answer } = f.post();
  const facts = store.events(f.board, { itemId: f.item.item_id }).map(row => row.event_detail).filter(text => /single-unaccounted-shard|replacement-complete-green/u.test(text));
  assert.equal(facts.length, 2, JSON.stringify(facts));
  for (const fact of facts) {
    assert.ok(fact.includes(f.originals[0]));
    assert.ok(fact.includes(f.replacement));
    assert.ok(!fact.includes(claim.token));
    assert.ok(!fact.includes('requestDigest'));
    assert.ok(!fact.includes('gate.js'));
  }
  assert.equal(answer.applied.recovery.reason, 'replacement-complete-green');
});
