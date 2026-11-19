/** Waiting-time policy exercises the native board and shared queue comparator [N2,B3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { QUEUE_FAIRNESS_ENGINE } from '../../../packages/state/light.js';
import { fixtureBoard } from '../../cli/tests/fixtures/board.js';

/** Give all observations a recorded clock and configure only a disposable board. */
function fixture(t) {
  let at = Date.parse('2026-11-01T00:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  store.register(board, { lane: 'coordinator', path: '/private/fairness-coordinator' });
  const seat = store.register(board, { lane: 'web', path: '/private/fairness-seat', route: 'strong' });
  const add = (title, route = 'light', after = []) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title,
      criterion: 'Native ready-item queue remains deterministic.', check: 'true', route: route === 'light' ? 'mid' : route, after, brief: 'Files: web/queue.js\nTest: native ready-item ordering follows the recorded waiting rate.' });
    // Light work needs a capable seat's diagnosis since 7a964958ab [C7].
    if (route === 'light') store.appendFact(board, id, { agentId: seat, kind: 'diagnosis', text: 'Files: web/queue.js Change: preserve the native queue ordering Test case: waiting work ranks at the recorded aging rate' });
    return id;
  };
  const setting = value => store.setLineSetting(board, { agentId: 'coordinator', key: 'agingMinutes', value,
    reason: 'Private queue starvation control', window: { windowMinutes: 600 } });
  const order = () => store.listItems(board).sort(store.buildOrder(board)).map(item => item.item_id);
  return { board, seat, add, setting, order, advance: minutes => { at += minutes * 60_000; } };
}

test('lib.fairness.an-old-low-rank-ready-item-outranks: an old low-rank ready item outranks newly arriving work at the recorded aging rate [N2,B3]', t => {
  const f = fixture(t);
  const old = f.add('Old strong work', 'strong');
  f.advance(600);
  const recent = f.add('New light quick win');
  assert.deepEqual(f.order(), [recent, old], 'off retains the existing computed order');
  f.setting(60);
  const events = store.events(f.board).length;
  assert.deepEqual(f.order(), [old, recent]);
  assert.deepEqual(f.order(), [old, recent], 'equal board state and clock produce exact repeated order');
  assert.equal(store.nextFor(f.board, { agentId: f.seat, lane: 'web' }).item.item_id, old,
    'ordinary native next uses the same fairness order');
  assert.equal(store.events(f.board).length, events, 'ordering is read-only');
  f.setting(10080);
  assert.deepEqual(f.order(), [recent, old], 'the board rate controls when the waiting bonus wins');
  f.setting(false);
  assert.deepEqual(f.order(), [recent, old], 'turning policy off restores the prior comparator');
});

test('lib.fairness.fairness-never-makes-a-dependency-blocked-item: fairness never makes a dependency-blocked item eligible and preserves historical ordering [N2,H16]', t => {
  const f = fixture(t);
  const blocker = f.add('Unfinished prerequisite');
  const blocked = f.add('Old dependent work', 'strong', [blocker]);
  f.advance(600);
  const ready = f.add('New ready work');
  f.setting(1);
  assert.notEqual(f.order()[0], blocked);
  assert.notEqual(store.nextFor(f.board, { agentId: f.seat, lane: 'web' }).item.item_id, blocked);
  f.board.executionEngineVersion = QUEUE_FAIRNESS_ENGINE - 1;
  const historical = f.order();
  f.board.executionEngineVersion = undefined;
  f.setting(false);
  assert.deepEqual(f.order(), historical, 'old moves keep their original queue even beside a future setting');
  assert.ok(historical.includes(ready));
  for (const value of [0, -1, Infinity, 10081, '60']) assert.throws(() => f.setting(value), /LINE_SETTING_RANGE/u);
});
