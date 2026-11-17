/** @pullboard-test-input source-cell resources */
/** The unattributed reader sums the runner time spans that name no item or no kind [C7,#3849]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { recordRunnerTime } from '../../../index.js';
import { unattributedRunnerTime } from '../../../index.js';

test('clause 1: unattributedRunnerTime totals the milliseconds of spans with no item or no kind [C7]', t => {
  const root = temporaryRepository(t, 'pullboard-unattributed-');
  const end = Date.now();
  recordRunnerTime(root, { startedAt: end - 60_000, endedAt: end, host: 'a', item: '1', kind: 'gate' });
  recordRunnerTime(root, { startedAt: end - 30_000, endedAt: end, host: 'a', item: '', kind: 'gate' });
  recordRunnerTime(root, { startedAt: end - 15_000, endedAt: end, host: 'a', item: '2', kind: '' });
  assert.equal(unattributedRunnerTime(root), 45_000);
});

test('clause 1: unattributedRunnerTime is 0 when every span names both item and kind [C7]', t => {
  const root = temporaryRepository(t, 'pullboard-attributed-');
  const end = Date.now();
  assert.equal(unattributedRunnerTime(root), 0);
  recordRunnerTime(root, { startedAt: end - 60_000, endedAt: end, host: 'a', item: '1', kind: 'gate' });
  assert.equal(unattributedRunnerTime(root), 0);
});
