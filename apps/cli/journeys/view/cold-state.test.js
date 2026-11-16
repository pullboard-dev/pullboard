/** A cold state build over more than 64 items reads every item thread in one pass, with no per-item thread read [C7,#8480]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { coldStateReads } from '../../tests/fixtures/api.js';

/** How many of the statements read one item's thread: the per-item activity read ends in its board-wide main-move branch, which no other read has. */
const threadReads = statements => statements.filter(sql => /item_id IS NULL AND event_kind = 'main-moved'/.test(sql)).length;

test('clause 1: a cold state build over 70 items reads no thread item by item, taking them all from the one read of the event list [C7,#8480]', t => {
  const { ids, built, statements, control, threads, expected } = coldStateReads(apiHttpFixture(t), 70);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  for (const id of ids) assert.deepEqual(threads.get(id), expected.get(id), `item ${id}: the built thread equals itemThread`);
  assert.equal(threadReads(statements), 0, 'no item read the log for its own thread');
  assert.ok(statements.some(sql => /^\s*SELECT \* FROM event\b(?!\s+WHERE)/.test(sql)), 'the whole event list was read');
  assert.equal(threadReads(control), 5, 'the control: itemThread reads the log once for each item, so the zero above is counted and not blind');
});
