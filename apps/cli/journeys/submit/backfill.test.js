/** A seat's Submit flake pair is filed as soon as it is recorded, so it never stops every landing [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { backfillRatchetQuarantines } from '../../../../packages/flakes/index.js';
import { flakeQuarantines } from '../../../../packages/flakes/index.js';
import { landingFlakeRatchet } from '../../../../packages/flakes/index.js';

const FILE = 'apps/lib/tests/submit-handoff-worker.test.js';

/** Record one admitted Submit-path run, as a seat's Submit and its diagnostic check record them. */
function submitRun(board, id, kind, tree, passed) {
  logEvent(board, 'coordinator', 'gate-run', null, { autoSubmit: true, run: { id, version: 2, kind, tree,
    proof: { sourceClean: true, exitCode: passed ? 0 : 1 }, testOutcomes: [{ file: FILE, name: 'case', passed, skipped: false }] } });
}

test('a Submit red and its green check on one tree are filed, and the landing ratchet then allows the landing [C7]', t => {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  logEvent(board, 'coordinator', 'merged', null, { flakeRatchet: { version: 1, eventId: events(board).at(-1).event_id, count: 0, quarantines: [] } });
  submitRun(board, 'submit-red', 'submit', 'e'.repeat(40), false);
  submitRun(board, 'check-green', 'check', 'e'.repeat(40), true);
  assert.deepEqual(landingFlakeRatchet(board).unprotected, [{ file: FILE, name: 'case' }]);
  const filed = backfillRatchetQuarantines(board, 'coordinator', () => 'core');
  assert.deepEqual(filed.map(row => row.file), [FILE]);
  const [quarantine] = flakeQuarantines(board);
  assert.deepEqual([quarantine.runs, quarantine.status], [['submit-red', 'check-green'], 'quarantined']);
  assert.match(getItem(board, quarantine.item).item_title, /^Flaky test: apps\/lib\/tests\/submit-handoff-worker\.test\.js :: case/);
  assert.equal(landingFlakeRatchet(board).allowed, true);
  assert.deepEqual(backfillRatchetQuarantines(board, 'coordinator', () => 'core'), [], 'an active quarantine is never filed twice');
});

test('a Submit red that its check repeats red is no flake and files nothing [C7]', t => {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  submitRun(board, 'submit-red', 'submit', 'f'.repeat(40), false);
  submitRun(board, 'check-red', 'check', 'f'.repeat(40), false);
  assert.deepEqual(backfillRatchetQuarantines(board, 'coordinator', () => 'core'), []);
  assert.deepEqual(flakeQuarantines(board), []);
});
