/** @pullboard-test-loads packages/state/src/io/engine/numbers.js packages/stats/src/io/cost.js */
/** The coordinator usage move is numbered one above every other engine and refuses older replays [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../../apps/cli/tests/fixtures/testkit.js';
import { COORDINATOR_USAGE_ENGINE } from '../light.js';
import { ENGINE_FOLDER } from '../src/io/engine/numbers.js';
import { readEngineLeaves } from '../src/io/engine/numbers.js';
import { recordCoordinatorUsage } from '../../stats/src/io/cost.js';

const RECORDS = [{ model: FIXTURE_MODEL, inputTokens: 1, outputTokens: 1, wallMs: 0, knownInputTokens: 1, knownOutputTokens: 1, unknownReasons: [] }];

/** A real in-memory board_meta table behind the one native port the store function uses. */
function board(executionEngineVersion) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)');
  return { db, executionEngineVersion, nativePorts: { atomic: (_board, run) => run() } };
}

test('COORDINATOR_USAGE_ENGINE is one above the highest other engine number [C7]', () => {
  const others = readEngineLeaves(resolve(import.meta.dirname, '../../..', ENGINE_FOLDER)).filter(leaf => leaf.name !== 'COORDINATOR_USAGE_ENGINE');
  assert.equal(COORDINATOR_USAGE_ENGINE, Math.max(...others.map(leaf => leaf.number ?? 0)) + 1);
});

test('recordCoordinatorUsage refuses below its engine with ENGINE_VERSION and records at it [C7]', () => {
  const old = board(COORDINATOR_USAGE_ENGINE - 1);
  assert.throws(() => recordCoordinatorUsage(old, { session: 's-1', records: RECORDS, observedAt: 1 }), { code: 'ENGINE_VERSION' });
  assert.equal(old.db.prepare('SELECT COUNT(*) AS n FROM board_meta').get().n, 0);
  assert.deepEqual(recordCoordinatorUsage(board(COORDINATOR_USAGE_ENGINE), { session: 's-1', records: RECORDS, observedAt: 1 }), { recorded: true });
});
