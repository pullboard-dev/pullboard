/** pullboard moves reports each move table's recorded shadow compares and state, read-only [C7,#8378]. */
/** @pullboard-world-pin reads the board's recorded moves.shadow counts and writes nothing [C7,#8378]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { recordShadow } from '../../../../../packages/store/index.js';
import { movesReport } from '../../../src/io/commands/moves.js';

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

/** Recorded counts for every table a shadow recorder writes, so each row's state comes from the settings alone. */
const SHADOWS = Object.fromEntries(['claim', 'commit', 'submit', 'start', 'complete', 'outcome', 'job', 'reopen', 'outbox']
  .map(table => [table, { compared: 1, disagreed: 0, since: '2026-11-16T00:00:00.000Z', lastDisagreedAt: null, last: [] }]));
const TABLES = ['backbone', 'claim', 'hop', 'job', 'landing', 'lease', 'outbox', 'pulled', 'reclaim', 'release', 'reopen', 'submit', 'verify', 'withdraw'];
const row = (rows, table) => rows.find(entry => entry.table === table);

test('clause 1: commit compares read live under moves.live.submit, start and complete under moves.live.handoff [C7,#9188]', () => {
  const off = movesReport(SHADOWS, TABLES, {});
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(off, table).state), ['shadow', 'shadow', 'shadow', 'shadow']);
  const submitOn = movesReport(SHADOWS, TABLES, { moves: { live: { submit: true } } });
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(submitOn, table).state), ['live', 'live', 'shadow', 'shadow']);
  const handoffOn = movesReport(SHADOWS, TABLES, { moves: { live: { handoff: true } } });
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(handoffOn, table).state), ['shadow', 'shadow', 'live', 'live']);
});

test('clause 2: hop reads live while gate.fencedHop is unset or on, and pulled always reads live [C7,#9188]', () => {
  assert.equal(row(movesReport({}, TABLES, {}), 'hop').state, 'live');
  assert.equal(row(movesReport({}, TABLES, { gate: { fencedHop: true } }), 'hop').state, 'live');
  assert.equal(row(movesReport({}, TABLES, { gate: { fencedHop: false } }), 'hop').state, 'none');
  assert.equal(row(movesReport({ hop: SHADOWS.claim }, TABLES, { gate: { fencedHop: false } }), 'hop').state, 'shadow');
  assert.equal(row(movesReport({}, TABLES, {}), 'pulled').state, 'live');
});

test('clause 3: each row names the switch that puts its writer live, or none for a writer that always runs its table [C7,#9188]', () => {
  const rows = movesReport(SHADOWS, TABLES, {});
  const switches = Object.fromEntries(rows.map(entry => [entry.table, entry.liveSwitch]));
  assert.deepEqual(switches, {
    backbone: null, claim: 'moves.live.claim', commit: 'moves.live.submit', complete: 'moves.live.handoff', hop: 'gate.fencedHop', job: 'moves.live.job',
    landing: null, lease: null, outbox: 'moves.live.outbox', outcome: 'moves.live.outcome', pulled: null, reclaim: 'moves.live.reclaim', release: null,
    reopen: 'moves.live.reopen', start: 'moves.live.handoff', submit: 'moves.live.submit', verify: null, withdraw: null,
  });
  const allOn = movesReport(SHADOWS, TABLES, { moves: { live: { claim: true, submit: true, handoff: true, outcome: true, job: true, reopen: true, outbox: true } } });
  assert.deepEqual(allOn.filter(entry => entry.state !== 'live').map(entry => entry.table), ['backbone', 'reclaim'], 'every table with a writer reads live once its switch is on');
});
