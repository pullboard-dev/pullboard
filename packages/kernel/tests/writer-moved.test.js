/** @pullboard-test-input source-cell packages/kernel */
/** @pullboard-world-pin: clause 1 asks whether the kernel's atomic.js file exists, which is the subject of the claim. */
/** The kernel holds only ids, errors, registries and the plugin shape: the state-file writer lives in the store [C7,CD31]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('kernel.writer-moved.the-kernel-no-longer-holds-writefileatomic: #10495 clause 1: the kernel has no atomic.js, and neither its front door nor its light door exports writeFileAtomic [C7,CD31]', async () => {
  assert.equal(existsSync(fileURLToPath(new URL('../src/logic/atomic.js', import.meta.url))), false);
  const front = await import('../index.js');
  const light = await import('../light.js');
  assert.equal('writeFileAtomic' in front, false);
  assert.equal('writeFileAtomic' in light, false);
});
