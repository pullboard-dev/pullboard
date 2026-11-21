/** The clock health document counts items without an owner or deadline, overdue items and per-rule counts, and each clock pass stores it and alarms the coordinator once per such item [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { clockHealth } from '../../../index.js';
import { clockSweep } from '../../../index.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const PORTS = { listItems: store.listItems, events: store.events, getItem: store.getItem, atomic: store.atomic, logEvent: store.logEvent,
  insertShout: store.insertShout, readBoardMeta: store.readBoardMeta, writeBoardMeta: store.writeBoardMeta, coordinator: 'coordinator' };

/** A board at T0 with two ready items; the second is given a status the clock table has no row for. */
function fixtureBoard(t) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(T0) });
  const ready = cellItem(board, { lane: 'core', title: 'Ready and unclaimed' }).item_id;
  const odd = cellItem(board, { lane: 'core', title: 'In a state no row covers' }).item_id;
  const facts = (_board, item) => (item.item_id === odd ? { status: 'frozen' } : {});
  return { board, ready, odd, facts };
}

test('health.io-clock-health.counts-missing-owner-deadline: clause 1: [B4,C7] an open item that matches no clock row counts as without owner and deadline with its id, and overdue, oldestOverdueMinutes and byRule are reported', t => {
  const { board, ready, odd, facts } = fixtureBoard(t);
  const fresh = clockHealth(board, { now: T0 + 10 * MINUTE, ports: PORTS, facts });
  assert.equal(fresh.version, 1);
  assert.equal(fresh.at, new Date(T0 + 10 * MINUTE).toISOString());
  assert.equal(fresh.withoutOwnerDeadline, 1);
  assert.deepEqual(fresh.withoutOwnerDeadlineIds, [odd]);
  assert.equal(fresh.overdue, 0);
  assert.equal(fresh.oldestOverdueMinutes, 0);
  assert.deepEqual(fresh.byRule.ready, { count: 1, nextDeadlineAt: T0 + 60 * MINUTE, move: 'alarm' });
  const late = clockHealth(board, { now: T0 + 90 * MINUTE, ports: PORTS, facts });
  assert.equal(late.overdue, 1, 'the ready item is 30 minutes past its 60 minute deadline');
  assert.equal(late.oldestOverdueMinutes, 30);
  assert.equal(late.byRule.ready.count, 1);
  assert.equal(clockHealth(board, { now: T0, ports: PORTS }).withoutOwnerDeadline, 0, 'with no odd status every item has a row');
  assert.ok(ready !== odd);
});

test('health.io-clock-health.stored-and-alarmed: clause 2: [B4,C7] each clock pass stores the health document in board meta clock.health with the pass time and shouts the coordinator once per item that lacks an owner or deadline', t => {
  const { board, odd, facts } = fixtureBoard(t);
  const shouts = () => store.events(board, { itemId: odd }).filter(event => event.event_kind === 'shout').length;
  const first = clockSweep(board, { now: T0 + 5 * MINUTE, facts, ports: PORTS });
  const stored = JSON.parse(store.readBoardMeta(board.db, 'clock.health'));
  assert.equal(stored.at, new Date(T0 + 5 * MINUTE).toISOString(), 'the stored document carries the pass time');
  assert.deepEqual(stored.withoutOwnerDeadlineIds, [odd]);
  assert.deepEqual(first.health, stored);
  assert.equal(shouts(), 1, 'the coordinator is shouted once for the item');
  clockSweep(board, { now: T0 + 6 * MINUTE, facts, ports: PORTS });
  assert.equal(shouts(), 1, 'a second pass does not shout again for the same item');
  assert.equal(JSON.parse(store.readBoardMeta(board.db, 'clock.health')).at, new Date(T0 + 6 * MINUTE).toISOString(), 'each pass restores the document');
  const dry = clockSweep(board, { now: T0 + 7 * MINUTE, dryRun: true, facts, ports: PORTS });
  assert.equal(dry.health.withoutOwnerDeadline, 1);
  assert.equal(JSON.parse(store.readBoardMeta(board.db, 'clock.health')).at, new Date(T0 + 6 * MINUTE).toISOString(), 'a dry run stores nothing');
});
