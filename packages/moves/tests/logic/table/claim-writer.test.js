/** @pullboard-world-pin reads the recorded claim history fixture to drive the store claim writer with it. The store claim and renew writer applies the claim table and agrees on every replayed move [C7,#8270]. */
/** @pullboard-test-input packages/moves/tests/fixtures/table/claim-history.json */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardClaimEngine } from '../../../index.js';
import { readClaimRecords } from '../../../index.js';
import { runTable } from '../../../index.js';
import { claim } from '../../../../store/index.js';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/claim-history.json', import.meta.url), 'utf8'));
const STAMP = '2026-01-01T00:00:00.000Z';

/** The recorded events on a scratch in-memory board, read the way the replay reads them. */
function recorded() {
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
  return readClaimRecords({ db }, { since: HISTORY.since, only: HISTORY.claims });
}

/** What the board stores for an event, without the actor's model, which the event writer stamps on every event, and without a fact's random id. */
const stored = ({ model, ...rest }) => {
  const copy = JSON.parse(JSON.stringify(rest));
  delete copy.detail?.model;
  // The record keeps a refusal's full note only in the cause; the claim stores the note cut short, and the writer rebuilds the cause from that cut note.
  if (copy.detail?.submitOutcome?.pipelineCause) delete copy.detail.submitOutcome.pipelineCause.text;
  if (copy.kind === 'fact') delete copy.detail.id;
  return copy;
};

/** A real board holding exactly what the replay record says the claim saw, on a clock at the claim's own instant. */
function boardFor(t, record) {
  const { snapshot } = record;
  const at = new Date(snapshot.now);
  const board = cellBoard(t, ':memory:', { now: () => at });
  const sql = board.db;
  // The scratch board is seeded with states a record saw; the state machine's own triggers guard only live moves.
  for (const { name } of sql.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine_item%'").all()) sql.exec(`DROP TRIGGER ${name}`);
  const seat = (id, lane, route) => sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(id, lane ?? 'core', `/seat/${id}`, route ?? 'strong', STAMP);
  if (snapshot.actor.joined) seat(snapshot.actor.id, snapshot.actor.lane, snapshot.actor.route);
  const stub = (id, lane) => { if (id != null && !sql.prepare('SELECT 1 FROM item WHERE item_id=?').get(id)) file({ id, status: 'verified' }, lane); };
  const file = (row, lane) => {
    for (const who of [row.owner, row.builtBy]) if (who) seat(who, lane, 'strong');
    stub(row.parentId, lane);
    if (sql.prepare('SELECT 1 FROM item WHERE item_id=?').get(row.id)) return;
    sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_owner, item_lease_until, item_after, item_hold_reason, item_hold_by, item_parent_id,
      item_frozen, item_frozen_digest, item_built_by, item_verdict, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'coordinator', ?, ?)`)
      .run(row.id, row.lane ?? lane, row.route ?? 'strong', row.status, row.owner ?? null, row.leaseUntil ?? null, (row.after ?? []).join(','), row.holdReason ?? null, row.holdReason ? 'coordinator' : null,
        row.parentId ?? null, row.frozenDigest ? 'frozen' : null, row.frozenDigest ?? null, row.builtBy ?? null, row.verdict ?? null, STAMP, STAMP);
    if (row.expectedMinutes != null) sql.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`item_expected_build_minutes:${row.id}`, JSON.stringify(row.expectedMinutes));
    if (row.outside) sql.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`outside_source:${row.id}`, JSON.stringify({ kind: 'pull-request' }));
  };
  for (const [id, other] of Object.entries(snapshot.items)) if (Number(id) !== snapshot.item.id) file({ id: Number(id), ...other, route: 'strong', after: [] }, other.lane);
  for (const mine of snapshot.actorClaims) if (mine.id !== snapshot.item.id && !snapshot.items[mine.id]) file({ id: mine.id, status: 'claimed', owner: snapshot.actor.id, leaseUntil: mine.leaseUntil, parentId: mine.parentId, verdict: mine.verdict, builtBy: mine.builtBy }, snapshot.actor.lane);
  file(snapshot.item, snapshot.item.lane);
  for (const e of snapshot.history) seat(e.by, snapshot.item.lane, 'strong');
  for (const e of snapshot.history) sql.prepare('INSERT INTO event (event_id, event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, e.at, e.by, e.kind, snapshot.item.id, JSON.stringify(e.detail));
  if (snapshot.claimWaiting.length) sql.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`claim_waiting:${snapshot.item.id}`, JSON.stringify(snapshot.claimWaiting));
  if (snapshot.laneHold) sql.prepare('INSERT INTO hold (hold_lane, hold_by, hold_reason, hold_at) VALUES (?, ?, ?, ?)').run(snapshot.item.lane, snapshot.laneHold.by, snapshot.laneHold.reason, STAMP);
  return board;
}

/** The claim options the record's move and shell inputs stand for. */
function optionsFor(record) {
  const { move, snapshot } = record;
  const { io, deferred } = snapshot;
  const refresh = io.policyRefresh;
  return { agentId: move.actor, lane: snapshot.actor.lane, leaseMs: move.leaseMs, head: io.head, itemFolder: move.itemFolder, autoNext: move.autoNext, autoNextSnapshot: io.autoNextSnapshot ?? undefined,
    reviewSkipped: move.reviewSkipped, adoptCorrection: move.adoptCorrection, refreshPolicy: Boolean(refresh), buildBudgetMinutes: io.buildBudgetMinutes,
    ...(io.seatCap ? { seatCap: io.seatCap.n } : {}), gateWaits: snapshot.actorClaims.filter(mine => mine.awaitingGateOrReview).map(mine => mine.id),
    ...(deferred.submitAdmission ? { submitAdmission: deferred.submitAdmission } : {}), ...(deferred.submitOutcome ? { submitOutcome: deferred.submitOutcome } : {}),
    freeze: () => ({ text: 'frozen', digest: io.freeze.digest, ...(refresh && !refresh.unnamed ? { policyRefreeze: refresh } : {}) }) };
}

const { records } = recorded();
const { rules, table } = boardClaimEngine();

test('moves.claim-writer.the-store-claim-and-renew-writer-applies: clause 1: the store claim and renew writer applies the claim table and agrees on every replayed move [C7,#8270]', t => {
  assert.ok(records.length >= 50, 'the replay holds the board\'s claims and renewals');
  const disagreements = [];
  const unrun = [];
  const gone = [];
  for (const record of records) {
    // A gone builder's heartbeat is a machine-local input no board records; the replay echoes it, so the writer cannot be driven to read it here.
    if (record.snapshot.io.builderGone) {
      gone.push(record.event.id);
      assert.deepEqual(runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move)).events.map(stored), record.recorded.events.map(stored), `the table agrees with the board's own record of claim ${record.event.id}`);
      continue;
    }
    const board = boardFor(t, record);
    const seen = [];
    board.claimShadow = (answer) => seen.push(answer);
    // The shadow compare runs only while the writer decides; with moves.live.claim on (its default since #8395) the table decides and compares nothing.
    board.movesLive = { claim: false };
    const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id;
    try { claim(board, record.move.id, optionsFor(record)); } catch (error) { unrun.push({ event: record.event.id, code: error.code, message: String(error.message).slice(0, 160) }); continue; }
    const wrote = board.db.prepare('SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE event_id>? ORDER BY event_id').all(before)
      .map(e => stored({ kind: e.kind, by: e.by, detail: JSON.parse(e.detail) }));
    const expected = runTable(table, rules, structuredClone(record.snapshot), structuredClone(record.move)).events.map(stored);
    const recordedEvents = record.recorded.events.map(stored);
    // An older claim sealed no seat cap, so this computer sizes one the board never recorded; that one number is the machine-local input, and every other key is still compared.
    if (!('claimsPerSeat' in recordedEvents[0].detail)) delete wrote[0].detail.claimsPerSeat;
    assert.deepEqual(seen.length, 1, 'the writer ran the table once');
    const shadow = seen[0].decided.events?.map(stored);
    if (!('claimsPerSeat' in recordedEvents[0].detail)) delete shadow[0].detail.claimsPerSeat;
    if (JSON.stringify(wrote) !== JSON.stringify(expected) || JSON.stringify(shadow) !== JSON.stringify(expected) || JSON.stringify(recordedEvents) !== JSON.stringify(expected)) {
      disagreements.push({ event: record.event.id, wrote, shadow, expected, recorded: recordedEvents, refused: seen[0].decided.refused });
    }
  }
  assert.equal(gone.length, 3, 'three claims stand on a gone builder');
  assert.deepEqual(unrun, []);
  assert.deepEqual(disagreements, []);
});
