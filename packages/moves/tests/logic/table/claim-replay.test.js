/** @pullboard-world-pin reads the recorded claim history fixture to replay it through the table. The claim and renew table replays claims recorded on a real board with zero disagreements, and refuses what the board refuses [C7,#8241]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardClaimEngine } from '../../../index.js';
import { CLAIM_NEXT } from '../../../index.js';
import { claimEngine } from '../../../index.js';
import { readClaimRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/claim-history.json', import.meta.url), 'utf8'));
const CLAIM = boardClaimEngine();

/** The recorded events, seats and items on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_lane TEXT, agent_route TEXT);
    CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_parent_id INTEGER);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)`);
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  const agent = db.prepare('INSERT INTO agent VALUES (?, ?, ?)');
  for (const [id, lane, route] of HISTORY.agents) agent.run(id, lane, route);
  const item = db.prepare('INSERT INTO item VALUES (?, ?)');
  for (const [id, parent] of HISTORY.items) item.run(id, parent);
  return { db };
}

const read = readClaimRecords(recordedBoard(), { since: HISTORY.since, only: HISTORY.claims });
const { records } = read;
const run = (record, change = {}) => runTable(CLAIM.table, CLAIM.rules, structuredClone({ ...record.snapshot, ...change.snapshot }), { ...structuredClone(record.move), ...change.move });

test('clause 1: replaying recorded board history through the claim and renew table gives zero disagreements [C7,#8241]', () => {
  const report = replayTable(CLAIM.table, CLAIM.rules, records, { cut: HISTORY.since });
  assert.deepEqual(report.disagreements, []);
  assert.deepEqual([report.total, report.agreed, report.notReplayable], [records.length, records.length, 0]);
  // 56 recorded claims and renewals, one per path: 54 written by the claim command, 2 renewals written by the gate's red return.
  assert.deepEqual([HISTORY.claims.length, records.length], [56, 54]);
  assert.deepEqual(read.unreplayable.map(entry => entry.path), Array(2).fill('renew: written by the gate red return, not the claim command'));
});

test('clause 1: the replay covers claims, renewals, sealed seat caps and the policy re-freeze note [C7,#8241]', () => {
  const via = new Set(records.flatMap(record => run(record).via));
  for (const path of ['claim', 'renew', 'policy-refrozen-fact']) assert.ok(via.has(path), `${path} replayed`);
  const written = records.map(record => record.recorded.events[0].detail);
  for (const key of ['claimsPerSeat', 'autoNextSnapshot', 'policyRefreshed', 'submitAdmission', 'submitOutcome', 'expectedBuildMinutes', 'itemFolder']) {
    assert.ok(written.some(detail => key in detail), `a claim writing ${key} replayed`);
  }
  assert.ok(records.some(record => record.snapshot.item.frozenDigest === null), 'a first claim freezes the criterion');
  assert.ok(records.some(record => record.snapshot.actorClaims.some(claim => claim.awaitingGateOrReview)), 'a claim beside one waiting on its gate');
  assert.ok(read.echoed.builderGone > 0, "a claim inside a gone builder's first-refusal window");
});

test('clause 1: a recorded claim replayed with one captured fact broken is a disagreement the replay names [C7,#8241]', () => {
  const record = records.find(entry => entry.recorded.events[0].kind === 'claim' && entry.snapshot.item.status === 'open');
  const held = { ...structuredClone(record), snapshot: { ...structuredClone(record.snapshot), item: { ...record.snapshot.item, holdReason: 'held' } } };
  const elsewhere = { ...structuredClone(record), snapshot: { ...structuredClone(record.snapshot), actor: { ...record.snapshot.actor, lane: 'nowhere' } } };
  const report = replayTable(CLAIM.table, CLAIM.rules, [held, elsewhere], { cut: HISTORY.since });
  assert.deepEqual(report.disagreements.map(entry => [entry.event, entry.table.code]), [[record.event.id, 'ITEM_HELD'], [record.event.id, 'WRONG_LANE']]);
  const renewal = records.find(entry => entry.recorded.events[0].kind === 'renew');
  const lapsed = { ...structuredClone(renewal), snapshot: { ...structuredClone(renewal.snapshot), item: { ...renewal.snapshot.item, leaseUntil: '2000-01-01T00:00:00.000Z', gateInFlight: false } } };
  assert.equal(replayTable(CLAIM.table, CLAIM.rules, [lapsed], { cut: HISTORY.since }).disagreements[0].differs, 'detail');
});

test('clause 1: the claim table refuses in the order the command throws, with the words the command prints [C7,#8241]', () => {
  const record = records.find(entry => entry.recorded.events[0].kind === 'claim' && entry.snapshot.item.status === 'open' && entry.snapshot.item.parentId === null);
  assert.deepEqual(run(record, { snapshot: { item: null } }).refused, { code: 'NO_ITEM', message: `no item #${record.move.id}; see: pullboard list`, next: CLAIM_NEXT.NO_ITEM,
    row: 'item-exists', fact: 'itemExists', trace: [{ fact: 'itemExists', holds: false }] });
  assert.equal(run(record, { snapshot: { actor: { ...record.snapshot.actor, joined: false } } }).refused.next, CLAIM_NEXT.NOT_JOINED);
  const other = { id: 1, leaseUntil: '2999-01-01T00:00:00.000Z', parentId: null, verdict: null, builtBy: null, awaitingGateOrReview: false };
  assert.deepEqual(run(record, { move: { itemFolder: false }, snapshot: { actorClaims: [other] } }).refused.message, 'you already hold #1; submit or release it first (child items are free)');
  const capped = run(record, { move: { itemFolder: true }, snapshot: { actorClaims: [other], io: { ...record.snapshot.io, seatCap: { n: 1, how: 'claims.perSeat sets 1' } } } }).refused;
  assert.deepEqual([capped.code, capped.next], ['ONE_CLAIM', CLAIM_NEXT.ONE_CLAIM]);
  assert.match(capped.message, /a seat holds up to 1 \(claims\.perSeat sets 1\)/u);
  assert.equal(run(record, { snapshot: { io: { ...record.snapshot.io, freeze: { refused: { code: 'UNKNOWN_SPEC', message: 'no row Z9' } } }, item: { ...record.snapshot.item, frozenDigest: null } } }).refused.next, CLAIM_NEXT.UNKNOWN_SPEC);
  for (const guard of CLAIM.table.guards) if (typeof guard.next === 'string' && CLAIM_NEXT[guard.code]) assert.equal(guard.next, CLAIM_NEXT[guard.code], guard.id);
  assert.throws(() => claimEngine({}), { code: 'CLAIM_TABLE_INPUTS' });
});
