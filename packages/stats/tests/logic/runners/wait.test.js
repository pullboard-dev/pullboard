/** @pullboard-test-input source-tree */
/** Runner wait rows survive a job whose step history holds hundreds of thousands of rows [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runnerWaits } from '../../../src/logic/runners/wait.js';
import { waitRows } from '../../../src/logic/runners/wait.js';

test('waitRows and runnerWaits take the earliest queue and start of a 200000-step job without a RangeError [C7]', () => {
  const steps = [{ name: 'offered', seq: 0, at: 1_000 }];
  for (let seq = 1; seq <= 200_000; seq += 1) steps.push({ name: 'claimed', seq, at: 5_000 + seq });
  steps.push({ name: 'claimed', seq: 200_001, at: 4_000 });
  const rows = waitRows([{ id: 'land:big', kind: 'land', step: 'done', created: 900, steps }]);
  assert.deepEqual(rows, [{ id: 'land:big', kind: 'land', queuedAt: 1_000, startedAt: 4_000, open: false }]);
  const report = runnerWaits(rows, { from: 0, until: 3_600_000 });
  assert.equal(report.kinds[0].p50Ms, 3_000);
});

test('waitRows queues a job with no queue step at its creation and leaves an unstarted job unstarted [C7]', () => {
  const rows = waitRows([{ id: 'x', kind: 'gate', step: 'queued', created: 700, steps: [] }]);
  assert.deepEqual(rows, [{ id: 'x', kind: 'gate', queuedAt: 700, startedAt: null, open: true }]);
});

test('runner stats logic holds no Math.min or Math.max spread over a step or arrival list [C7]', () => {
  const dir = new URL('../../../src/logic/runners/', import.meta.url);
  for (const file of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(new URL(file, dir), 'utf8'), /Math\.(min|max)\([^)]*\.\.\./, file);
  }
});
