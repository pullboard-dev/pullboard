/** The inbox marks spool carries interrupt delivery records and one drain writes them with the marks [C7,#10878]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { activityDeliveryState } from '../../index.js';
import { recordActivityDelivery } from '../../index.js';
import { drainInboxMarks } from '../../src/io/inbox-marks.js';
import { spoolInboxMarks } from '../../src/io/inbox-marks.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixture } from '../fixtures/dispatch.js';

/** A private folder holding one board file path; the spool lives beside it. */
const folder = () => join(privateFixtureFiles('pullboard-marks-').root, 'board.sqlite');

/** Ports that record every call in order. */
function ports(calls, { delivery = true } = {}) {
  return { enqueue: (agent, mark) => calls.push(['mark', agent, mark]), flush: () => { calls.push(['flush']); return 2; },
    ...(delivery ? { recordDelivery: (agent, value) => calls.push(['delivery', agent, value]) } : {}) };
}

const FIRST = { interrupts: [], through: 3, observedThrough: 4 };
const SECOND = { interrupts: [], through: 7, observedThrough: 7, digestThrough: 6 };

test('store.inbox-marks.drain-delivery: clause 1: one drain writes every mark in one flush and records each delivery line in spool order with its exact object [C7,#10878]', t => {
  const board = folder();
  spoolInboxMarks(board, [['alpha', 5], { agent: 'alpha', delivery: FIRST }, ['beta', 9], { agent: 'beta', delivery: SECOND }]);
  const calls = [];
  assert.equal(drainInboxMarks(board, ports(calls)), 2);
  assert.deepEqual(calls.filter(call => call[0] === 'mark'), [['mark', 'alpha', 5], ['mark', 'beta', 9]]);
  assert.equal(calls.filter(call => call[0] === 'flush').length, 1, 'one flush');
  assert.deepEqual(calls.filter(call => call[0] === 'delivery'), [['delivery', 'alpha', FIRST], ['delivery', 'beta', SECOND]]);
  assert.deepEqual(readdirSync(join(board, '..')), [], 'the spool is consumed');
});

test('store.inbox-marks.delivery-replay: clause 2: replaying a drained delivery line leaves the recorded cursor unchanged, a mark-only spool drains as before, and no port keeps delivery lines [C7,#10878]', t => {
  const box = fixture(t);
  const agentId = box.seats.actor.id;
  const through = box.board.db.prepare('SELECT MAX(event_id) AS id FROM event').get().id;
  const delivery = { interrupts: [], through, observedThrough: through, digestThrough: through };
  recordActivityDelivery(box.board, { agentId, ...delivery });
  const recorded = activityDeliveryState(box.board, agentId);
  const file = folder();
  spoolInboxMarks(file, [{ agent: agentId, delivery }]);
  drainInboxMarks(file, { enqueue() {}, flush: () => 0, recordDelivery: (agent, value) => recordActivityDelivery(box.board, { agentId: agent, ...value }) });
  assert.deepEqual(activityDeliveryState(box.board, agentId), recorded, 'the replayed line changed no cursor');

  const marks = [];
  spoolInboxMarks(file, [['alpha', 4]]);
  assert.equal(drainInboxMarks(file, { enqueue: (agent, mark) => marks.push([agent, mark]), flush: () => 1 }), 1);
  assert.deepEqual(marks, [['alpha', 4]]);

  spoolInboxMarks(file, [{ agent: 'alpha', delivery: FIRST }]);
  drainInboxMarks(file, ports([], { delivery: false }));
  assert.ok(readdirSync(join(file, '..')).some(name => name.includes('.work-')), 'the delivery line stays in its work file');
  const calls = [];
  drainInboxMarks(file, ports(calls));
  assert.deepEqual(calls.filter(call => call[0] === 'delivery'), [['delivery', 'alpha', FIRST]]);
  assert.equal(existsSync(join(file, '..', 'pullboard-inbox-marks.jsonl')), false);
});
