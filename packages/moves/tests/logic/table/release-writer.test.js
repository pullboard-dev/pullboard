/** @pullboard-world-pin reads the release history fixture to drive the store release writer with the same releases. The store release writer applies the release table and agrees on every replayed release [C7,#8246]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/release-history.json */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { diagnosisBrief } from '../../../../items/index.js';
import { boardReleaseEngine } from '../../../index.js';
import { readReleaseRecords } from '../../../index.js';
import { runTable } from '../../../index.js';
import { release } from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/release-history.json', import.meta.url), 'utf8'));
const FAR = '2099-01-01T00:00:00.000Z';

/** The recorded events on a scratch in-memory board, read the way the replay reads them. */
function recorded() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT)`);
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) event.run(id, at, by, kind, item, JSON.stringify(detail));
  const agent = db.prepare('INSERT INTO agent VALUES (?, ?)');
  for (const [id, route] of HISTORY.agents) agent.run(id, route);
  return readReleaseRecords({ db }, { since: HISTORY.since, only: HISTORY.releases });
}

/** What the board stores for an event, without the actor's model, which the event writer stamps on every event and no move decides. */
const stored = ({ detail, ...rest }) => {
  const { model, ...kept } = detail ?? {};
  return JSON.parse(JSON.stringify({ ...rest, ...(detail ? { detail: kept } : {}) }));
};

/** A real board holding exactly what the replay record says the release saw, on a clock at the release's own instant. */
function boardFor(t, record) {
  const at = new Date(record.event.at);
  const board = cellBoard(t, ':memory:', { now: () => at });
  const { item, actor, history } = record.snapshot;
  const sql = board.db;
  const stamp = '2026-01-01T00:00:00.000Z';
  // The fixture files items in states no move reached, so the scratch board keeps none of the machine guards.
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'machine%'").all()) sql.exec(`DROP TRIGGER "${name}"`);
  const seat = (id, route) => sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'core', `/seat/${id}`, route ?? 'strong', stamp);
  seat('coordinator', 'strong');
  seat(actor.id, actor.route);
  if (item.owner) seat(item.owner, 'strong');
  if (item.reviewer) seat(item.reviewer, 'strong');
  const file = (id, row) => sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_after, item_hold_reason, item_hold_by, item_created_by, item_created_at, item_updated_at)
    VALUES (?, 'core', 'recorded', ?, ?, ?, ?, ?, ?, ?, 'coordinator', ?, ?)`).run(id, row.route ?? 'strong', row.status, row.owner ?? null, row.leaseUntil ?? null, (row.after ?? []).join(','), row.holdReason ?? null, row.holdBy ?? null, stamp, stamp);
  for (const [id, other] of Object.entries(record.snapshot.items)) if (Number(id) !== item.id) file(Number(id), other);
  file(item.id, item);
  // The replay records every release as holding a diagnosed claim, so the board holds the matching diagnosis for the item.
  const diagnosis = { criterion: 'the bar', check: 'a check', files: ['a.js'], change: 'the change', testCase: 'the test' };
  sql.prepare('UPDATE item SET item_criterion = ?, item_check = ?, item_brief = ? WHERE item_id = ?').run(diagnosis.criterion, diagnosis.check, diagnosisBrief(diagnosis), item.id);
  sql.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item_diagnosis:${item.id}`, JSON.stringify(diagnosis));
  for (const e of history) sql.prepare('INSERT INTO event (event_id, event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, e.at, e.by, e.kind, item.id, JSON.stringify(e.detail));
  if (item.status === 'submitted') sql.prepare('UPDATE item SET item_review_by = ?, item_review_until = ? WHERE item_id = ?').run(item.reviewer, FAR, item.id);
  if (item.status === 'submitted') sql.prepare('INSERT INTO event (event_id, event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Math.max(0, ...history.map(e => e.id)) + 1, stamp, item.reviewer, 'reserve', item.id, JSON.stringify({ reviewer: item.reviewer, until: FAR }));
  return board;
}

/** Drive the store's release writer with what the record's move said, and return what it wrote after the seeded history; the sentinel's shout to the coordinator is delivery, not a move event, so it is left out. */
function drive(board, record) {
  const { move } = record;
  const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id;
  const observation = { ...(move.on ? { blockedOn: move.on } : {}), ...(move.worktreeSnapshot ? { worktreeSnapshot: move.worktreeSnapshot } : {}) };
  release(board, move.id, move.actor, move.note, Object.keys(observation).length ? observation : undefined, move.reason);
  return board.db.prepare('SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE event_id>? AND event_kind <> \'shout\' ORDER BY event_id').all(before)
    .map(e => stored({ kind: e.kind, by: e.by, detail: JSON.parse(e.detail) }));
}

const records = recorded().release.filter(record => !record.move.stale);

test('clause 1: the store release writer agrees with the release table on every replayed release [C7,#8246]', t => {
  const { rules, table } = boardReleaseEngine();
  assert.ok(records.length >= 50, 'the replay holds the board\'s ordinary and review releases');
  const disagreements = [];
  for (const record of records) {
    const answer = runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move));
    const wrote = drive(boardFor(t, record), record);
    const expected = answer.events.map(stored);
    if (JSON.stringify(wrote) !== JSON.stringify(expected)) disagreements.push({ event: record.event.id, wrote, expected });
    assert.deepEqual(expected, record.recorded.events.filter(e => e.kind !== 'fact'), `the table agrees with the board's own record of release ${record.event.id}`);
  }
  assert.deepEqual(disagreements, []);
});

test('clause 1: the writer refuses with the table\'s code and words, and writes nothing [C7,#8246]', t => {
  const record = records.find(entry => entry.snapshot.item.status === 'claimed' && !entry.move.on);
  const board = boardFor(t, record);
  const events = () => board.db.prepare('SELECT COUNT(*) n FROM event').get().n;
  const count = events();
  assert.throws(() => release(board, record.move.id, 'someone-else', record.move.note, undefined, record.move.reason),
    { code: 'NOT_YOURS', message: `[NOT_YOURS] item #${record.move.id} is not claimed by you` });
  assert.throws(() => release(board, record.move.id, record.move.actor, '', undefined, 'OTHER'), { code: 'RELEASE_REASON' });
  assert.equal(events(), count);
});
