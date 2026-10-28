/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import { dispatchHealth } from '../src/dispatch-health.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { healthReport } from '../src/health.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { context } from '../src/cli-read-context.js';
import { waitForSubmissionVerdict } from '../src/submit-wait.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { prepareEngineMove, applyRelayMove } from '../src/engine.js';
import { REJECTED_WORK_RETURN_ENGINE } from '../src/rejected-work-return-engine.js';
import { scanHealthSentinel } from '../src/health-sentinel.js';
import { firstRefusal } from '../src/board-item-read.js';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Read one private board without retaining a lock while a real CLI child runs. */
function onBoard(box, action, clock) {
  // @pullboard-board-file journey: observe the real CLI child's persisted submission and verdict without retaining its lock.
  const board = store.openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Submit through the public CLI and let a real recorded verdict release its waiting child. */
async function waitingVerdict(t, decision, { command = 'submit', json = false, builderHeartbeatOffsetMs = 0 } = {}) {
  const box = helpers.project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Wait for the verdict', '--specs', 'G1',
    '--criterion', 'The fixture check passes.', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/wait.txt', 'submitted work\n', 'feat(web): await verdict [G1]').status, 0);
  const child = helpers.launch(box, box.web, process.execPath, [helpers.BIN, command, '1', '--wait', ...(json ? ['--json'] : [])]);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await child.closed;
  });
  await helpers.waitFor(() => child.exitCode !== null || onBoard(box, board => store.getItem(board, 1).item_status === 'submitted'),
    'a public submission or its actionable refusal');
  assert.equal(onBoard(box, board => store.getItem(board, 1).item_status), 'submitted', child.stderrText);
  assert.equal(child.exitCode, null, '--wait stays attached until the verdict, not only until submission');
  const note = decision === 'ACCEPT' ? 'The submitted fixture meets its bar.' : 'The fixture deliberately rejects this concrete clause.';
  if (builderHeartbeatOffsetMs) {
    onBoard(box, board => heartbeatSeat(board, store.getItem(board, 1).item_built_by),
      { now: () => new Date(Date.now() + builderHeartbeatOffsetMs) });
  }
  onBoard(box, board => store.verify(board, 1, { agentId: 'coordinator', decision,
    digest: store.getItem(board, 1).item_frozen_digest, head: store.getItem(board, 1).item_commit,
    reason: decision === 'ACCEPT' ? 'CRITERION_MET' : 'BEHAVIOR_MISMATCH', note, policy: 'any', check: 'green', reopenFirstRefusalMinutes: 30,
    ...(decision === 'REJECT' ? { clause: 'The fixture check passes.' } : {}) }));
  await helpers.waitFor(() => child.exitCode !== null, 'the verdict to end the attached submit');
  await child.closed;
  assert.equal(child.exitCode, decision === 'ACCEPT' ? 0 : 1, 'reject is actionable failure; accept succeeds');
  if (json) {
    const document = JSON.parse(child.stdoutText);
    assert.equal(document.id, 1);
    assert.ok(document.commit);
    assert.ok(document.pin);
    assert.ok(document.gate);
    assert.equal(document.verdict.verdict_decision, decision);
    assert.equal(document.verdict.verdict_note, note);
  }
  assert.match(child.stdoutText + child.stderrText, new RegExp(decision, 'iu'));
  assert.ok((child.stdoutText + child.stderrText).includes(note), 'the builder receives the actual recorded verdict note');
  return box;
}

test('submit --wait prints the verdict, and an unclaimed reject returns to the queue with its note [V2,V4,B5,B13,A6]', async t => {
  await waitingVerdict(t, 'ACCEPT');
  const box = await waitingVerdict(t, 'REJECT');
  const rejected = onBoard(box, board => store.events(board).findLast(event => event.event_kind === 'reject'));
  const start = Date.parse(rejected.event_at);
  let now = new Date(start + 10 * 60_000 - 1);
  const clock = { now: () => now };
  const nextPath = join(box.dir, 'next-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', nextPath, 'main');
  const nextActor = onBoard(box, board => store.register(board, { lane: 'web', path: nextPath }));
  const config = loadConfig(box.repo);
  assert.throws(() => onBoard(box, board => store.claim(board, 1, { agentId: nextActor, lane: 'web', leaseMs: 60_000 }), clock),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER', 'another builder cannot steal the original first refusal early');
  onBoard(box, board => heartbeatSeat(board, store.getItem(board, 1).item_built_by), clock);
  const before = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  assert.ok(!before.stuck.some(finding => finding.item === 1 && finding.cause === 'REWORK_UNCLAIMED'),
    'the ten-minute boundary is not rounded down');
  now = new Date(start + 10 * 60_000);
  const due = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  const finding = due.stuck.find(entry => entry.item === 1 && entry.cause === 'REWORK_UNCLAIMED');
  assert.ok(finding, 'an unreclaimed reject interrupts the coordinator at ten minutes');
  assert.equal(finding.owner.who, 'coordinator');
  assert.ok(finding.why.includes('The fixture deliberately rejects this concrete clause.'), 'queue return retains the reviewer note');
  onBoard(box, board => {
    const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision, findings: due.stuck, returnRejected: true });
    const afterReturn = store.events(board).length;
    const currentRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: currentRevision,
      findings: due.stuck, returnRejected: true });
    assert.equal(store.events(board).length, afterReturn, 'an unchanged scan never returns or notifies twice');
    store.claim(board, 1, { agentId: nextActor, lane: 'web', leaseMs: 60_000 });
    assert.equal(store.getItem(board, 1).item_owner, nextActor, 'the next builder really receives the rejected item');
    assert.ok(store.verdictsFor(board, 1).some(entry => entry.verdict_decision === 'REJECT'
      && entry.verdict_note === 'The fixture deliberately rejects this concrete clause.'), 'return preserves the original rejection');
  }, clock);
});

/** The historical alias retains the same versioned submission fields while returning its verdict. */
test('done --wait preserves submission JSON and prints the exact accepted verdict [V2,A1]', async t => {
  await waitingVerdict(t, 'ACCEPT', { command: 'done', json: true });
});

/** A withdrawn acceptance must never turn an old attached submission into a successful result. */
test('a withdrawn verdict does not finish a submission wait successfully [V2,V6]', async t => {
  const box = await waitingVerdict(t, 'ACCEPT');
  const { item_id: id, item_commit: commit } = onBoard(box, board => store.getItem(board, 1));
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', withdrawVerdict: true,
    note: 'The reviewer withdrew this acceptance after a concrete gap was found.' }));
  const io = { cwd: box.repo, say: () => {}, err: () => {} };
  await assert.rejects(waitForSubmissionVerdict(context(io), id, { id, commit }, receipt),
    error => error.code === 'SUBMISSION_CHANGED');
});

/** Refreezing permits the same SHA again; an older wait must not inherit the newer attempt's verdict. */
test('a wait keeps its original receipt across a same-SHA refrozen resubmission [V2,V6]', async t => {
  const box = helpers.project('true');
  assert.equal(box.run(box.repo, 'add', 'web', 'Same commit, new attempt', '--specs', 'G1',
    '--criterion', 'The fixture check passes.', '--check', 'true').code, 0);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/retry.txt', 'same source\n', 'feat(web): pin the attempt [G1]').status, 0);
  const sent = box.run(box.web, 'submit', '1', '--json');
  assert.equal(sent.code, 0, sent.out + sent.err);
  const submission = JSON.parse(sent.out);
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', note: 'Refreeze the review bar before reviewing this source.' }));
  const refrozen = box.run(box.repo, 'refreeze', '1');
  assert.equal(refrozen.code, 0, refrozen.out + refrozen.err);
  assert.equal(box.run(box.web, 'claim', '1').code, 0);
  const resent = box.run(box.web, 'submit', '1', '--json');
  assert.equal(resent.code, 0, resent.out + resent.err);
  assert.equal(JSON.parse(resent.out).commit, submission.commit, 'the regression really resubmits the same SHA');
  /** End the later attempt through its real verifier, including cleanup if the old wait stalls. */
  const rejectLaterAttempt = () => onBoard(box, board => store.verify(board, 1, { agentId: 'coordinator', decision: 'REJECT',
    reason: 'BEHAVIOR_MISMATCH', note: 'This verdict belongs only to the later attempt.', policy: 'any', clause: 'The fixture check passes.',
    digest: store.getItem(board, 1).item_frozen_digest, head: submission.commit }));
  const io = { cwd: box.repo, say: () => {}, err: () => {} };
  let superseded;
  const originalWait = waitForSubmissionVerdict(context(io), submission.id, submission, receipt)
    .catch(error => { superseded = error; });
  t.after(async () => {
    if (!superseded) rejectLaterAttempt();
    await originalWait;
  });
  await helpers.waitFor(() => superseded, 'the original wait to refuse a later pending same-SHA submission');
  assert.equal(superseded.code, 'SUBMISSION_CHANGED', 'a later pending attempt cannot keep the old wait attached');
  rejectLaterAttempt();
  await assert.rejects(waitForSubmissionVerdict(context(io), submission.id, submission, receipt),
    error => error.code === 'SUBMISSION_CHANGED');
});

/** An already-gone builder returns immediately; only the coordinator can authorize that observation. */
test('an inactive builder returns its rejected item before ten minutes [B13,A6,H2]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const config = loadConfig(box.repo);
  const due = onBoard(box, board => healthReport({ dispatchHealth, db: board.db, root: box.repo, config, now }), clock);
  assert.ok(due.stuck.some(entry => entry.item === 1 && entry.detail.reason === 'inactive'));
  const nextPath = join(box.dir, 'replacement-builder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', nextPath, 'main');
  const nextActor = onBoard(box, board => store.register(board, { lane: 'web', path: nextPath }));
  onBoard(box, board => {
    const revision = () => board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    const before = revision();
    assert.throws(() => store.recordHealthFindings(board, { agentId: nextActor, observedRevision: before,
      findings: due.stuck, returnRejected: true }), error => error.code === 'COORDINATOR_ONLY');
    assert.equal(revision(), before, 'unauthorized return appends no event');
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: before,
      findings: due.stuck, returnRejected: true });
    const returned = store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject_returned');
    const detail = JSON.parse(returned.event_detail);
    assert.equal(detail.rejection, rejected.event_id);
    assert.equal(detail.reason, 'inactive');
    assert.ok(detail.note.includes('deliberately rejects'));
    store.claim(board, 1, { agentId: nextActor, lane: 'web', leaseMs: 60_000 });
    assert.equal(store.getItem(board, 1).item_owner, nextActor);
  }, clock);
});

/** Replica-local liveness cannot rewrite an already authenticated inactive-seat observation. */
test('an unattended reject return replays across different local heartbeats [B13,H2,H16]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const config = loadConfig(box.repo);
  const observation = scanHealthSentinel(join(box.repo, '.git/pullboard/board.sqlite'),
    { root: box.repo, config, now, returnRejected: true });
  assert.ok(observation);
  const document = onBoard(box, board => exportBoard(board));
  const move = onBoard(box, board => prepareEngineMove(board, 'recordHealthFindings',
    [{ agentId: 'coordinator', ...observation }], { id: 'unattended-reject-fixture', actor: 'coordinator' }), clock);
  const copies = ['live', 'gone'].map(name => {
    // @pullboard-board-file persistence: replay one sealed return into separate databases with different private heartbeat sidecars.
    const board = store.openBoard(join(box.dir, `return-${name}.sqlite`), clock);
    importBoard(board, document);
    t.after(() => store.closeBoard(board));
    return board;
  });
  heartbeatSeat(copies[0], store.getItem(copies[0], 1).item_built_by);
  assert.equal(store.listAgents(copies[0]).find(seat => seat.agent_id === store.getItem(copies[0], 1).item_built_by).presence, 'live');
  assert.equal(store.listAgents(copies[1]).find(seat => seat.agent_id === store.getItem(copies[1], 1).item_built_by).presence, 'gone');
  const order = { sequence: 1, at: now.toISOString(), kind: 'move',
    sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } };
  const before = exportBoard(copies[0]);
  assert.throws(() => applyRelayMove(copies[0], { ...move, engine: REJECTED_WORK_RETURN_ENGINE - 1 }, order),
    error => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(copies[0]), before, 'downgrade refuses before any board mutation');
  const results = copies.map(board => applyRelayMove(board, move, order));
  assert.equal(results[0].error, undefined, JSON.stringify(results[0]));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(exportBoard(copies[0]), exportBoard(copies[1]));
  for (const board of copies) {
    assert.equal(firstRefusal(board, 1), null);
    const after = exportBoard(board);
    assert.deepEqual(applyRelayMove(board, move, order), results[0]);
    assert.deepEqual(exportBoard(board), after, 'a replayed receipt appends nothing twice');
  }
});

/** Revision and episode guards both protect a builder who already reclaimed the rejected work. */
test('a reclaimed reject refuses both stale and retargeted health observations [B13,H16]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  const rejected = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reject'));
  const now = new Date(Date.parse(rejected.event_at) + 1000);
  const clock = { now: () => now };
  const observation = scanHealthSentinel(join(box.repo, '.git/pullboard/board.sqlite'),
    { root: box.repo, config: loadConfig(box.repo), now, returnRejected: true });
  onBoard(box, board => {
    const builder = store.getItem(board, 1).item_built_by;
    store.claim(board, 1, { agentId: builder, lane: 'web', leaseMs: 60_000 });
    const before = exportBoard(board);
    assert.throws(() => store.recordHealthFindings(board, { agentId: 'coordinator', ...observation }),
      error => error.code === 'HEALTH_SCAN_STALE');
    assert.deepEqual(exportBoard(board), before);
    const observedRevision = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM event').get().n;
    assert.throws(() => store.recordHealthFindings(board, { agentId: 'coordinator', ...observation, observedRevision }),
      error => error.code === 'HEALTH_SCAN_STALE');
    assert.deepEqual(exportBoard(board), before, 'updating only the revision cannot retarget the old rejection');
    assert.equal(store.getItem(board, 1).item_owner, builder);
  }, clock);
});

/** The existing public coordinator scan, rather than a direct test-only move, performs the handback. */
test('the public coordinator health scan returns an inactive reject to the queue [B13,A6]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  assert.ok(onBoard(box, board => firstRefusal(board, 1)), 'the original reservation is still live');
  const ran = box.run(box.repo, 'sentinel', 'run', '--health-only', '--json');
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.ok(JSON.parse(ran.out).health.findings.some(finding => finding.cause === 'REWORK_UNCLAIMED' && finding.item === 1));
  onBoard(box, board => {
    assert.equal(firstRefusal(board, 1), null);
    assert.ok(store.events(board, { itemId: 1 }).some(event => event.event_kind === 'reject_returned'));
    assert.ok(store.allShouts(board).some(shout => shout.shout_to === 'coordinator'
      && shout.shout_text.includes('The fixture deliberately rejects this concrete clause.')));
  });
});
