/** The pipeline ledger joins board events, gate and landing spans, receipts and session logs into per-hop time [C7,N2]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { itemLedger } from '../../../src/logic/pipeline/ledger.js';
import { ledgerLines } from '../../../src/logic/pipeline/ledger.js';
import { pipelineLedger } from '../../../src/logic/pipeline/ledger.js';
import { tile } from '../../../src/logic/pipeline/ledger.js';
import { foldText } from '../../../src/logic/activity.js';
import { newFold } from '../../../src/logic/activity.js';
import { claudeProjectName } from '../../../src/io/logs.js';
import { readSessions } from '../../../src/io/logs.js';
import { readPipelineLedger } from '../../../src/io/ledger.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const MIN = 60_000;
const BUILDER_MODEL = 'fixture-sonnet';
const REVIEWER_MODEL = 'fixture-luna';
const iso = ms => new Date(ms).toISOString();
const at = minutes => T0 + minutes * MIN;

/** One fixture item's loop: a red gate, a rework, a green gate, a review, and a landing batch that merges it. */
function loop(item = 7) {
  const events = [
    { at: at(0), kind: 'claim', by: 'core-1', item },
    { at: at(10), kind: 'submit-handoff', state: 'queued', by: 'core-1', item },
    { at: at(10) + 10_000, kind: 'submit-handoff', state: 'running', by: 'core-1', item },
    { at: at(16), kind: 'submit-handoff', state: 'red', by: 'core-1', item },
    { at: at(20), kind: 'renew', by: 'core-1', item },
    { at: at(30), kind: 'submit-handoff', state: 'queued', by: 'core-1', item },
    { at: at(36), kind: 'submit-handoff', state: 'green', by: 'core-1', item },
    { at: at(40), kind: 'reserve', by: 'core-2', item },
    { at: at(45), kind: 'accept', by: 'core-2', item },
    { at: at(56), kind: 'merged', by: 'coordinator', item },
  ];
  const gateSpans = [
    { v: 1, job: 'gate-1', item, phase: 'queued', start: iso(at(10)), end: iso(at(10.5)), ms: 0.5 * MIN, host: 'local', outcome: 'ok' },
    { v: 1, job: 'gate-1', item, phase: 'tests', start: iso(at(11)), end: iso(at(15)), ms: 4 * MIN, host: 'runner-a', outcome: 'failed' },
    { v: 1, job: 'gate-2', item, phase: 'tests', start: iso(at(30)), end: iso(at(35)), ms: 5 * MIN, host: 'runner-b', outcome: 'ok' },
  ];
  const landingSpans = [
    { v: 1, job: 'land-1', kind: 'landing', phase: 'smoke', start: iso(at(50)), end: iso(at(52)), ms: 2 * MIN, items: [], outcome: 'ok' },
    { v: 1, job: 'land-1', kind: 'landing', phase: 'prove', start: iso(at(52)), end: iso(at(54)), ms: 2 * MIN, items: [], outcome: 'ok' },
  ];
  const batches = [{ id: 'batch-1', startedAt: at(50), at: at(55), candidates: [item] }];
  const receipts = [
    { item, at: at(15), runner: 'runner-a', durationMs: 200_000, files: 3, kind: 'submit' },
    { item, at: at(35), runner: 'runner-b', durationMs: 100_000, files: 2, kind: 'submit' },
  ];
  return { events, gateSpans, landingSpans, batches, receipts };
}

/** The seats and the token buckets their sessions left: a builder in its seat and item folder, a reviewer, the coordinator. */
function sessions() {
  const agents = [{ id: 'core-1', path: '/w/seat-1', lane: 'core' }, { id: 'core-2', path: '/w/seat-2', lane: 'core' }];
  const bucket = (minutes, c, m, fresh, out) => ({ t: at(minutes), c, m, fresh, read: 1000, write: 0, out });
  return {
    agents,
    sessions: {
      segments: [
        { s: at(0), e: at(9), k: 'thinking', m: BUILDER_MODEL, c: '/w/seat-1' },
        { s: at(9), e: at(10), k: 'submit', m: BUILDER_MODEL, c: '/w/seat-1' },
        { s: at(40), e: at(44), k: 'thinking', m: REVIEWER_MODEL, c: '/w/seat-2' },
        { s: at(44), e: at(50), k: 'idle', m: REVIEWER_MODEL, c: '/w/seat-2' },
      ],
      buckets: [
        bucket(5, '/w/seat-1', BUILDER_MODEL, 100, 50),
        bucket(25, '/w/seat-1-item-7', BUILDER_MODEL, 10, 5),
        bucket(42, '/w/seat-2', REVIEWER_MODEL, 20, 2),
        bucket(50, '/w/main', BUILDER_MODEL, 1, 1),
      ],
    },
  };
}

/** Whether a ledger's segments tile its cycle with no gap and no overlap. */
function assertTiles(ledger) {
  let cursor = ledger.start;
  for (const segment of ledger.segments) {
    assert.equal(segment.start, cursor, `#${ledger.item} ${segment.hop} starts where the last hop ended`);
    cursor = segment.end;
  }
  assert.equal(cursor, ledger.end, `#${ledger.item} hops reach the cycle's end`);
}

test('stats.ledger.tile-splits-an-interval-by-the: tile splits an interval by the latest-started covering span and names the gaps [C7]', () => {
  const pieces = tile(0, 100, [{ start: 10, end: 60, label: 'a' }, { start: 20, end: 30, label: 'b' }, { start: 80, end: 200, label: 'c' }], 'gap');
  assert.deepEqual(pieces.map(piece => [piece.label, piece.start, piece.end]),
    [['gap', 0, 10], ['a', 10, 20], ['b', 20, 30], ['a', 30, 60], ['gap', 60, 80], ['c', 80, 100]]);
});

test('stats.ledger.an-item-ledger-names-every-hop: an item ledger names every hop from claim to merged: gate phases, red-gate rework, review, landing steps [C7]', () => {
  const fixture = loop();
  const ledger = itemLedger({ item: 7, ...fixture, now: at(90) });
  assert.equal(ledger.totalMs, 56 * MIN);
  assert.equal(ledger.unattributedMs, 0);
  assertTiles(ledger);
  assert.deepEqual(ledger.hops, {
    build: 10 * MIN, gate: 12 * MIN, 'gate.queued': 0.5 * MIN, 'gate.untraced': 2.5 * MIN, 'gate.tests': 9 * MIN,
    'after failed gate': 4 * MIN, 'rework after red gate': 10 * MIN, 'review wait': 4 * MIN, review: 5 * MIN,
    land: 11 * MIN, 'land.queue': 5 * MIN, 'land.smoke': 2 * MIN, 'land.prove': 2 * MIN, 'land.untraced': 2 * MIN,
  });
  assert.equal(ledger.gateAttempts, 2);
  assert.equal(ledger.submits, 2);
  assert.equal(ledger.landingBatch, 'batch-1');
  assert.deepEqual(ledger.compute.byHost, { coordinator: 0.5 * MIN, 'runner-a': 4 * MIN, 'runner-b': 5 * MIN });
  assert.equal(ledger.compute.shards, 2);
  assert.equal(ledger.compute.testFiles, 5);
});

test('stats.ledger.tokens-follow-the-seat-that-held: tokens follow the seat that held the item: builder in its seat and item folder, reviewer, coordinator apart [C7,N2]', () => {
  const fixture = loop();
  const { agents, sessions: logs } = sessions();
  const seatEvents = fixture.events;
  const ledger = pipelineLedger({ since: at(0), now: at(60), events: fixture.events, seatEvents, gateSpans: fixture.gateSpans,
    landingSpans: fixture.landingSpans, batches: fixture.batches, receipts: fixture.receipts, sessions: logs, agents });
  const one = ledger.ledgers[0];
  assert.equal(one.tokens.total, 1150 + 1015 + 1022);
  assert.equal(one.tokensByRole.builder.total, 1150 + 1015);
  assert.equal(one.tokensByRole.reviewer.byModel[REVIEWER_MODEL], 1022);
  const roles = Object.fromEntries(ledger.agents.roles.map(row => [`${row.role}/${row.model}`, row]));
  assert.equal(roles[`coordinator/${BUILDER_MODEL}`].tokens.total, 1002);
  assert.deepEqual(roles[`builder/${BUILDER_MODEL}`].minutes, { thinking: 9, commands: 1, waiting: 0, idle: 0 });
  assert.deepEqual(roles[`reviewer/${REVIEWER_MODEL}`].minutes, { thinking: 4, commands: 0, waiting: 0, idle: 6 });
  assert.equal(ledger.agents.totals.total, 1150 + 1015 + 1022 + 1002);
  assert.equal(ledger.agents.perLanding.landed, 1);
  assert.equal(ledger.agents.perLanding.itemTokensPerLanding, 1150 + 1015 + 1022);
  assert.deepEqual(ledger.agents.unlogged, []);
  const byRunner = Object.fromEntries(ledger.compute.byRunner.map(row => [row.runner, row]));
  assert.equal(byRunner['runner-a'].testMs, 200_000);
  assert.equal(byRunner['runner-b'].files, 2);
  const lines = ledgerLines(ledger, '1h');
  assert.match(lines[0], /1 item\(s\) moved, 1 merged/u);
  assert.ok(lines.some(line => /^ {2}gate\.tests\s+1\s/u.test(line)), 'gate phases print under the gate hop');
});

test('stats.ledger.audit-every-second-of-every-item: audit: every second of every item\'s claim-to-end time is attributed to a hop, unattributed under 1% [C7]', () => {
  const events = [];
  const gateSpans = [];
  for (let item = 1; item <= 12; item += 1) {
    const base = item * 7;
    events.push({ at: at(base), kind: 'claim', by: `core-${item}`, item });
    if (item % 4 === 0) { events.push({ at: at(base + 3), kind: 'release', by: `core-${item}`, item }, { at: at(base + 9), kind: 'claim', by: 'core-99', item }); continue; }
    events.push({ at: at(base + 5), kind: 'submit-handoff', state: 'queued', by: `core-${item}`, item });
    gateSpans.push({ v: 1, job: `g${item}`, item, phase: 'tests', start: iso(at(base + 6)), end: iso(at(base + 8)), ms: 2 * MIN, host: 'runner-a', outcome: 'ok' });
    events.push({ at: at(base + 9), kind: 'submit-handoff', state: item % 3 === 0 ? 'infrastructure' : 'green', by: `core-${item}`, item });
    if (item % 3 === 0) continue;
    events.push({ at: at(base + 11), kind: 'reserve', by: 'core-50', item });
    if (item % 5 === 0) { events.push({ at: at(base + 12), kind: 'reject', by: 'core-50', item }, { at: at(base + 14), kind: 'release', by: `core-${item}`, item },
      { at: at(base + 20), kind: 'claim', by: `core-${item}`, item }); continue; }
    events.push({ at: at(base + 13), kind: 'accept', by: 'core-50', item }, { at: at(base + 19), kind: 'merged', by: 'coordinator', item });
  }
  // #13 is accepted, then rejected before the landing batch that names it starts: no time is counted twice.
  events.push({ at: at(100), kind: 'claim', by: 'core-13', item: 13 }, { at: at(101), kind: 'submit', by: 'core-13', item: 13 },
    { at: at(102), kind: 'reserve', by: 'core-50', item: 13 }, { at: at(103), kind: 'accept', by: 'core-50', item: 13 },
    { at: at(105), kind: 'reject', by: 'core-51', item: 13 });
  const batches = [{ id: 'late', startedAt: at(110), at: at(112), candidates: [13] }];
  events.sort((a, b) => a.at - b.at);
  const ledger = pipelineLedger({ since: at(0), now: at(200), item: null, events, gateSpans, batches });
  assert.equal(ledger.items, 13);
  assert.ok(ledger.audit.totalMs > 0);
  assert.ok(Math.abs(ledger.audit.unattributedShare) < 0.01, `unattributed ${ledger.audit.unattributedShare}`);
  assert.deepEqual(ledger.audit.items, []);
  for (let item = 1; item <= 13; item += 1) assertTiles(pipelineLedger({ since: at(0), now: at(200), item, events, gateSpans, batches }).ledgers[0]);
  const hops = new Set(ledger.hops.map(row => row.hop));
  for (const hop of ['build', 'gate', 'gate.tests', 'gate.untraced', 'after failed gate', 'review', 'rework after reject', 'unowned', 'land', 'land.queue']) assert.ok(hops.has(hop), `hop ${hop} appears`);
});

/** Serialize session rows as JSONL. */
function jsonl(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

/** A Claude transcript: a prompt, a streamed message that waits on the board, a reply that ends the turn, a later prompt. */
function claudeRows(cwd) {
  const usage = out => ({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: out });
  return [
    { type: 'user', timestamp: iso(T0), cwd, message: { role: 'user', content: 'build it' } },
    { type: 'assistant', timestamp: iso(T0 + 5_000), cwd, message: { id: 'm1', model: BUILDER_MODEL, usage: usage(20), content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', timestamp: iso(T0 + 5_000), cwd, message: { id: 'm1', model: BUILDER_MODEL, usage: usage(40), content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'pullboard next --wait 30' } }] } },
    { type: 'user', timestamp: iso(T0 + 35_000), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
    { type: 'assistant', timestamp: iso(T0 + 50_000), cwd, message: { id: 'm2', model: BUILDER_MODEL, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', timestamp: iso(T0 + 10 * MIN), cwd, message: { role: 'user', content: 'next' } },
  ];
}

/** A Codex rollout: one turn with a usage record and a test command, then idle until the next turn. */
function codexRows(cwd) {
  return [
    { type: 'session_meta', timestamp: iso(T0), payload: { cwd } },
    { type: 'turn_context', timestamp: iso(T0), payload: { cwd, model: REVIEWER_MODEL } },
    { type: 'event_msg', timestamp: iso(T0), payload: { type: 'task_started' } },
    { type: 'token_usage_record', timestamp: iso(T0 + 10_000), payload: { usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } },
    { type: 'event_msg', timestamp: iso(T0 + 40_000), payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bash', '-lc', 'node --test x.test.js'], duration: { secs: 20, nanos: 0 } } } },
    { type: 'event_msg', timestamp: iso(T0 + 60_000), payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: iso(T0 + 5 * MIN), payload: { type: 'task_started' } },
  ];
}

/** Sum a fold's buckets by field. */
function bucketSum(buckets) {
  return buckets.reduce((sum, bucket) => ({ fresh: sum.fresh + bucket.fresh, read: sum.read + bucket.read, write: sum.write + bucket.write, out: sum.out + bucket.out }), { fresh: 0, read: 0, write: 0, out: 0 });
}

test('stats.ledger.a-claude-transcript-folds-into-thinking: a Claude transcript folds into thinking, waiting and idle time, and a streamed message counts its tokens once [C7,N2]', () => {
  const out = { segments: [], buckets: [] };
  foldText(newFold('claude'), jsonl(claudeRows('/w/seat-1')), out);
  assert.deepEqual(out.segments.map(segment => [segment.k, (segment.s - T0) / 1000, (segment.e - T0) / 1000]),
    [['thinking', 0, 5], ['waiting', 5, 35], ['thinking', 35, 50], ['idle', 50, 600]]);
  assert.deepEqual(bucketSum(out.buckets), { fresh: 11, read: 100, write: 5, out: 45 });
  assert.ok(out.segments.slice(1).every(segment => segment.m === BUILDER_MODEL));
});

test('stats.ledger.a-codex-rollout-folds-into-turns: a Codex rollout folds into turns, command time from completed commands, and per-response usage [C7,N2]', () => {
  const out = { segments: [], buckets: [] };
  foldText(newFold('codex'), jsonl(codexRows('/w/seat-3')), out);
  assert.deepEqual(out.segments.map(segment => [segment.k, (segment.s - T0) / 1000, (segment.e - T0) / 1000]),
    [['thinking', 0, 20], ['tests', 20, 40], ['thinking', 40, 60], ['idle', 60, 300]]);
  assert.deepEqual(bucketSum(out.buckets), { fresh: 200, read: 800, write: 0, out: 50 });
  assert.equal(out.buckets[0].m, REVIEWER_MODEL);
});

test('stats.ledger.a-coordinator-subagent-driving-a-seat: a coordinator subagent driving a seat through its wrapper or a cd is credited to that seat, not the coordinator [C7,N2]', () => {
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 };
  const main = '/w/repo';
  const rows = [
    { type: 'user', timestamp: iso(T0), cwd: main, message: { role: 'user', content: 'loop as sonnet-15' } },
    { type: 'assistant', timestamp: iso(T0 + 1_000), cwd: main, message: { id: 'a1', model: BUILDER_MODEL, usage,
      content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: '~/pbseat/coord/seat-sonnet-15.sh pullboard claim 7' } }] } },
    { type: 'user', timestamp: iso(T0 + 2_000), cwd: main, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
    { type: 'assistant', timestamp: iso(T0 + 3_000), cwd: main, message: { id: 'a2', model: BUILDER_MODEL, usage,
      content: [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: `cd "${main}-opus-4-item-8" && pullboard submit 8` } }] } },
    { type: 'user', timestamp: iso(T0 + 4_000), cwd: main, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'ok' }] } },
  ];
  const out = { segments: [], buckets: [] };
  foldText(newFold('claude'), jsonl(rows), out);
  assert.deepEqual(out.buckets.map(bucket => bucket.c), ['seat:sonnet-15', `${main}-opus-4-item-8`]);
  const agents = [{ id: 'core-15', path: `${main}-sonnet-15`, lane: 'core' }, { id: 'core-5', path: `${main}-sonnet-5`, lane: 'core' }, { id: 'core-4', path: `${main}-opus-4`, lane: 'core' }];
  const seatEvents = [{ at: T0 - MIN, kind: 'claim', by: 'core-15', item: 7 }, { at: T0 - MIN, kind: 'claim', by: 'core-4', item: 8 }];
  const ledger = pipelineLedger({ since: T0 - 2 * MIN, now: T0 + MIN, events: seatEvents, seatEvents, sessions: { segments: out.segments, buckets: out.buckets }, agents });
  const builder = ledger.agents.roles.find(row => row.role === 'builder');
  assert.equal(builder.tokens.total, 20);
  assert.equal(builder.seats, 2);
  assert.equal(ledger.agents.roles.find(row => row.role === 'coordinator')?.tokens.total ?? 0, 0);
  assert.deepEqual(ledger.agents.unlogged, []);
});

/** A private folder holding a fake home, a repository root and its common Git directory. */
function scratch(t) {
  const { root } = privateFixtureFiles('pullboard-ledger-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const commonDir = join(repo, '.git');
  mkdirSync(join(commonDir, 'pullboard'), { recursive: true });
  return { home: join(root, 'home'), repo, commonDir };
}

test('stats.ledger.session-logs-are-read-once-a: session logs are read once: a later read folds only the bytes a log gained, and matches a full fold [C7,N2]', t => {
  const { home, repo } = scratch(t);
  const claudeFolder = join(home, '.claude', 'projects', claudeProjectName(repo));
  const codexFolder = join(home, '.codex', 'sessions', '2026', '11', '09');
  mkdirSync(claudeFolder, { recursive: true });
  mkdirSync(codexFolder, { recursive: true });
  const claudeFile = join(claudeFolder, 'session.jsonl');
  const rows = claudeRows(join(repo, 'seat'));
  writeFileSync(claudeFile, jsonl(rows.slice(0, 3)));
  writeFileSync(join(codexFolder, 'rollout-a.jsonl'), jsonl(codexRows(`${repo}-seat-3`)));
  writeFileSync(join(codexFolder, 'rollout-other.jsonl'), jsonl(codexRows('/elsewhere/project')));
  const keep = cwd => typeof cwd === 'string' && cwd.startsWith(repo);
  const saved = new Map();
  const cache = { load: key => saved.get(key) ?? null, save: (key, bytes) => saved.set(key, bytes) };
  const window = { root: repo, since: 0, now: T0 + 3_600_000, keep, home, cache };
  const first = readSessions(window);
  assert.equal(first.parsed, 3);
  assert.ok(first.buckets.every(bucket => bucket.c !== '/elsewhere/project'), 'another project\'s Codex rollout is left out');
  appendFileSync(claudeFile, jsonl(rows.slice(3)));
  const second = readSessions(window);
  assert.equal(second.parsed, 1, 'only the grown log is read again');
  const whole = { segments: [], buckets: [] };
  foldText(newFold('claude'), jsonl(rows), whole);
  const mine = second.segments.filter(segment => segment.c === join(repo, 'seat'));
  assert.deepEqual(mine, whole.segments);
  assert.deepEqual(bucketSum(second.buckets.filter(bucket => bucket.c === join(repo, 'seat'))), bucketSum(whole.buckets));
  assert.equal(readSessions(window).parsed, 0, 'an unchanged log is not read at all');
});

test('stats.ledger.readpipelineledger-joins-a-real-sqlite-board: readPipelineLedger joins a real SQLite board, span files and receipts, and traces one item [C7]', t => {
  const { home, commonDir } = scratch(t);
  const fixture = loop();
  const db = new DatabaseSync(join(commonDir, 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT);
    CREATE TABLE agent (agent_id TEXT, agent_path TEXT, agent_lane TEXT);`);
  const insert = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const rows = [
    ...fixture.events.map(event => [event.at, event.by, event.kind, event.item, JSON.stringify(event.state ? { state: event.state } : {})]),
    ...fixture.receipts.map(receipt => [receipt.at, 'core-1', 'proof-run', 7, JSON.stringify({ receipt: { id: `r${receipt.at}`, kind: 'submit', runner: receipt.runner, durationMs: receipt.durationMs, testRuntimes: Array.from({ length: receipt.files }, (_, index) => ({ file: `t${index}.test.js` })) } })]),
    [at(55), 'coordinator', 'landing_batch', null, JSON.stringify({ batch: { id: 'batch-1', startedAt: iso(at(50)), candidates: [{ id: 7 }] } })],
  ].sort((a, b) => a[0] - b[0]);
  for (const [when, by, kind, item, detail] of rows) insert.run(iso(when), by, kind, item, detail);
  db.prepare('INSERT INTO agent VALUES (?, ?, ?)').run('core-1', '/w/seat-1', 'core');
  const gateFolder = join(commonDir, 'pullboard', 'gate-spans');
  const landingFolder = join(commonDir, 'pullboard', 'landing-spans');
  mkdirSync(gateFolder, { recursive: true });
  mkdirSync(landingFolder, { recursive: true });
  writeFileSync(join(gateFolder, '2026-11-09.jsonl'), jsonl(fixture.gateSpans));
  writeFileSync(join(landingFolder, '2026-11-09.jsonl'), jsonl(fixture.landingSpans));
  const window = readPipelineLedger(db, { commonDir, since: at(30), now: at(60), home });
  assert.equal(window.items, 1);
  assert.equal(window.merged, 1);
  assert.equal(window.audit.unattributedMs, 0);
  assert.equal(window.ledgers[0].hops['land.queue'], 5 * MIN, 'the landing batch from the board bounds the queue wait');
  assert.equal(window.ledgers[0].compute.testFiles, 5);
  const one = readPipelineLedger(db, { commonDir, since: at(30), now: at(60), item: 7, home });
  assert.equal(one.timeline.start, at(0));
  assert.deepEqual(one.timeline.entries.filter(entry => entry.type !== 'event').map(entry => entry.text),
    ['gate.queued', 'gate.tests', 'proof-run submit', 'gate.tests', 'proof-run submit', 'land.smoke', 'land.prove']);
  assert.ok(ledgerLines(one, '1h').some(line => line.startsWith('#7 merged after 56.0m')));
});
