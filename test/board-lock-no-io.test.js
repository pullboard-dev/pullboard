/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/board.js src/cli.js src/board-event-log.js */
/** Criterion preparation must not occupy the actual SQLite writer lease [B2,C7,V2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';

/** Set up only native fixture operations; file storage is necessary to observe the writer lock. */
function setup(t) {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'locking' });
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const agentId = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Prepared outside the writer',
    criterion: 'The actual fixture check passes', check: 'node bin/run-tests.js test/board-lock-no-io.test.js',
    brief: 'Files: src/board.js\nTest: observes the actual private SQLite writer', route: 'strong' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const peer = new DatabaseSync(file);
  peer.exec('PRAGMA busy_timeout=0');
  t.after(() => peer.close());
  return { board, agentId, id, peer };
}

/** Prepare a real source read and prove a separate connection can acquire and release the actual lock. */
function unlockedFreeze(peer, observed) {
  return item => {
    assert.ok(readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8').length > 0);
    peer.exec('BEGIN IMMEDIATE');
    try { observed.calls++; }
    finally { peer.exec('ROLLBACK'); }
    return { text: JSON.stringify({ criterion: item.item_criterion, check: item.item_check, rows: [],
      policy: { version: 1, commit: 'a'.repeat(40), verify: { policy: 'any', family: 'off' } } }), digest: 'prepared-lock-fixture' };
  };
}

test('claim prepares its criterion before the real SQLite write lock [B2,C7,V2]', t => {
  const { board, agentId, id, peer } = setup(t);
  const observed = { calls: 0 };
  const result = store.claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000,
    freeze: unlockedFreeze(peer, observed) });
  assert.equal(observed.calls, 1, 'prepare the actual source once');
  assert.equal(result.renewed, false);
  assert.equal(store.getItem(board, id).item_owner, agentId);
  assert.equal(store.events(board).filter(event => event.item_id === id && event.event_kind === 'claim').length, 1);
});

test('a refused claim keeps the original guard priority before criterion preparation [B2,V2]', t => {
  const { board, agentId, id } = setup(t);
  const before = store.events(board);
  let calls = 0;
  assert.throws(() => store.claim(board, id, { agentId, lane: 'other', leaseMs: 7_200_000,
    freeze: () => { calls++; throw new Error('a wrong-lane claim must not read source'); } }),
  error => error.code === 'WRONG_LANE');
  assert.equal(calls, 0);
  assert.deepEqual(store.events(board), before);
  assert.equal(store.getItem(board, id).item_status, 'open');
});
