import { REJECT_OPEN_ENGINE } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { REJECTION_RETURN_ENGINE } from '../../../../state/index.js';
import { MOVE_REGISTRY } from '../../../index.js';
/** @pullboard-test-loads packages/store/src/io/board.js src/claims.js */
/** Advancing clocks preserve the entire opt-in builder window [B13,B5]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from "../../../../store/index.js";
import { openCellBoard as openBoard } from "../../../../board/tests/fixtures/cell-board.js";
import { submitFixture } from "../../../../store/tests/fixtures/submit.js";

const COMMIT = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
/** Open a real SQLite board with a clock advanced independently of the host. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-'));
  let at = Date.parse('2026-01-01T00:00:00Z');
  const board = openBoard(':memory:', { now: () => new Date(at) });
  // These controls prove replay of the former first-refusal policy, not the current rejection rule.
  board.executionEngineVersion = REJECT_OPEN_ENGINE - 1;
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', family: 'Fixture Clock Builder Vendor', route: 'mid' });
  const other = store.register(board, { lane: 'core', path: '/other', family: 'Fixture Clock Reviewer Vendor', route: 'mid' });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: true,
    reason: 'Private fixture explicitly requires declared vendor pairs; this changes no operational board.',
    window: { syntheticPolicy: 1 } });
  return { board, directory, builder, other, advance: (minutes) => { at += minutes * 60_000; } };
}
/** Claim the item with a frozen bar and a bounded lease. */
function claim(f, id, agentId) {
  return store.claim(f.board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } } }), digest: 'digest:bar' }) });
}
/** Submit and return an item through the real rejection, landing-failure or conflict path. */
function returned(f, cause, minutes, causeKey) {
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'fix', criterion: 'prove', specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves the fix' });
  claim(f, id, f.builder);
  submitFixture(f.board, id, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  const verdict = { agentId: f.other, head: COMMIT, digest: 'digest:bar', policy: 'any', note: 'proof', ...(causeKey ? { cause: causeKey } : {}) };
  if (cause === 'reject') store.verify(f.board, id, { ...verdict, decision: 'REJECT', reason: 'OTHER', clause: 'prove', reopenFirstRefusalMinutes: minutes });
  else {
    store.verify(f.board, id, { ...verdict, decision: 'ACCEPT' });
    store.reopen(f.board, id, { agentId: 'coordinator', reopenFirstRefusalMinutes: minutes, ...(causeKey ? { cause: causeKey } : {}),
      ...(cause === 'conflict' ? { conflict: { files: ['src/a.js'], trunk: TRUNK } }
        : { note: `test/a.test.js: failed case; merge commit ${TRUNK}` }) });
  }
  return id;
}

test('moves.claim.every-return-anchors-its-full-builder-window: [B13,B5] every return anchors its full builder window to one advancing-clock instant', t => {
  for (const cause of ['reject', 'landing', 'conflict']) {
    for (const stepMs of [1, 1000]) {
      const f = fixture(t);
      let instant = Date.parse('2026-01-01T00:00:00Z');
      f.board.clock = { now: () => { const at = new Date(instant); instant += stepMs; return at; } };
      const id = returned(f, cause, 30);
      const event = store.events(f.board, { itemId: id }).findLast(row => row.event_kind === (cause === 'reject' ? 'reject' : 'reopen'));
      const window = JSON.parse(event.event_detail).reopenFirstRefusal;
      assert.equal(Date.parse(window.until) - Date.parse(event.event_at), 30 * 60_000, `${cause}/${stepMs}`);
      assert.equal(store.recentShouts(f.board).filter(row => row.shout_to === f.builder && row.shout_text.includes('waits for you')).length, 1);
      instant = Date.parse(window.until) - 1;
      f.board.clock = { now: () => new Date(instant) };
      assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
      instant += 1;
      claim(f, id, f.other);
      assert.equal(store.getItem(f.board, id).item_owner, f.other);
    }
  }
});

/** Record the person-approved opt-in without changing defaults on other boards. */
function enable(f, key = 'returnRejectedWork') {
  store.setLineSetting(f.board, { agentId: 'coordinator', key, value: true, reason: 'approved automatic returns', window: { observed: 1 } });
}
/** Ask the real native planner for this seat's next build. */
function next(f, agentId) { return store.nextFor(f.board, { agentId, lane: 'core' }); }

test('moves.claim.rejection-is-the-builder-next-work-with: [B35,B13] rejection is the builder next work with its clause, verdict and handoff', t => {
  const f = fixture(t); enable(f);
  const older = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'older', criterion: 'prove', specIds: ['B35'], route: 'mid', check: 'true', brief: 'Files: src/older.js\nTest: proves older work' });
  const id = returned(f, 'reject', 0);
  const picked = next(f, f.builder);
  assert.equal(picked.item.item_id, id);
  assert.match(picked.reasons.join('\n'), /prove.*proof.*builder handoff/u);
  assert.equal(next(f, f.other).item.item_id, older);
  assert.throws(() => claim(f, id, f.other), error => error.code === 'REOPEN_HELD_FOR_BUILDER');
  claim(f, id, f.builder);
  assert.equal(store.getItem(f.board, id).item_owner, f.builder);
});

test('moves.claim.any-lane-family-can-take-an-unclaimed: [B35,B13,H16] any lane family can take an unclaimed reject at the thirty-minute boundary', t => {
  const f = fixture(t); enable(f); enable(f, 'reworkSameFamily');
  const id = returned(f, 'reject', 0);
  assert.equal(next(f, f.other).item, null);
  f.advance(30);
  const picked = next(f, f.other);
  assert.equal(picked.item.item_id, id);
  assert.match(picked.reasons.join('\n'), /prove.*proof.*builder handoff/u);
  claim(f, id, f.other);
  assert.equal(store.getItem(f.board, id).item_owner, f.other);
});

test('moves.claim.manual-reopen-refuses-with-the-board-return-explanation: [B35,V6] manual reopen refuses with the board-return explanation', t => {
  const f = fixture(t); enable(f);
  const id = returned(f, 'reject', 0);
  assert.throws(() => store.reopen(f.board, id, { agentId: 'coordinator', note: 'return it' }),
    error => error.code === 'BOARD_RETURNS_REJECTED' && error.message.includes('the board returns rejected work'));
  assert.equal(store.getItem(f.board, id).item_verdict, 'REJECT');
});

test('moves.claim.rejection-routing-remains-opt-in-and-respects-item: [B35,H16] rejection routing remains opt-in and respects item holds', t => {
  const f = fixture(t);
  const id = returned(f, 'reject', 0);
  assert.equal(next(f, f.other).item.item_id, id);
  enable(f);
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'stop-reason triage' });
  assert.equal(next(f, f.builder).item, null);
  assert.throws(() => claim(f, id, f.builder), error => error.code === 'ITEM_HELD');
});

test('moves.claim.automatic-rejection-routing-is-sealed-into-claim: [B35,H16] automatic rejection routing is sealed into claim and verdict replay floors', t => {
  const f = fixture(t); enable(f);
  const id = returned(f, 'reject', 0);
  const options = { agentId: f.builder, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) };
  const claimMove = prepareEngineMove(f.board, 'claim', [id, options]);
  const verdictMove = prepareEngineMove(f.board, 'verify', [id, { agentId: f.other, decision: 'REJECT' }]);
  assert.equal(claimMove.args[1].returnRejectedWork, true);
  assert.equal(verdictMove.args[1].returnRejectedWork, true);
  for (const operation of ['claim', 'verify', 'reopen']) {
    assert.ok(MOVE_REGISTRY[operation].minimumEngine([id, { returnRejectedWork: true }], f.board) >= REJECTION_RETURN_ENGINE);
  }
});

test('moves.claim.a-new-rejection-precedes-the-builder-other: [B35,B5] a new rejection precedes the builder other live claim and retains triage holds', t => {
  const f = fixture(t); enable(f);
  const id = returned(f, 'reject', 0);
  const active = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'already active', criterion: 'prove',
    specIds: ['B35'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves current work' });
  claim(f, active, f.builder);
  assert.equal(next(f, f.builder).item.item_id, id);
  store.holdItem(f.board, id, { agentId: 'coordinator', reason: 'stop-reason triage' });
  assert.equal(next(f, f.builder).item.item_id, active);
  store.holdLane(f.board, 'core', { agentId: 'coordinator', reason: 'triage' });
  assert.equal(next(f, f.builder).item.item_id, active);
});

test('moves.claim.a-claimed-rejection-remains-next-ahead-of: [B35,B5] a claimed rejection remains next ahead of an older live claim', t => {
  const f = fixture(t); enable(f);
  const active = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'older active work', criterion: 'prove',
    specIds: ['B35'], route: 'mid', check: 'true', brief: 'Files: src/active.js\nTest: proves current work' });
  const id = returned(f, 'reject', 0);
  claim(f, active, f.builder);
  assert.equal(next(f, f.builder).item.item_id, id);
  claim(f, id, f.builder);
  assert.equal(next(f, f.builder).item.item_id, id);
});

test('moves.claim.the-builder-own-claimed-rejection-precedes-an: [B35,B5] the builder own claimed rejection precedes an older returned item from another builder', t => {
  const f = fixture(t); enable(f);
  const older = returned({ ...f, builder: f.other, other: f.builder }, 'reject', 0);
  const own = returned(f, 'reject', 0);
  f.advance(30);
  claim(f, older, f.builder);
  claim(f, own, f.builder);
  assert.equal(next(f, f.builder).item.item_id, own);
});
