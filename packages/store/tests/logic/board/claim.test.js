/** A red gate, a reject or a submit refusal gives the claim back to the board for any free seat of its lane [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { firstRefusalArgs } from '../../../../items/index.js';
import { REJECT_OPEN_ENGINE } from '../../../../state/index.js';
import { fixture } from '../../fixtures/dispatch.js';

/**
 * Queue, start and complete one refused gate for the seat's claim through the ordered board moves.
 *
 * @param {any} box the next-take fixture
 * @param {number} id the claimed item
 * @param {{ id: string, path: string }} seat the claiming seat
 * @param {string} code the retained refusal code
 * @param {boolean} returnToBoard whether claim.returnToBoard is on for this result
 */
function refuse(box, id, seat, code, returnToBoard) {
  const commit = box.git(seat.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${commit}^{tree}`);
  const item = store.getItem(box.board, id);
  const job = store.writeBoardCommand(box.board, 'queueSubmitHandoff', [id, { agentId: seat.id,
    job: randomUUID(), main: box.git(box.root, 'rev-parse', 'HEAD'), commit, tree,
    executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest, companionDigest: null,
    leaseMs: 7_200_000 }], seat.id).job;
  store.startSubmitHandoff(box.board, id, { agentId: seat.id, job: job.id });
  store.writeBoardCommand(box.board, 'completeSubmitHandoff', [id, { agentId: seat.id, job: job.id,
    result: { code: 1, error: { code, message: 'Fixture gate refused the source.', next: 'Fix the named source.' } },
    reopenFirstRefusalMinutes: 30, ...(returnToBoard ? { returnToBoard: true } : {}) }], seat.id);
}

/**
 * The item next offers a seat of the given lane, or null.
 *
 * @param {any} box
 * @param {{ id: string, lane: string }} seat
 * @returns {number | null}
 */
function offered(box, seat) {
  return store.nextFor(box.board, { agentId: seat.id, lane: seat.lane }).item?.item_id ?? null;
}

/**
 * Assert the item is open with no holder and no builder first refusal, and that a free seat of its lane is offered it
 * while a seat of another lane is not.
 *
 * @param {any} box
 * @param {number} id
 */
function onTheBoard(box, id) {
  const item = store.getItem(box.board, id);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_owner, null, 'the builder claim is released');
  assert.equal(store.firstRefusal(box.board, id), null, 'no builder first refusal');
  assert.equal(offered(box, box.seats.actor), id, 'another free seat of the web lane is offered it');
  assert.notEqual(offered(box, box.seats.sibling), id, 'a seat of another lane is not');
}

for (const [kind, code] of [['a red gate result', 'GATE_RED'], ['a submit refusal', 'CELLS_PLAN_UNPLACED']]) {
  test(`clause 1: recording ${kind} with claim.returnToBoard releases the builder claim with no first refusal and next offers it to a free seat of the lane [C7,V4,H16]`, t => {
    const box = fixture(t);
    box.board.gitRoot = box.root;
    const id = box.add(`Returned ${code}`);
    box.claim(id, box.seats.builder);
    refuse(box, id, box.seats.builder, code, true);
    onTheBoard(box, id);
    const returned = box.board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit_handoff_returned' ORDER BY event_id DESC LIMIT 1").get(id);
    const detail = JSON.parse(returned.event_detail);
    assert.equal(detail.returnedToBoard, true);
    assert.equal(detail.reopenFirstRefusal, undefined, 'the return reserves nothing for the builder');
    assert.equal(store.submitHandoff(box.board, id).state, 'red', 'the refusal stays readable on the item');
  });
}

/**
 * Reject a synthetic submission through the arguments the CLI seals for this configuration.
 *
 * @param {any} box
 * @param {any} config the coordinator configuration whose claim policy is sealed
 * @param {boolean} [former] replay the first-refusal policy of engines before REJECT_OPEN_ENGINE (#2779) for the verdict
 * @returns {number} the rejected item
 */
function reject(box, config, former = false) {
  const id = box.add('Rejected work');
  box.submit(id); // Explicit synthetic board-state setup; it claims no gate execution.
  const item = store.getItem(box.board, id);
  const args = firstRefusalArgs('verify', [id, { agentId: box.seats.outside.id, decision: 'REJECT', head: item.item_commit, policy: 'any',
    digest: item.item_frozen_digest, reason: 'TEST_FAILURE', clause: 'The real fixture succeeds.', note: 'Synthetic conveyor rejection' }], config);
  if (former) box.board.executionEngineVersion = REJECT_OPEN_ENGINE - 1; // The submission above stays current; only the verdict replays the former policy.
  store.verify(box.board, ...args);
  return id;
}

test('store.logic-board-claim.recording-a-reject-with-claim-returntoboard: clause 1: recording a reject with claim.returnToBoard releases the builder hold with no first refusal and next offers it to a free seat of the lane [C7,V4,H16]', t => {
  const box = fixture(t);
  const id = reject(box, { claim: { reopenFirstRefusalMinutes: 30, returnToBoard: true } });
  onTheBoard(box, id);
});

test('store.logic-board-claim.with-claim-returntoboard-off-a-reject: clause 1: with claim.returnToBoard off a reject still reserves its builder for the configured window [C7,V4]', t => {
  const box = fixture(t);
  const id = reject(box, { claim: { reopenFirstRefusalMinutes: 30 } }, true);
  assert.equal(store.firstRefusal(box.board, id)?.builder, box.seats.builder.id);
  assert.notEqual(offered(box, box.seats.actor), id);
});

test('store.logic-board-claim.with-claim-returntoboard-off-a-red: clause 1: with claim.returnToBoard off a red gate still keeps the builder claim, so the setting is what returns it [C7,V4]', t => {
  const box = fixture(t);
  box.board.gitRoot = box.root;
  const id = box.add('Kept red');
  box.claim(id, box.seats.builder);
  refuse(box, id, box.seats.builder, 'GATE_RED', false);
  const item = store.getItem(box.board, id);
  assert.equal(item.item_status, 'claimed');
  assert.equal(item.item_owner, box.seats.builder.id);
  assert.notEqual(offered(box, box.seats.actor), id);
});
