/** A real checkout binds local timing to its joined seat without board writes [C7,N2]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { beginSeatTiming } from '../../seats/light.js';
import { seatLedger } from '../../seats/index.js';
import { seatLines } from '../../seats/index.js';
import { worktreeActivity } from '../../seats/index.js';
import { beginImmediateQueued } from '../src/io/board/busy.js';

test('store.seat-timing.local-command-record-binds-joined-seat: local command record binds joined seat, item, start and end [C7,N2]', t => {
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
  assert.equal(rows.length, 2); // budget: declared synthetic start and end records, not elapsed time.
  assert.equal(rows[0].phase, 'start'); assert.equal(rows[1].phase, 'end');
  assert.equal(rows[1].seat, 'core-1'); assert.equal(rows[1].item, 7); // budget: declared fixture identities, not elapsed time.
  assert.equal(rows[1].id, rows[0].id); assert.ok(rows[1].durationMs >= 0);
});

test('store.seat-timing.seat-ledger-distinguishes-held-reserved-and: seat ledger distinguishes held, reserved and idle seats and measured waits [C7,N2]', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const agents = ['builder', 'reviewer', 'idle'].map(agent_id => ({ agent_id }));
  const items = [{ item_id: 1, item_status: 'claimed', item_owner: 'builder' }, { item_id: 2, item_status: 'submitted', item_review_by: 'reviewer', item_review_until: new Date(now + 60000).toISOString() }];
  const events = agents.map(a => ({ event_by: a.agent_id, event_at: at, event_kind: 'fact' }));
  const rows = seatLedger(agents, items, events, [{ version: 1, id: 'x', seat: 'builder', kind: 'runner-wait', phase: 'end', start: now - 60000, end: now }], now);
  assert.deepEqual(rows.map(row => row.state), ['building', 'reviewing', 'idle']);
  assert.equal(rows[0].split.runnerWaitMs, 60000); // budget: declared synthetic one-minute span.
});

test('store.seat-timing.seat-ledger-prints-each-observed-live: seat ledger prints each observed live state and elapsed minutes [C7,N2]', () => {
  const now = Date.now();
  const names = ['building', 'reviewing', 'gate', 'reviewWait', 'lock', 'runner', 'silent', 'idle'];
  const agents = names.map(agent_id => ({ agent_id }));
  const ago = ms => new Date(now - ms).toISOString();
  const items = [
    ...['building', 'gate', 'lock', 'runner', 'silent'].map((owner, index) => ({ item_id: index + 1, item_status: 'claimed', item_owner: owner })),
    { item_id: 6, item_status: 'submitted', item_review_by: 'reviewing', item_review_until: ago(-60000) },
    { item_id: 7, item_status: 'submitted', item_built_by: 'reviewWait' },
  ];
  const events = names.map(name => ({ event_by: name, event_at: ago(name === 'silent' ? 25 * 60000 : 5 * 60000), event_kind: 'fact' }));
  events.push({ event_by: 'gate', item_id: 2, event_at: ago(3 * 60000), event_kind: 'submit-handoff', event_detail: '{"state":"running"}' });
  const records = ['lock', 'runner'].map((seat, i) => ({ version: 1, id: seat, seat, pid: process.pid, kind: i ? 'runner-wait' : 'lock-wait', phase: 'start', start: now - 2 * 60000 }));
  // A fixture SQLite board supplies the same seat/item/event columns as the real command.
  const board = new DatabaseSync(':memory:');
  board.exec('CREATE TABLE agent(agent_id TEXT); CREATE TABLE item(item_id INTEGER, item_status TEXT, item_owner TEXT, item_review_by TEXT, item_review_until TEXT, item_built_by TEXT); CREATE TABLE event(event_by TEXT, event_at TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  for (const agent of agents) board.prepare('INSERT INTO agent VALUES (?)').run(agent.agent_id);
  for (const item of items) board.prepare('INSERT INTO item VALUES (?,?,?,?,?,?)').run(item.item_id, item.item_status, item.item_owner ?? null, item.item_review_by ?? null, item.item_review_until ?? null, item.item_built_by ?? null);
  for (const event of events) board.prepare('INSERT INTO event VALUES (?,?,?,?,?)').run(event.event_by, event.event_at, event.event_kind, event.item_id ?? null, event.event_detail ?? null);
  const rows = seatLedger(board.prepare('SELECT * FROM agent').all(), board.prepare('SELECT * FROM item').all(), board.prepare('SELECT * FROM event').all(), records, now);
  board.close();
  const printed = seatLines(rows).join('\n');
  for (const name of ['building', 'reviewing', 'waiting on gate', 'waiting on review', 'waiting on lock', 'waiting on runner slot', 'silent', 'idle']) assert.ok(printed.includes(name));
  assert.deepEqual(rows.map(row => [row.state, row.minutes]), [
    ['building', 5], ['reviewing', 5], ['waiting on gate', 3], ['waiting on review', 5],
    ['waiting on lock', 2], ['waiting on runner slot', 2], ['silent', 25], ['idle', 5],
  ]);
});

/** The measured lock span closes even when acquisition fails for a reason unrelated to contention. */
test('store.seat-timing.board-lock-timing-closes-on-success: board lock timing closes on success and refusal [C7,N2]', () => {
  const port = Symbol.for('pullboard.seat-timing.lock');
  const prior = globalThis[port]; let started = 0, ended = 0;
  globalThis[port] = () => { started++; return () => { ended++; }; };
  try {
    const pragma = { prepare: () => ({ get: () => ({ timeout: 5000 }) }) };
    beginImmediateQueued({ ...pragma, exec() {} }, Date.now());
    assert.throws(() => beginImmediateQueued({ ...pragma, exec(sql) { if (sql === 'BEGIN IMMEDIATE') throw new Error('broken'); } }, Date.now()), /broken/u);
    assert.equal(started, 2); assert.equal(ended, 2);
  } finally { if (prior) globalThis[port] = prior; else delete globalThis[port]; }
});

/** A queued old item must not hide the seat's newer active claim. */
test('store.seat-timing.a-queued-handoff-does-not-hide: a queued handoff does not hide a newer active build [C7,N2]', () => {
  const now = Date.now(), at = new Date(now - 60000).toISOString();
  const items = [{ item_id: 1, item_status: 'claimed', item_owner: 'builder' }, { item_id: 2, item_status: 'claimed', item_owner: 'builder' }];
  const events = [{ event_by: 'builder', event_at: at, event_kind: 'submit-handoff', item_id: 1, event_detail: '{"state":"running"}' }, { event_by: 'builder', event_at: at, event_kind: 'claim', item_id: 2 }];
  const [row] = seatLedger([{ agent_id: 'builder' }], items, events, [], now);
  assert.equal(row.state, 'building'); assert.equal(row.item, 2);
});

test('store.seat-timing.a-successful-join-records-the-command: a successful join records the command that created its seat [C7,N2]', t => {
  const root = mkdtempSync(join(tmpdir(), 'seat-join-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]); mkdirSync(join(root, '.git', 'pullboard'));
  const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'));
  db.exec('CREATE TABLE agent(agent_id TEXT, agent_path TEXT); CREATE TABLE item(item_id INTEGER, item_status TEXT, item_owner TEXT)');
  const finish = beginSeatTiming(root, 'command', 'join');
  db.prepare('INSERT INTO agent VALUES (?,?)').run('core-1', root); db.close(); finish();
  const rows = readFileSync(join(root, '.git', 'pullboard', 'seat-timing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'end']); assert.equal(rows[1].seat, 'core-1');
});

test('store.seat-timing.overlapping-command-test-and-wait-spans: overlapping command, test and wait spans split observed claim time without double counting [C7,N2]', () => {
  const now = Date.now(), m = 60000;
  const agents = [{ agent_id: 'builder' }], items = [{ item_id: 1, item_status: 'claimed', item_owner: 'builder' }];
  const events = [{ event_by: 'builder', event_at: new Date(now - 10 * m).toISOString(), event_kind: 'claim', item_id: 1 }];
  const records = [
    { id: 'command', seat: 'builder', kind: 'command', start: now - 6 * m, end: now - 3 * m },
    { id: 'test', seat: 'builder', kind: 'test', start: now - 5 * m, end: now - 4 * m },
    { id: 'wait', seat: 'builder', kind: 'lock-wait', start: now - 4.5 * m, end: now - 4.25 * m },
  ];
  const [row] = seatLedger(agents, items, events, records, now);
  assert.equal(row.split.states.building, 7 * m);
  assert.equal(row.split.states.command, 2 * m);
  assert.equal(row.split.states.test, 0.75 * m);
  assert.equal(row.split.states.lockWait, 0.25 * m);
  assert.equal(Object.values(row.split.states).reduce((a, b) => a + b, 0), 24 * 60 * m);
});


test('store.seat-timing.recent-uncommitted-work-keeps-a-held: recent uncommitted work keeps a held seat building [C7,N2]', t => {
  const root = mkdtempSync(join(tmpdir(), 'seat-activity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'work.txt'), 'editing');
  const now = Date.now();
  const agents = [{ agent_id: 'builder', agent_path: root }];
  const items = [{ item_id: 7, item_status: 'claimed', item_owner: 'builder' }];
  const events = [{ event_by: 'builder', item_id: 7, event_kind: 'claim', event_at: new Date(now - 30 * 60000).toISOString() }];
  assert.equal(seatLedger(agents, items, events, [], now)[0].state, 'silent');
  assert.equal(seatLedger(agents, items, events, [], now, new Map([['builder', worktreeActivity(root)]]))[0].state, 'building');
});
