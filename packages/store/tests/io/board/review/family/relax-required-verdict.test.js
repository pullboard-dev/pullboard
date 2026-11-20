/** The verdict note of a review run under a required-family relaxation witness records that the required family was widened and why [C7,#9838]. */
// fixture-subject: addItem (a store unit test of the verdict record over two seeded --review-family items; the board is opened through the kit)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { FIXTURE_MODEL } from '../../../../fixtures/cell.js';
import { openKitBoard } from '../../../../fixtures/cell.js';
import { reviewFamilyRelaxation } from '../../../../../src/io/board/review/family.js';
import { reservedRelaxation } from '../../../../../src/io/board/review/family.js';
import { relaxationRecordLine } from '../../../../../src/io/board/review/family.js';
import { logEvent } from '../../../../../src/io/board/event/log.js';
import { submitFixture } from '../../../../fixtures/submit.js';
import { privateFixtureFiles } from '../../../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../gate/tests/fixtures/testkit.js';

/** Run `act` against a private machine home with review.relaxRequiredFamily on, restoring the home afterwards. */
function withRelaxOn(act) {
  const { root: dir } = privateFixtureFiles('pullboard-relax-verdict-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { review: { relaxRequiredFamily: true } });
    return act();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/**
 * Two submitted items that require reviewer family anthropic, built by an openai seat, then a reservation by an openai seat of another session that carries the
 * witness reviewFamilyRelaxation grants; returns the verdict-note line for that review. Reserve itself does not yet honor the witness for a required family, so the
 * reservation is written as reserve writes it.
 */
function widenedLine(t) {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const board = openKitBoard(':memory:', { now: () => new Date(now) });
  t.after(() => store.closeBoard(board));
  for (const [id, lane, family, parent] of [['coordinator', 'coordinator', 'human', 'a'], ['core-1', 'core', 'openai', 'b'], ['core-2', 'core', 'openai', 'c']]) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: FIXTURE_MODEL });
  }
  now = new Date(now.getTime() + 16 * 60_000);
  const items = [1, 2].map(() => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it', reviewFamily: 'anthropic' }));
  for (const id of items) {
    store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text: JSON.stringify({ policy: { verify: { familyRelaxAt: 2 } } }), digest: 'fixture-digest' }) });
    submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  }
  const item = store.getItem(board, items[0]);
  const witness = withRelaxOn(() => reviewFamilyRelaxation(board, item, 'core-2', 2, 'any', 'prefer'));
  assert.ok(witness, 'the waiting pair yields a witness');
  const until = new Date(now.getTime() + 3_600_000).toISOString();
  board.db.prepare('UPDATE item SET item_review_by=?, item_review_until=? WHERE item_id=?').run('core-2', until, item.item_id);
  logEvent(board, 'core-2', 'reserve', item.item_id, { until, commit: item.item_commit, digest: item.item_frozen_digest, familyRelaxation: witness });
  const reserved = store.getItem(board, item.item_id);
  const relaxation = reservedRelaxation(board, reserved, 'core-2');
  assert.ok(relaxation, 'the reservation carries the witness');
  return relaxationRecordLine(board, reserved, 'core-2', relaxation);
}

test('store.io-board-review-family-relax-required-verdict.records-widened: clause 1: a verdict given by a seat of another family under a relaxation witness records that the required family was widened [C7,#9838]', t => {
  const note = widenedLine(t);
  assert.match(note, /^review family relaxed at reservation: 2 waiting, threshold 2; active seats: [^;]*; required/u);
  assert.match(note, /required reviewer family anthropic widened/u);
});

test('store.io-board-review-family-relax-required-verdict.records-reason: clause 2: the widened record names the reason, no live eligible seat of the family for 20 minutes [C7,#9838]', t => {
  const note = widenedLine(t);
  assert.match(note, /widened: no live eligible seat of the family for 20 minutes$/u);
});
