/** Shouts with no item group under their sender, never under a shared No item thread [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shoutsModel } from '../../../../src/logic/panel/model.js';

const today = Date.parse('2026-11-13T00:00:00Z');
const shout = (id, from, ms, values = {}) => ({ id, from, to: 'person', at: new Date(ms).toISOString(), ms, text: 'words ' + id, decision: false, answers: null, item: null, ...values });

test('view.x-panel-model-no-item.clause-1-shouts-with-no-item-from: clause 1: shouts with no item from two senders get one thread each, titled with the sender and never No item [N26]', () => {
  const view = shoutsModel({ startOfToday: today, messages: [
    shout(1, 'core-1', today + 1e6), shout(2, 'view-2', today + 2e6), shout(3, 'core-1', today + 3e6),
    shout(4, 'sentinel', today + 4e6, { text: 'waits: 1 over budget' }),
  ] });
  const threads = [...view.needs, ...view.threads];
  assert.deepEqual(threads.map((thread) => thread.title).sort(), ['core-1', 'sentinel', 'view-2'], 'one thread per sender, titled with the sender name');
  assert.equal(threads.find((thread) => thread.title === 'core-1').count, 2, 'both shouts from one sender share its thread');
  assert.ok(threads.every((thread) => thread.chip === null || thread.chip.label !== 'No item'), 'no chip reads No item');
  assert.ok(threads.every((thread) => !/no item/iu.test(thread.title)), 'no thread is titled with No item');
  assert.equal(threads.find((thread) => thread.title === 'sentinel').quiet, true, 'an automated sender stays a muted notice thread');
  // A reply that names no item sits in the thread of the question it answers, not in a thread of its own sender.
  const replied = shoutsModel({ startOfToday: today, messages: [shout(1, 'core-1', today + 1e6), shout(2, 'person', today + 2e6, { answers: 1, to: 'core-1' })] });
  const repliedThreads = [...replied.needs, ...replied.threads];
  assert.deepEqual(repliedThreads.map((thread) => [thread.title, thread.count]), [['core-1', 2]], 'the reply joins its question thread');
});
