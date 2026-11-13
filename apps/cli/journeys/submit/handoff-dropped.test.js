/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-world-pin reads submit.js itself to prove it never names the hand-off queue functions [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('clause 1: submit.js never calls enqueueSubmitHandoff, recoverItemSubmitHandoff or replaceSubmitHandoff [P7]', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/io/commands/submit.js'), 'utf8');
  for (const name of ['enqueueSubmitHandoff', 'recoverItemSubmitHandoff', 'replaceSubmitHandoff']) assert.equal(source.includes(name), false, `submit.js still names ${name}`);
});
