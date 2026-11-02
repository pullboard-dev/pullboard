/** A real checkout binds local timing to its joined seat without board writes [C7,N2]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { beginSeatTiming } from '../src/seat-timing.js';
import { seatLedger } from '../src/seat-ledger.js';

test('local command record binds joined seat, item, start and end [C7,N2]', t => {
  const root = mkdtempSync(join(tmpdir(), 'seat-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  mkdirSync(join(root, '.git', 'pullboard'));
  const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'));
  db.exec('CREATE TABLE agent(agent_id TEXT, agent_path TEXT); CREATE TABLE item(item_id INTEGER, item_status TEXT, item_owner TEXT)');
  db.prepare('INSERT INTO agent VALUES (?,?)').run('core-1', root);
  db.prepare('INSERT INTO item VALUES (?,?,?)').run(7, 'claimed', 'core-1');
  db.close();
  const finish = beginSeatTiming(root, 'command', 'status'); finish(); finish();
  const rows = readFileSync(join(root, '.git', 'pullboard', 'seat-timing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].phase, 'start'); assert.equal(rows[1].phase, 'end');
  assert.equal(rows[1].seat, 'core-1'); assert.equal(rows[1].item, 7);
  assert.equal(rows[1].id, rows[0].id); assert.ok(rows[1].durationMs >= 0);
});

test('seat ledger distinguishes held, reserved and idle seats and measured waits [C7,N2]', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const agents = ['builder', 'reviewer', 'idle'].map(agent_id => ({ agent_id }));
  const items = [{ item_id: 1, item_status: 'claimed', item_owner: 'builder' }, { item_id: 2, item_status: 'submitted', item_review_by: 'reviewer', item_review_until: new Date(now + 60000).toISOString() }];
  const events = agents.map(a => ({ event_by: a.agent_id, event_at: at, event_kind: 'fact' }));
  const rows = seatLedger(agents, items, events, [{ version: 1, id: 'x', seat: 'builder', kind: 'runner-wait', phase: 'end', start: now - 60000, end: now }], now);
  assert.deepEqual(rows.map(row => row.state), ['building', 'reviewing', 'idle']);
  assert.equal(rows[0].split.runnerWaitMs, 60000);
});
