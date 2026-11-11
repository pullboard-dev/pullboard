/** Rejected work comes before new work for every seat in its lane, as a preference, never a reservation [C7,N2,#5765]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { addItem } from '../../../index.js';
import { register } from '../../../index.js';
import { submitFixture } from '../../../../../apps/cli/tests/fixtures/board/submit.js';
import { REJECTED_FIRST_ENGINE } from '../../../../state/index.js';
import { STUCK_RETURN_MS } from '../../../src/logic/rework.js';

const COMMIT = 'a'.repeat(40);

/** A clock-controlled memory board with three core seats and the coordinator. */
function fixture(t) {
  let at = Date.parse('2026-01-01T00:00:00.000Z');
  const board = cellBoard(t, ':memory:', { now: () => new Date(at) });
  register(board, { lane: 'coordinator', path: '/repo' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'mid' });
  const peer = register(board, { lane: 'core', path: '/peer', route: 'mid' });
  const third = register(board, { lane: 'core', path: '/third', route: 'mid' });
  return { board, builder, peer, third, advance: ms => { at += ms; } };
}

/** File one plain core item touching its own file, so no overlap orders the candidates. */
function add(f, title) {
  return addItem(f.board, { by: 'coordinator', lane: 'core', title, criterion: 'prove it', specIds: ['N2'], route: 'mid', check: 'true',
    brief: `Files: src/${title.replace(/\W+/gu, '-')}.js\nTest: proves ${title}` });
}

/** Claim through the native writer with a frozen bar. */
function claim(f, id, agentId) {
  return store.claim(f.board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) });
}

/** Build, submit and reject one item through the native board operations. */
function rejected(f, title, builder, verifier) {
  const id = add(f, title);
  claim(f, id, builder);
  submitFixture(f.board, id, { agentId: builder, commit: COMMIT, tree: COMMIT });
  store.verify(f.board, id, { agentId: verifier, decision: 'REJECT', reason: 'OTHER', note: 'one fix', clause: 'prove it',
    head: COMMIT, digest: 'fixture-bar', policy: 'any' });
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  return id;
}

const next = (f, agentId) => store.nextFor(f.board, { agentId, lane: 'core' }).item?.item_id ?? null;

test('[N2] a rejected item sorts before never-claimed work for every seat, after the seat\'s own parked work (#5765 clause 1)', t => {
  const f = fixture(t);
  const fresh = add(f, 'never claimed, older');
  const back = rejected(f, 'returned work', f.builder, f.third);
  for (const seat of [f.builder, f.peer, f.third]) assert.equal(next(f, seat), back, `${seat} is offered the rejected item before older new work`);

  f.board.executionEngineVersion = REJECTED_FIRST_ENGINE - 1;
  assert.equal(next(f, f.peer), fresh, 'older engines replay the former oldest-first order');
  f.board.executionEngineVersion = REJECTED_FIRST_ENGINE;

  const blocker = add(f, 'blocker');
  const parked = add(f, 'parked work');
  claim(f, parked, f.peer);
  store.release(f.board, parked, f.peer, '', { blockedOn: [blocker] }, 'BLOCKED');
  store.withdraw(f.board, blocker, { agentId: 'coordinator', reason: 'No longer needed' });
  assert.equal(next(f, f.peer), parked, 'the seat\'s own parked work still comes first');
  assert.equal(next(f, f.third), back, 'another seat\'s parked work does not displace the rejection');
});

test('[N2] the builder sees its own rejection first, and when busy any seat takes it with no window (#5765 clause 2)', t => {
  const f = fixture(t);
  const peerBack = rejected(f, 'peer returned, older', f.peer, f.third);
  const mineBack = rejected(f, 'builder returned', f.builder, f.third);
  add(f, 'never claimed');
  assert.equal(next(f, f.builder), mineBack, 'the builder sees its own rejection ahead of an older one');
  assert.equal(next(f, f.peer), peerBack, 'every builder sees its own rejection first');

  const other = add(f, 'busy work');
  claim(f, other, f.builder);
  assert.equal(next(f, f.builder), other, 'a busy builder keeps its claim; nothing reserves the rejection for it');
  claim(f, peerBack, f.peer);
  assert.equal(next(f, f.third), mineBack, 'while its builder is busy, any eligible seat is offered the rejection');
  claim(f, mineBack, f.third);
  assert.equal(store.getItem(f.board, mineBack).item_owner, f.third, 'the claim writer takes it with no builder window');
});

test('[N2] a rejected item open over 1 h while a lane seat calls next idle raises one stuck shout (#5765 clause 3)', t => {
  const f = fixture(t);
  const back = rejected(f, 'stuck returned', f.builder, f.third);
  const stuckShouts = () => f.board.db.prepare("SELECT shout_text FROM shout WHERE shout_from='rework' AND shout_to='coordinator'").all();
  const idle = seat => store.board_recordNextIdle(f.board, { agentId: seat, reason: 'nothing-eligible' });

  idle(f.peer);
  assert.equal(stuckShouts().length, 0, 'under an hour is not stuck');
  f.advance(STUCK_RETURN_MS + 60_000);
  assert.equal(store.nextIdleChanged(f.board, { agentId: f.peer, reason: 'nothing-eligible' }), true, 'an owed shout takes the writer even when the idle reason is unchanged');
  idle(f.peer);
  idle(f.third);
  f.advance(60_000);
  idle(f.peer);
  const shouts = stuckShouts();
  assert.equal(shouts.length, 1, 'one shout per rejection, however many idle calls');
  assert.match(shouts[0].shout_text, new RegExp(`#${back}\\b`, 'u'));
  assert.equal(store.nextIdleChanged(f.board, { agentId: f.peer, reason: 'nothing-eligible' }), false, 'once shouted, an unchanged idle takes no writer');

  claim(f, back, f.peer);
  submitFixture(f.board, back, { agentId: f.peer, commit: 'c'.repeat(40), tree: 'c'.repeat(40) });
  store.verify(f.board, back, { agentId: f.third, decision: 'REJECT', reason: 'OTHER', note: 'again', clause: 'prove it',
    head: 'c'.repeat(40), digest: 'fixture-bar', policy: 'any' });
  f.advance(STUCK_RETURN_MS + 60_000);
  idle(f.builder);
  assert.equal(stuckShouts().length, 2, 'a second rejection is a new episode with its own shout');
});
