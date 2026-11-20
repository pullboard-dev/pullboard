/** One next --verify selection computes the review-family relaxation witness once, not per candidate [C7]. */
// fixture-subject: addItem (a store-level unit of the relaxation witness; no kit seam builds a 30-seat board with a frozen policy)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/src/io/board.js';
import { getItem } from '../../../../packages/store/src/io/board/query.js';
import { listItems } from '../../../../packages/store/src/io/board/query.js';
import { reviewHolder } from '../../../../packages/store/src/io/board/query.js';
import { relaxationWitness } from '../../../../packages/store/src/io/relaxation.js';
import { itemReviewPolicy } from '../../../../packages/verify/index.js';
import { seatFamily } from '../../../../packages/verify/index.js';
import { familiesDiffer } from '../../../../packages/verify/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'model'].join('-');

/** A board with 30 active seats and 10 submitted items whose frozen rule relaxes at 2 waiting reviews. */
function busyBoard(t) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human',
    parentDigest: 'a'.repeat(64), model: FIXTURE_MODEL });
  for (let seat = 1; seat <= 30; seat += 1) {
    store.register(board, { id: `core-${seat}`, lane: 'core', path: `/fixture/core-${seat}`, family: 'openai',
      parentDigest: String(seat % 10).repeat(64), model: FIXTURE_MODEL });
  }
  const ids = Array.from({ length: 10 }, () => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' }));
  now = new Date(now.getTime() + 16 * 60_000);
  for (const id of ids) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  return { board, ids };
}

test('cli.journeys-queue-relaxation-once.a-selection-over-10-submitted-items: clause 1: a selection over 10 submitted items on a 30-seat board builds the witness once [C7]', t => {
  const { board, ids } = busyBoard(t);
  let queueReads = 0;
  const ports = { reviewerChecks: store.reviewerChecks, reviewHolder, reviewReleaseCooldown: store.reviewReleaseCooldown,
    listItems: (...args) => { queueReads += 1; return listItems(...args); }, getItem, seatFamily, familiesDiffer, itemReviewPolicy };
  const cache = new Map();
  for (const id of ids) relaxationWitness(board, getItem(board, id), 'core-2', 2, 'any', ports, cache);
  assert.equal(queueReads, 1, `the queue was read ${queueReads} times for ${ids.length} candidates`);
});

test('cli.journeys-queue-relaxation-once.the-shared-witness-equals-the-one: clause 2: the shared witness equals the one each candidate would build alone [C7]', t => {
  const { board, ids } = busyBoard(t);
  const ports = { reviewerChecks: store.reviewerChecks, reviewHolder, reviewReleaseCooldown: store.reviewReleaseCooldown,
    listItems, getItem, seatFamily, familiesDiffer, itemReviewPolicy };
  const cache = new Map();
  for (const id of ids) {
    const shared = relaxationWitness(board, getItem(board, id), 'core-2', 2, 'any', ports, cache);
    const alone = relaxationWitness(board, getItem(board, id), 'core-2', 2, 'any', ports);
    assert.deepEqual(shared, alone, `item ${id}`);
    assert.equal(shared.queueLength, ids.length);
  }
});
