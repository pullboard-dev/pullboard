import { recordLandingBatch } from '../../../../packages/store/index.js';
import { join } from 'node:path';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { DatabaseSync } from 'node:sqlite';
import { prepareFlakeLanding } from '../../../../packages/landing/index.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { addItem } from '../../../../packages/store/index.js';
import { logEvent } from '../../../../packages/store/index.js';
import { events } from '../../../../packages/store/index.js';
import { withdraw } from '../../../../packages/store/index.js';
import { flakeQuarantines } from '../../../../packages/flakes/index.js';
import { gateRuns } from '../../../../packages/flakes/index.js';
import { recordSealedGateRun } from '../../../../packages/flakes/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { listItems } from '../../../../packages/store/index.js';
import { QUARANTINE_BACKFILL_ENGINE } from '../../../../packages/state/light.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { QUARANTINE_CORE_ENGINE } from '../../../../packages/state/light.js';
import { AUTO_SUBMIT_QUARANTINE_ENGINE } from '../../../../packages/state/light.js';
/** Quarantine counts are a per-landing ratchet, with named flake evidence [C7,T12]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flakeRatchet,
  pairedFlakeObservations,
  quarantinesAt,
  landingFlakeRatchet,
  legacyFlakeObservations,
} from '../../../../packages/flakes/index.js';

const observed = (file, eventId) => ({ file, name: 'case', status: 'active', count: 1, lastEventId: eventId });
const quarantine = (file, item, eventId) => ({ file, name: 'case', status: 'quarantined', item, eventId });

test('a new unquarantined flake refuses the landing by test name [C7,T12]', () => {
  const result = flakeRatchet({ previous: { version: 1, eventId: 10, count: 0, quarantines: [] }, eventId: 12,
    observations: [observed('test/new.test.js', 11)], quarantines: [] });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.unprotected, [{ file: 'test/new.test.js', name: 'case' }]);
});

test('a filed newly observed quarantine can raise the count, and repair lowers it [C7,T12]', () => {
  const previous = { version: 1, eventId: 10, count: 0, quarantines: [] };
  const first = flakeRatchet({ previous, eventId: 13, observations: [observed('test/new.test.js', 11)],
    quarantines: [quarantine('test/new.test.js', 7, 12)] });
  assert.equal(first.allowed, true);
  assert.equal(first.snapshot.count, 1);
  assert.equal(first.snapshot.quarantines.length, 1);
  const fixed = flakeRatchet({ previous: first.snapshot, eventId: 15, observations: [], quarantines: [] });
  assert.equal(fixed.allowed, true);
  assert.equal(fixed.snapshot.count, 0);
  assert.equal(fixed.snapshot.quarantines.length, 0);
});

test('old or unfiled quarantine cannot justify increasing the landing baseline [C7,T12]', () => {
  const previous = { version: 1, eventId: 10, count: 0, quarantines: [] };
  const old = flakeRatchet({ previous, eventId: 12, observations: [observed('test/old.test.js', 9)],
    quarantines: [quarantine('test/old.test.js', 4, 11)] });
  assert.equal(old.allowed, false);
  assert.deepEqual(old.unjustified, [{ file: 'test/old.test.js', name: 'case' }]);
  const missing = flakeRatchet({ previous, eventId: 12, observations: [observed('test/new.test.js', 11)],
    quarantines: [quarantine('test/new.test.js', null, 12)] });
  assert.equal(missing.allowed, false);
});

/** Quarantine's native source is a pair of actual verdicts on the same tree. */
test('native paired test verdicts identify new flakes without mixing trees [C7,T12]', () => {
  const run = (id, eventId, tree, passed, extra = {}) => ({ id, eventId, tree, version: 1, kind: 'landing',
    testOutcomes: [{ file: 'test/a.test.js', name: 'case', passed, skipped: false }], ...extra });
  const red = run('red', 5, 'tree-a', false), green = run('green', 8, 'tree-a', true);
  assert.deepEqual(pairedFlakeObservations([red, run('other', 6, 'tree-b', true)]), []);
  assert.deepEqual(pairedFlakeObservations([red, green], { afterEvent: 6 }), [observed('test/a.test.js', 8)]);
  assert.deepEqual(pairedFlakeObservations([red, green], { afterEvent: 8 }), []);
  assert.deepEqual(pairedFlakeObservations([red, { ...green, id: 'red' }]), []);
});

/** A later repair must not rewrite the count that was true at an earlier landing. */
test('historical quarantines use the landing boundary, including later reopens and merges [C7,T12]', () => {
  const event = (event_id, event_kind, item_id, event_detail = {}) => ({ event_id, event_kind, item_id, event_detail });
  const history = [event(1, 'test-quarantine', 7, { file: 'test/a.test.js', name: 'case', engine: 2 }),
    event(2, 'accept', 7), event(3, 'reopen', 7), event(4, 'test-quarantine', 8, { file: 'test/b.test.js', name: 'case', engine: 3, autoSubmit: true }),
    event(5, 'accept', 8), event(6, 'merged', 8)];
  const at = throughEvent => quarantinesAt(history, [], { throughEvent, quarantineCoreEngine: 2, autoSubmitEngine: 3 });
  assert.equal(at(1)[0].status, 'quarantined');
  assert.equal(at(2)[0].status, 'lifted');
  assert.equal(at(3)[0].status, 'quarantined');
  assert.equal(at(5)[1].status, 'quarantined');
  assert.equal(at(6)[1].status, 'lifted');
});

/** The first post-activation landing reconstructs the previous landing, not the later current state. */
test('native event adapter reconstructs and advances the previous landing snapshot [C7,T12]', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = (id, kind, item, detail) => db.prepare('INSERT INTO event VALUES (?, ?, ?, ?)').run(id, kind, item, JSON.stringify(detail));
  insert(1, 'test-quarantine', 7, { file: 'test/old.test.js', name: 'case', engine: 0 });
  insert(2, 'landing_batch', null, { batch: { state: 'landed' } });
  insert(3, 'accept', 7, {});
  const board = { db };
  const readers = { readRuns: () => [], readLedger: () => [], readQuarantines: () => [] };
  const result = landingFlakeRatchet(board, readers);
  assert.equal(result.allowed, true);
  assert.equal(result.snapshot.count, 0, 'a repair after the previous landing lowers the next count');
  insert(4, 'landing_batch', null, { batch: { state: 'landed', flakeRatchet: result.snapshot } });
  insert(5, 'gate-run', null, {});
  insert(6, 'gate-run', null, {});
  insert(7, 'test-quarantine', 8, { file: 'test/new.test.js', name: 'case', engine: 0 });
  const outcome = passed => [{ file: 'test/new.test.js', name: 'case', passed, skipped: false }];
  const runs = [{ id: 'red', eventId: 5, tree: 'tree', version: 1, kind: 'landing', testOutcomes: outcome(false) },
    { id: 'green', eventId: 6, tree: 'tree', version: 1, kind: 'landing', testOutcomes: outcome(true) }];
  const next = landingFlakeRatchet(board, { ...readers, readRuns: () => runs,
    readQuarantines: () => [quarantine('test/new.test.js', 8, 7)] });
  assert.equal(next.allowed, true, 'a newly observed, filed native pair justifies the increase');
  assert.equal(next.snapshot.count, 1);
});

/** A changed board never produces a mixed event boundary and quarantine snapshot. */
test('native ratchet refuses a concurrently changed board [C7,T12]', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const readers = { readRuns: () => [], readQuarantines: () => [], readLedger: () => {
    db.prepare('INSERT INTO event VALUES (1, ?, NULL, ?)').run('fact', '{}');
    return [];
  } };
  assert.throws(() => landingFlakeRatchet({ db }, readers), { code: 'BOARD_BUSY' });
});

/** A standalone merged receipt becomes the next baseline just like a landed batch. */
test('a merged receipt advances the landing baseline [C7,T12]', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = (id, kind, detail) => db.prepare('INSERT INTO event VALUES (?, ?, NULL, ?)').run(id, kind, JSON.stringify(detail));
  insert(1, 'landing_batch', { batch: { state: 'landed', flakeRatchet: { version: 1, eventId: 0, count: 0, quarantines: [] } } });
  insert(2, 'merged', { flakeRatchet: { version: 1, eventId: 1, count: 1, quarantines: [{ file: 'test/a.test.js', name: 'case', item: 7 }] } });
  insert(3, 'fact', {});
  const result = landingFlakeRatchet({ db }, { readRuns: () => [], readLedger: () => [],
    readQuarantines: () => [quarantine('test/a.test.js', 7, 1)] });
  assert.equal(result.allowed, true, 'the count recorded after publication is the previous baseline');
  assert.equal(result.snapshot.count, 1);
});

/** A landed repair clears older paired evidence, but never a later recurrence. */
test('paired evidence respects the repair landing boundary [C7,T12]', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = (id, kind, item = null) => db.prepare('INSERT INTO event VALUES (?, ?, ?, ?)').run(id, kind, item, '{}');
  insert(1, 'gate-run'); insert(2, 'gate-run'); insert(3, 'merged', 7); insert(4, 'gate-run');
  const outcome = passed => [{ file: 'test/a.test.js', name: 'case', passed, skipped: false }];
  const red = { id: 'red', eventId: 1, tree: 'tree', version: 1, kind: 'landing', testOutcomes: outcome(false) };
  const green = { ...red, id: 'green', eventId: 2, testOutcomes: outcome(true) };
  const readers = { readQuarantines: () => [], readLedger: () => [{ ...observed('test/a.test.js', 2), item: 7, status: 'fixed' }],
    readRuns: () => [red, green] };
  assert.equal(landingFlakeRatchet({ db }, readers).allowed, true);
  readers.readRuns = () => [red, green, { ...red, id: 'later', eventId: 4 }];
  assert.deepEqual(landingFlakeRatchet({ db }, readers).unprotected, [{ file: 'test/a.test.js', name: 'case' }]);
});

/** Legacy proof is coordinator-owned and requires the same exact tree and distinct runs. */
test('legacy coordinator gate pairs retain their named flake evidence [C7,T12]', () => {
  const red = { id: 'red', by: 'coordinator', eventId: 4, tree: 'tree', kind: 'landing', green: false,
    failures: [{ file: 'test/a.test.js', name: 'case' }] };
  const green = { id: 'green', by: 'coordinator', eventId: 8, tree: 'tree', kind: 'landing', green: true, failures: [] };
  assert.deepEqual(legacyFlakeObservations([red, green], { afterEvent: 6 }), [observed('test/a.test.js', 8)]);
  assert.deepEqual(legacyFlakeObservations([red, { ...green, tree: 'other' }]), []);
  assert.deepEqual(legacyFlakeObservations([red, { ...green, by: 'agent' }]), []);
});

/** Publication refuses before any batch write, then records an allowed lower count. */
test('landing guard names unquarantined flakes and records the lower count [C7,T12]', async () => {
  let result = flakeRatchet({ previous: { version: 1, eventId: 10, count: 0, quarantines: [] }, eventId: 11,
    observations: [observed('test/new.test.js', 11)], quarantines: [] });
  let writes = 0;
  const state = { board: {}, batch: { revision: 0 }, landingPorts: { landingFlakeRatchet: () => result },
    write: async (_operation, [request]) => { writes++; return { ...request.batch, revision: request.revision + 1 }; } };
  await assert.rejects(prepareFlakeLanding(state), error => error.code === 'FLAKE_RATCHET' && error.message.includes('test/new.test.js :: case'));
  assert.equal(writes, 0);
  result = flakeRatchet({ previous: { version: 1, eventId: 10, count: 1, quarantines: [quarantine('test/old.test.js', 7, 8)] },
    eventId: 12, observations: [], quarantines: [] });
  await prepareFlakeLanding(state);
  assert.equal(state.batch.flakeRatchet.count, 0);
  assert.equal(writes, 1);
});

/** Historical reconstruction agrees with native projection and retains the earlier boundary. */
test('historical quarantine matches native state across a real board withdrawal [C7,T12]', async t => {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Flake repair', route: 'strong' });
  logEvent(board, 'coordinator', 'test-quarantine', id, { engine: 1, file: 'test/a.test.js', name: 'case', runs: [] });
  const boundary = events(board).at(-1).event_id;
  const options = { quarantineCoreEngine: QUARANTINE_CORE_ENGINE, autoSubmitEngine: AUTO_SUBMIT_QUARANTINE_ENGINE };
  const historical = () => quarantinesAt(events(board), gateRuns(board), { ...options, throughEvent: boundary });
  assert.equal(historical()[0].status, flakeQuarantines(board)[0].status);
  withdraw(board, id, { agentId: 'coordinator', reason: 'The synthetic repair was withdrawn.' });
  assert.equal(flakeQuarantines(board)[0].status, 'lifted');
  assert.equal(historical()[0].status, 'quarantined');
});

/** Only twenty observed, non-skipped clean runs can release a structured quarantine. */
test('historical structured quarantine requires twenty clean runs before the boundary [C7,T12]', () => {
  const events = [{ event_id: 1, event_kind: 'test-quarantine', item_id: 7,
    event_detail: { file: 'test/a.test.js', name: 'case', engine: 2 } }];
  const runs = Array.from({ length: 20 }, (_, index) => ({ id: `run-${index}`, eventId: index + 2, version: 1,
    kind: 'landing', testOutcomes: [{ file: 'test/a.test.js', name: 'case', passed: true, skipped: false }] }));
  const at = throughEvent => quarantinesAt(events, runs, { throughEvent, quarantineCoreEngine: 2, autoSubmitEngine: 3 })[0].status;
  assert.equal(at(20), 'quarantined');
  assert.equal(at(21), 'lifted');
});

/** Exercise the actual landing route against a private board and remote. */
test('a real landing refuses a newly observed unquarantined flake [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const item = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, item);
  fixtures.acceptItem(box, item);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    const outcome = passed => [{ file: 'test/unstable.test.js', name: 'unstable case', passed, skipped: false }];
    for (const [id, passed] of [['red-fixture', false], ['green-fixture', true]]) {
      logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: 'fixture-tree', kind: 'landing', testOutcomes: outcome(passed) } });
    }
  } finally { closeBoard(board); }
  const before = box.git(box.repo, 'rev-parse', 'main');
  const result = await box.runLocal(box.repo, 'land', '--json');
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.err + result.out, /FLAKE_RATCHET|unquarantined flaky test/);
  assert.match(result.err + result.out, /test\/unstable\.test\.js/);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), before);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), before);
});

/** Two actual landings retain a falling, named quarantine count in their batch receipts. */
test('real landings record the quarantine baseline and lower it after repair [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(boardFile, undefined, { gitRoot: box.repo });
  let repair;
  try {
    repair = addItem(board, { by: 'coordinator', lane: 'web', title: 'Repair synthetic flake', route: 'strong' });
    logEvent(board, 'coordinator', 'test-quarantine', repair, { engine: 1, file: 'test/old.test.js', name: 'old case', runs: [] });
  } finally { closeBoard(board); }
  const first = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, first);
  fixtures.acceptItem(box, first);
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.equal(JSON.parse(landed.out).batch.flakeRatchet.count, 1);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const laterBoard = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try { withdraw(laterBoard, repair, { agentId: 'coordinator', reason: 'The synthetic flake was repaired.' }); }
  finally { closeBoard(laterBoard); }
  const second = fixtures.itemWorktree(box, 2);
  fixtures.submitItem(box, second);
  fixtures.acceptItem(box, second);
  const next = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  assert.equal(JSON.parse(next.out).batch.flakeRatchet.count, 0);
});

/** A manual merged receipt records the count even if a current flake would block a fresh publication. */
test('manual merged records quarantine count without refusing historical publication [C7,T12]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  const item = fixtures.itemWorktree(box, 1);
  fixtures.submitItem(box, item);
  fixtures.acceptItem(box, item);
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try {
    const repair = addItem(board, { by: 'coordinator', lane: 'web', title: 'Repair fixture flake', route: 'strong' });
    logEvent(board, 'coordinator', 'test-quarantine', repair, { engine: 1, file: 'test/old.test.js', name: 'old case', runs: [] });
    for (const [id, passed] of [['receipt-red', false], ['receipt-green', true]]) {
      logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: 'receipt-tree', kind: 'landing',
        testOutcomes: [{ file: 'test/new.test.js', name: 'new case', passed, skipped: false }] } });
    }
  } finally { closeBoard(board); }
  const result = await box.runLocal(box.repo, 'merged', String(item.item), item.commit, '--note', 'already published fixture');
  assert.equal(result.code, 0, result.err + result.out);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const after = openBoard(boardFile, undefined, { gitRoot: box.repo });
  try {
    const receipt = events(after).filter(event => event.event_kind === 'merged' && event.item_id === item.item).at(-1);
    assert.equal(JSON.parse(receipt.event_detail).flakeRatchet.count, 1);
  } finally { closeBoard(after); }
});

/** The ordered writer rejects a stale snapshot before storing a batch, then seals publication. */
test('landing batch recording fences flake events and preserves the published snapshot [C7,T12]', t => {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  const boundary = events(board).at(-1).event_id;
  logEvent(board, 'coordinator', 'flake-observation', null, {});
  const snapshot = { version: 1, eventId: boundary, count: 0, quarantines: [] };
  const batch = { version: 1, id: 'ratchet-fixture', state: 'ready', base: 'a'.repeat(40), tip: 'b'.repeat(40),
    root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], flakeRatchet: snapshot };
  assert.throws(() => recordLandingBatch(board, { agentId: 'coordinator', batch }), { code: 'BOARD_BUSY' });
  batch.flakeRatchet = { ...snapshot, eventId: events(board).at(-1).event_id };
  const ready = recordLandingBatch(board, { agentId: 'coordinator', batch });
  const pushed = recordLandingBatch(board, { agentId: 'coordinator', revision: ready.revision, batch: { ...ready, state: 'pushed' } });
  assert.throws(() => recordLandingBatch(board, { agentId: 'coordinator', revision: pushed.revision,
    batch: { ...pushed, flakeRatchet: { ...pushed.flakeRatchet, count: 1, quarantines: [{ file: 'test/x.js', name: 'case', item: 1 }] } } }), { code: 'LAND_BATCH' });
});

/** Record proven, red-only, green-only and pre-landing flake evidence; return the next structured land receipt. */
function backfillFixture(t) {
  const { board } = boardFixture();
  t.after(() => closeBoard(board));
  const outcome = (file, passed) => ({ file, name: 'case', passed, skipped: false });
  const tree = letter => letter.repeat(40);
  const run = (id, on, rows) => logEvent(board, 'coordinator', 'gate-run', null, { run: { id, version: 1, tree: tree(on), kind: 'land', testOutcomes: rows } });
  run('before-red', 'a', [outcome('test/old.test.js', false)]);
  run('before-green', 'a', [outcome('test/old.test.js', true)]);
  logEvent(board, 'coordinator', 'merged', null, { flakeRatchet: { version: 1, eventId: events(board).at(-1).event_id, count: 0, quarantines: [] } });
  run('proven-red', 'b', [outcome('test/flaky.test.js', false), outcome('test/red.test.js', false), outcome('test/green.test.js', true)]);
  run('proven-green', 'b', [outcome('test/flaky.test.js', true), outcome('test/red.test.js', false), outcome('test/green.test.js', true)]);
  const receipt = { version: 1, id: '00000000-0000-4000-8000-0000000000c1', kind: 'land', tree: tree('c'), head: tree('c'), main: tree('c'),
    command: 'd'.repeat(64), green: true, failures: [], load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: new Date().toISOString(),
    testOutcomes: [outcome('test/other.test.js', true)] };
  return { board, receipt, tree };
}

/** A flake proven on a tree that never runs again is filed by the next recorded run, so landing is not stuck on it. */
test('a recorded gate run backfills quarantines for flakes proven on other trees since the last landing [C7,D1]', t => {
  const { board, receipt, tree } = backfillFixture(t);
  assert.deepEqual(landingFlakeRatchet(board).unprotected, [{ file: 'test/flaky.test.js', name: 'case' }]);
  const result = recordSealedGateRun(board, { agentId: 'coordinator', receipt, lane: 'core' });
  assert.deepEqual(result.quarantined.map(row => row.file), ['test/flaky.test.js']);
  const [quarantined] = flakeQuarantines(board);
  assert.equal(flakeQuarantines(board).length, 1, 'only-red, only-green and pre-landing tests get no quarantine');
  assert.deepEqual([quarantined.file, quarantined.tree, quarantined.runs, quarantined.status], ['test/flaky.test.js', tree('b'), ['proven-red', 'proven-green'], 'quarantined']);
  assert.match(getItem(board, quarantined.item).item_title, /Flaky test: test\/flaky\.test\.js :: case/);
  const ratchet = landingFlakeRatchet(board);
  assert.deepEqual(ratchet.unprotected, []);
  assert.equal(ratchet.allowed, true);
  assert.deepEqual(recordSealedGateRun(board, { agentId: 'coordinator', receipt: { ...receipt, id: '00000000-0000-4000-8000-0000000000c2' }, lane: 'core' }).quarantined, [], 'an active quarantine is never filed twice');
});

/** Replay runs a move at its recorded engine: an older structured run must file nothing, so later ids stay as recorded. */
test('an old-engine recorded gate run replays through the engine without backfill; a current one backfills [C7,H16]', t => {
  for (const [engine, filed] of [[QUARANTINE_BACKFILL_ENGINE - 1, 0], [ENGINE_VERSION, 1]]) {
    const { board, receipt } = backfillFixture(t);
    const items = listItems(board, { all: true }).length, before = events(board).length;
    const move = { version: 1, engine, id: `backfill-replay-${engine}`, operation: 'recordGateRun', args: [{ agentId: 'coordinator', receipt, lane: 'core' }], actor: 'coordinator' };
    applyEngineMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString() });
    assert.equal(flakeQuarantines(board).length, filed);
    assert.equal(listItems(board, { all: true }).length, items + filed, 'only the current engine adds a repair item');
    assert.deepEqual(events(board).slice(before).map(row => row.event_kind).filter(kind => ['gate-run', 'test-quarantine'].includes(kind)),
      filed ? ['gate-run', 'test-quarantine'] : ['gate-run'], 'an old move records only the run itself');
  }
});
