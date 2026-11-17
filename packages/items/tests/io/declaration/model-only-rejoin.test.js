/** A model-only rejoin keeps the seat's first declared vendor family on every family read [H24,V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { derivedFamily } from '../../../index.js';
import { saveJoinedSession } from '../../../index.js';
import { seatFamily } from '../../../index.js';
import { withDerivedFamilies } from '../../../index.js';
import { withDerivedFamily } from '../../../index.js';
import { withFamilyReads } from '../../../index.js';

const SESSION = 'model-only-rejoin-session';

/** Append one ordered board event the way a registration records it. */
function log(board, id, kind, detail) {
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,event_detail) VALUES(?,?,?,?)').run('2026-10-28T00:00:00Z', id, kind, JSON.stringify(detail));
}

/** A fresh seat joined in a session, as a registration with no family records it. */
function join(board, id, session) {
  board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_family,agent_created_at) VALUES(?,?,?,?,?)').run(id, 'core', `/fixture/${id}`, null, '2026-10-28T00:00:00Z');
  saveJoinedSession(board, id, { session, inserting: true });
  log(board, id, 'join', { lane: 'core', family: null });
}

/** A board whose seat joined blank, declared codex, then rejoined naming only a new model (no family in the join). */
function rejoined(t) {
  const board = fixtureBoard(t);
  const seat = 'core-1';
  join(board, seat, SESSION);
  // The declaring rejoin: the session is first to name a vendor, so the seat row and a family event record it.
  assert.equal(saveJoinedSession(board, seat, { session: SESSION, family: 'codex' }), false);
  board.db.prepare('UPDATE agent SET agent_family = ? WHERE agent_id = ?').run('codex', seat);
  log(board, seat, 'family', { family: 'codex' });
  // The model-only rejoin passes no family at all and reports the family as already declared.
  assert.equal(saveJoinedSession(board, seat, { session: SESSION }), true);
  return { board, seat };
}

/** Every family read a command can use for one seat id. */
function reads(board, id) {
  const row = board.db.prepare('SELECT * FROM agent WHERE agent_id = ?').get(id);
  return {
    seatFamily: seatFamily(board, id),
    derivedFamily: derivedFamily(board, id),
    withDerivedFamily: withDerivedFamily(board, row).agent_family,
    withDerivedFamilies: withDerivedFamilies(board, [row])[0].agent_family,
    scoped: withFamilyReads(board, () => seatFamily(board, id)),
  };
}

test('items.declaration.model-only-rejoin-keeps-family: clause 1: a seat registered without a family that declares codex and then rejoins with only a new model reads codex from seatFamily and every family read [H24,C7]', t => {
  const { board, seat } = rejoined(t);
  for (const [name, family] of Object.entries(reads(board, seat))) assert.equal(family, 'codex', name);
});

test('items.declaration.model-only-rejoin-peers: clause 2: a same-session peer of that seat reads codex after the model-only rejoin and a seat with no declaration reads unknown [H24,C7]', t => {
  const { board } = rejoined(t);
  const peer = 'core-2', stranger = 'core-3';
  join(board, peer, SESSION);
  join(board, stranger, 'another-session');
  for (const [name, family] of Object.entries(reads(board, peer))) assert.equal(family, 'codex', `peer ${name}`);
  for (const [name, family] of Object.entries(reads(board, stranger))) assert.equal(family ?? 'unknown', 'unknown', `stranger ${name}`);
});

test('items.declaration.model-only-rejoin-refuses-change: clause 3: a later different nonblank family for that seat still refuses [H24,C7]', t => {
  const { board, seat } = rejoined(t);
  assert.throws(() => saveJoinedSession(board, seat, { session: SESSION, family: 'claude' }), error => error.code === 'FAMILY_DECLARED');
  assert.equal(seatFamily(board, seat), 'codex');
});
