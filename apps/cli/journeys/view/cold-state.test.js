/** A cold state build over more than 64 items reads every item thread, and over 70 every item's verdicts and reopens, in one pass each [C7,#8480,#8848]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { coldStateReads } from '../../tests/fixtures/api.js';

/** How many of the statements read one item's thread: the per-item activity read ends in its board-wide main-move branch, which no other read has. */
const threadReads = statements => statements.filter(sql => /item_id IS NULL AND event_kind = 'main-moved'/.test(sql)).length;

test('cli.journeys-view-cold-state.a-cold-state-build-over-70: clause 1: a cold state build over 70 items reads no thread item by item, taking them all from the one read of the event list [C7,#8480]', t => {
  const { ids, built, statements, control, threads, expected } = coldStateReads(apiHttpFixture(t), 70);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  for (const id of ids) assert.deepEqual(threads.get(id), expected.get(id), `item ${id}: the built thread equals itemThread`);
  assert.equal(threadReads(statements), 0, 'no item read the log for its own thread');
  assert.ok(statements.some(sql => /^\s*SELECT \* FROM event\b(?!\s+WHERE)/.test(sql)), 'the whole event list was read');
  assert.equal(threadReads(control), 5, 'the control: itemThread reads the log once for each item, so the zero above is counted and not blind');
});

/** The build's statements that read an item's verdict rows (one item at a time, or every item's at once), and those that read reopen events. Whole-table reads for other purposes are not item verdict reads. */
const verdictReads = statements => statements.filter(sql => /\bFROM verdict (?:WHERE item_id|JOIN item)/.test(sql));
const reopenReads = statements => statements.filter(sql => /event_kind = 'reopen'/.test(sql));

test('cli.journeys-view-cold-state.a-cold-state-build-over-70-2: clause 1: a cold state build over 70 items reads verdict rows once in total, not once per item [C7,#8848]', t => {
  const { ids, built, statements } = coldStateReads(apiHttpFixture(t), 70);
  assert.ok(ids.length >= 70);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  assert.equal(verdictReads(statements).length, 1, verdictReads(statements).join('\n'));
});

test('cli.journeys-view-cold-state.the-same-build-reads-reopen-rows: clause 2: the same build reads reopen rows once in total [C7,#8848]', t => {
  const { statements } = coldStateReads(apiHttpFixture(t), 70);
  assert.equal(reopenReads(statements).length, 1, reopenReads(statements).join('\n'));
});

test('cli.journeys-view-cold-state.a-cold-state-build-over-300-items-takes-under: clause 1: a cold state build over 300 items takes under 10 s, built through the same view ports the API serves [C7,#8480]', t => {
  const started = performance.now();
  const { ids, built } = coldStateReads(apiHttpFixture(t), 300);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(ids.length >= 300);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  assert.ok(seconds < 10, `the cold build of ${ids.length} items took ${seconds.toFixed(2)} s`);
});
