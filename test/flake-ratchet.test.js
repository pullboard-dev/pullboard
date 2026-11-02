/** Quarantine counts are a per-landing ratchet, with named flake evidence [C7,T12]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flakeRatchet, pairedFlakeObservations, quarantinesAt, landingFlakeRatchet, legacyFlakeObservations } from '../packages/flakes/index.js';

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
  const { DatabaseSync } = await import('node:sqlite');
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
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const readers = { readRuns: () => [], readQuarantines: () => [], readLedger: () => {
    db.prepare('INSERT INTO event VALUES (1, ?, NULL, ?)').run('fact', '{}');
    return [];
  } };
  assert.throws(() => landingFlakeRatchet({ db }, readers), { code: 'BOARD_BUSY' });
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
  const { prepareFlakeLanding } = await import('../packages/landing/index.js');
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
