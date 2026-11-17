/** Native reservations and verdicts preserve the family-relaxation witness [V1,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { fixtureBoard } from '../../../../../../board/tests/fixtures/board.js';
import { submitFixture } from '../../../../fixtures/submit.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../../../state/light.js';
import { REVIEW_FAMILY_SEAT_ENGINE } from '../../../../../../state/light.js';
import { prepareEngineMove } from '../../../../../../state/index.js';
import { applyEngineMove } from '../../../../../../state/index.js';
import { exportBoard } from '../../../../../index.js';

test('store.io-board-review-family-relax.backlog-relaxation-is-bound-to-the: backlog relaxation is bound to the reservation and never permits self review [V1,H16]', t => {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  for (const [id, family, parent] of [['coordinator', 'human', 'a'], ['core-1', 'openai', 'b'], ['core-2', 'openai', 'c'], ['core-3', 'openai', 'b']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family,
      parentDigest: parent.repeat(64), model: 'fixture-model' });
  }
  const add = extra => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it', ...extra });
  const first = add(), second = add(), strict = add({ sensitive: true }), legacy = add();
  now = new Date(now.getTime() + 16 * 60_000);
  const submit = (id, familyRelaxAt = 2) => {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', ...(familyRelaxAt ? { familyRelaxAt } : {}) } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  };
  const options = { agentId: 'core-2', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require', familyRelaxAt: 2 };
  const noThreshold = { agentId: 'core-2', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require' };
  submit(first);
  assert.throws(() => store.reserveReview(board, first, { ...options, familyRelaxAt: 1 }), { code: 'BAD_REVIEW_POLICY' });
  assert.throws(() => store.reserveReview(board, first, options), { code: 'SAME_FAMILY' });
  assert.throws(() => store.reserveReview(board, first, { ...options, familyPolicy: 'prefer' }), { code: 'SAME_FAMILY' }, 'frozen require cannot be bypassed by current prefer policy');
  assert.equal(store.nextFor(board, { ...options, lane: 'core', verify: true }).item, null);
  submit(second);
  board.executionEngineVersion = REVIEW_FAMILY_RELAX_ENGINE - 1;
  assert.throws(() => store.reserveReview(board, first, options), { code: 'SAME_FAMILY' }, 'historical engines cannot reinterpret a new setting');
  delete board.executionEngineVersion;
  assert.ok(prepareEngineMove(board, 'reserveReview', [first, noThreshold]).engine >= REVIEW_FAMILY_RELAX_ENGINE);
  assert.ok(prepareEngineMove(board, 'reserveNextReview', [{ ...noThreshold, lane: 'core' }]).engine >= REVIEW_FAMILY_RELAX_ENGINE);
  assert.ok([first, second].includes(store.nextFor(board, { ...options, lane: 'core', verify: true }).item?.item_id));
  assert.ok([first, second].includes(store.nextFor(board, { ...noThreshold, lane: 'core', verify: true }).item?.item_id));
  assert.throws(() => store.reserveReview(board, first, { ...options, agentId: 'core-1' }), { code: 'SELF_VERIFY' });
  assert.throws(() => store.reserveReview(board, first, { ...options, agentId: 'core-3' }), { code: 'SELF_SESSION_VERIFY' });
  store.register(board, { id: 'core-4', lane: 'core', path: '/fixture/core-4', family: 'anthropic',
    parentDigest: 'd'.repeat(64), model: 'fixture-model' });
  assert.throws(() => store.reserveReview(board, first, options), { code: 'SAME_FAMILY' }, 'a live eligible other-family reviewer prevents relaxation');
  assert.equal(store.nextFor(board, { ...options, lane: 'core', verify: true }).item, null);
  now = new Date(now.getTime() + 16 * 60_000);
  const move = prepareEngineMove(board, 'reserveReview', [first, noThreshold], { id: 'relaxed-review-fixture' });
  const before = exportBoard(board);
  assert.throws(() => applyEngineMove(board, { ...move, engine: REVIEW_FAMILY_RELAX_ENGINE - 1 },
    { sequence: 1, at: now.toISOString() }), { code: 'RELAY_MOVE' });
  assert.deepEqual(exportBoard(board), before);
  const receipt = applyEngineMove(board, move, { sequence: 1, at: now.toISOString() });
  assert.equal(receipt.error, undefined);
  assert.equal(store.getItem(board, first).item_review_by, 'core-2');
  const event = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='reserve' ORDER BY event_id DESC LIMIT 1").get(first);
  assert.equal(JSON.parse(event.event_detail).familyRelaxation.queueLength, 2);
  const item = store.getItem(board, first);
  assert.ok(prepareEngineMove(board, 'verify', [first, { agentId: 'core-2', decision: 'ACCEPT', note: 'evidence',
    head: item.item_commit, digest: 'fixture-digest', policy: 'any', familyPolicy: 'require' }]).engine >= REVIEW_FAMILY_RELAX_ENGINE);
  board.db.prepare('UPDATE item SET item_frozen_digest=? WHERE item_id=?').run('changed-digest', first);
  assert.throws(() => store.verify(board, first, { agentId: 'core-2', decision: 'ACCEPT', note: 'evidence', head: item.item_commit,
    digest: 'changed-digest', policy: 'any', familyPolicy: 'require' }), { code: 'SAME_FAMILY' }, 'a witness cannot cross a refreeze');
  board.db.prepare('UPDATE item SET item_frozen_digest=? WHERE item_id=?').run('fixture-digest', first);
  assert.throws(() => store.verify(board, first, { agentId: 'core-2', decision: 'ACCEPT', note: '', head: item.item_commit,
    digest: 'fixture-digest', policy: 'any', familyPolicy: 'require' }), { code: 'PROOF_REQUIRED' });
  store.verify(board, first, { agentId: 'core-2', decision: 'ACCEPT', note: 'inspected the change', head: item.item_commit,
    digest: 'fixture-digest', policy: 'any', familyPolicy: 'require' });
  const verdict = board.db.prepare('SELECT verdict_note FROM verdict WHERE item_id=?').get(first);
  assert.match(verdict.verdict_note, /review family relaxed at reservation: 2 waiting, threshold 2/u);
  const afterVerdict = exportBoard(board);
  assert.deepEqual(applyEngineMove(board, move, { sequence: 1, at: now.toISOString() }), receipt);
  assert.deepEqual(exportBoard(board), afterVerdict, 'replayed reservation receipt cannot apply twice');
  assert.throws(() => store.reserveReview(board, second, options), { code: 'SAME_FAMILY' });
  submit(strict);
  assert.throws(() => store.reserveReview(board, strict, options), { code: 'SAME_FAMILY' }, 'strict review never relaxes');
  submit(legacy, null);
  assert.throws(() => store.reserveReview(board, legacy, options), { code: 'BAD_REVIEW_POLICY' }, 'a caller cannot add a threshold to an older frozen policy');
  assert.throws(() => store.reserveReview(board, legacy, noThreshold), { code: 'SAME_FAMILY' }, 'missing frozen threshold never relaxes');
});

test('store.io-board-review-family-relax.coordinator-activity-cannot-suppress-family-relaxation: coordinator activity cannot suppress family relaxation; an available other-family agent can [V1,H16]', t => {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  for (const [id, lane, family, parent] of [['coordinator', 'coordinator', 'anthropic', 'a'], ['core-1', 'core', 'openai', 'b'], ['core-2', 'core', 'openai', 'c']]) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: 'fixture-model' });
  }
  const items = Array.from({ length: 5 }, () => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' }));
  for (const id of items) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 5 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  const options = { agentId: 'core-2', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require', familyRelaxAt: 5 };
  const pick = () => store.nextFor(board, { ...options, lane: 'core', verify: true }).item;
  board.executionEngineVersion = REVIEW_FAMILY_SEAT_ENGINE - 1;
  assert.equal(pick(), null, 'old engines retain their original coordinator calculation');
  delete board.executionEngineVersion;
  assert.ok(pick(), 'five waiting items relax when only the coordinator is an opposite-family seat');
  board.db.prepare("UPDATE agent SET agent_lane='person' WHERE agent_id='coordinator'").run();
  assert.ok(pick(), 'a person seat also does not suppress relaxation');
  board.db.prepare("UPDATE agent SET agent_lane='coordinator' WHERE agent_id='coordinator'").run();
  store.register(board, { id: 'core-3', lane: 'core', path: '/fixture/core-3', family: 'anthropic', parentDigest: 'd'.repeat(64), model: 'fixture-model' });
  assert.equal(pick(), null, 'a free opposite-family agent prevents relaxation');
});
