/** An empty inbox prints exactly one line [C7,#8520,#1886]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('clause 2: an empty inbox prints exactly one line [C7,#8520]', async () => {
  const box = e2e.project();
  for (const cwd of [box.repo, box.web]) {
    const read = await box.runLocal(cwd, 'inbox');
    assert.equal(read.code, 0, read.err + read.out);
    const lines = read.out.split('\n').filter(line => line.trim());
    assert.deepEqual(lines, ['no new shouts or activity'], 'one line, nothing else');
  }
});
