/** A red landing gate bisects its named unwaived failures; waived failures never block a batch [C7,#2900]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { bisectableFailures, unwaivedFailures } from '../packages/landing/src/shell/landing-step-failures.js';

const PORTS = { quarantineWaivers: () => [] };

/** A board holding one live person waiver for test/machine.test.js. */
function board(t) {
  const opened = openBoard(':memory:', { now: () => new Date('2026-11-04T07:30:00.000Z') });
  t.after(() => store.closeBoard(opened));
  opened.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, 'landing_waiver', NULL, ?)")
    .run('2026-11-04T06:44:00.000Z', store.PERSON, JSON.stringify({ waiver: { id: 'w1', test: 'test/machine.test.js', until: '2026-11-05T07:00:00.000Z', reason: 'main red since the cells moves' } }));
  return opened;
}

const waived = { file: 'test/machine.test.js', name: 'every refusal a move raises today is declared on that move' };
const own = { file: 'test/spec-apply-busy-board.test.js', name: 'spec apply waits for a busy board' };
const other = { file: 'test/e2e-model-names.test.js', name: 'model names render' };

test('named unwaived failures of an unaccounted red gate are bisectable [C7,#2900]', t => {
  assert.deepEqual(bisectableFailures(board(t), [waived, own, other], PORTS), [own, other]);
});

test('waived failures are dropped before bisect, so a waived red never blocks a batch [C7,#2900]', t => {
  const opened = board(t);
  assert.deepEqual(unwaivedFailures(opened, [waived, waived], PORTS), []);
  assert.equal(bisectableFailures(opened, [waived], PORTS), null, 'nothing left to bisect when every red is waived');
});

test('an unnamed failure still needs a person to read the gate [C7,#2900]', t => {
  assert.equal(bisectableFailures(board(t), [own, { file: null, name: 'This operation was aborted' }], PORTS), null);
});
