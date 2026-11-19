/** @pullboard-test-input source-cell packages/kernel */
/** @pullboard-world-pin: clause 1 lists the kernel's logic folder, which is the subject of the claim. */
/** The kernel holds only ids, errors, registries and the plugin shape: the state-file writer lives in the store [C7,CD31]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('kernel.index.the-kernel-no-longer-holds-writefileatomic: #10495 clause 1: the kernel has no atomic.js, and neither its front door nor its light door exports writeFileAtomic [C7,CD31]', async () => {
  assert.equal(readdirSync(fileURLToPath(new URL('../src/logic', import.meta.url))).includes('atomic.js'), false);
  const front = await import('../index.js');
  const light = await import('../light.js');
  assert.equal('writeFileAtomic' in front, false);
  assert.equal('writeFileAtomic' in light, false);
});
