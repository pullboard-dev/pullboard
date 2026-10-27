/** Submission verdict delivery and deterministic rejected-work return [V2,V4,B5,B13,A6]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
import { loadConfig } from '../src/config.js';
import { healthReport } from '../src/health.js';
import { heartbeatSeat } from '../src/seat-presence.js';
import { createE2eHelpers } from './e2e-helpers.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Read one private board without retaining a lock while a real CLI child runs. */
function onBoard(box, action, clock) {
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
    reason: decision === 'ACCEPT' ? 'CRITERION_MET' : 'BEHAVIOR_MISMATCH', note, policy: 'any', check: 'green', reopenFirstRefusalMinutes: 30 }));
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
  const before = onBoard(box, board => healthReport({ db: board.db, root: box.repo, config, now }), clock);
  assert.ok(!before.stuck.some(finding => finding.item === 1 && finding.cause === 'REWORK_UNCLAIMED'),
    'the ten-minute boundary is not rounded down');
  now = new Date(start + 10 * 60_000);
  const due = onBoard(box, board => healthReport({ db: board.db, root: box.repo, config, now }), clock);
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
