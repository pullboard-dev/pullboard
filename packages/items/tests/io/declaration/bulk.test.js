/** Real SQLite fixtures compare bulk family reads with the unchanged single-seat authority [V4,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { derivedFamily } from '../../../index.js';
import { seatFamily } from '../../../index.js';
import { withDerivedFamilies } from '../../../index.js';
import { FAMILY_DECLARE_ENGINE } from '../../../../state/light.js';

/** Seed historical rows without executing a registration whose modern guards would forbid that history. */
function seat(board, id, family, session = null) {
  board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)')
    .run(id, 'core', `/fixture/${id}`, family, '2026-10-28T00:00:00Z');
  if (session !== null) metadata(board, `agent_session:${id}`, session);
}

/** Add only explicit synthetic fixture metadata, never machine state. */
function metadata(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(key, value);
}

/** Append an ordered synthetic family history record to the real production table. */
function event(board, id, kind, detail, order = null) {
  board.db.prepare('INSERT INTO event(event_id,event_at,event_by,event_kind,event_detail) VALUES(?,?,?,?,?)')
    .run(order, '2026-10-28T00:00:00Z', id, kind, JSON.stringify(detail));
}

/** Compare every ordinary row with the unchanged individual derivation and explicit expected vendors. */
function families(board, expected) {
  const rows = board.db.prepare('SELECT * FROM agent ORDER BY rowid').all();
  const bulk = withDerivedFamilies(board, rows);
  assert.deepEqual(bulk.map(row => row.agent_family), rows.map(row => seatFamily(board, row.agent_id)));
  const observed = Object.fromEntries(bulk.map(row => [row.agent_id, row.agent_family]));
  assert.deepEqual(observed, expected);
}

test('items.declaration.bulk-requested-ties: synthetic historical inputs: bulk family reads preserve requested-seat ties, shared sessions and ghost peer evidence [V4,H16,C7]', t => {
  const board = fixtureBoard(t);
  seat(board, 'core-1', 'OpenAI', 'shared'); seat(board, 'core-2', 'Claude', 'shared');
  assert.deepEqual(withDerivedFamilies(board, []), []);
  assert.deepEqual(withDerivedFamilies(board, [null]), [null]);
  families(board, { 'core-1': 'OpenAI', 'core-2': 'Claude' }); // No join: LAST ties retain the requested seat first.
  metadata(board, 'agent_session:ghost', 'shared');
  event(board, 'ghost', 'join', { family: 'Ghost vendor' });
  families(board, { 'core-1': 'Ghost vendor', 'core-2': 'Ghost vendor' });
  seat(board, 'core-3', null, 'independent');
  metadata(board, 'agent_parent_session:core-3', 'shared'); // A parent is not the original session.
  families(board, { 'core-1': 'Ghost vendor', 'core-2': 'Ghost vendor', 'core-3': null });
});

test('items.declaration.bulk-blank-last-ties: synthetic historical inputs: blank requested seats retain row-ordered ghost peer LAST ties [V4,H16,C7]', t => {
  const board = fixtureBoard(t);
  seat(board, 'core-1', null, 'shared');
  metadata(board, 'agent_session:ghost', 'shared'); // Deliberately before the lexically earlier real peer.
  seat(board, 'core-2', 'OpenAI', 'shared');
  event(board, 'ghost', 'family', { family: 'Ghost vendor' }, Number.MAX_SAFE_INTEGER);
  families(board, { 'core-1': 'Ghost vendor', 'core-2': 'OpenAI' });
});

test('items.declaration.bulk-case-variants: synthetic historical inputs: case-variant metadata remains a peer but never overrides an original session [V4,H16,C7]', t => {
  const board = fixtureBoard(t);
  seat(board, 'core-1', 'OpenAI'); metadata(board, 'AGENT_SESSION:core-1', 'shared');
  seat(board, 'core-2', null, 'shared'); metadata(board, 'agent_session:ghost', 'shared');
  event(board, 'ghost', 'join', { family: 'Ghost vendor' });
  seat(board, 'core-3', 'Claude', 'independent'); metadata(board, 'AGENT_SESSION:core-3', 'shared');
  families(board, { 'core-1': 'OpenAI', 'core-2': 'Ghost vendor', 'core-3': 'Claude' });
});

test('items.declaration.bulk-earliest-nonblank: synthetic historical inputs: bulk family reads retain earliest nonblank declarations and exact historical receipt binding [V4,H16,C7]', t => {
  const board = fixtureBoard(t);
  seat(board, 'core-1', null); event(board, 'core-1', 'join', {}); event(board, 'core-1', 'family', { family: 'Claude' });
  families(board, { 'core-1': 'Claude' });
  metadata(board, 'relay_receipt_first', JSON.stringify({ sequence: 1,
    move: JSON.stringify({ operation: 'register', args: [{ path: '/fixture/core-1', family: 'OpenAI' }] }), outcome: { result: 'core-1' } }));
  families(board, { 'core-1': 'OpenAI' }); // A new receipt is visible on the same connection.
  seat(board, 'core-2', null); event(board, 'core-2', 'join', { family: ' ' });
  event(board, 'core-2', 'family', { family: '' }); event(board, 'core-2', 'family', { family: 'First vendor' });
  event(board, 'core-2', 'family', { family: 'Later vendor' });
  seat(board, 'core-3', null); event(board, 'core-3', 'join', {}); event(board, 'core-3', 'family', { family: 'Claude' });
  metadata(board, 'relay_receipt_wrong_seat', JSON.stringify({ sequence: 2,
    move: JSON.stringify({ operation: 'register', args: [{ path: '/fixture/core-3', family: 'OpenAI' }] }), outcome: { result: 'another-seat' } }));
  metadata(board, 'relay_receipt_failed', JSON.stringify({ sequence: 0,
    move: JSON.stringify({ operation: 'register', args: [{ path: '/fixture/core-3', family: 'Wrong vendor' }] }), outcome: { error: { code: 'REFUSED' } } }));
  metadata(board, 'relay_receipt_malformed', '{');
  families(board, { 'core-1': 'OpenAI', 'core-2': 'First vendor', 'core-3': 'Claude' });
});

test('items.declaration.bulk-snapshot-ends: synthetic historical inputs: bulk family snapshots end at return and never cache a late declaration or rolled-back row [V4,H16,C7]', t => {
  const board = fixtureBoard(t);
  seat(board, 'core-1', null); families(board, { 'core-1': null });
  board.db.prepare('UPDATE agent SET agent_family=? WHERE agent_id=?').run('OpenAI', 'core-1');
  families(board, { 'core-1': 'OpenAI' });
  board.db.exec('SAVEPOINT fixture_family_change');
  board.db.prepare('UPDATE agent SET agent_family=? WHERE agent_id=?').run('Claude', 'core-1');
  families(board, { 'core-1': 'Claude' });
  board.db.exec('ROLLBACK TO fixture_family_change; RELEASE fixture_family_change');
  families(board, { 'core-1': 'OpenAI' });
  seat(board, 'core-2', null, 'late'); families(board, { 'core-1': 'OpenAI', 'core-2': null });
  seat(board, 'core-3', null, 'late'); event(board, 'core-3', 'join', { family: 'Late vendor' });
  families(board, { 'core-1': 'OpenAI', 'core-2': 'Late vendor', 'core-3': 'Late vendor' });
});

test('items.declaration.bulk-external-writes: synthetic historical inputs: bulk family snapshots observe external writes and preserve preengine and inserting semantics [V4,H16,C7]', t => {
  const board = fixtureBoard(t, { storage: 'file', purpose: 'persistence' });
  seat(board, 'core-1', 'OpenAI'); families(board, { 'core-1': 'OpenAI' });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
  const external = new DatabaseSync(file);
  try { external.prepare('UPDATE agent SET agent_family=? WHERE agent_id=?').run('Claude', 'core-1'); }
  finally { external.close(); }
  families(board, { 'core-1': 'Claude' });
  assert.equal(derivedFamily(board, 'core-1', { inserting: true }), null, 'a just-inserted display column is still excluded by registration authority');
  event(board, 'core-1', 'join', { family: 'Original vendor' });
  families(board, { 'core-1': 'Original vendor' });
  board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
  families(board, { 'core-1': 'Claude' });
  delete board.executionEngineVersion;
  families(board, { 'core-1': 'Original vendor' });
});

test('items.declaration.bulk-bounded-scans: synthetic historical inputs: bulk family reads use bounded SQLite scans even when every seat shares a session [V4,H16,C7]', t => {
  const board = fixtureBoard(t), expected = {};
  for (let index = 1; index <= 64; index++) {
    const id = `core-${index}`; seat(board, id, null, 'shared'); expected[id] = 'OpenAI';
  }
  event(board, 'core-64', 'join', { family: 'OpenAI' });
  const statements = [], rows = board.db.prepare('SELECT * FROM agent ORDER BY rowid').all();
  const observed = Object.create(board);
  observed.db = new Proxy(board.db, {
    /** Count real SQL preparations while preserving native SQLite receiver identity. */
    get(target, key) {
    if (key === 'prepare') return sql => { statements.push(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = withDerivedFamilies(observed, rows);
  assert.deepEqual(Object.fromEntries(result.map(row => [row.agent_id, row.agent_family])), expected);
  assert.ok(statements.length <= 6, `one bulk read stays bounded, saw ${statements.length} SQL preparations`);
});
