/** A coordinator session's usage is stored once under its own key, with no claimed item [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { recordCoordinatorUsage } from '../../../src/io/cost.js';

const RECORDS = [{ model: FIXTURE_MODEL, inputTokens: 9, outputTokens: 4, wallMs: 0, knownInputTokens: 9, knownOutputTokens: 4,
  freshInputTokens: 2, cacheReadInputTokens: 5, cacheWriteInputTokens: 2, unknownReasons: [] }];

/** A real in-memory board_meta table behind the two native ports the store function uses. */
function board() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
  return { db, nativePorts: { atomic: (_board, run) => run() } };
}

test('coordinator usage is stored under coordinator:<session> with all token kinds and no item [C7]', () => {
  const b = board();
  assert.deepEqual(recordCoordinatorUsage(b, { session: 's-1', records: RECORDS, observedAt: 5 }), { recorded: true });
  const row = JSON.parse(b.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='coordinator:s-1'").get().meta_value);
  assert.equal(row.agent, 'coordinator');
  assert.equal('item' in row, false);
  const [record] = row.records;
  assert.deepEqual([record.model, record.inputTokens, record.outputTokens, record.freshInputTokens, record.cacheReadInputTokens, record.cacheWriteInputTokens],
    [FIXTURE_MODEL, 9, 4, 2, 5, 2]);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key NOT LIKE 'coordinator:%'").get().n, 0);
});

test('repeating a payload changes nothing and a changed payload refuses USAGE_CHANGED [C7]', () => {
  const b = board();
  recordCoordinatorUsage(b, { session: 's-1', records: RECORDS, observedAt: 5 });
  const before = b.db.prepare('SELECT * FROM board_meta').all();
  assert.deepEqual(recordCoordinatorUsage(b, { session: 's-1', records: RECORDS, observedAt: 5 }), { duplicate: true });
  assert.deepEqual(b.db.prepare('SELECT * FROM board_meta').all(), before);
  assert.throws(() => recordCoordinatorUsage(b, { session: 's-1', records: [{ ...RECORDS[0], outputTokens: 5, knownOutputTokens: 5 }], observedAt: 5 }), { code: 'USAGE_CHANGED' });
});
