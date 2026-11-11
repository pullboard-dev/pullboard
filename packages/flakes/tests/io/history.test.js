/** Gate-run and flake history is read before the board lock, so a write inside it reads only the events since [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { eventHistory } from '../../src/io/history.js';
import { gateRuns } from '../../index.js';
import { warmFlakeHistory } from '../../index.js';

/** A board with only the event log the histories read. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT,
    item_id INTEGER, event_detail TEXT); CREATE INDEX event_kind_id ON event (event_kind, event_id);`);
  return { db };
}

/** Append one gate run the way the board records it. */
function run(target, id, extra = {}) {
  target.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'coordinator', 'gate-run', null, JSON.stringify({ engine: 1, run: { id, tree: 't', failures: [], ...extra } }));
}

/** A parse that counts how many events it was handed. */
function counting() {
  const parse = row => { parse.calls += 1; return { id: row.event_id }; };
  parse.calls = 0;
  return parse;
}

test('a history warmed before the lock parses only the events since, inside it [C7]', () => {
  const target = board();
  for (let n = 0; n < 500; n += 1) run(target, `r${n}`);
  const parse = counting();
  assert.equal(eventHistory(target, 'runs', ['gate-run'], parse).length, 500);
  assert.equal(parse.calls, 500);
  target.db.exec('BEGIN IMMEDIATE');
  run(target, 'new');
  const inside = eventHistory(target, 'runs', ['gate-run'], parse);
  target.db.exec('COMMIT');
  assert.equal(inside.length, 501);
  assert.equal(parse.calls, 501, 'the lock reads one new event, not the 500 before it');
});

test('a run read inside a transaction that rolls back is never kept [C7]', () => {
  const target = board();
  run(target, 'kept');
  assert.deepEqual(gateRuns(target).map(entry => entry.id), ['kept']);
  target.db.exec('BEGIN IMMEDIATE');
  run(target, 'phantom');
  assert.deepEqual(gateRuns(target).map(entry => entry.id), ['kept', 'phantom']);
  target.db.exec('ROLLBACK');
  run(target, 'later');
  assert.deepEqual(gateRuns(target).map(entry => entry.id), ['kept', 'later']);
});

test('a log that no longer matches the kept prefix is read again from the start [C7]', () => {
  const target = board();
  for (const id of ['a', 'b', 'c']) run(target, id);
  const parse = counting();
  eventHistory(target, 'runs', ['gate-run'], parse);
  target.db.exec("DELETE FROM event WHERE event_id = 2");
  assert.deepEqual(eventHistory(target, 'runs', ['gate-run'], parse).map(entry => entry.id), [1, 3]);
  assert.equal(parse.calls, 5, 'two events read again after the prefix changed');
});

test('shared runs are frozen, so one caller cannot change what the next reads [C7]', () => {
  const target = board();
  run(target, 'one', { failures: [{ file: 'a.test.js', name: 'x' }] });
  const [first] = gateRuns(target);
  assert.throws(() => { first.tree = 'changed'; }, TypeError);
  assert.throws(() => { first.failures.push({}); }, TypeError);
  assert.equal(gateRuns(target)[0].tree, 't');
});

test('warming outside a transaction keeps the history; inside one it reads nothing early [C7]', () => {
  const target = board();
  run(target, 'w');
  target.db.exec('BEGIN');
  warmFlakeHistory(target);
  target.db.exec('COMMIT');
  warmFlakeHistory(target);
  target.db.exec('BEGIN IMMEDIATE');
  assert.deepEqual(gateRuns(target).map(entry => entry.id), ['w']);
  target.db.exec('COMMIT');
});
