/** A red landing gate bisects its named unwaived failures; waived failures never block a batch [C7,#2900]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { openCellBoard as openBoard } from '../../board/tests/fixtures/cell-board.js';
import {
  bisectableFailures,
  unwaivedFailures,
} from '../index.js';
import { bisect } from '../index.js';

const PORTS = { quarantineWaivers: () => [] };

/** A board holding one live person waiver for apps/cli/journeys/verify/machine.test.js. */
function board(t) {
  const opened = openBoard(':memory:', { now: () => new Date('2026-11-04T07:30:00.000Z') });
  t.after(() => store.closeBoard(opened));
  opened.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, 'landing_waiver', NULL, ?)")
    .run('2026-11-04T06:44:00.000Z', store.PERSON, JSON.stringify({ waiver: { id: 'w1', test: 'apps/cli/journeys/verify/machine.test.js', until: '2026-11-05T07:00:00.000Z', reason: 'main red since the cells moves' } }));
  return opened;
}

const waived = { file: 'apps/cli/journeys/verify/machine.test.js', name: 'every refusal a move raises today is declared on that move' };
const own = { file: 'apps/cli/journeys/spec/board.test.js', name: 'spec apply waits for a busy board' };
const other = { file: 'apps/cli/journeys/release/model.test.js', name: 'model names render' };

test('landing.unaccounted.named-unwaived-failures-of-an-unaccounted: named unwaived failures of an unaccounted red gate are bisectable [C7,#2900]', t => {
  assert.deepEqual(bisectableFailures(board(t), [waived, own, other], PORTS), [own, other]);
});

test('landing.unaccounted.waived-failures-are-dropped-before-bisect: waived failures are dropped before bisect, so a waived red never blocks a batch [C7,#2900]', t => {
  const opened = board(t);
  assert.deepEqual(unwaivedFailures(opened, [waived, waived], PORTS), []);
  assert.equal(bisectableFailures(opened, [waived], PORTS), null, 'nothing left to bisect when every red is waived');
});

test('landing.unaccounted.only-unnamed-failures-still-need-a: only unnamed failures still need a person; named reds bisect beside an unnamed one [C7,#2900]', t => {
  assert.equal(bisectableFailures(board(t), [{ file: null, name: 'This operation was aborted' }], PORTS), null);
  // An unnamed row rides along: the named reds split the batch and the rebuilt green set's whole-plan run catches the rest.
  assert.deepEqual(bisectableFailures(board(t), [own, { file: null, name: 'This operation was aborted' }], PORTS), [own]);
});

test('landing.unaccounted.bisect-compares-only-unwaived-reds-with: bisect compares only unwaived reds with base main; a live-waived red file is never compared [C7,#2900]', async t => {
  const opened = board(t);
  const compared = [];
  const compare = async (_root, { tests }) => { compared.push(...tests.map(test => test.file)); return { main: 'base', files: [] }; };
  const state = { board: opened, landingPorts: PORTS, culprits: [], say() {}, onWait: undefined,
    batch: { id: 'batch', root: '/nowhere', base: 'base', tip: 'tip', revision: 0 },
    write: async (_operation, [{ batch }]) => batch };
  const green = await bisect(state, [{ id: 1, commit: 'c1' }, { id: 2, commit: 'c2' }], [waived, own], 'split', async () => { throw new Error('no gate'); }, compare);
  assert.deepEqual(compared, [own.file], 'the unwaived file is checked on main and the waived one is not');
  assert.deepEqual(green, [], 'an own red that is not green on main holds the batch');
});
