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
import { LIVE_SWITCH } from '../../../src/io/commands/moves.js';
import { moveTableNames } from '../../../src/io/commands/moves.js';

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

test('cli.io-commands-moves.moves-prints-each-table-s-compares-disagreements: clause 1: moves prints each table\'s compares, disagreements and first compare time [C7,#8378]', async t => {
  const box = recorded(t);
  const ran = await runCliInProcess(['moves'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /claim\s+live\s+2\s+1\s+2026-11-15T12:00:00\.000Z/u);
  assert.match(ran.stdout, /disagreed on #9 at 2026-11-15T12:00:00\.000Z: events\.0\.detail\.leaseUntil/u);
  assert.match(ran.stdout, /submit\s+live\s+0\s+0\s+never/u);
});

test('cli.io-commands-moves.moves-json-gives-each-table-a-state: clause 2: moves --json gives each table a state of live, shadow or none [C7,#8378]', async t => {
  const box = recorded(t);
  const ran = await runCliInProcess(['moves', '--json'], { cwd: box.root, env: box.env });
  const report = JSON.parse(ran.stdout);
  const tables = (report.result ?? report).tables;
  const state = name => tables.find(row => row.table === name).state;
  assert.equal(state('claim'), 'live', 'the claim table is live by default (#8395)');
  assert.equal(state('release'), 'live');
  assert.equal(state('submit'), 'live');
  assert.deepEqual(['start', 'complete', 'outbox'].map(name => state(name)), ['none', 'none', 'none'], 'hand-off and outbox stay off by default');
  assert.deepEqual(tables.find(row => row.table === 'claim').lastDisagreements.map(row => row.id), [9]);
});

test('cli.io-commands-moves.moves-writes-nothing-to-the-board: clause 3: moves writes nothing to the board [C7,#8378]', async t => {
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
/** Machine settings with every moves.live switch off but the ones named: since #8395 six of them default on, so a test of the off state says so. */
const offWith = on => ({ moves: { live: { claim: false, submit: false, handoff: false, outcome: false, job: false, reopen: false, reclaim: false, outbox: false, ...on } } });

test('cli.io-commands-moves.commit-compares-read-live-under-moves-live: clause 1: commit compares read live under moves.live.submit, start and complete under moves.live.handoff [C7,#9188]', () => {
  const off = movesReport(SHADOWS, TABLES, offWith({}));
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(off, table).state), ['shadow', 'shadow', 'shadow', 'shadow']);
  const submitOn = movesReport(SHADOWS, TABLES, offWith({ submit: true }));
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(submitOn, table).state), ['live', 'live', 'shadow', 'shadow']);
  const handoffOn = movesReport(SHADOWS, TABLES, offWith({ handoff: true }));
  assert.deepEqual(['commit', 'submit', 'start', 'complete'].map(table => row(handoffOn, table).state), ['shadow', 'shadow', 'live', 'live']);
});

test('cli.io-commands-moves.hop-reads-live-while-gate-fencedhop-is: clause 2: hop reads live while gate.fencedHop is unset or on, and pulled always reads live [C7,#9188]', () => {
  assert.equal(row(movesReport({}, TABLES, {}), 'hop').state, 'live');
  assert.equal(row(movesReport({}, TABLES, { gate: { fencedHop: true } }), 'hop').state, 'live');
  assert.equal(row(movesReport({}, TABLES, { gate: { fencedHop: false } }), 'hop').state, 'none');
  assert.equal(row(movesReport({ hop: SHADOWS.claim }, TABLES, { gate: { fencedHop: false } }), 'hop').state, 'shadow');
  assert.equal(row(movesReport({}, TABLES, {}), 'pulled').state, 'live');
});

test('cli.io-commands-moves.each-row-names-the-switch-that-puts: clause 3: each row names the switch that puts its writer live, or none for a writer that always runs its table [C7,#9188]', () => {
  const rows = movesReport(SHADOWS, TABLES, {});
  const switches = Object.fromEntries(rows.map(entry => [entry.table, entry.liveSwitch]));
  assert.deepEqual(switches, {
    backbone: null, claim: 'moves.live.claim', commit: 'moves.live.submit', complete: 'moves.live.handoff', hop: 'gate.fencedHop', job: 'moves.live.job',
    landing: null, lease: null, outbox: 'moves.live.outbox', outcome: 'moves.live.outcome', pulled: null, reclaim: 'moves.live.reclaim', release: null,
    reopen: 'moves.live.reopen', start: 'moves.live.handoff', submit: 'moves.live.submit', verify: null, withdraw: null,
  });
  const allOn = movesReport(SHADOWS, TABLES, { moves: { live: { claim: true, submit: true, handoff: true, outcome: true, job: true, reopen: true, outbox: true } } });
  assert.deepEqual(allOn.filter(entry => entry.state !== 'live').map(entry => entry.table), ['backbone'], 'every table with a writer reads live once its switch is on; reclaim is live by default (#8395)');
});

{
  /** Table files as the moves cell has them: none named start or complete. */
  const PATHS = ['backbone', 'claim', 'hop', 'job', 'landing', 'lease', 'outbox', 'pulled', 'reclaim', 'release', 'reopen', 'submit', 'verify', 'withdraw']
    .map(name => `packages/moves/src/logic/table/${name}.table.js`);
  const row = (rows, table) => rows.find(entry => entry.table === table);

  test('clause 1: with no start or complete file and nothing recorded, start and complete list as none, 0 compares, under moves.live.handoff [C7]', () => {
    const rows = movesReport({}, moveTableNames(PATHS), {});
    for (const table of ['start', 'complete']) {
      const found = row(rows, table);
      assert.ok(found, `${table} is listed`);
      assert.deepEqual([found.state, found.compared, found.liveSwitch], ['none', 0, 'moves.live.handoff']);
    }
  });

  test('clause 2: start and complete read live with moves.live.handoff on, and every LIVE_SWITCH key is listed exactly once [C7]', () => {
    const rows = movesReport({}, moveTableNames(PATHS), { moves: { live: { handoff: true } } });
    assert.deepEqual(['start', 'complete'].map(table => row(rows, table).state), ['live', 'live']);
    for (const table of Object.keys(LIVE_SWITCH)) assert.equal(rows.filter(entry => entry.table === table).length, 1, `${table} listed once`);
  });
}

/** The recorded fixture board plus the live jobs the backbone reads: a main test job it serves, a gate job for an item that was never claimed (unserved), and one job of a kind it does not list. */
function withJobs(t) {
  const box = recorded(t);
  const at = Date.now();
  withFixtureBoard(boardFile(box), board => {
    const now = '2026-11-17T12:00:00.000Z';
    board.db.prepare('INSERT INTO item (item_id, item_lane, item_title, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(8, 'core', 'never claimed', 'open', 'core-1', now, now);
    const job = board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_candidate, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const step = board.db.prepare("INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, 'offered', ?, ?)");
    for (const [id, kind, itemId] of [['main:1', 'main-test', null], ['gate:8', 'gate', 8], ['odd:8', 'odd-kind', 8]]) {
      job.run(id, kind, itemId, 'c'.repeat(40), 'offered', at, at);
      step.run(id, JSON.stringify({ needs: [], request: { submit: { agentId: 'core-1', digest: 'd'.repeat(64) } } }), at);
    }
  });
  return box;
}

const backboneRow = async box => (await runCliInProcess(['moves', '--json'], { cwd: box.root, env: box.env }).then(ran => { const report = JSON.parse(ran.stdout); return (report.result ?? report).tables; })).find(entry => entry.table === 'backbone');

test('cli.io-commands-moves.backbone-row-counts-the-live-jobs-it-compared: clause 1: moves --json gives the backbone row compared as served plus unserved jobs offered in the last 24 hours and disagreed as the unserved ones, from readBackboneRecords [C7,#10584]', async t => {
  const row = await backboneRow(withJobs(t));
  assert.equal(row.compared, 2);
  assert.equal(row.disagreed, 1);
  assert.deepEqual(row.lastDisagreements.map(entry => entry.id), [8]);
  assert.match(row.lastDisagreements[0].differs, /^gate:8 \(serves\.gate\)$/u);
});

test('cli.io-commands-moves.backbone-row-reads-shadow-once-compared: clause 2: the backbone row reads state shadow once compared is 1 or more, and map with none [C7,#10584]', async t => {
  assert.equal((await backboneRow(withJobs(t))).state, 'shadow');
  const none = await backboneRow(recorded(t));
  assert.deepEqual([none.state, none.compared, none.disagreed], ['map', 0, 0]);
});

test('cli.io-commands-moves.backbone-row-lists-unreadable-jobs-by-kind: clause 3: the JSON backbone row lists the unreadable counts per job kind, and a board with none lists none [C7,#10584]', async t => {
  assert.deepEqual((await backboneRow(withJobs(t))).unreadable, { 'odd-kind': 1 });
  assert.deepEqual((await backboneRow(recorded(t))).unreadable, {});
});
