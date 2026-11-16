/** Throwaway measurement of a dual-write replay on a file board [C7,#9020]. */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';

test('measure 9020 replay [C7]', () => {
  const N = Number(process.env.M9020 ?? 30000);
  process.env[DERIVED_SETTING] = '1';
  const db = new DatabaseSync(join(privateFixtureFiles('pullboard-m9020-').root, 'board.sqlite'));
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  let clock = Date.parse('2026-10-01T00:00:00Z');
  db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    clock += 37_000;
    const item = (i / 5 | 0) + 1, kinds = ['add', 'claim', 'submit', 'accept', 'merged'], kind = kinds[i % 5];
    insert.run(new Date(clock).toISOString(), kind === 'add' ? 'coordinator' : `agent-${item % 40}`, kind, item, JSON.stringify(kind === 'add' ? { lane: 'core', after: [] } : { commit: String(item).padStart(8, '0').repeat(5) }));
  }
  db.exec('COMMIT');
  const board = { db, runtimePorts: { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } } };
  const t0 = performance.now();
  rebuildProofCounters(board, { refresh: false });
  console.log(`MEASURE9020 events=${N} replay=${(performance.now() - t0).toFixed(0)}ms`);
  db.close();
});
