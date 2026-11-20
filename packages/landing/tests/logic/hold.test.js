/** A batch refused RUNNER_SOURCE retries three times then waits, and a held verified item joins no batch [C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { openCellBoard as openBoard } from '../../../board/tests/fixtures/cell-board.js';
import {
  RUNNER_SOURCE_RETRIES,
  runnerSourceHold,
  repeatedBlockedCause,
  repeatedLandingHold,
  repeatedLandingHoldCleared,
  repeatedLandingNotice,
  REPEATED_LANDING_HOLD,
} from '../../index.js';
import {
  applyItemHold,
  applyItemHoldRelease,
} from '../../../items/index.js';
import { candidates } from '../../index.js';

const ITEM = { item_id: 2601, item_commit: 'a'.repeat(40) };
const BASE = 'b'.repeat(40);

/** A blocked batch that carried the item and was refused with a recorded code and message. */
function refused(base = BASE, commit = ITEM.item_commit, code = 'RUNNER_SOURCE') {
  return { state: 'blocked', base, candidates: [{ id: ITEM.item_id, commit }], refusal: { code, message: 'the runner checkout is not the queued candidate', at: '2026-11-03T14:00:00.000Z' } };
}

test('landing.hold.runner-source-retries-at-most-three: RUNNER_SOURCE retries at most three times, then the item is held with the recorded reason [C7]', () => {
  assert.equal(RUNNER_SOURCE_RETRIES, 3);
  assert.equal(runnerSourceHold([], ITEM, BASE), null);
  assert.equal(runnerSourceHold([refused(), refused()], ITEM, BASE), null, 'two refusals still retry');
  const held = runnerSourceHold([refused(), refused(), refused()], ITEM, BASE);
  assert.equal(held.code, 'LAND_RUNNER_SOURCE_HELD');
  assert.match(held.message, /3 landing attempts were refused RUNNER_SOURCE .*the runner checkout is not the queued candidate.*#2601 waits for a new head or a new main/u);
});

test('landing.hold.resumed-attempts-on-one-batch-count: resumed attempts on one batch count toward the three retries [C7]', () => {
  const attempt = { code: 'RUNNER_SOURCE', message: 'the runner checkout is not the queued candidate', at: '2026-11-03T14:00:00.000Z' };
  const resumed = { state: 'gating', base: BASE, candidates: [{ id: ITEM.item_id, commit: ITEM.item_commit }], refusal: null, refusals: [attempt, attempt] };
  assert.equal(runnerSourceHold([resumed], ITEM, BASE), null, 'two attempts still retry');
  assert.equal(runnerSourceHold([{ ...resumed, refusals: [attempt, attempt, attempt] }], ITEM, BASE).code, 'LAND_RUNNER_SOURCE_HELD');
});

test('landing.hold.a-new-main-a-new-head: a new main, a new head or another refusal code starts no hold [C7]', () => {
  const three = (...args) => [refused(...args), refused(...args), refused(...args)];
  assert.equal(runnerSourceHold(three('c'.repeat(40)), ITEM, BASE), null, 'main moved, so the count starts again');
  assert.equal(runnerSourceHold(three(BASE, 'd'.repeat(40)), ITEM, BASE), null, 'the item has a new head');
  assert.equal(runnerSourceHold(three(BASE, ITEM.item_commit, 'LAND_GATE_RED'), ITEM, BASE), null, 'only RUNNER_SOURCE counts');
});

test('landing.hold.a-verified-item-can-be-held: a verified item can be held and released, a landed one cannot [C7]', () => {
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

test('landing.hold.a-held-verified-item-is-skipped: a held verified item is skipped by landing selection with its reason [C7]', t => {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-03T14:00:00.000Z') });
  const root = mkdtempSync(join(tmpdir(), 'pullboard-hold-landing-'));
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const listed = [{ item_id: 7, item_status: 'verified', item_merged_commit: null, item_commit: ITEM.item_commit,
    item_hold_at: '2026-11-03T13:00:00.000Z', item_hold_reason: 'landing keeps dying on this item' }];
  const selected = candidates(board, root, BASE, 8, { listItems: () => listed });
  assert.deepEqual(selected.ready, []);
  assert.deepEqual(selected.blocked.map(entry => [entry.id, entry.code, entry.message]), [[7, 'ITEM_HELD', 'landing keeps dying on this item']]);
});

test('landing.hold.a-full-batch-stops-landing-selection: a full batch stops landing selection before checking later items [C7]', t => {
  const board = openBoard(':memory:', { now: () => new Date('2026-11-05T16:00:00.000Z') });
  const root = mkdtempSync(join(tmpdir(), 'pullboard-full-batch-'));
  t.after(() => { store.closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  const listed = [{ item_id: 8, item_status: 'verified', item_merged_commit: null, item_commit: ITEM.item_commit,
    item_hold_at: '2026-11-05T15:00:00.000Z', item_hold_reason: 'held' }];
  // A batch with no room left never walks the queue, so no item beyond it costs a verdict projection or git call.
  const selected = candidates(board, root, BASE, 0, { listItems: () => listed });
  assert.deepEqual(selected, { ready: [], blocked: [] });
});

test('landing.hold.two-consecutive-blocked-batches-with-the: clause 1: two consecutive blocked batches with the same refusal park only that exact item head [C7]', () => {
  /** Make one blocked batch recording the selected item's refusal. */
  const batch = (id, base, code) => ({ id, state: 'blocked', base, items: [{ id: ITEM.item_id, commit: ITEM.item_commit }],
    refusal: { code, message: 'runner could not adopt the recorded tree' } });
  assert.deepEqual(repeatedBlockedCause([batch('one', BASE, 'LAND_ADOPT'), batch('two', BASE, 'LAND_ADOPT')], ITEM),
    { kind: 'refusal', key: 'LAND_ADOPT', detail: 'runner could not adopt the recorded tree', base: BASE, commit: ITEM.item_commit, batch: 'two' });
  assert.equal(repeatedBlockedCause([batch('one', BASE, 'LAND_ADOPT'), batch('two', BASE, 'LAND_DIRTY')], ITEM), null);
  assert.equal(repeatedBlockedCause([batch('one', BASE, 'LAND_ADOPT'), batch('two', BASE, 'LAND_ADOPT')],
    { ...ITEM, item_commit: 'c'.repeat(40) }), null);
  assert.equal(repeatedBlockedCause([refused(), refused()], ITEM), null, 'RUNNER_SOURCE keeps its own three-attempt retry, not the two-batch park');
});

test('landing.hold.two-consecutive-blocked-batches-with-the-2: clause 1: two consecutive blocked batches with the same named failing case park it, but a different case does not [C7]', () => {
  /** Make one blocked batch recording a named failing case for the selected item. */
  const batch = (id, name) => ({ id, state: 'blocked', base: BASE, items: [{ id: ITEM.item_id, commit: ITEM.item_commit }],
    culprits: [{ id: ITEM.item_id, commit: ITEM.item_commit, tests: [{ file: 'test/landing.test.js', name }] }] });
  assert.equal(repeatedBlockedCause([batch('one', 'clause 1 parks the item'), batch('two', 'clause 1 parks the item')], ITEM)?.key,
    'test/landing.test.js::clause 1 parks the item');
  assert.equal(repeatedBlockedCause([batch('one', 'first case'), batch('two', 'second case')], ITEM), null);
});

test('landing.hold.a-land-dirty-hold-lifts-only: clause 2: a LAND_DIRTY hold lifts only when its worktree is clean, never on a moved base or new head alone [C7]', () => {
  const hold = { kind: 'refusal', key: 'LAND_DIRTY', base: BASE, commit: ITEM.item_commit };
  const MOVED = 'c'.repeat(40);
  const NEWHEAD = { ...ITEM, item_commit: 'd'.repeat(40) };
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, null, { worktreeDirty: true }), false, 'dirty at the same base stays held');
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, MOVED, null, { worktreeDirty: true }), false, 'dirty after the base moved stays held');
  assert.equal(repeatedLandingHoldCleared(hold, NEWHEAD, MOVED, null, { worktreeDirty: true }), false, 'dirty after a new head and base stays held');
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, MOVED, null, { worktreeDirty: false }), true, 'clean lifts the hold');
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, null, { worktreeDirty: false }), true, 'clean at the same base lifts the hold');
  const reason = `${REPEATED_LANDING_HOLD}${JSON.stringify({ ...hold, root: '/tmp/landing-batch' })} the landing worktree has uncommitted changes`;
  assert.equal(repeatedLandingHold(reason).root, '/tmp/landing-batch', 'the hold remembers the worktree it named');
});

test('landing.hold.a-refusal-code-with-no-probe: clause 2: a refusal code with no probe stays held on a moved base or new head alone [C7]', () => {
  const hold = { kind: 'refusal', key: 'LAND_ADOPT', base: BASE, commit: ITEM.item_commit };
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, null), false);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, null, { worktreeDirty: false }), false);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, 'c'.repeat(40), null), false);
  assert.equal(repeatedLandingHoldCleared(hold, { ...ITEM, item_commit: 'd'.repeat(40) }, BASE, null), false);
});

test('landing.hold.a-repeated-named-case-hold-clears: clause 2: a repeated named-case hold clears only when main no longer reproduces that exact case [C7]', () => {
  const hold = { kind: 'case', key: 'test/landing.test.js::clause 2 parks the item', base: BASE, commit: ITEM.item_commit };
  const comparison = failures => ({ main: BASE, files: [{ file: 'test/landing.test.js', result: 'red', failures }] });
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, comparison([{ file: 'test/landing.test.js', name: 'clause 2 parks the item' }])), false);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, comparison([{ file: 'test/landing.test.js', name: 'another case' }])), true);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, { main: BASE, files: [{ file: 'test/landing.test.js', result: 'green' }] }), true);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, BASE, { main: 'c'.repeat(40), unavailable: 'source changed', files: [] }), false);
  const MOVED = 'c'.repeat(40);
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, MOVED, null), false, 'a moved main alone does not lift a case hold');
  assert.equal(repeatedLandingHoldCleared(hold, { ...ITEM, item_commit: 'd'.repeat(40) }, BASE, comparison([{ file: 'test/landing.test.js', name: 'clause 2 parks the item' }])), false, 'a new item commit alone does not lift a case hold');
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, MOVED, { main: MOVED, files: [{ file: 'test/landing.test.js', result: 'red', failures: [{ file: 'test/landing.test.js', name: 'clause 2 parks the item' }] }] }), false, 'main moved and still reproduces the case');
  assert.equal(repeatedLandingHoldCleared(hold, ITEM, MOVED, { main: MOVED, files: [{ file: 'test/landing.test.js', result: 'green' }] }), true, 'main moved and the case now passes');
});

test('landing.hold.the-one-coordinator-notice-names-the: clause 3: the one coordinator notice names the parked item and repeated cause [C7]', () => {
  assert.equal(repeatedLandingNotice(3189, { kind: 'case', detail: 'test/landing.test.js :: repeats' }),
    'Landing parked #3189 after two blocked batches with failing case test/landing.test.js :: repeats; it will rejoin when the cause clears.');
});
