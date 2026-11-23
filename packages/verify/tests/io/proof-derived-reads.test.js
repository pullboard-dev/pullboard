/** With PULLBOARD_PROOF_DERIVED_DB on, proof counter reads come from the derived database; off they read board_meta [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { test } from 'node:test';
import { proofCounter } from '../../src/io/proof/counters.js';
import { proofCounterRows } from '../../src/io/proof/counters.js';
import { rebuildProofCounters } from '../../src/io/proof/counters.js';
import { PROOF_COUNTER_PREFIX } from '../../src/io/proof/counters.js';
import { DERIVED_SETTING } from '../../src/io/proof/derived.js';
import { counterProofStats } from '../../src/io/proof/caught.js';

/** A file-backed board with a few items' events and counters rebuilt under the setting; the setting is restored after the test. */
function recorded(t, setting = '1') {
  const dir = privateFixtureFiles('pullboard-derived-reads-').root;
  const previous = process.env[DERIVED_SETTING];
  if (setting === '1') delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = '0';
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
  t.after(() => {
    if (previous === undefined) delete process.env[DERIVED_SETTING]; else process.env[DERIVED_SETTING] = previous;
    db.close();
  });
  db.exec('CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  db.exec('CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT)');
  const insert = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const put = (kind, by, id, detail) => { clock += 37_000; insert.run(new Date(clock).toISOString(), by, kind, id, JSON.stringify(detail)); };
  for (let item = 1; item <= 6; item++) {
    put('add', 'coordinator', item, { lane: 'core', after: [] });
    put('claim', `agent-${item}`, item, { leaseUntil: new Date(clock + 3_600_000).toISOString() });
    put('submit', `agent-${item}`, item, { commit: item.toString(16).padStart(8, '0').repeat(5) });
  }
  const board = { db, runtimePorts: { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } } };
  rebuildProofCounters(board, { refresh: false });
  return board;
}

test('clause 1: with PULLBOARD_PROOF_DERIVED_DB=1 readCounter, proofCounter and proofCounterRows return the derived rows [C7]', t => {
  const board = recorded(t);
  const summary = proofCounter(board, 'summary');
  const events = proofCounterRows(board, 'event');
  assert.equal(summary.last, 18);
  assert.equal(events.length, 18);
  assert.deepEqual(events.map(row => row.item).slice(0, 3), [1, 1, 1], 'numeric id order, not text order');
  // Empty board_meta: only the derived database can still answer.
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`);
  assert.deepEqual(proofCounter(board, 'summary'), summary, 'the point read comes from the derived file');
  assert.deepEqual(proofCounterRows(board, 'event'), events, 'the kind read comes from the derived file');
  // Held reads (inside a replay) take the same source.
  assert.deepEqual(proofCounter(board, 'item:2'), proofCounter(board, 'item:2'));
  assert.notEqual(proofCounter(board, 'item:2'), null);
});

test('clause 2: with the setting off the counters read board_meta exactly as today [C7]', t => {
  const board = recorded(t, 'off');
  const summary = proofCounter(board, 'summary');
  assert.deepEqual(proofCounter(board, 'summary'), summary, 'board_meta still holds the rows');
  board.db.prepare('DELETE FROM board_meta WHERE meta_key GLOB ?').run(`${PROOF_COUNTER_PREFIX}*`);
  assert.equal(proofCounter(board, 'summary'), null, 'off, an emptied board_meta reads empty');
  assert.deepEqual(proofCounterRows(board, 'event'), []);
});

/** The per-event proof counters the paged case writes, and the most rows one counter read may return. */
const EVENT_ROWS = 200_000;
const PAGE_ROWS = 5000;
const SINCE = '2026-10-15T00:00:00.000Z';

/** One synthetic per-event fact, the shape appendProofCounter stores; the last two share an instant written two ways. */
function fact(index) {
  const at = Date.parse('2026-11-01T00:00:00Z') + Math.min(index, EVENT_ROWS - 2) * 1000;
  const date = index === EVENT_ROWS - 1 ? new Date(at).toISOString().replace('.000Z', 'Z') : new Date(at).toISOString();
  return { at, date, by: `agent-${index % 4}`, family: index % 8 < 4 ? 'anthropic' : 'openai', item: 1 + (index % 500),
    submitted: index % 3 === 0, rejected: index % 5 === 0, merged: index % 7 === 0, anomaly: index % 14 === 0 };
}

/** The window counters and actors as one read of every fact computed them: filter, sort the dates, count. */
function wholeRead(facts, boundary, seats) {
  const start = boundary ? Date.parse(boundary) : -Infinity;
  const selected = facts.filter(row => row.at >= start);
  const dates = selected.map(row => row.date).sort((a, b) => Date.parse(a) - Date.parse(b));
  const agents = new Map(), families = new Map();
  for (const row of selected.filter(row => seats.has(row.by))) {
    const agent = agents.get(row.by) ?? { id: row.by, moves: 0, families: new Set() }; agents.set(row.by, agent);
    agent.moves += 1; agent.families.add(row.family);
    const family = families.get(row.family) ?? { name: row.family, moves: 0, agents: new Set() }; families.set(row.family, family);
    family.moves += 1; family.agents.add(row.by);
  }
  return { counts: { since: boundary, submissions: selected.filter(row => row.submitted).length, rejections: selected.filter(row => row.rejected).length,
    merged: new Set(selected.filter(row => row.merged).map(row => row.item)).size,
    mergedWithoutAccept: new Set(selected.filter(row => row.merged && row.anomaly).map(row => row.item)).size,
    firstEventAt: dates[0] ?? null, lastEventAt: dates.at(-1) ?? null },
  agents: [...agents.values()].map(agent => ({ ...agent, families: [...agent.families].sort() })).sort((a, b) => a.id < b.id ? -1 : 1),
  families: [...families.values()].map(family => ({ ...family, agents: family.agents.size })).sort((a, b) => a.name < b.name ? -1 : 1) };
}

/** A connection whose counter reads record how many rows each read returned. */
function counted(db, reads) {
  const wrap = statement => new Proxy(statement, { get(target, name) {
    if (name === 'all') return (...args) => { const rows = target.all(...args); reads.push(rows.length); return rows; };
    if (name === 'iterate') return (...args) => { const rows = [...target.iterate(...args)]; reads.push(rows.length); return rows.values(); };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, name) {
    if (name === 'prepare') return sql => /proof_counter|board_meta/u.test(sql) ? wrap(target.prepare(sql)) : target.prepare(sql);
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('verify.io-proof-derived-reads.proof-stats-page-event-counters: clause 1: counterProofStats on a board with 200,000 per-event proof counters returns the same totals as a whole read, with and without since, while no read returns more than 5,000 counter rows [C7,#13010]', t => {
  const previous = process.env[DERIVED_SETTING];
  delete process.env[DERIVED_SETTING];
  const db = new DatabaseSync(join(privateFixtureFiles('pullboard-derived-paged-').root, 'board.sqlite'));
  t.after(() => {
    if (previous !== undefined) process.env[DERIVED_SETTING] = previous;
    db.close();
  });
  db.exec(`CREATE TABLE board_meta(meta_key TEXT PRIMARY KEY, meta_value TEXT);
    CREATE TABLE event(event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT);
    CREATE TABLE agent(agent_id TEXT PRIMARY KEY, agent_lane TEXT);
    CREATE TABLE verdict(verdict_id INTEGER PRIMARY KEY, item_id INTEGER, verdict_kind TEXT)`);
  const add = db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)');
  for (let item = 1; item <= 3; item++) add.run(`2026-10-0${item}T00:00:00.000Z`, 'coordinator', 'add', item, JSON.stringify({ lane: 'core', after: [] }));
  const seats = new Set(['agent-0', 'agent-1', 'agent-2', 'agent-3']);
  for (const seat of seats) db.prepare('INSERT INTO agent VALUES (?,?)').run(seat, 'core');
  const runtime = { verification: { appendRigorCounter() {}, ensureRigorCounters() {} } };
  rebuildProofCounters({ db, runtimePorts: runtime }, { refresh: false });
  const recordedFacts = proofCounterRows({ db, runtimePorts: runtime }, 'event');
  const facts = Array.from({ length: EVENT_ROWS }, (_, index) => fact(index));
  const put = db.prepare('INSERT INTO proof_derived.proof_counter(meta_key,meta_value) VALUES (?,?)');
  db.exec('BEGIN');
  facts.forEach((row, index) => put.run(`${PROOF_COUNTER_PREFIX}v2:event:${1000 + index}`, `{"data":${JSON.stringify(row)},"numbers":[]}`));
  db.exec('COMMIT');
  const reads = [];
  const board = { db: counted(db, reads), runtimePorts: runtime };
  const now = Date.parse('2026-11-22T00:00:00Z');
  const pick = stats => ({ since: stats.since, submissions: stats.submissions, rejections: stats.rejections, merged: stats.merged,
    mergedWithoutAccept: stats.mergedWithoutAccept, firstEventAt: stats.firstEventAt, lastEventAt: stats.lastEventAt });

  const windowed = counterProofStats(board, SINCE, now);
  const expected = wholeRead([...recordedFacts, ...facts], SINCE, seats);
  assert.deepEqual(pick(windowed), expected.counts, 'the since window counts what a whole read counts');
  assert.equal(windowed.lastEventAt, facts.at(-1).date, 'a tie on the last instant keeps the later recorded fact');
  assert.deepEqual(windowed.agents, expected.agents);
  assert.deepEqual(windowed.families, expected.families);
  assert.deepEqual([windowed.agentCount, windowed.familyCount], [4, 2]);

  const all = counterProofStats(board, null, now);
  const summary = proofCounter(board, 'summary');
  assert.deepEqual(pick(all), { since: null, submissions: summary.submissions, rejections: summary.rejections, merged: summary.merged,
    mergedWithoutAccept: summary.mergedWithoutAccept, firstEventAt: summary.firstEventAt, lastEventAt: summary.lastEventAt }, 'all-time counts come from the summary row');
  const whole = wholeRead([...recordedFacts, ...facts], null, seats);
  assert.deepEqual(all.agents, whole.agents, 'all-time actors fold every per-event fact');
  assert.deepEqual(all.families, whole.families);

  assert.ok(reads.reduce((sum, rows) => sum + rows, 0) >= 2 * EVENT_ROWS, 'both reads visited every per-event counter');
  assert.ok(Math.max(...reads) <= PAGE_ROWS, `no counter read returned more than ${PAGE_ROWS} rows (largest ${Math.max(...reads)})`);
});
