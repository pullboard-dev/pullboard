/** pullboard land --why and the status landing line read recorded events only [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../../store/tests/fixtures/cell.js';
import {
  landWhy,
  landWhyLines,
  landingLine,
} from '../../../index.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');

/** A board with one landed item, a recent reopen and two refused batches sharing a failure. */
function seeded(t) {
  const board = openBoard(':memory:', { now: () => NOW });
  t.after(() => store.closeBoard(board));
  const at = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const add = (kind, item, detail, minutes) => board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)').run(at(minutes), 'coordinator', kind, item, JSON.stringify(detail));
  add('merged', 11, { commit: 'a'.repeat(40) }, 90);
  add('merged', 12, { commit: 'b'.repeat(40) }, 30);
  add('reopen', 13, {}, 20);
  add('reopen', 14, {}, 120);
  const machine = { file: 'apps/cli/journeys/verify/machine.test.js', name: 'boots', assertion: 'expected 1' };
  const unchecked = { file: 'test/other.test.js', name: 'no comparison', assertion: 'y' };
  add('landing_batch', null, { batch: { id: 'b1', state: 'blocked', startedAt: at(50), items: [{ id: 21 }], blocked: [], refusal: { code: 'LAND_GATE_RED' }, gateResults: [{ failures: [machine] }] } }, 50);
  // An overlapping batch: it shares the item that causes the failure, so differing item sets prove nothing about main.
  add('landing_batch', null, { batch: { id: 'b1b', state: 'blocked', items: [{ id: 21 }, { id: 25 }], blocked: [], gateResults: [{ failures: [unchecked] }] } }, 40);
  add('landing_batch', null, { batch: { id: 'b2', state: 'blocked', startedAt: at(10), items: [{ id: 22 }, { id: 23 }],
    blocked: [{ id: 22, code: 'ITEM_HELD' }, { id: 23, code: 'ITEM_HELD' }, { id: 24, code: 'STALE_VERDICT' }], refusal: { code: 'LAND_GATE_RED' },
    gateResults: [{ knownMain: [machine], failures: [{ file: 'test/mine.test.js', name: 'only here', assertion: 'x' }, unchecked] }] } }, 10);
  return board;
}

test('landing.why.land-why-names-the-last-landing: clause 1: land --why names the last landing, the batch, its refusal, blocked items and each failure by scope [C7]', (t) => {
  const why = landWhy(seeded(t), NOW);
  assert.deepEqual(why.lastLanded, { item: 12, at: '2026-11-04T09:30:00.000Z' });
  assert.equal(why.batch.id, 'b2');
  assert.equal(why.batch.state, 'blocked');
  assert.deepEqual(why.batch.items, [22, 23]);
  assert.equal(why.batch.refusal, 'LAND_GATE_RED');
  assert.deepEqual(why.blocked.map(entry => [entry.id, entry.code]), [[22, 'ITEM_HELD'], [23, 'ITEM_HELD'], [24, 'STALE_VERDICT']]);
  assert.deepEqual(why.failures.map(entry => [entry.file, entry.name, entry.scope]),
    [['apps/cli/journeys/verify/machine.test.js', 'boots', 'also red on main'], ['test/mine.test.js', 'only here', 'batch only'], ['test/other.test.js', 'no comparison', 'batch only']]);
  const text = landWhyLines(why).join('\n');
  assert.match(text, /last landed: #12 at 2026-11-04T09:30/u);
  assert.match(text, /blocked: #24 STALE_VERDICT/u);
  assert.match(text, /apps\/cli\/journeys\/verify\/machine\.test\.js :: boots \(also red on main\)/u);
  assert.match(text, /test\/mine\.test\.js :: only here \(batch only\)/u);
});

test('landing.why.without-a-recorded-main-comparison-a: without a recorded main comparison a failure is unknown, even when an overlapping batch also failed it [C7]', (t) => {
  const board = seeded(t);
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)').run(NOW.toISOString(), 'coordinator', 'landing_batch', null,
    JSON.stringify({ batch: { id: 'b3', state: 'blocked', items: [{ id: 21 }, { id: 26 }], gateResults: [{ failures: [{ file: 'apps/cli/journeys/verify/machine.test.js', name: 'boots' }] }] } }));
  assert.deepEqual(landWhy(board, NOW).failures.map(entry => entry.scope), ['unknown']);
  assert.match(landWhyLines(landWhy(board, NOW)).join('\n'), /boots \(unknown\)/u);
});

test('landing.why.the-status-landing-line-counts-the: clause 2: the status landing line counts the last hour and names the top blocker [C7]', (t) => {
  const why = landWhy(seeded(t), NOW);
  assert.equal(why.landedLastHour, 1, 'the merge 90 minutes ago is outside the hour');
  assert.equal(why.reopenedLastHour, 1);
  assert.equal(landingLine(why), 'landing: 1 landed, 1 reopened in the last hour; top blocker: LAND_GATE_RED');
});

test('landing.why.an-empty-board-and-a-landed: clause 3: an empty board and a landed batch read cleanly, from events alone with no git [C7]', (t) => {
  const board = openBoard(':memory:', { now: () => NOW });
  t.after(() => store.closeBoard(board));
  assert.deepEqual(landWhyLines(landWhy(board, NOW)), ['last landed: nothing yet', 'batch: none recorded']);
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)')
    .run(NOW.toISOString(), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: 'ok', state: 'landed', items: [{ id: 1 }] } }));
  assert.equal(landWhy(board, NOW).topBlocker, null);
  assert.match(landingLine(landWhy(board, NOW)), /top blocker: none/u);
});

test('landing.why.land-why-on-a-20000-event: clause 1: land --why on a 20000-event landing history answers in under 1 s [C7]', (t) => {
  const board = openBoard(':memory:', { now: () => NOW });
  t.after(() => store.closeBoard(board));
  const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)');
  board.db.exec('BEGIN');
  for (let index = 0; index < 20_000; index++) {
    insert.run(NOW.toISOString(), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: `h${index}`, state: 'blocked', items: [{ id: index }], gateResults: [{ failures: [{ file: 'test/x.test.js', name: `case ${index}` }] }] } }));
  }
  board.db.exec('COMMIT');
  insert.run(NOW.toISOString(), 'coordinator', 'merged', 7, '{}');
  const started = performance.now();
  const why = landWhy(board, NOW);
  const lines = landWhyLines(why);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `land --why took ${Math.round(elapsed)} ms`); // budget: declared by the item's bar, under 1 s
  assert.equal(why.batch.id, 'h19999');
  assert.equal(why.lastLanded.item, 7);
  assert.match(lines.join('\n'), /case 19999 \(unknown\)/u);
});

test('landing.why.a-failure-is-also-red-on: clause 1: a failure is also red on main when the batch itself records the main comparison, as the landing writer saves it [C7]', (t) => {
  const board = openBoard(':memory:', { now: () => NOW });
  t.after(() => store.closeBoard(board));
  const insert = board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)');
  // The production shape: gate rows carry tree, failures and accounting; knownMain sits on the batch.
  insert.run(NOW.toISOString(), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: 'real', state: 'blocked', items: [{ id: 5 }],
    knownMain: [{ file: 'apps/cli/journeys/verify/machine.test.js', name: 'boots' }],
    gateResults: [{ tree: 't', isGreen: false, accounted: [], complete: true, failures: [{ file: 'apps/cli/journeys/verify/machine.test.js', name: 'boots' }, { file: 'test/mine.test.js', name: 'only here' }] }] } }));
  assert.deepEqual(landWhy(board, NOW).failures.map(entry => [entry.file, entry.scope]),
    [['apps/cli/journeys/verify/machine.test.js', 'also red on main'], ['test/mine.test.js', 'batch only']]);
});
