/** A usage record stores cached and fresh input tokens, or says they were not reported (never zero) [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../../gate/tests/fixtures/testkit.js';
import { recordCoordinatorUsage } from '../../../src/io/cost.js';
import { sumUsage } from '../../../src/io/cost/usage.js';

/** A real in-memory board_meta table behind the two native ports the store function uses. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
  return { db, nativePorts: { atomic: (_board, run) => run(), logEvent: () => {} } };
}

/** Record one usage row under a session, then read the stored records back. */
function stored(session, row) {
  const b = board();
  recordCoordinatorUsage(b, { session, records: [row], observedAt: 1 });
  return JSON.parse(b.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`coordinator:${session}`).meta_value).records;
}

const BASE = { model: FIXTURE_MODEL, inputTokens: 9, outputTokens: 4, wallMs: 0, knownInputTokens: 9, knownOutputTokens: 4, unknownReasons: [] };

test('clause 1: a usage record with cached and fresh input counts stores both [C7]', () => {
  const [record] = stored('s-split', { ...BASE, freshInputTokens: 2, cacheReadInputTokens: 5, cacheWriteInputTokens: 2 });
  assert.deepEqual([record.freshInputTokens, record.cacheReadInputTokens, record.cacheWriteInputTokens], [2, 5, 2]);
  assert.deepEqual([sumUsage([record], {}).freshInputTokens, sumUsage([record], {}).cacheReadInputTokens], [2, 5]);
});

test('clause 2: a usage record without them is stored as not reported, never as zero [C7]', () => {
  const [record] = stored('s-plain', BASE);
  assert.equal('freshInputTokens' in record, false);
  const total = sumUsage([record], {});
  assert.deepEqual([total.freshInputTokens, total.cacheReadInputTokens, total.cacheWriteInputTokens], [null, null, null]);
  const [partial] = stored('s-null', { ...BASE, freshInputTokens: 9, cacheReadInputTokens: null, cacheWriteInputTokens: null });
  assert.equal(partial.cacheReadInputTokens, null);
  assert.equal(sumUsage([partial], {}).cacheReadInputTokens, null);
});
