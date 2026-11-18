/** @pullboard-test-input source-cell store */
/** deliverHealthNotices logs a resolved finding without shouting it from HEALTH_QUIET_ENGINE [A6,H16,#1479]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverHealthNotices } from '../../../src/logic/board/receipts.js';
import { HEALTH_QUIET_ENGINE } from '../../../../state/light.js';

const finding = (key) => ({ key, cause: 'STUCK_BUILD', item: 7, subject: '#7', title: 'sits', since: '2026-11-18T00:00:00Z', why: 'no commit', owner: 'core-1', next: 'ask the builder' });

/** Run one delivery with one resolved and one new finding, recording every shout and log. */
function deliver(engine) {
  const shouts = [];
  const logs = [];
  deliverHealthNotices({ resolved: [finding('old')], added: [finding('new')], engine, coordinator: 'coordinator',
    targets: () => ['coordinator'], shout: (to, text) => shouts.push([to, text]), log: (found, cleared) => logs.push([found.key, cleared]) });
  return { shouts, logs };
}

test('store.logic-board-receipts.clause-1-resolved-is-logged-not-shouted: clause 1: from HEALTH_QUIET_ENGINE deliverHealthNotices logs every resolved finding and shouts none of them [A6,H16,#1479]', () => {
  const { shouts, logs } = deliver(HEALTH_QUIET_ENGINE);
  assert.deepEqual(logs, [['old', true], ['new', false]], 'the resolved finding is still recorded');
  assert.equal(shouts.filter(([, text]) => text.startsWith('Resolved')).length, 0, 'no resolved notice is shouted');
  assert.equal(shouts.filter(([, text]) => text.startsWith('Stuck')).length, 1, 'a new finding still shouts');
});

test('store.logic-board-receipts.clause-2-older-engine-still-shouts-resolved: clause 2: below HEALTH_QUIET_ENGINE the same call still shouts each resolved finding as before [A6,H16,#1479]', () => {
  const { shouts, logs } = deliver(HEALTH_QUIET_ENGINE - 1);
  assert.deepEqual(logs, [['old', true], ['new', false]]);
  assert.deepEqual(shouts.map(([, text]) => text.split(':')[0]), ['Resolved', 'Stuck']);
});
