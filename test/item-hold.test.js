/** Coordinator item holds preserve routing, claims and ordered replay [N2,N22,H16,M1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import * as store from '../src/board.js';
import { applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';

const e2e = createE2eHelpers();

/** Add a runnable mid item to a real private board. */
function addMidItem(board, lane, title) {
  return store.addItem(board, { by: 'coordinator', lane, title, route: 'mid',
    criterion: 'The private fixture proves the hold.', brief: e2e.LIGHT_BRIEF, check: 'true' });
}

/** Read a successful private CLI JSON result without hiding its diagnostic on failure. */
function jsonSuccess(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err || result.out);
  return JSON.parse(result.out);
}

/** Read the item fields that a hold must leave unchanged. */
function withoutHold(item) {
  const { item_hold_reason, item_hold_by, item_hold_at, item_updated_at, ...unchanged } = item;
  return unchanged;
}

test('a held item is never offered or claimed [N2,N22,M1]', t => {
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const board = store.openBoard(`${box.repo}/.git/pullboard/board.sqlite`);
  t.after(() => store.closeBoard(board));
  const held = new Map();
  const actors = [];
  for (const lane of ['web', 'api']) {
    const id = addMidItem(board, lane, `Held ${lane} item`);
    const before = store.getItem(board, id);
    const reason = `waiting for the person in ${lane}`;
    const result = jsonSuccess(box, box.repo, 'hold', String(id), reason);
    assert.equal(result.id, id);
    assert.equal(result.lane, lane);
    assert.equal(result.held, true);
    assert.equal(result.reason, reason);
    assert.deepEqual(withoutHold(store.getItem(board, id)), withoutHold(before));
    assert.match(box.run(box.repo, 'show', String(id)).out, new RegExp(`held by coordinator: ${reason}`));
    assert.match(box.run(box.repo, 'list', lane).out, new RegExp(`held by coordinator: ${reason}`));
    held.set(lane, { id, reason });
    for (const route of ['light', 'mid', 'strong']) {
      const actor = jsonSuccess(box, box.repo, 'worktree', lane, '--route', route);
      actors.push({ ...actor, lane, route });
      const next = store.nextFor(board, { agentId: actor.agent, lane });
      assert.equal(next.item, null, `${lane}/${route} cannot offer a held item`);
      assert.ok(next.reasons.includes(`#${id} is held by coordinator: ${reason}`));
      const attempted = box.run(actor.path, 'next', '--build', '--json');
      assert.equal(attempted.code, 1);
      const refusal = JSON.parse(attempted.out);
      assert.equal(refusal.error.code, 'NOTHING_FREE');
      assert.ok(refusal.error.message.includes(`#${id} is held by coordinator: ${reason}`));
    }
  }
  jsonSuccess(box, box.repo, 'hold', 'web', '--reason', 'lane release review');
  const webActor = actors.find(value => value.lane === 'web' && value.route === 'strong');
  const paused = box.run(webActor.path, 'next', '--build', '--json');
  assert.equal(paused.code, 1);
  const pausedReason = JSON.parse(paused.out).error.message;
  assert.ok(pausedReason.includes('lane release review'));
  assert.ok(pausedReason.includes(`#${held.get('web').id} is held by coordinator: ${held.get('web').reason}`),
    'a lane hold does not mask the item hold reason');
  jsonSuccess(box, box.repo, 'hold', 'web', '--off');
  for (const actor of actors) {
    for (const { id, reason } of held.values()) {
      const attempted = box.run(actor.path, 'claim', String(id), '--json');
      assert.equal(attempted.code, 1);
      const refusal = JSON.parse(attempted.out);
      assert.equal(refusal.error.code, 'ITEM_HELD', `${actor.lane}/${actor.route} cannot claim a held item in either lane`);
      assert.ok(refusal.error.message.includes(reason));
      assert.equal(store.getItem(board, id).item_status, 'open');
      assert.equal(store.getItem(board, id).item_owner, null);
    }
  }
  const actor = actors.find(value => value.lane === 'web' && value.route === 'mid');
  const free = addMidItem(board, 'web', 'Available work after a held item');
  const selected = jsonSuccess(box, actor.path, 'next', '--build');
  assert.equal(selected.item.item_id, free, 'next passes the held item to claim available work');
  assert.ok(selected.reasons.includes(`#${held.get('web').id} is held by coordinator: ${held.get('web').reason}`));
  const unauthorized = box.run(actor.path, 'hold', String(free), 'an agent cannot hold work', '--json');
  assert.equal(unauthorized.code, 1);
  assert.match(unauthorized.out + unauthorized.err, /COORDINATOR_ONLY/u);
});

test('lifting a hold makes the item offerable again [N2,N22,H16,M1]', t => {
  const box = e2e.project('true');
  t.after(e2e.cleanup);
  const board = store.openBoard(`${box.repo}/.git/pullboard/board.sqlite`);
  t.after(() => store.closeBoard(board));
  const id = addMidItem(board, 'web', 'Held item');
  const peer = store.openBoard(':memory:');
  t.after(() => store.closeBoard(peer));
  store.register(peer, { lane: 'coordinator', path: '/peer' });
  store.register(peer, { lane: 'web', path: '/peer-web' });
  assert.equal(addMidItem(peer, 'web', 'Held item'), id);
  const initial = store.getItem(board, id);
  const hold = prepareEngineMove(board, 'holdItem', [id, { agentId: 'coordinator', reason: 'review the release' }]);
  const at = '2026-10-09T12:00:00.000Z';
  const transport = { kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
  const applied = applyRelayMove(board, hold, { ...transport, sequence: 1, at });
  assert.deepEqual(applyRelayMove(peer, hold, { ...transport, sequence: 1, at }), applied);
  assert.equal(store.getItem(peer, id).item_hold_reason, 'review the release');
  const holdEvent = store.events(peer, { itemId: id }).at(-1);
  assert.equal(holdEvent.event_kind, 'hold_item');
  assert.equal(JSON.parse(holdEvent.event_detail).reason, 'review the release');
  const restored = store.openBoard(':memory:');
  t.after(() => store.closeBoard(restored));
  importBoard(restored, exportBoard(board));
  assert.deepEqual(store.getItem(restored, id), store.getItem(board, id), 'snapshot sync preserves the complete held item');
  assert.deepEqual(store.events(restored), store.events(board), 'snapshot sync preserves the hold event');
  assert.equal(store.nextFor(restored, { agentId: 'web-1', lane: 'web' }).item, null);
  const legacyExport = exportBoard(board);
  for (const item of legacyExport.tables.item) {
    delete item.item_hold_reason;
    delete item.item_hold_by;
    delete item.item_hold_at;
  }
  const incompatible = store.openBoard(':memory:');
  t.after(() => store.closeBoard(incompatible));
  assert.throws(() => importBoard(incompatible, legacyExport), error => error.code === 'IMPORT_SCHEMA'
    && error.message === '[IMPORT_SCHEMA] a item row does not have exactly its board columns; export it again',
    'a pre-hold export retains the existing strict-schema refusal');
  const release = prepareEngineMove(board, 'releaseItemHold', [id, { agentId: 'coordinator' }]);
  const releaseAt = '2026-10-09T12:01:00.000Z';
  const released = applyRelayMove(board, release, { ...transport, sequence: 2, at: releaseAt });
  assert.deepEqual(applyRelayMove(peer, release, { ...transport, sequence: 2, at: releaseAt }), released);
  assert.equal(store.events(peer, { itemId: id }).at(-1).event_kind, 'unhold_item');
  for (const replica of [board, peer]) {
    const item = store.getItem(replica, id);
    assert.equal(item.item_hold_reason, null);
    assert.equal(item.item_hold_by, null);
    assert.equal(item.item_hold_at, null);
    assert.equal(store.nextFor(replica, { agentId: 'web-1', lane: 'web' }).item.item_id, id);
  }
  assert.deepEqual(withoutHold(store.getItem(board, id)), withoutHold(initial));
  jsonSuccess(box, box.repo, 'hold', String(id), 'CLI hold and lift');
  const lifted = jsonSuccess(box, box.repo, 'hold', String(id), '--off');
  assert.equal(lifted.held, false);
  assert.equal(lifted.reason, null);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, id);
  assert.equal(jsonSuccess(box, box.web, 'next', '--build').item.item_id, id);
  jsonSuccess(box, box.repo, 'hold', String(id), 'finish your current work');
  assert.equal(store.getItem(board, id).item_owner, 'web-1');
  const heldClaimCopy = store.openBoard(':memory:');
  t.after(() => store.closeBoard(heldClaimCopy));
  importBoard(heldClaimCopy, exportBoard(board));
  assert.deepEqual(store.getItem(heldClaimCopy, id), store.getItem(board, id), 'snapshot sync preserves the held claim and reason');
  assert.equal(store.getItem(heldClaimCopy, id).item_owner, 'web-1');
  assert.equal(jsonSuccess(box, box.web, 'claim', String(id)).renewed, true);
  box.git(box.web, 'commit', '--allow-empty', '-qm', 'feat(web): finish held work [G1]');
  assert.equal(jsonSuccess(box, box.web, 'submit', String(id)).id, id);
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the existing live holder can still submit');
});
