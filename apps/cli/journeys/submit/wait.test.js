import { withBoardRead } from '../../index.js';
import { retrySync } from '../../index.js';
/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import * as nativeBoard from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { context } from '../../index.js';
import { waitForSubmissionVerdict } from '../../../../packages/items/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../packages/state/index.js';
import { REJECTED_WORK_RETURN_ENGINE } from '../../../../packages/state/light.js';
import { scanHealthSentinel } from '../../../../packages/sentinels/index.js';
import { firstRefusal } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const waitPorts = { withBoardRead, retrySync, events: store.events, verdictsFor: store.verdictsFor, getItem: store.getItem };
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Read one private board without retaining a lock while a real CLI child runs. */
function onBoard(box, action, clock) {
  // @pullboard-board-file journey: observe the real CLI child's persisted submission and verdict without retaining its lock.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
  try { return action(board); } finally { store.closeBoard(board); }
}

/** Submit through the public CLI, then independently record a real verdict for queue-return tests. */
async function waitingVerdict(t, decision, { command = 'submit', json = false, builderHeartbeatOffsetMs = 0 } = {}) {
  const box = helpers.project('true');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Wait for the verdict', '--specs', 'G1', '--route', 'mid',
    '--brief', 'Files:\n- web/wait.txt\nChange:\n- add the submitted fixture file\nTest:\n- the fixture check accepts the submitted source\n',
    '--criterion', 'The fixture check passes.', '--check', 'true')).code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/wait.txt', 'submitted work\n', 'feat(web): await verdict [G1]').status, 0);
  const child = helpers.launch(box, box.web, process.execPath, [helpers.BIN, command, '1', '--wait', ...(json ? ['--json'] : [])]);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await child.closed;
  });
  await helpers.waitFor(() => child.exitCode !== null || onBoard(box, board => store.getItem(board, 1).item_status === 'submitted'), 'a public submission or its actionable refusal', 30_000); // budget: detached submit completion ceiling under concurrent gate load.
  assert.equal(onBoard(box, board => store.getItem(board, 1).item_status), 'submitted', child.stderrText);
  await helpers.waitFor(() => child.exitCode !== null, 'the final gate to end submit before any verdict', 30_000); // budget: detached submit completion ceiling under concurrent gate load.
  await child.closed;
  assert.equal(child.exitCode, 0, child.stdoutText + child.stderrText);
  assert.equal(onBoard(box, board => store.verdictsFor(board, 1).length), 0, 'gate completion requires no review');
  // A green submit starts a detached review comparison that records two facts (pending, then its result) on its own clock;
  // a verdict or health scan made before the second would be raced by it and read as a board change mid-scan.
  await helpers.waitFor(() => onBoard(box, board => board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind = 'fact' AND event_detail LIKE '%Review comparison%'").get().n >= 2),
    'the background review comparison to record its result');
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
  assert.equal(child.exitCode, 0, 'a later independent verdict does not change the completed gate result');
  if (json) {
    const document = JSON.parse(child.stdoutText);
    assert.equal(document.id, 1);
    assert.ok(document.commit);
    assert.ok(document.pin);
    assert.ok(document.gate);
    assert.equal(document.verdict, undefined, 'submit reports its gate independently of a later review');
  }
  assert.ok(onBoard(box, board => store.verdictsFor(board, 1)).some(row => row.verdict_decision === decision
    && row.verdict_note === note), 'the actual independent verdict and note remain on the board');
  return box;
}

test('submit --wait ends at its gate, and a later unclaimed reject returns with its note [V2,V4,B5,B13,A6]', async t => {
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
  // The window waits only for a builder who can come back; a gone seat's window ends at once (18a0128eb0, #3447).
  onBoard(box, board => heartbeatSeat(board, store.getItem(board, 1).item_built_by), clock);
  // A rejection reserves nothing since #4950: no builder window is sealed, so any seat could claim it at once.
  assert.equal(onBoard(box, board => firstRefusal(board, 1), clock), null, 'a rejection seals no builder window');
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
test('done --wait preserves gate JSON independently of the later accepted verdict [V2,A1]', async t => {
  await waitingVerdict(t, 'ACCEPT', { command: 'done', json: true });
});

/** A withdrawn acceptance must never turn an old attached submission into a successful result. */
test('clause 1: a withdrawn verdict does not finish a submission wait successfully [V2,V6]', async t => {
  const box = await waitingVerdict(t, 'ACCEPT');
  const { item_id: id, item_commit: commit } = onBoard(box, board => store.getItem(board, 1));
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', withdrawVerdict: true,
    note: 'The reviewer withdrew this acceptance after a concrete gap was found.' }));
  const io = { cwd: box.repo, nativeBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, say: () => {}, err: () => {} };
  await assert.rejects(waitForSubmissionVerdict(context(io), id, { id, commit }, receipt, waitPorts),
    error => error.code === 'SUBMISSION_CHANGED');
});

/** Refreezing permits the same SHA again; an older wait must not inherit the newer attempt's verdict. */
test('clause 1: a wait keeps its original receipt across a same-SHA refrozen resubmission [V2,V6]', async t => {
  const box = helpers.project('true');
  assert.equal((await fixtureAdd(box.runLocal, box.repo, 'web', 'Same commit, new attempt', '--specs', 'G1', '--route', 'mid',
    '--brief', 'Files:\n- web/retry.txt\nChange:\n- add the submitted fixture file\nTest:\n- the fixture check accepts the submitted source\n',
    '--criterion', 'The fixture check passes.', '--check', 'true')).code, 0);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/retry.txt', 'same source\n', 'feat(web): pin the attempt [G1]').status, 0);
  const sent = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(sent.code, 0, sent.out + sent.err);
  const submission = JSON.parse(sent.out);
  const receipt = onBoard(box, board => store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'submit'));
  onBoard(box, board => store.reopen(board, 1, { agentId: 'coordinator', note: 'Refreeze the review bar before reviewing this source.' }));
  const refrozen = await box.runLocal(box.repo, 'refreeze', '1');
  assert.equal(refrozen.code, 0, refrozen.out + refrozen.err);
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  const resent = await box.runLocal(box.web, 'submit', '1', '--json');
  assert.equal(resent.code, 0, resent.out + resent.err);
  assert.equal(JSON.parse(resent.out).commit, submission.commit, 'the regression really resubmits the same SHA');
  /** End the later attempt through its real verifier, including cleanup if the old wait stalls. */
  const rejectLaterAttempt = () => onBoard(box, board => store.verify(board, 1, { agentId: 'coordinator', decision: 'REJECT',
    reason: 'BEHAVIOR_MISMATCH', note: 'This verdict belongs only to the later attempt.', policy: 'any', clause: 'The fixture check passes.',
    digest: store.getItem(board, 1).item_frozen_digest, head: submission.commit }));
  const io = { cwd: box.repo, nativeBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, say: () => {}, err: () => {} };
  let superseded;
  const originalWait = waitForSubmissionVerdict(context(io), submission.id, submission, receipt, waitPorts)
    .catch(error => { superseded = error; });
  t.after(async () => {
    if (!superseded) rejectLaterAttempt();
    await originalWait;
  });
  await helpers.waitFor(() => superseded, 'the original wait to refuse a later pending same-SHA submission');
  assert.equal(superseded.code, 'SUBMISSION_CHANGED', 'a later pending attempt cannot keep the old wait attached');
  rejectLaterAttempt();
  await assert.rejects(waitForSubmissionVerdict(context(io), submission.id, submission, receipt, waitPorts),
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
    const board = openBoard(join(box.dir, `return-${name}.sqlite`), clock);
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
test('clause 1: the public coordinator health scan returns an inactive reject to the queue [B13,A6]', async t => {
  const box = await waitingVerdict(t, 'REJECT', { builderHeartbeatOffsetMs: -31 * 60_000 });
  assert.equal(onBoard(box, board => firstRefusal(board, 1)), null, 'a rejection reserves nothing for the inactive builder');
  const ran = await box.runLocal(box.repo, 'sentinel', 'run', '--health-only', '--json');
  assert.equal(ran.code, 0, ran.out + ran.err);
  assert.ok(JSON.parse(ran.out).health.findings.some(finding => finding.cause === 'REWORK_UNCLAIMED' && finding.item === 1));
  onBoard(box, board => {
    assert.equal(firstRefusal(board, 1), null);
    assert.ok(store.events(board, { itemId: 1 }).some(event => event.event_kind === 'reject_returned'));
    assert.ok(store.allShouts(board).some(shout => shout.shout_to === 'coordinator'
      && shout.shout_text.includes('The fixture deliberately rejects this concrete clause.')));
  });
});
