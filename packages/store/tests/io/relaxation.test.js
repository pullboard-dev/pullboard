/** blockedFor reads reviewHeartbeats from its ports, so the relaxation check runs with waiting items [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../src/io/board.js';
import { getItem } from '../../src/io/board/query.js';
import { listItems } from '../../src/io/board/query.js';
import { reviewHolder } from '../../src/io/board/query.js';
import { relaxationWitness } from '../../src/io/relaxation.js';
import { confirmRelaxation } from '../../src/io/relaxation.js';
import { itemReviewPolicy } from '../../../verify/index.js';
import { seatFamily } from '../../../verify/index.js';
import { familiesDiffer } from '../../../verify/index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { submitFixture } from '../fixtures/submit.js';

/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'model'].join('-');

/** The ports reviewFamilyRelaxation supplies, without reviewHeartbeats: the shape that crashed. */
const ports = { reviewerChecks: store.reviewerChecks, reviewHolder, reviewReleaseCooldown: store.reviewReleaseCooldown,
  listItems, getItem, seatFamily, familiesDiffer, itemReviewPolicy };

test('clause 1: relaxationWitness and confirmRelaxation run with waiting submitted items and free seats [C7]', t => {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  for (const [id, family, parent] of [['coordinator', 'human', 'a'], ['core-1', 'openai', 'b'], ['core-2', 'openai', 'c']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family,
      parentDigest: parent.repeat(64), model: FIXTURE_MODEL });
  }
  const ids = [1, 2].map(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' }));
  now = new Date(now.getTime() + 16 * 60_000);
  for (const id of ids) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  const subject = getItem(board, ids[0]);
  const witness = relaxationWitness(board, subject, 'core-2', 2, 'any', ports);
  assert.equal(witness.queueLength, 2);
  assert.deepEqual(witness.waiting, ids);
  assert.deepEqual(confirmRelaxation(board, subject, witness, 'core-2', 2, 'any', ports), witness);
});
