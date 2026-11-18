/** @pullboard-test-input packages/store/tests/fixtures/verify-records.json */
/** @pullboard-world-pin reads the recorded verdict records fixture to replay each verdict through the store verify writer. The store verify writer agrees with the verify table on every replayed verdict [C7,#8272]. */
/** @pullboard-test-input packages/store/tests/fixtures/verify-records.json */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verify } from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';

const STAMP = '2026-01-01T00:00:00.000Z';

/** What the board stores for an event, without the actor's model, which the event writer stamps on every event and no move decides. */
const stored = ({ model, ...rest }) => JSON.parse(JSON.stringify(rest));

/** The frozen bar with its reviewer-family rule off: the records were reviewed by seats of declared vendor families the scratch board does not model, and no table row reads that rule. */
function openPolicy(frozen) {
  const bar = JSON.parse(frozen);
  return JSON.stringify({ ...bar, policy: { ...bar.policy, verify: { ...bar.policy.verify, family: 'off' } } });
}

/** A real board holding exactly what the replay record says the verdict saw, on a clock at the verdict's own instant. */
function boardFor(t, record) {
  const at = new Date(record.recorded.verdictRow.at);
  const board = cellBoard(t, ':memory:', { now: () => at });
  const { item, actor, history, verdicts } = record.snapshot;
  const sql = board.db;
  const seat = (id, route) => sql.prepare('INSERT OR IGNORE INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'core', `/seat/${id}`, route ?? 'strong', STAMP);
  seat(actor.id, actor.route);
  for (const name of [item.owner, item.builtBy]) if (name) seat(name, 'strong');
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, 'recorded', ?, 'open', 'coordinator', ?, ?)`)
    .run(item.id, item.lane ?? 'core', item.route, STAMP, STAMP);
  // The board's machine only lets an item reach a state by its declared moves, so the item walks to where the record found it.
  const fields = { item_owner: item.owner, item_built_by: item.builtBy, item_commit: item.commit, item_frozen: openPolicy(item.frozen), item_frozen_digest: item.frozenDigest };
  const set = (state, extra) => { const all = { ...extra, item_status: state }; sql.prepare(`UPDATE item SET ${Object.keys(all).map(k => `${k}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(all), item.id); };
  // Only a board move may change a status; the seed holds the same token a move holds while it writes.
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  set('claimed', { ...fields, item_lease_until: '2099-01-01T00:00:00.000Z' });
  set('submitted', {});
  if (item.status === 'verified') set('verified', { item_verified_by: 'someone-else', item_verdict: 'ACCEPT' });
  sql.exec('DELETE FROM temp.moving');
  const event = sql.prepare('INSERT INTO event (event_id, event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?, ?)');
  for (const e of history) event.run(e.id, STAMP, e.by, e.kind, item.id, JSON.stringify(e.detail));
  for (const e of record.snapshot.actorFlakeObservations) event.run(e.id, STAMP, actor.id, 'flake-observation', null, JSON.stringify(e.detail));
  const verdict = sql.prepare(`INSERT INTO verdict (verdict_id, item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_verifier_family, verdict_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const v of verdicts) verdict.run(v.id, v.item, v.by, v.decision, v.reason, v.note, v.commit, v.digest, v.head, v.family, v.at);
  // The board numbers its next event and verdict from its sequences, so they stand where the record's verdict was numbered.
  sql.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='event'").run(record.event.id - 1);
  sql.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='verdict'").run(record.recorded.verdictRow.id - 1);
  if (record.snapshot.lineSettings.sharpenToPerson) sql.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('line_setting:bar.sharpenToPerson', 'true');
  return board;
}

/** Drive the store's verify writer with what the record's move said, and return what it wrote after the seeded history. */
function drive(board, record) {
  const { move } = record;
  const before = board.db.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id;
  const { as, itemReviewPolicy, ...call } = move;
  verify(board, move.id, { agentId: move.actor, ...call, policy: 'any', familyPolicy: 'off', prechecked: true });
  return board.db.prepare(`SELECT e.event_kind kind, e.event_by by, e.event_detail detail, e.item_id item FROM event e WHERE e.event_id>? ORDER BY e.event_id`).all(before)
    .map(e => { const { model, ...detail } = JSON.parse(e.detail); return { kind: e.kind, by: e.by, detail, item: e.item }; });
}

/** Reduce what the writer logged to the table's own event shape: a shout event holds the shout's id, so its words come from the shout row. */
function asEvents(board, written) {
  return written.map(e => {
    if (e.kind !== 'shout') return stored({ kind: e.kind, by: e.by, detail: e.detail });
    const row = board.db.prepare('SELECT shout_to, shout_text FROM shout WHERE shout_id=?').get(e.detail.shout);
    return { kind: 'shout', by: e.by, to: row.shout_to, text: row.shout_text };
  });
}
const shape = (e) => (e.kind === 'shout' ? { kind: 'shout', by: e.by, to: e.detail.to, text: e.detail.text } : stored({ kind: e.kind, by: e.by, detail: e.detail }));

/** The paths where two event lists differ, so a disagreement names what the writer got different. */
function differences(wrote, expected) {
  const out = [];
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') { for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${path}.${key}`); return; }
    out.push(`${path}: wrote ${JSON.stringify(a)?.slice(0, 120)} expected ${JSON.stringify(b)?.slice(0, 120)}`);
  };
  walk(wrote, expected, 'events');
  return out;
}

const records = JSON.parse(readFileSync(new URL('../../../../../store/tests/fixtures/verify-records.json', import.meta.url), 'utf8'));

test('board.verify-table.the-store-verify-writer-agrees-with: clause 1: the store verify writer agrees with the verify table on every replayed verdict [C7,#8272]', t => {
  assert.ok(records.length >= 10, 'the replay holds accepts and rejects');
  const disagreements = [];
  const via = new Set();
  for (const record of records) {
    for (const step of record.via) via.add(step);
    const board = boardFor(t, record);
    const wrote = asEvents(board, drive(board, record).filter(e => e.kind !== 'fact'));
    const expected = record.table.filter(e => e.kind !== 'fact').map(shape);
    if (JSON.stringify(wrote) !== JSON.stringify(expected)) disagreements.push({ event: record.event.id, differences: differences(wrote, expected) });
  }
  assert.deepEqual(disagreements, []);
  for (const path of ['accept', 'reject', 'bar-sharpen', 'route-calibration', 'two-rejects']) assert.ok(via.has(path), `${path} replayed through the writer`);
});

test('board.verify-table.the-writer-refuses-with-its-own: clause 1: the writer refuses with its own code and writes nothing when the verdict is not allowed [C7,#8272]', t => {
  const record = records.find(entry => entry.move.decision === 'ACCEPT');
  const board = boardFor(t, record);
  const count = () => board.db.prepare('SELECT COUNT(*) n FROM event').get().n;
  const before = count();
  assert.throws(() => verify(board, record.move.id, { agentId: record.snapshot.item.builtBy, ...record.move, actor: undefined, policy: 'any', familyPolicy: 'off', prechecked: true }), { code: 'SELF_VERIFY' });
  assert.throws(() => verify(board, record.move.id, { agentId: record.move.actor, ...record.move, digest: 'moved', policy: 'any', familyPolicy: 'off', prechecked: true }), { code: 'CRITERIA_CHANGED' });
  assert.equal(count(), before);
});
