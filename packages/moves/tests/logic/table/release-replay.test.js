/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads the recorded release history fixture to replay it through the tables. The release and reclaim tables replay releases recorded on a real board with zero disagreements, and refuse what the board refuses [C7,#8240]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardReleaseEngine } from '../../../index.js';
import { RECLAIM_RULES } from '../../../index.js';
import { RECLAIM_TABLE } from '../../../index.js';
import { readReleaseRecords } from '../../../index.js';
import { releaseEngine } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/release-history.json', import.meta.url), 'utf8'));
const RELEASE = boardReleaseEngine();

/** The recorded events and seats on an in-memory board, shaped as the real board stores them. */
function recordedBoard() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT)`);
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  const agent = db.prepare('INSERT INTO agent VALUES (?, ?)');
  for (const [id, route] of HISTORY.agents) agent.run(id, route);
  return { db };
}

const board = recordedBoard();
const records = readReleaseRecords(board, { since: HISTORY.since, only: HISTORY.releases });

test('clause 1: replaying recorded board history through the release and reclaim tables gives zero disagreements [C7,#8240]', () => {
  const release = replayTable(RELEASE.table, RELEASE.rules, records.release, { cut: HISTORY.since });
  const reclaim = replayTable(RECLAIM_TABLE, RECLAIM_RULES, records.reclaim, { cut: HISTORY.since });
  assert.deepEqual(release.disagreements, []);
  assert.deepEqual(reclaim.disagreements, []);
  assert.deepEqual([release.total, release.agreed, release.notReplayable], [records.release.length, records.release.length, 0]);
  assert.deepEqual([reclaim.total, reclaim.agreed, reclaim.notReplayable], [records.reclaim.length, records.reclaim.length, 0]);
  // 65 recorded releases, one or two per path: 55 decided by the release table, 8 by maintenance, 1 whose route changed off the record, 1 that counted a structured blocker (#2956).
  assert.deepEqual([HISTORY.releases.length, release.agreed, reclaim.agreed], [65, 55, 8]);
  assert.deepEqual(records.unreplayable.map(entry => entry.path), ['release: the item route changed off the record', 'release: counted a structured blocker, which no longer counts']);
});

test('clause 1: the replay covers every release path the board used, follow-ups included [C7,#8240]', () => {
  const via = new Set();
  for (const record of records.release) for (const step of runTable(RELEASE.table, RELEASE.rules, structuredClone(record.snapshot), structuredClone(record.move)).via) via.add(step);
  for (const record of records.reclaim) via.add(runTable(RECLAIM_TABLE, RECLAIM_RULES, structuredClone(record.snapshot), structuredClone(record.move)).via[0]);
  for (const path of ['free-review', 'release-stale', 'return-claim', 'released-twice', 'reclaim-idle', 'expire-lapsed-claim', 'free-idle-review', 'free-lapsed-review']) assert.ok(via.has(path), `${path} replayed`);
  const kinds = new Set(records.reclaim.map(record => record.move.row?.idle).filter(Boolean));
  for (const kind of ['seat-gone', 'release', 'waiting', 'progress', 'dependency']) assert.ok(kinds.has(kind), `idle ${kind} replayed`);
});

test('clause 1: a recorded release replayed with one captured fact broken is a disagreement the replay names [C7,#8240]', () => {
  const holder = records.release.find(record => record.move.reason === 'BLOCKED' && !record.move.stale && record.snapshot.item.status === 'claimed');
  const stranger = { ...structuredClone(holder), move: { ...structuredClone(holder.move), actor: 'someone-else' } };
  const report = replayTable(RELEASE.table, RELEASE.rules, [stranger], { cut: HISTORY.since });
  assert.deepEqual(report.disagreements.map(entry => [entry.event, entry.table.code]), [[holder.event.id, 'NOT_YOURS']]);
  const seat = records.reclaim.find(record => record.move.row?.idle === 'seat-gone');
  const moved = { ...structuredClone(seat), snapshot: { ...structuredClone(seat.snapshot), ownerLastClaimId: -1 } };
  assert.deepEqual(replayTable(RECLAIM_TABLE, RECLAIM_RULES, [moved], { cut: HISTORY.since }).disagreements.map(entry => entry.table.code), ['STALE_STATE_CHANGED']);
});

test('clause 1: the release table refuses in the order the command throws, with its words [C7,#8240]', () => {
  const record = records.release.find(entry => !entry.move.stale && entry.snapshot.item.status === 'claimed');
  const refuse = (move, snapshot = record.snapshot) => runTable(RELEASE.table, RELEASE.rules, structuredClone(snapshot), { ...structuredClone(record.move), ...move }).refused;
  assert.equal(refuse({ reason: 'NOPE' }).code, 'RELEASE_REASON');
  assert.match(refuse({ reason: 'NOPE' }).message, /--reason INELIGIBLE\|ROUTED_ELSEWHERE\|BLOCKED\|BUDGET\|TAKEN_OVER\|DIAGNOSIS_WRONG\|INFRA\|OTHER/u);
  assert.equal(refuse({ reason: 'OTHER', note: ' ' }).code, 'RELEASE_REASON');
  assert.equal(refuse({ on: [1], reason: 'BUDGET' }).code, 'USAGE');
  assert.deepEqual(refuse({ id: 999 }, { ...record.snapshot, item: null }), { code: 'NO_ITEM', message: 'no item #999; see: pullboard list', next: 'find the item id: pullboard list --all', row: 'item-exists', fact: 'itemExists', trace: [{ fact: 'itemExists', holds: false }] });
  assert.equal(refuse({ stale: { staleClaim: {} }, actor: 'core-1' }).code, 'NOT_YOURS');
  assert.throws(() => releaseEngine({ reasons: [] }), { code: 'RELEASE_TABLE_INPUTS' });
});
