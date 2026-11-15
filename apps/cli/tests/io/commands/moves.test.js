/** pullboard moves reports each move table's recorded shadow compares and state, read-only [C7,#8378]. */
/** @pullboard-world-pin reads the board's recorded moves.shadow counts and writes nothing [C7,#8378]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { recordShadow } from '../../../../../packages/store/index.js';

/** The fixture repo's board file. */
const boardFile = box => join(box.root, '.git', 'pullboard', 'board.sqlite');

/** A fixture repo whose board holds two recorded compares for the claim table, one of them a disagreement. */
function recorded(t) {
  const box = apiHttpFixture(t);
  withFixtureBoard(boardFile(box), board => {
    board.clock = { now: () => new Date('2026-11-15T12:00:00.000Z') };
    recordShadow(board, 'claim', 7, null);
    recordShadow(board, 'claim', 9, 'events.0.detail.leaseUntil');
  });
  return box;
}

test('clause 1: moves prints each table\'s compares, disagreements and first compare time [C7,#8378]', async t => {
  const box = recorded(t);
  const ran = await runCliInProcess(['moves'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /claim\s+shadow\s+2\s+1\s+2026-11-15T12:00:00\.000Z/u);
  assert.match(ran.stdout, /disagreed on #9 at 2026-11-15T12:00:00\.000Z: events\.0\.detail\.leaseUntil/u);
  assert.match(ran.stdout, /submit\s+none\s+0\s+0\s+never/u);
});

test('clause 2: moves --json gives each table a state of live, shadow or none [C7,#8378]', async t => {
  const box = recorded(t);
  const ran = await runCliInProcess(['moves', '--json'], { cwd: box.root, env: box.env });
  const report = JSON.parse(ran.stdout);
  const tables = (report.result ?? report).tables;
  const state = name => tables.find(row => row.table === name).state;
  assert.equal(state('claim'), 'shadow');
  assert.equal(state('release'), 'live');
  assert.equal(state('submit'), 'none');
  assert.deepEqual(tables.find(row => row.table === 'claim').lastDisagreements.map(row => row.id), [9]);
});

test('clause 3: moves writes nothing to the board [C7,#8378]', async t => {
  const box = recorded(t);
  const count = () => withFixtureBoard(boardFile(box), board => ({ ...board.db.prepare('SELECT (SELECT COUNT(*) FROM event) events, (SELECT COUNT(*) FROM board_meta) meta, (SELECT meta_value FROM board_meta WHERE meta_key = ?) claim').get('moves.shadow.claim') }));
  const before = count();
  await runCliInProcess(['moves'], { cwd: box.root, env: box.env });
  assert.deepEqual(count(), before);
});
