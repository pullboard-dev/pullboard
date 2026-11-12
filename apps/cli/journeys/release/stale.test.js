/** Real private Git/SQLite fixtures; injected clocks are observations, never operational proof receipts. */
import assert from 'node:assert/strict';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { conditionalHoldFloor } from '../../../../packages/health/index.js';
import {
  runFixtureChildAsync,
  safeFixtureDiagnostic,
} from '../../tests/fixtures/child.js';
import {
  readFileSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';

import { staleStateSnapshot } from '../../../../packages/health/index.js';
import { planStaleState } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  appliedSequence,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { run as statusRun } from '../../index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { STALE_STATE_ENGINE } from '../../../../packages/state/light.js';

const MINUTE = 60_000;

/** Construct genuine private native state while keeping real person settings and boards untouched. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', undefined, { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, health: { sentinel: false } }));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-qm', 'chore: isolate private maintenance fixture');
  let at = Math.ceil(Date.now() / 1000) * 1000;
  const clock = { now: () => new Date(at) };
  /** Create a real private worktree with its HEAD reflog timestamp bound to the injected fixture clock. */
  const worktree = (path, branch) => {
    box.git(box.repo, 'worktree', 'add', '-q', path, '-b', branch);
    const reflog = resolve(path, box.git(path, 'rev-parse', '--git-path', 'logs/HEAD').trim());
    utimesSync(reflog, clock.now(), clock.now());
  };
  // @pullboard-board-file journey: this is the same durable board.sqlite opened by the fixture's real CLI.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), clock);
  t.after(() => store.closeBoard(board));
  const builder = store.register(board, { lane: 'web', path: join(box.dir, 'builder') });
  const reviewer = store.register(board, { lane: 'web', path: join(box.dir, 'reviewer') });
  /** Freeze a board-only private lifecycle criterion; no real gate result is claimed. */
  const freeze = item => ({ text: item.item_title, digest: `private:${item.item_title}` });
  /** Create ordinary board work using public native moves. */
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title });
  /** Establish a submitted review using explicitly synthetic submission metadata, not a gate receipt. */
  const review = () => {
    const id = add('Review the private page');
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 120 * MINUTE, freeze });
    submitFixture(board, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'private-tree' });
    store.reserveReview(board, id, { agentId: reviewer, leaseMs: 120 * MINUTE, policy: 'any' });
    return id;
  };
  /** Observe a genuine unchanged private worktree; the callback is explicit unavailable otherwise. */
  const workObservation = () => {
    assert.equal(box.git(box.repo, 'status', '--porcelain').trim(), '');
    return { available: true, at: null };
  };
  /** Advance only the board clock, not any global wall clock or production metadata. */
  const advance = ms => { at += ms; };
  /** Read one consistent snapshot with an explicit private work observation. */
  const snapshot = (options = {}, config = {}) => {
    assert.equal(typeof staleStateSnapshot, 'function', 'stale-state observation is implemented');
    return staleStateSnapshot(board, config, { workObservation, ...options });
  };
  /** Run the real private CLI with its public injected clock; all identity/settings files use private HOME. */
  const cli = async (...args) => {
    const source = `import {main} from ${JSON.stringify(new URL('../../tests/fixtures/native.js', import.meta.url).href)};
process.exitCode=await main(${JSON.stringify(args)}, {cwd:${JSON.stringify(box.repo)},clock:{now:()=>new Date(${JSON.stringify(clock.now().toISOString())})},stdout:process.stdout,stderr:process.stderr,loadNativeBoard:()=>import(${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)})});`;
    return runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  };
  return { box, board, builder, reviewer, clock, freeze, add, review, advance, snapshot, cli, worktree };
}

test('timed holds warn one hour before expiry and retain exact half-limit bindings [B4,C7]', t => {
  const f = fixture(t);
  const id = f.add('A private timed hold');
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Awaiting an outside response' });
  const original = f.snapshot();
  const binding = original.holds[0];
  assert.equal(binding.scope, 'item');
  assert.equal(binding.until, null);
  assert.equal(binding.evidence.complete, true);
  assert.equal(binding.pastHalf, false);
  f.advance(12 * 60 * MINUTE - 1);
  assert.equal(f.snapshot().holds[0].pastHalf, false);
  f.advance(1);
  assert.equal(f.snapshot().holds[0].pastHalf, true);
  f.advance(11 * 60 * MINUTE - 1);
  assert.equal(planStaleState(f.snapshot()).holdWarnings.length, 0);
  f.advance(1);
  const warning = planStaleState(f.snapshot());
  assert.equal(warning.holdWarnings.length, 1);
  assert.equal(warning.holdWarnings[0].holdEventId, binding.holdEventId);
  assert.equal(warning.holdWarnings[0].heldAt, binding.heldAt);
  assert.equal(warning.holdWarnings[0].reason, 'Awaiting an outside response');
  assert.equal(warning.holdExpiries.length, 0);
  f.advance(60 * MINUTE);
  const expired = planStaleState(f.snapshot());
  assert.equal(expired.holdWarnings.length, 0);
  assert.equal(expired.holdExpiries.length, 1);
  assert.equal(expired.holdExpiries[0].id, id);
  assert.equal(expired.observedRevision, f.snapshot().observedRevision);
  assert.equal(store.itemHold(f.board, id).item_hold_reason, binding.reason, 'the pure planner never mutates a hold');
});

test('review inactivity requires complete evidence and preserves exact current reservation bindings [B4,V1,H16]', t => {
  const f = fixture(t);
  const id = f.review();
  const initial = f.snapshot().reviews[0];
  assert.equal(initial.evidence.complete, true);
  assert.equal(initial.commit, 'a'.repeat(40));
  assert.equal(initial.reviewer, f.reviewer);
  assert.ok(initial.reserveEventId > initial.sourceSubmitEventId);
  assert.equal(initial.reviewUntil, store.getItem(f.board, id).item_review_until);
  f.advance(15 * MINUTE - 1);
  assert.equal(f.snapshot().reviews[0].pastHalf, false);
  f.advance(1);
  assert.equal(f.snapshot().reviews[0].pastHalf, true);
  f.advance(15 * MINUTE - 1);
  assert.equal(planStaleState(f.snapshot()).reviewReleases.length, 0);
  f.advance(1);
  const due = planStaleState(f.snapshot());
  assert.equal(due.reviewReleases.length, 1);
  assert.deepEqual(due.reviewReleases[0], f.snapshot().reviews[0], 'planner retains the complete matching row');
  assert.equal(due.reviewReleases[0].reserveEventId, initial.reserveEventId);
  assert.equal(store.getItem(f.board, id).item_review_by, f.reviewer, 'planning cannot release or replace a reviewer');
  const unavailable = staleStateSnapshot(f.board);
  assert.equal(unavailable.reviews[0].evidence.complete, false);
  assert.ok(unavailable.reviews[0].evidence.unknown.includes('work observation unavailable or future'));
  assert.equal(planStaleState(unavailable).reviewReleases.length, 0);
  const future = f.snapshot({ workObservation: () => ({ available: true, at: new Date(f.clock.now().getTime() + 1).toISOString() }) });
  assert.equal(future.reviews[0].evidence.complete, false);
  assert.equal(planStaleState(future).reviewReleases.length, 0);
});

test('reviewer heartbeat and native shouts restart measured inactivity without rewriting reservation identity [B3,B4]', t => {
  const f = fixture(t);
  const id = f.review();
  const initial = f.snapshot().reviews[0];
  f.advance(29 * MINUTE);
  store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'Reading the private submitted page', lanes: ['web'] });
  f.advance(MINUTE);
  assert.equal(planStaleState(f.snapshot()).reviewReleases.length, 0);
  assert.equal(f.snapshot().reviews[0].ageMs, MINUTE);
  assert.equal(f.snapshot().reviews[0].reserveEventId, initial.reserveEventId);
  f.advance(29 * MINUTE);
  assert.equal(planStaleState(f.snapshot()).reviewReleases.length, 1);
  heartbeatSeat(f.board, f.reviewer);
  assert.equal(f.snapshot().reviews[0].ageMs, 0);
  assert.equal(planStaleState(f.snapshot()).reviewReleases.length, 0);
  assert.equal(store.getItem(f.board, id).item_review_by, f.reviewer);
});

test('future or unavailable presence cannot authorize stale review expiry [B3,B4,H16]', t => {
  const f = fixture(t);
  f.review();
  f.advance(-1);
  const future = f.snapshot();
  assert.equal(future.reviews[0].evidence.complete, false);
  assert.equal(planStaleState(future).reviewReleases.length, 0);
  assert.ok(future.reviews[0].evidence.unknown.length > 0);
});


test('an idle review reservation returns to the queue [B4,V1,H16]', async t => {
  const f = fixture(t);
  const id = f.review();
  f.worktree(join(f.box.dir, 'reviewer'), 'private-idle-reviewer');
  f.advance(30 * MINUTE);
  const lastActivity = f.clock.now().getTime() - 30 * MINUTE;
  const before = store.events(f.board).length;
  const result = await f.cli('sentinel', 'run', '--health-only', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.getItem(f.board, id).item_status, 'submitted');
  assert.equal(store.getItem(f.board, id).item_review_by, null);
  assert.equal(store.getItem(f.board, id).item_review_until, null);
  const events = store.events(f.board).slice(before);
  const release = events.find(event => event.event_kind === 'release');
  assert.equal(release.event_by, 'coordinator');
  const detail = JSON.parse(release.event_detail);
  assert.equal(detail.review, true);
  assert.equal(detail.reasonCode, 'OTHER', 'current automatic idle release retains its coded reason');
  assert.equal(detail.stale.reviewer, f.reviewer);
  assert.equal(detail.stale.lastActivity, new Date(lastActivity).toISOString());
  const notice = events.find(event => event.event_kind === 'shout');
  assert.equal(JSON.parse(notice.event_detail).to, f.reviewer);
  assert.equal(notice.event_by, 'sentinel');
  const message = store.getShout(f.board, JSON.parse(notice.event_detail).shout);
  assert.equal(message.shout_to, f.reviewer, 'direct reviewer address is not rewritten to the item author');
  assert.ok(message.shout_text.includes('Released your idle review'));
  assert.throws(() => store.reserveReview(f.board, id, { agentId: f.builder, leaseMs: 30 * MINUTE, policy: 'any' }), error => error.code === 'SELF_VERIFY');
  store.reserveReview(f.board, id, { agentId: f.reviewer, leaseMs: 30 * MINUTE, policy: 'any' });
  assert.equal(store.getItem(f.board, id).item_review_by, f.reviewer, 'ordinary independent review guards still apply');
});

test('coordinator expiry refuses stale revisions and a replaced reviewer without changing either holder [B4,H16]', t => {
  const f = fixture(t);
  const id = f.review();
  f.advance(30 * MINUTE);
  const snapshot = f.snapshot();
  assert.throws(() => store.maintainStaleState(f.board, { agentId: f.reviewer, snapshot }), error => error.code === 'COORDINATOR_ONLY');
  store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'I am actively reading this review', lanes: ['web'] });
  assert.throws(() => store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot }), error => error.code === 'STALE_STATE_CHANGED');
  assert.equal(store.getItem(f.board, id).item_review_by, f.reviewer);
  const other = store.register(f.board, { lane: 'web', path: join(f.box.dir, 'replacement-reviewer') });
  store.release(f.board, id, f.reviewer, 'Another independent reviewer will continue', 'OTHER');
  store.reserveReview(f.board, id, { agentId: other, leaseMs: 120 * MINUTE, policy: 'any' });
  const currentRevision = f.snapshot().observedRevision;
  // A caller cannot make stale holder evidence valid by merely replacing its revision number.
  assert.throws(() => store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot: { ...snapshot, observedRevision: currentRevision } }), error => error.code === 'STALE_STATE_CHANGED');
  assert.equal(store.getItem(f.board, id).item_review_by, other);
});

test('ordered stale review expiry replays captured evidence despite a replica-local heartbeat [B3,B4,H16]', t => {
  const f = fixture(t);
  const id = f.review();
  const prefix = exportBoard(f.board);
  f.advance(30 * MINUTE);
  const snapshot = f.snapshot();
  const move = prepareEngineMove(f.board, 'maintainStaleState', [{ agentId: 'coordinator', snapshot, health: {} }], { actor: 'coordinator' });
  const options = { sequence: appliedSequence(f.board) + 1, at: f.clock.now().toISOString(),
    sender: { kind: 'agent', agent: 'coordinator', userId: 'private-fixture-coordinator' }, kind: 'move' };
  const outcome = applyRelayMove(f.board, move, options);
  assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
  assert.deepEqual(outcome.result.reviews, [id]);
  const replica = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, prefix);
  heartbeatSeat(replica, f.reviewer);
  const replayed = applyRelayMove(replica, move, options);
  assert.deepEqual(replayed, outcome);
  assert.equal(store.getItem(replica, id).item_review_by, null);
  assert.deepEqual(applyRelayMove(replica, move, options), outcome, 'duplicate delivery has one immutable receipt');
});

test('incomplete or future work observations never authorize a review release [B4,H16]', t => {
  const f = fixture(t);
  const id = f.review();
  f.advance(30 * MINUTE);
  for (const workObservation of [() => ({ available: false, at: null }),
    () => ({ available: true, at: new Date(f.clock.now().getTime() + 1).toISOString() })]) {
    const snapshot = f.snapshot({ workObservation });
    const result = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot });
    assert.deepEqual(result.reviews, []);
    assert.equal(store.getItem(f.board, id).item_review_by, f.reviewer);
  }
});


test('coordinator hold warnings and expiry use direct sentinel notices without borrowing the coordinator identity [B4,H16]', t => {
  const f = fixture(t);
  const id = f.add('Warn about a private hold');
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'An outside decision is pending' });
  f.advance(23 * 60 * MINUTE);
  const before = store.events(f.board).length;
  const warning = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot: f.snapshot() });
  assert.deepEqual(warning.warnings, [id]);
  const event = store.events(f.board).slice(before).find(entry => entry.event_kind === 'shout');
  const message = store.getShout(f.board, JSON.parse(event.event_detail).shout);
  assert.equal(event.event_by, 'sentinel');
  assert.equal(message.shout_to, 'coordinator');
  assert.ok(message.shout_text.includes('expires within one hour'));
  assert.equal(event.item_id, id, 'the note remains associated with its item without rerouting its recipient');
  const duplicate = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot: f.snapshot() });
  assert.deepEqual(duplicate.warnings, [], 'one warning is recorded for this exact hold event');
  f.advance(60 * MINUTE);
  const expiry = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot: f.snapshot() });
  assert.deepEqual(expiry.holds, [id]);
  assert.equal(store.itemHold(f.board, id), null);
  assert.equal(store.getItem(f.board, id).item_status, 'open');
});

test('lane and person holds remain visible but outside automatic item-hold authority [B4,B26]', t => {
  const f = fixture(t);
  store.holdLane(f.board, 'web', { agentId: 'coordinator', reason: 'Person requested a pause', asPerson: true, channel: 'terminal' });
  f.advance(24 * 60 * MINUTE);
  const snapshot = f.snapshot();
  assert.equal(snapshot.holds[0].scope, 'lane');
  assert.equal(snapshot.holds[0].actor, 'person');
  assert.equal(snapshot.holds[0].pastHalf, true);
  assert.deepEqual(planStaleState(snapshot).holdWarnings, []);
  assert.deepEqual(planStaleState(snapshot).holdExpiries, []);
  const result = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot });
  assert.deepEqual(result.holds, []);
  assert.equal(store.laneHold(f.board, 'web').hold_by, 'person');
});

test('status exposes every past-half hold claim and review with honest unknown evidence [B4,C7]', async t => {
  const f = fixture(t);
  const review = f.review();
  const held = f.add('A near-expiry hold');
  store.holdItem(f.board, held, { agentId: 'coordinator', reason: 'Private hold for status' });
  const claim = f.add('A private claim for status');
  store.claim(f.board, claim, { agentId: f.builder, lane: 'web', leaseMs: 48 * 60 * MINUTE, freeze: f.freeze });
  f.advance(8 * MINUTE);
  let result;
  const lines = [];
  const io = { cwd: f.box.repo, clock: f.clock, result: value => { result = value; }, say: line => lines.push(line), err: line => lines.push(line) };
  assert.equal(await statusRun(io, { values: { json: true } }), 0);
  const uncertain = result.staleState.claims.find(entry => entry.id === claim);
  assert.equal(uncertain.blocker, null);
  assert.equal(uncertain.classificationUnknown, true);
  assert.equal(uncertain.expiryAuthorized, false);
  assert.equal(uncertain.limitMs, 15 * MINUTE, 'unknown status classification warns at the shortest possible half-limit');
  assert.equal(uncertain.evidence.complete, false);
  f.advance(12 * 60 * MINUTE - 8 * MINUTE);
  assert.equal(await statusRun(io, { values: { json: true } }), 0);
  assert.deepEqual(result.staleState.holds.map(entry => entry.id), [held]);
  assert.deepEqual(result.staleState.claims.map(entry => entry.id), [claim]);
  assert.deepEqual(result.staleState.reviews.map(entry => entry.id), [review]);
  assert.equal(result.staleState.reviews[0].evidence.complete, false, 'read-only status does not invent a worktree observation');
  assert.equal(result.staleState.reviews[0].expiryAuthorized, false);
  assert.equal(await statusRun(io, { values: {} }), 0);
  for (const id of [held, claim, review]) assert.ok(lines.some(line => line.startsWith('past half limit:') && line.includes(`#${id}`)));
  assert.ok(lines.some(line => line.includes('inactivity unproven (evidence unknown)')));
  assert.ok(lines.some(line => line.includes('blocker classification unknown; shown at shortest possible half-limit')));
  assert.equal(store.getItem(f.board, review).item_review_by, f.reviewer, 'status never releases anything');
});


test('a hold with --until lifts when its condition is met [B4,H16]', async t => {
  const f = fixture(t);
  const held = f.add('A condition-bound private hold');
  const unrelated = f.add('An unrelated private item');
  const history = store.events(f.board);
  // A matching event before the hold cannot satisfy it retroactively.
  store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'A prior observation', item: held, lanes: ['web'] });
  const result = await f.cli('hold', String(held), '--reason', 'Wait for its next recorded observation', '--until', 'shout', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(store.itemHold(f.board, held));
  const heldEvent = store.events(f.board, { itemId: held }).findLast(event => event.event_kind === 'hold_item');
  assert.ok(heldEvent.event_id > history.length);
  store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'Other item observed', item: unrelated, lanes: ['web'] });
  assert.ok(store.itemHold(f.board, held), 'the same event kind on another item cannot lift this hold');
  store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'This item was observed', item: held, lanes: ['web'] });
  assert.equal(store.itemHold(f.board, held), null);
  const events = store.events(f.board, { itemId: held });
  const trigger = events.findLast(event => event.event_kind === 'shout');
  const lift = events.findLast(event => event.event_kind === 'unhold_item');
  const lifted = JSON.parse(lift.event_detail);
  assert.equal(lifted.reason, 'Wait for its next recorded observation');
  assert.equal(lifted.until, 'shout');
  assert.equal(lifted.holdEventId, heldEvent.event_id);
  assert.equal(lifted.triggerEventId, trigger.event_id);
  assert.ok(trigger.event_id > heldEvent.event_id && lift.event_id > trigger.event_id);
  assert.equal(f.board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`stale_hold_until:${held}`), undefined);
});

test('a conditional lift retains the captured trigger timestamp rather than the later board clock [B4,H16]', t => {
  const f = fixture(t);
  const id = f.add('A captured native event time');
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Wait for its captured observation', until: 'shout' });
  f.advance(MINUTE);
  const triggerAt = f.clock.now();
  f.advance(MINUTE);
  // Exercise the exported native append seam used by split store modules, not a fabricated proof receipt.
  store.logEvent(f.board, f.reviewer, 'shout', id, { observation: 'Private captured event instant' }, triggerAt);
  assert.equal(store.itemHold(f.board, id), null);
  const trigger = store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'shout');
  const lift = store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'unhold_item');
  assert.equal(trigger.event_at, triggerAt.toISOString());
  assert.equal(JSON.parse(lift.event_detail).triggerEventId, trigger.event_id);
  assert.equal(store.getItem(f.board, id).item_updated_at, trigger.event_at);
  assert.notEqual(trigger.event_at, f.clock.now().toISOString());
});

test('conditional holds recognize verified and landed aliases through ordinary lifecycle writes [B4,H16]', async t => {
  for (const until of ['verified', 'accept', 'landed', 'merged']) {
    await t.test(until, () => {
      const f = fixture(t);
      const id = f.add(`A private ${until} condition`);
      store.claim(f.board, id, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
      store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Observe its own lifecycle', until });
      const heldEvent = store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'hold_item');
      submitFixture(f.board, id, { agentId: f.builder, commit: 'a'.repeat(40), tree: 'private-tree' });
      assert.ok(store.itemHold(f.board, id), 'an unrelated earlier lifecycle write preserves the condition');
      store.reserveReview(f.board, id, { agentId: f.reviewer, leaseMs: 120 * MINUTE, policy: 'any' });
      // Synthetic board-state acceptance exercises the native event hook, not a gate or operational landing receipt.
      store.verify(f.board, id, { agentId: f.reviewer, decision: 'ACCEPT', head: 'a'.repeat(40),
        digest: store.getItem(f.board, id).item_frozen_digest, policy: 'any', note: 'Private native event boundary only' });
      const kind = ['verified', 'accept'].includes(until) ? 'accept' : 'merged';
      if (kind === 'merged') {
        assert.ok(store.itemHold(f.board, id), 'acceptance alone cannot satisfy the later landing condition');
        store.merged(f.board, id, { agentId: 'coordinator', commit: 'b'.repeat(40) });
      }
      assert.equal(store.itemHold(f.board, id), null);
      const events = store.events(f.board, { itemId: id });
      const trigger = events.findLast(event => event.event_kind === kind);
      const lifts = events.filter(event => event.event_kind === 'unhold_item');
      assert.equal(lifts.length, 1);
      const detail = JSON.parse(lifts[0].event_detail);
      assert.equal(detail.reason, 'Observe its own lifecycle');
      assert.equal(detail.until, kind);
      assert.equal(detail.holdEventId, heldEvent.event_id);
      assert.equal(detail.triggerEventId, trigger.event_id);
      store.shout(f.board, { from: f.reviewer, to: 'coordinator', text: 'A later observation', item: id, lanes: ['web'] });
      assert.equal(store.events(f.board, { itemId: id }).filter(event => event.event_kind === 'unhold_item').length, 1);
    });
  }
});

test('conditional hold replay retains the trigger and refuses a writer below its pending-condition floor [B3,B4,H16]', t => {
  const f = fixture(t);
  const id = f.add('A replayed condition');
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'Await a recorded observation', until: 'shout' });
  const prefix = exportBoard(f.board);
  const move = prepareEngineMove(f.board, 'shout', [{ from: f.reviewer, to: 'coordinator',
    text: 'A native matching observation', item: id, lanes: ['web'] }], { actor: f.reviewer });
  const options = { sequence: appliedSequence(f.board) + 1, at: f.clock.now().toISOString(),
    sender: { kind: 'agent', agent: f.reviewer, userId: 'private-fixture-reviewer' }, kind: 'move' };
  const outcome = applyRelayMove(f.board, move, options);
  assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
  assert.equal(store.itemHold(f.board, id), null);
  const replica = fixtureBoard(t, { clock: f.clock });
  const older = fixtureBoard(t, { clock: f.clock });
  importBoard(replica, prefix);
  importBoard(older, prefix);
  assert.deepEqual(applyRelayMove(replica, move, options), outcome);
  assert.equal(store.itemHold(replica, id), null);
  const lift = store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'unhold_item');
  const replayLift = store.events(replica, { itemId: id }).findLast(event => event.event_kind === 'unhold_item');
  assert.deepEqual(replayLift, lift, 'trigger and hold event IDs survive ordered replay exactly');
  assert.deepEqual(applyRelayMove(replica, move, options), outcome, 'duplicate delivery cannot lift twice');
  assert.throws(() => applyRelayMove(older, { ...move, engine: conditionalHoldFloor(older) - 1 }, options),
    error => error.code === 'RELAY_MOVE' && error.message.includes('checked-composition snapshot'));
  assert.ok(store.itemHold(older, id), 'an older writer cannot skip the modern condition');
});

test('a silent claim on a blocker can be released by the coordinator after 15 minutes [B4,H16]', async t => {
  const f = fixture(t);
  const path = join(f.box.dir, 'builder');
  f.worktree(path, 'private-stale-builder');
  const id = f.add('A release-blocking private claim');
  addMilestone(f.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Private release', items: [id] });
  store.claim(f.board, id, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
  f.advance(15 * MINUTE - 1);
  const early = await f.cli('release', String(id), '--stale', '--reason', 'BLOCKED', '--note', 'The release waits on this silent claim', '--json');
  assert.equal(early.status, 1);
  assert.equal(JSON.parse(early.stdout).error.code, 'NOT_YOURS', 'a valid code retains the original measured-inactivity refusal');
  assert.equal(store.getItem(f.board, id).item_owner, f.builder);
  f.advance(1);
  const invalid = await f.cli('release', String(id), '--stale', '--reason', 'NOPE', '--note', 'The release waits on this silent claim', '--json');
  assert.equal(JSON.parse(invalid.stdout).error.code, 'RELEASE_REASON');
  assert.equal(store.getItem(f.board, id).item_owner, f.builder);
  const before = store.events(f.board).length;
  const result = await f.cli('release', String(id), '--stale', '--reason', 'BLOCKED', '--note', 'The release waits on this silent claim', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.equal(store.getItem(f.board, id).item_owner, null);
  const events = store.events(f.board).slice(before);
  const release = events.find(event => event.event_kind === 'release');
  assert.equal(release.event_by, 'coordinator');
  const detail = JSON.parse(release.event_detail);
  assert.equal(detail.staleClaim.holder, f.builder);
  assert.equal(detail.reasonCode, 'BLOCKED', 'the actual stale CLI records its explicitly supplied code');
  assert.equal(detail.staleClaim.limitMs, 15 * MINUTE);
  assert.equal(detail.reason, 'The release waits on this silent claim');
  const notice = events.find(event => event.event_kind === 'shout');
  const message = store.getShout(f.board, JSON.parse(notice.event_detail).shout);
  assert.equal(message.shout_to, f.builder, 'holder notification is direct and commits with release');
  assert.ok(message.shout_text.includes(detail.reason));
});


test('actual private worktree activity prevents an otherwise stale blocker release [B4,C7]', async t => {
  const { captureStaleState } = await import('../../../../packages/health/src/io/stale/state/capture.js');
  const f = fixture(t);
  const path = join(f.box.dir, 'builder');
  f.worktree(path, 'private-active-builder');
  const id = f.add('Active release blocker');
  addMilestone(f.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Private active release', items: [id] });
  store.claim(f.board, id, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
  f.advance(13 * MINUTE);
  const changed = join(path, 'actual-private-edit.txt');
  writeFileSync(changed, 'an actual untracked worktree edit');
  // Private filesystem metadata follows the injected fixture clock, never a real board or a performance budget.
  utimesSync(changed, f.clock.now(), f.clock.now());
  f.advance(2 * MINUTE);
  const ctx = { info: { root: f.box.repo }, config: {}, clock: f.clock };
  const snapshot = await captureStaleState(ctx, f.board);
  const row = snapshot.claims.find(entry => entry.id === id);
  assert.equal(row.evidence.complete, true);
  assert.equal(row.ageMs, 2 * MINUTE);
  assert.throws(() => store.release(f.board, id, 'coordinator', 'Still working', {
    staleClaim: row, observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: {} }, 'BLOCKED'), error => error.code === 'NOT_YOURS');
  assert.equal(store.getItem(f.board, id).item_owner, f.builder);
  heartbeatSeat(f.board, f.builder);
  const revived = await captureStaleState(ctx, f.board);
  assert.equal(revived.claims[0].ageMs, 0);
});


test('stale releases carry observation plus code through native and ordered APIs without rewriting history [B4,C7,H16]', async t => {
  const { applyEngineMove } = await import('../../../../packages/state/index.js');
  const { STALE_STATE_ENGINE } = await import('../../../../packages/state/light.js');
  const { RELEASE_REASONS_ENGINE } = await import('../../../../packages/state/light.js');
  for (const mode of ['native', 'ordered', 'historical']) {
    const f = fixture(t);
    store.register(f.board, { lane: 'coordinator', path: f.box.repo, model: 'Coded maintenance fixture' });
    const id = f.add('Silent native maintenance target');
    store.claim(f.board, id, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
    f.advance(60 * MINUTE);
    const snapshot = f.snapshot(), row = snapshot.claims.find(entry => entry.id === id);
    assert.equal(row.evidence.complete, true, 'the real snapshot observes the private unchanged Git worktree and native activity');
    const observation = { staleClaim: row, observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision, health: {} };
    const note = 'The silent claim blocks the next handoff';
    const before = store.getItem(f.board, id), events = store.events(f.board);
    assert.throws(() => store.release(f.board, id, 'coordinator', note, observation), { code: 'RELEASE_REASON' });
    assert.throws(() => store.release(f.board, id, f.builder, note, observation, 'BLOCKED'), { code: 'NOT_YOURS' });
    assert.deepEqual(store.getItem(f.board, id), before);
    assert.deepEqual(store.events(f.board), events);
    const args = [id, 'coordinator', note, observation, 'BLOCKED'];
    const move = prepareEngineMove(f.board, 'release', args);
    assert.ok(move.engine >= RELEASE_REASONS_ENGINE);
    const options = { sequence: 1, at: f.clock.now().toISOString() };
    assert.throws(() => applyEngineMove(f.board, { ...move, engine: STALE_STATE_ENGINE }, options), { code: 'RELAY_MOVE' });
    assert.deepEqual(store.getItem(f.board, id), before);
    if (mode === 'native') store.release(f.board, id, 'coordinator', note, observation, 'BLOCKED');
    else {
      const selected = mode === 'historical'
        ? { ...prepareEngineMove(f.board, 'release', args.slice(0, 4)), engine: STALE_STATE_ENGINE }
        : move;
      const outcome = applyEngineMove(f.board, selected, options);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(applyEngineMove(f.board, selected, options), outcome);
    }
    assert.equal(store.getItem(f.board, id).item_status, 'open');
    const detail = JSON.parse(store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'release').event_detail);
    assert.equal(detail.staleClaim.holder, f.builder);
    assert.equal(detail.reason, note);
    assert.equal(detail.model, 'Coded maintenance fixture');
    assert.deepEqual(Object.keys(detail).sort(), mode === 'historical' ? ['model', 'reason', 'staleClaim'] : ['model', 'reason', 'reasonCode', 'staleClaim']);
    if (mode !== 'historical') assert.equal(detail.reasonCode, 'BLOCKED');
  }
});

test('the stale CLI validates and retains an explicit maintenance reason override [B4,C7]', async t => {
  const { captureStaleState } = await import('../../../../packages/health/src/io/stale/state/capture.js');
  const f = fixture(t), id = f.add('Silent coded override');
  const path = store.agentById(f.board, f.builder).agent_path;
  f.worktree(path, 'private-coded-stale-override');
  store.claim(f.board, id, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
  f.advance(60 * MINUTE);
  const captured = await captureStaleState({ info: { root: f.box.repo }, config: { health: { sentinel: false } }, clock: f.clock }, f.board);
  const observed = captured.claims.find(entry => entry.id === id);
  assert.ok(observed, 'the production capture observes the actual native claim');
  assert.equal(observed.actor, f.builder);
  assert.equal(observed.evidence.complete, true, 'the registered private Git worktree supplies real CLI work evidence');
  assert.equal(observed.limitMs, 60 * MINUTE);
  assert.ok(observed.ageMs >= observed.limitMs, 'the real observation establishes the unchanged one-hour threshold');
  const result = await f.cli('release', String(id), '--stale', '--reason', 'OTHER', '--note', 'An outside prerequisite blocks this claim', '--json');
  assert.equal(result.status, 0, safeFixtureDiagnostic(`stdout: ${result.stdout}\nstderr: ${result.stderr}`, f.box.env));
  const detail = JSON.parse(store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'release').event_detail);
  assert.equal(detail.reasonCode, 'OTHER');
  assert.equal(detail.reason, 'An outside prerequisite blocks this claim');
});

test('clause 1: release --stale by the coordinator frees a claim at once when the holder worktree folder is gone and records the path [C7]', async t => {
  const f = fixture(t);
  store.register(f.board, { lane: 'coordinator', path: f.box.repo, model: 'Gone folder fixture' });
  const gone = f.add('Claim whose seat folder was removed'), present = f.add('Claim whose seat folder exists');
  const goneSeat = store.agentById(f.board, f.builder).agent_path;
  const other = store.register(f.board, { lane: 'web', path: join(f.box.dir, 'present-builder') });
  f.worktree(store.agentById(f.board, other).agent_path, 'private-present-builder');
  store.claim(f.board, gone, { agentId: f.builder, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
  store.claim(f.board, present, { agentId: other, lane: 'web', leaseMs: 120 * MINUTE, freeze: f.freeze });
  f.advance(MINUTE);
  const kept = await f.cli('release', String(present), '--stale', '--reason', 'OTHER', '--note', 'Folder still exists, so this must wait', '--json');
  assert.notEqual(kept.status, 0, 'a present folder still needs the configured stale interval');
  assert.equal(store.getItem(f.board, present).item_owner, other);
  const result = await f.cli('release', String(gone), '--stale', '--reason', 'OTHER', '--note', 'Seat folder was removed', '--json');
  assert.equal(result.status, 0, safeFixtureDiagnostic(`stdout: ${result.stdout}\nstderr: ${result.stderr}`, f.box.env));
  assert.equal(store.getItem(f.board, gone).item_status, 'open');
  const detail = JSON.parse(store.events(f.board, { itemId: gone }).findLast(event => event.event_kind === 'release').event_detail);
  assert.equal(detail.staleClaim.seatFolderMissing, goneSeat);
  assert.ok(detail.reason.includes(goneSeat), 'the missing path is recorded as the reason');
});

/** Preserve historical release detail bytes while current automatic expiry uses a genuine coded reason. */
test('automatic idle review release codes current maintenance without rewriting historical detail [B4,C7,H16]', t => {
  for (const historical of [false, true]) {
    const f = fixture(t), id = f.review();
    f.advance(30 * MINUTE);
    const snapshot = f.snapshot();
    const previous = f.board.executionEngineVersion;
    if (historical) f.board.executionEngineVersion = STALE_STATE_ENGINE;
    try {
      const result = store.maintainStaleState(f.board, { agentId: 'coordinator', snapshot });
      assert.deepEqual(result.reviews, [id]);
    } finally {
      if (previous === undefined) delete f.board.executionEngineVersion;
      else f.board.executionEngineVersion = previous;
    }
    const release = store.events(f.board, { itemId: id }).findLast(event => event.event_kind === 'release');
    const detail = JSON.parse(release.event_detail);
    const reason = `Review idle for 30 minutes; last observed activity ${snapshot.reviews[0].lastActivity}.`;
    const expected = { review: true, reason, ...(historical ? {} : { reasonCode: 'OTHER' }),
      stale: { reviewer: snapshot.reviews[0].reviewer, reservedAt: snapshot.reviews[0].reservedAt,
        lastActivity: snapshot.reviews[0].lastActivity } };
    const { model, ...payload } = detail;
    assert.deepEqual(payload, expected);
    assert.equal(Object.hasOwn(detail, 'reasonCode'), !historical);
  }
});
