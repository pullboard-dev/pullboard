/** @pullboard-test-input source-cell api */
/** A cold state build over more than 64 items reads every item thread in one pass, with no per-item thread or verdict read [C7,#8480]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../../../apps/cli/tests/fixtures/api.js';
import { coldStateReads } from '../../../../../apps/cli/tests/fixtures/api.js';

/** How many of the statements read the log, the verdicts or the reopens one item at a time. */
const reads = statements => ({
  threads: statements.filter(sql => /item_id IS NULL AND event_kind = 'main-moved'/.test(sql)).length,
  verdicts: statements.filter(sql => /FROM verdict WHERE item_id = \?/.test(sql)).length,
  reopens: statements.filter(sql => /event_kind = 'reopen'/.test(sql)).length,
});

test('clause 1: a cold state build over 70 items reads no thread, verdict or reopen item by item [C7,#8480]', t => {
  const { ids, built, statements, control } = coldStateReads(apiHttpFixture(t), 70);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  assert.deepEqual(reads(statements), { threads: 0, verdicts: 0, reopens: 0 }, 'the build took every thread from the one read of the event list');
  assert.ok(statements.some(sql => /^\s*SELECT \* FROM event\b(?!\s+WHERE)/.test(sql)), 'the whole event list was read');
  assert.equal(reads(control).threads, 5, 'the control: itemThread reads the log once for each item, so the zero above is counted and not blind');
});
