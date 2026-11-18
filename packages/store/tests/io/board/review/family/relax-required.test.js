/** With review.relaxRequiredFamily on, a strict-only-because-of-its-family --review-family item with no live eligible seat yields a relaxation witness for a seat of another session; off, none [C7,#11127]. */
// fixture-subject: addItem (a store unit test of the required-family witness over two seeded items; the board is opened through the kit)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { reviewFamilyRelaxation } from '../../../../../src/io/board/review/family.js';
import { confirmFamilyRelaxation } from '../../../../../src/io/board/review/family.js';
import { FIXTURE_MODEL } from '../../../../fixtures/cell.js';
import { openKitBoard } from '../../../../fixtures/cell.js';
import { submitFixture } from '../../../../fixtures/submit.js';
import { privateFixtureFiles } from '../../../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home with review.relaxRequiredFamily set as given, restoring the home afterwards. */
function withRelax(on, read) {
  const { root: dir } = privateFixtureFiles('pullboard-relax-required-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { review: { relaxRequiredFamily: on } });
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A board with two submitted items that require reviewer family anthropic (strict only because of that family unless `sensitive`), frozen with familyRelaxAt 2, and one openai builder seat as the only active seat. */
function waitingBoard(t, { sensitive = false } = {}) {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const board = openKitBoard(':memory:', { now: () => new Date(now) });
  t.after(() => store.closeBoard(board));
  for (const [id, lane, family, parent] of [['coordinator', 'coordinator', 'human', 'a'], ['core-1', 'core', 'openai', 'b'], ['core-2', 'core', 'openai', 'c'], ['core-3', 'core', 'openai', 'b']]) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: FIXTURE_MODEL });
  }
  now = new Date(now.getTime() + 16 * 60_000);
  const items = [1, 2].map(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it', reviewFamily: 'anthropic', sensitive }));
  for (const id of items) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  return { board, items };
}

test('store.io-board-review-family-relax-required.witness-for-required-family: clause 1: with review.relaxRequiredFamily on, two waiting --review-family items with no live eligible seat yield a witness for a seat of another session [C7,#11127]', t => {
  const { board, items } = waitingBoard(t);
  const item = store.getItem(board, items[0]);
  const witness = withRelax(true, () => reviewFamilyRelaxation(board, item, 'core-2', 2, 'any', 'prefer'));
  assert.equal(witness?.queueLength, 2);
  assert.equal(witness.threshold, 2);
  assert.deepEqual(witness.waiting, items);
  assert.deepEqual(withRelax(true, () => confirmFamilyRelaxation(board, item, witness, 'core-2', 2, 'any', 'prefer')), witness);
  assert.equal(withRelax(true, () => reviewFamilyRelaxation(board, item, 'core-3', 2, 'any', 'prefer')), null, 'a seat of the builder session gets no witness');
});

test('store.io-board-review-family-relax-required.no-witness-when-off: clause 2: with review.relaxRequiredFamily off the same board yields null from reviewFamilyRelaxation and from confirmFamilyRelaxation [C7,#11127]', t => {
  const { board, items } = waitingBoard(t);
  const item = store.getItem(board, items[0]);
  const witness = withRelax(true, () => reviewFamilyRelaxation(board, item, 'core-2', 2, 'any', 'prefer'));
  assert.ok(witness, 'the same board yields a witness with the setting on');
  assert.equal(withRelax(false, () => reviewFamilyRelaxation(board, item, 'core-2', 2, 'any', 'prefer')), null);
  assert.equal(withRelax(false, () => confirmFamilyRelaxation(board, item, witness, 'core-2', 2, 'any', 'prefer')), null);
});

test('store.io-board-review-family-relax-required.no-witness-when-sensitive: clause 3: with review.relaxRequiredFamily on, the same items made sensitive yield null from reviewFamilyRelaxation [C7,#11127]', t => {
  const { board, items } = waitingBoard(t, { sensitive: true });
  const item = store.getItem(board, items[0]);
  assert.equal(withRelax(true, () => reviewFamilyRelaxation(board, item, 'core-2', 2, 'any', 'prefer')), null);
});
