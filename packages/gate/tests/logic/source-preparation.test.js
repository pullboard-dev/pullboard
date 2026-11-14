/** A runner's source-cache maintenance stays inside the measured receipt, so a finished run is never voided for it [C7,#7538]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourcePreparationFields } from '../../light.js';

/** One complete worker observation whose git rows are the given operations. */
function observation(operations) {
  return { version: 1, packBytes: 1024, totalMs: 900,
    stages: { cacheWaitMs: 1, inventoryMs: 2, transferMs: 3, validateMs: 4, materializeMs: 5 },
    git: Object.fromEntries(operations.map(name => [name, { calls: 1, ms: 7 }])), reusedCommit: null };
}

test('a receipt timing the cache repack and commit-graph write is accepted [C7]', () => {
  const fields = sourcePreparationFields(observation(['fetch', 'repack', 'commit-graph', 'merge-base']));
  assert.ok(fields, 'the maintenance rows the worker records past eight cache packs are valid source measurements');
  assert.deepEqual(fields.git.repack, { calls: 1, ms: 7 });
  assert.deepEqual(fields.git['commit-graph'], { calls: 1, ms: 7 });
});

test('a git row outside the known operations still voids the measurement [C7]', () => {
  assert.equal(sourcePreparationFields(observation(['fetch', 'gc'])), null);
  assert.equal(sourcePreparationFields(observation(['--upload-pack=x'])), null);
});
