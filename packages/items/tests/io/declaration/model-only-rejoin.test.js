/** A model-only rejoin keeps the seat's first declared vendor family on every family read [H24,V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { register } from '../../../../store/index.js';
import { derivedFamily } from '../../../index.js';
import { seatFamily } from '../../../index.js';
import { withDerivedFamilies } from '../../../index.js';
import { withDerivedFamily } from '../../../index.js';
import { withFamilyReads } from '../../../index.js';
import { FIXTURE_MODEL_EARLIER } from '../../../../store/tests/fixtures/cell.js';

const SESSION = 'model-only-rejoin-session';

/** A board whose seat joined blank, declared codex, then rejoined naming only a new model. */
function rejoined(t) {
  const board = fixtureBoard(t);
  const seat = register(board, { lane: 'core', path: '/fixture/model-only', session: SESSION });
  register(board, { lane: 'core', path: '/fixture/model-only', family: 'codex', session: SESSION });
  register(board, { lane: 'core', path: '/fixture/model-only', model: FIXTURE_MODEL_EARLIER, session: SESSION });
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
  const peer = register(board, { lane: 'core', path: '/fixture/model-only-peer', session: SESSION });
  const stranger = register(board, { lane: 'core', path: '/fixture/model-only-stranger', session: 'another-session' });
  for (const [name, family] of Object.entries(reads(board, peer))) assert.equal(family, 'codex', `peer ${name}`);
  for (const [name, family] of Object.entries(reads(board, stranger))) assert.equal(family ?? 'unknown', 'unknown', `stranger ${name}`);
});

test('items.declaration.model-only-rejoin-refuses-change: clause 3: a later different nonblank family for that seat still refuses [H24,C7]', t => {
  const { board, seat } = rejoined(t);
  assert.throws(() => register(board, { lane: 'core', path: '/fixture/model-only', family: 'claude', session: SESSION }), error => error.code === 'FAMILY_DECLARED');
  assert.equal(seatFamily(board, seat), 'codex');
});
