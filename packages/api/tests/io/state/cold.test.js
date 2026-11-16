/** @pullboard-test-input source-cell api */
/** A cold state build over a board of at least 70 items reads every item's verdicts and reopens in one pass each [C7,#8848]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../../../apps/cli/tests/fixtures/api.js';
import { coldStateReads } from '../../../../../apps/cli/tests/fixtures/api.js';

/** How many of the build's statements read verdict rows, and how many read reopen events. */
const verdictReads = statements => statements.filter(sql => /\bFROM verdict\b/.test(sql));
const reopenReads = statements => statements.filter(sql => /event_kind = 'reopen'/.test(sql));

test('clause 1: a cold state build over 70 items reads verdict rows once in total, not once per item [C7,#8848]', t => {
  const { ids, built, statements } = coldStateReads(apiHttpFixture(t), 70);
  assert.ok(ids.length >= 70);
  assert.deepEqual(ids.filter(id => !built.includes(id)), [], 'the build projected every item');
  assert.equal(verdictReads(statements).length, 1, verdictReads(statements).join('\n'));
});

test('clause 2: the same build reads reopen rows once in total [C7,#8848]', t => {
  const { statements } = coldStateReads(apiHttpFixture(t), 70);
  assert.equal(reopenReads(statements).length, 1, reopenReads(statements).join('\n'));
});
