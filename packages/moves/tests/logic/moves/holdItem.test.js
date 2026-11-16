/** Coordinator item holds preserve routing, claims and ordered replay [N2,N22,H16,M1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { exportBoard } from '../../../../store/index.js';
import { importBoard } from '../../../../store/index.js';
import { applyRelayMove } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { heldCounted } from '../../../index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';

const HOUR = 3_600_000;
const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** Add a runnable mid item to a real private board. */
function addMidItem(board, lane, title) {
  return store.addItem(board, { by: 'coordinator', lane, title, route: 'mid',
    criterion: 'The private fixture proves the hold.', brief: LIGHT_BRIEF, check: 'true' });
}

/** Freeze the criterion alone, with a digest of the frozen text. */
const freeze = (item) => {
  const text = JSON.stringify({ criterion: item.item_criterion });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
};

/** Read the item fields that a hold must leave unchanged. */
function withoutHold(item) {
  const { item_hold_reason, item_hold_by, item_hold_at, item_updated_at, ...unchanged } = item;
  return unchanged;
}

/** The refusal a claim of the item raises, or null when it is accepted. */
function claimRefusal(board, id, seat) {
  try { store.claim(board, id, { agentId: seat.id, lane: seat.lane, leaseMs: 2 * HOUR, freeze }); return null; } catch (error) { return error; }
}

test('a held item is never offered or claimed [N2,N22,M1]', t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const held = new Map();
  const actors = [];
  for (const lane of ['web', 'api']) {
    const id = addMidItem(board, lane, `Held ${lane} item`);
    const before = store.getItem(board, id);
    const reason = `waiting for the person in ${lane}`;
    store.holdItem(board, id, { agentId: 'coordinator', reason });
    const item = store.getItem(board, id);
    assert.equal(item.item_lane, lane);
    assert.equal(Boolean(item.item_hold_at), true);
    assert.equal(item.item_hold_reason, reason);
    assert.equal(item.item_hold_by, 'coordinator');
    assert.deepEqual(withoutHold(item), withoutHold(before));
    held.set(lane, { id, reason });
    for (const route of ['light', 'mid', 'strong']) {
      const actor = { ...cellSeat(board, { lane, path: join(project.dir, `${lane}-${route}`), route, model: 'Fixture' }), lane, route };
      actors.push(actor);
      const next = store.nextFor(board, { agentId: actor.id, lane });
      assert.equal(next.item, null, `${lane}/${route} cannot offer a held item`);
      assert.ok(next.reasons.includes(`#${id} is held by coordinator: ${reason}`));
      assert.ok(heldCounted(next.reasons).includes('1 item is held by coordinator'), `${lane}/${route} is told one item is held`);
    }
  }
  store.holdLane(board, 'web', { agentId: 'coordinator', reason: 'lane release review' });
  const webActor = actors.find(value => value.lane === 'web' && value.route === 'strong');
  const paused = store.nextFor(board, { agentId: webActor.id, lane: 'web' });
  assert.equal(paused.item, null);
  const pausedReason = heldCounted(paused.reasons).join('; ');
  assert.ok(pausedReason.includes('lane release review'));
  assert.ok(pausedReason.includes('1 item is held by coordinator'),
    'a lane hold does not mask the item hold reason');
  store.releaseLane(board, 'web', { agentId: 'coordinator' });
  for (const actor of actors) {
    for (const { id, reason } of held.values()) {
      const refusal = claimRefusal(board, id, actor);
      assert.equal(refusal?.code, 'ITEM_HELD', `${actor.lane}/${actor.route} cannot claim a held item in either lane`);
      assert.ok(refusal.message.includes(`#${id} is held by coordinator: ${reason}`), refusal.message);
      assert.equal(store.getItem(board, id).item_status, 'open');
      assert.equal(store.getItem(board, id).item_owner, null);
    }
  }
  const actor = actors.find(value => value.lane === 'web' && value.route === 'mid');
  const free = addMidItem(board, 'web', 'Available work after a held item');
  const selected = store.nextFor(board, { agentId: actor.id, lane: 'web' });
  assert.equal(selected.item.item_id, free, 'next passes the held item to claim available work');
  assert.ok(selected.reasons.includes(`#${held.get('web').id} is held by coordinator: ${held.get('web').reason}`));
  assert.throws(() => store.holdItem(board, free, { agentId: actor.id, reason: 'an agent cannot hold work' }), error => error.code === 'COORDINATOR_ONLY');
});

test('lifting a hold makes the item offerable again [N2,N22,H16,M1]', t => {
  const project = cellProject(t, { real: true, gate: 'true' });
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const base = project.git(project.repo, 'rev-parse', 'main');
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  cellSeat(board, { lane: 'web', path: web });
  const id = addMidItem(board, 'web', 'Held item');
  const peer = cellBoard(t, ':memory:');
  cellSeat(peer, { lane: 'coordinator', path: '/peer' });
  cellSeat(peer, { lane: 'web', path: '/peer-web' });
  assert.equal(addMidItem(peer, 'web', 'Held item'), id);
  const initial = store.getItem(board, id);
  const hold = prepareEngineMove(board, 'holdItem', [id, { agentId: 'coordinator', reason: 'review the release' }]);
  const at = '2026-10-09T12:00:00.000Z';
  const transport = { kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
  const unnumbered = (moved) => ({ ...moved, events: moved.events.map(({ event_id, ...event }) => event) });
  const applied = applyRelayMove(board, hold, { ...transport, sequence: 1, at });
  assert.deepEqual(unnumbered(applyRelayMove(peer, hold, { ...transport, sequence: 1, at })), unnumbered(applied));
  assert.equal(store.getItem(peer, id).item_hold_reason, 'review the release');
  const holdEvent = store.events(peer, { itemId: id }).at(-1);
  assert.equal(holdEvent.event_kind, 'hold_item');
  assert.equal(JSON.parse(holdEvent.event_detail).reason, 'review the release');
  const restored = cellBoard(t, ':memory:');
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
  const incompatible = cellBoard(t, ':memory:');
  assert.throws(() => importBoard(incompatible, legacyExport), error => error.code === 'IMPORT_SCHEMA'
    && error.message === '[IMPORT_SCHEMA] a item row does not have exactly its board columns; export it again',
    'a pre-hold export retains the existing strict-schema refusal');
  const release = prepareEngineMove(board, 'releaseItemHold', [id, { agentId: 'coordinator' }]);
  const releaseAt = '2026-10-09T12:01:00.000Z';
  const released = applyRelayMove(board, release, { ...transport, sequence: 2, at: releaseAt });
  assert.deepEqual(unnumbered(applyRelayMove(peer, release, { ...transport, sequence: 2, at: releaseAt })), unnumbered(released));
  assert.equal(store.events(peer, { itemId: id }).at(-1).event_kind, 'unhold_item');
  for (const replica of [board, peer]) {
    const item = store.getItem(replica, id);
    assert.equal(item.item_hold_reason, null);
    assert.equal(item.item_hold_by, null);
    assert.equal(item.item_hold_at, null);
    assert.equal(store.nextFor(replica, { agentId: 'web-1', lane: 'web' }).item.item_id, id);
  }
  assert.deepEqual(withoutHold(store.getItem(board, id)), withoutHold(initial));
  store.holdItem(board, id, { agentId: 'coordinator', reason: 'hold and lift' });
  store.releaseItemHold(board, id, { agentId: 'coordinator' });
  const lifted = store.getItem(board, id);
  assert.equal(Boolean(lifted.item_hold_at), false);
  assert.equal(lifted.item_hold_reason, null);
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item.item_id, id);
  assert.notEqual(store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, head: base }).renewed, true);
  store.holdItem(board, id, { agentId: 'coordinator', reason: 'finish your current work' });
  assert.equal(store.getItem(board, id).item_owner, 'web-1');
  const heldClaimCopy = cellBoard(t, ':memory:');
  importBoard(heldClaimCopy, exportBoard(board));
  assert.deepEqual(store.getItem(heldClaimCopy, id), store.getItem(board, id), 'snapshot sync preserves the held claim and reason');
  assert.equal(store.getItem(heldClaimCopy, id).item_owner, 'web-1');
  assert.equal(store.claim(board, id, { agentId: 'web-1', lane: 'web', leaseMs: 2 * HOUR, freeze, head: base }).renewed, true);
  mkdirSync(`${web}/web`, { recursive: true });
  writeFileSync(`${web}/web/held-work.txt`, 'finished held work\n');
  project.git(web, 'add', 'web/held-work.txt');
  project.git(web, 'commit', '-qm', 'feat(web): finish held work [G1]');
  const commit = project.git(web, 'rev-parse', 'HEAD');
  const policyCommit = project.git(project.repo, 'rev-parse', 'main');
  submitFixture(board, id, { agentId: 'web-1', commit, tree: project.git(web, 'rev-parse', `${commit}^{tree}`), policyCommit, clausePolicyCommit: policyCommit });
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the existing live holder can still submit');
});
