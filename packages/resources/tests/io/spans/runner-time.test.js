/** @pullboard-test-input source-cell resources */
/** Every runner dispatch is recorded in the runner-time sidecar with its host, item, kind and minutes, gate or landing run or none [C7,#8183]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { closeGateSpans } from '../../../index.js';
import { closeLandingSpans } from '../../../index.js';
import { recordRunnerTime } from '../../../index.js';
import { readRunnerTime } from '../../../../jobs/index.js';
import { runnerTimeFolder } from '../../../../jobs/index.js';
import { repoInfo } from '../../../../git/light.js';

/** The sidecar lines of a repository for the last day. */
function lines(root, now) {
  return readRunnerTime(runnerTimeFolder(repoInfo(root).commonDir), { since: now - 86_400_000, now });
}

test('clause 1: a dispatch records its host, item, kind and minutes in the runner-time sidecar [C7]', t => {
  const root = temporaryRepository(t, 'pullboard-runner-time-');
  const end = Date.now(), ninetySeconds = 90_000;
  const line = recordRunnerTime(root, { startedAt: end - ninetySeconds, endedAt: end, host: 'runner-a', item: 4000, kind: 'gate' });
  assert.equal(line.host, 'runner-a');
  assert.equal(line.item, '4000');
  assert.equal(line.kind, 'gate');
    assert.deepEqual(lines(root, end).map(({ host, item, kind, minutes }) => ({ host, item, kind, minutes })), [{ host: 'runner-a', item: '4000', kind: 'gate', minutes: ninetySeconds / 60_000 }]);
});

test('clause 2: a dispatch with no gate or landing run open is still recorded, named or not [C7]', t => {
  closeGateSpans();
  closeLandingSpans();
  const root = temporaryRepository(t, 'pullboard-runner-time-open-');
  const end = Date.now();
  recordRunnerTime(root, { startedAt: end - 60_000, endedAt: end, host: 'runner-b', kind: 'focused', item: '8183' });
  recordRunnerTime(root, { startedAt: end - 30_000, endedAt: end, host: 'runner-b', kind: null, item: null, error: Object.assign(new Error('lost'), { code: 'RUNNER_JOB_LOST' }) });
  const recorded = lines(root, end);
  assert.deepEqual(recorded.map(({ item, kind, minutes, outcome }) => ({ item, kind, minutes, outcome })),
    [{ item: '8183', kind: 'focused', minutes: 1, outcome: 'ok' }, { item: '', kind: '', minutes: 0.5, outcome: 'failed' }]);
});

test('clause 2: a root that is no repository records nothing and never throws [C7]', t => {
  const root = join(temporaryRepository(t, 'pullboard-runner-time-none-'), 'missing', 'elsewhere');
  assert.equal(recordRunnerTime(root, { startedAt: Date.now() - 1000, host: 'h', item: '1', kind: 'k' }), null);
});
