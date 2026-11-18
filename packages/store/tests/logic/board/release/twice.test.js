/** Two review releases by one family hold the item for the coordinator behind board.holdAfterTwoReleases, from REVIEW_RELEASE_TWICE_ENGINE on [C7,#10930]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../../index.js';
import { REVIEW_RELEASE_TWICE_ENGINE } from '../../../../../state/light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE } from '../../../../../state/light.js';

// The release table decides review releases from the untouched-reroute engine on, which is the newest engine the table waits for; the hold rule needs both.
const TABLE_STARTS_AT = Math.max(REVIEW_RELEASE_TWICE_ENGINE, RELEASE_UNTOUCHED_REROUTE_ENGINE);

// fixture-subject: addItem (a store unit test of review releases over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-release-twice-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'off' };

/** A submitted item built by core-1 (openai), with reviewer seats core-2 and core-3 (openai) and core-4 (claude), on a board with the hold flag as asked. */
function fixture(t, { flag, engine = TABLE_STARTS_AT }) {
  const board = fixtureBoard(t);
  board.holdAfterTwoReleases = flag;
  board.executionEngineVersion = engine;
  const seats = [['coordinator', 'coordinator', undefined, 'f'], ['core-1', 'core', 'openai', 'a'], ['core-2', 'core', 'openai', 'b'], ['core-3', 'core', 'openai', 'c'], ['core-4', 'core', 'claude', 'd']];
  for (const [id, lane, family, parent] of seats) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), session: parent.repeat(64), model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Release twice fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  const releaseReview = seat => {
    store.reserveReview(board, id, { agentId: seat, leaseMs: 60_000, ...REVIEW });
    store.release(board, id, seat, 'no time to judge this one', 'OTHER');
  };
  return { board, id, releaseReview,
    held: () => store.getItem(board, id),
    holds: () => board.db.prepare(`SELECT event_by, event_detail FROM event WHERE item_id = ? AND event_kind = 'hold_item'`).all(id),
    shouts: () => board.db.prepare('SELECT shout_to, shout_text FROM shout WHERE shout_to = ?').all('coordinator').filter(row => row.shout_text.includes(`#${id} held after two releases`)) };
}

test('store.logic-board-release-twice.review-release-holds: clause 1: with board.holdAfterTwoReleases on at REVIEW_RELEASE_TWICE_ENGINE, two review releases by two seats of one family leave the item held by the coordinator with an automatic review-release-twice hold_item event and one coordinator shout [C7,#10930]', t => {
  const f = fixture(t, { flag: true });
  f.releaseReview('core-2');
  assert.equal(f.held().item_hold_by, null, 'one review release holds nothing');
  f.releaseReview('core-3');
  const item = f.held();
  assert.equal(item.item_hold_by, 'coordinator');
  assert.match(item.item_hold_reason, /^Review released twice without a verdict: core-2 \(no time to judge this one\); core-3 \(no time to judge this one\)/u);
  const holds = f.holds();
  assert.equal(holds.length, 1);
  assert.equal(JSON.parse(holds[0].event_detail).automatic, 'review-release-twice');
  const shouts = f.shouts();
  assert.equal(shouts.length, 1, 'one coordinator shout');
  assert.match(shouts[0].shout_text, /core-2.*core-3.*next: /u, 'it names both releases and the next step');
});

test('store.logic-board-release-twice.off-unchanged: clause 2: with board.holdAfterTwoReleases off, below the engine, or with the two releases by two families, both review releases only free the review and hold nothing [C7,#10930]', t => {
  for (const [why, given, second] of [['flag off', { flag: false }, 'core-3'], ['flag absent', { flag: undefined }, 'core-3'], ['below the engine', { flag: true, engine: REVIEW_RELEASE_TWICE_ENGINE - 1 }, 'core-3'], ['two families', { flag: true }, 'core-4']]) {
    const f = fixture(t, given);
    f.releaseReview('core-2');
    f.releaseReview(second);
    assert.equal(f.held().item_hold_by, null, why);
    assert.equal(f.holds().length, 0, why);
    assert.equal(f.held().item_status, 'submitted', why);
    assert.equal(f.held().item_review_by, null, `${why}: the review is free`);
  }
});
