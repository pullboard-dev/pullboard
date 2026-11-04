/** pullboard land --why and the status landing line read recorded events only [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { landWhy, landWhyLines, landingLine } from '../packages/landing/src/core/land-why.js';

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
  const machine = { file: 'test/machine.test.js', name: 'boots', assertion: 'expected 1' };
  add('landing_batch', null, { batch: { id: 'b1', state: 'blocked', startedAt: at(50), items: [{ id: 21 }], blocked: [], refusal: { code: 'LAND_GATE_RED' }, gateResults: [{ failures: [machine] }] } }, 50);
  add('landing_batch', null, { batch: { id: 'b2', state: 'blocked', startedAt: at(10), items: [{ id: 22 }, { id: 23 }],
    blocked: [{ id: 22, code: 'ITEM_HELD' }, { id: 23, code: 'ITEM_HELD' }, { id: 24, code: 'STALE_VERDICT' }], refusal: { code: 'LAND_GATE_RED' },
    gateResults: [{ failures: [machine, { file: 'test/mine.test.js', name: 'only here', assertion: 'x' }] }] } }, 10);
  return board;
}

test('land --why names the last landing, the batch, its refusal, blocked items and each failure by scope [C7]', (t) => {
  const why = landWhy(seeded(t), NOW);
  assert.deepEqual(why.lastLanded, { item: 12, at: '2026-11-04T09:30:00.000Z' });
  assert.equal(why.batch.id, 'b2');
  assert.equal(why.batch.state, 'blocked');
  assert.deepEqual(why.batch.items, [22, 23]);
  assert.equal(why.batch.refusal, 'LAND_GATE_RED');
  assert.deepEqual(why.blocked.map(entry => [entry.id, entry.code]), [[22, 'ITEM_HELD'], [23, 'ITEM_HELD'], [24, 'STALE_VERDICT']]);
  assert.deepEqual(why.failures.map(entry => [entry.file, entry.name, entry.scope]),
    [['test/machine.test.js', 'boots', 'also red on main'], ['test/mine.test.js', 'only here', 'batch only']]);
  const text = landWhyLines(why).join('\n');
  assert.match(text, /last landed: #12 at 2026-11-04T09:30/u);
  assert.match(text, /blocked: #24 STALE_VERDICT/u);
  assert.match(text, /test\/machine\.test\.js :: boots \(also red on main\)/u);
  assert.match(text, /test\/mine\.test\.js :: only here \(batch only\)/u);
});

test('the status landing line counts the last hour and names the top blocker [C7]', (t) => {
  const why = landWhy(seeded(t), NOW);
  assert.equal(why.landedLastHour, 1, 'the merge 90 minutes ago is outside the hour');
  assert.equal(why.reopenedLastHour, 1);
  assert.equal(landingLine(why), 'landing: 1 landed, 1 reopened in the last hour; top blocker: LAND_GATE_RED');
});

test('an empty board and a landed batch read cleanly, from events alone with no git [C7]', (t) => {
  const board = openBoard(':memory:', { now: () => NOW });
  t.after(() => store.closeBoard(board));
  assert.deepEqual(landWhyLines(landWhy(board, NOW)), ['last landed: nothing yet', 'batch: none recorded']);
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,?,?)')
    .run(NOW.toISOString(), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: 'ok', state: 'landed', items: [{ id: 1 }] } }));
  assert.equal(landWhy(board, NOW).topBlocker, null);
  assert.match(landingLine(landWhy(board, NOW)), /top blocker: none/u);
});
