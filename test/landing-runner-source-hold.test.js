/** A batch refused RUNNER_SOURCE retries three times then waits, and a held verified item joins no batch [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { openBoard } from '../apps/lib/index.js';
import { RUNNER_SOURCE_RETRIES, runnerSourceHold } from '../packages/landing/src/core/runner-source-hold.js';
import { applyItemHold, applyItemHoldRelease } from '../packages/items/src/core/item-holds.js';
import { candidates } from '../packages/landing/src/shell/landing-step-selection.js';

const ITEM = { item_id: 2601, item_commit: 'a'.repeat(40) };
const BASE = 'b'.repeat(40);

/** A blocked batch that carried the item and was refused with a recorded code and message. */
function refused(base = BASE, commit = ITEM.item_commit, code = 'RUNNER_SOURCE') {
  return { state: 'blocked', base, candidates: [{ id: ITEM.item_id, commit }], refusal: { code, message: 'the runner checkout is not the queued candidate', at: '2026-11-03T14:00:00.000Z' } };
}

test('RUNNER_SOURCE retries at most three times, then the item is held with the recorded reason [C7]', () => {
  assert.equal(RUNNER_SOURCE_RETRIES, 3);
  assert.equal(runnerSourceHold([], ITEM, BASE), null);
  assert.equal(runnerSourceHold([refused(), refused()], ITEM, BASE), null, 'two refusals still retry');
  const held = runnerSourceHold([refused(), refused(), refused()], ITEM, BASE);
  assert.equal(held.code, 'LAND_RUNNER_SOURCE_HELD');
  assert.match(held.message, /3 landing batches were refused RUNNER_SOURCE .*the runner checkout is not the queued candidate.*#2601 waits for a new head or a new main/u);
});

test('a new main, a new head or another refusal code starts no hold [C7]', () => {
  const three = (...args) => [refused(...args), refused(...args), refused(...args)];
  assert.equal(runnerSourceHold(three('c'.repeat(40)), ITEM, BASE), null, 'main moved, so the count starts again');
  assert.equal(runnerSourceHold(three(BASE, 'd'.repeat(40)), ITEM, BASE), null, 'the item has a new head');
  assert.equal(runnerSourceHold(three(BASE, ITEM.item_commit, 'LAND_GATE_RED'), ITEM, BASE), null, 'only RUNNER_SOURCE counts');
});

test('a verified item can be held and released, a landed one cannot [C7]', () => {
  const rows = new Map();
  const events = [];
  const dependencies = { coordinatorOnly() {}, atomic: (_board, work) => work(), getItem: (_board, id) => rows.get(id), now: () => '2026-11-03T14:00:00.000Z',
    setItem: (_board, id, fields) => rows.set(id, { ...rows.get(id), ...fields }), logEvent: (_board, _agent, kind, id) => events.push([kind, id]),
    postRigorNotices() {}, itemHold: (_board, id) => (rows.get(id).item_hold_at ? rows.get(id) : null), holdUntilKind: () => null,
    forgetHoldMaintenance() {}, rememberHoldCondition() {}, staleStateEngine: 0 };
  const board = {};
  rows.set(1, { item_id: 1, item_status: 'verified', item_merged_commit: null });
  rows.set(2, { item_id: 2, item_status: 'verified', item_merged_commit: 'c'.repeat(40) });
  applyItemHold(board, 1, { agentId: 'coordinator', reason: 'landing keeps dying on this item' }, dependencies);
  assert.equal(rows.get(1).item_status, 'verified', 'the hold keeps its accept');
  assert.equal(rows.get(1).item_hold_reason, 'landing keeps dying on this item');
  assert.throws(() => applyItemHold(board, 2, { agentId: 'coordinator', reason: 'late' }, dependencies), { code: 'ITEM_NOT_OPEN' });
  applyItemHoldRelease(board, 1, { agentId: 'coordinator' }, dependencies);
  assert.equal(rows.get(1).item_hold_at, null, 'hold --off returns it');
  assert.deepEqual(events, [['hold_item', 1], ['unhold_item', 1]]);
});

test('a held verified item is skipped by landing selection with its reason [C7]', t => {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-03T14:00:00.000Z') });
  const root = mkdtempSync(join(tmpdir(), 'pullboard-hold-landing-'));
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const listed = [{ item_id: 7, item_status: 'verified', item_merged_commit: null, item_commit: ITEM.item_commit,
    item_hold_at: '2026-11-03T13:00:00.000Z', item_hold_reason: 'landing keeps dying on this item' }];
  const selected = candidates(board, root, BASE, 8, { listItems: () => listed });
  assert.deepEqual(selected.ready, []);
  assert.deepEqual(selected.blocked.map(entry => [entry.id, entry.code, entry.message]), [[7, 'ITEM_HELD', 'landing keeps dying on this item']]);
});
