/** @pullboard-test-input source-cell apps/view */
/** The needs door exports one name, the same one index.js exports [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const viewDir = fileURLToPath(new URL('..', import.meta.url));
const doorUrl = pathToFileURL(join(viewDir, 'needs.js')).href;

test('clause 1: apps/view/needs.js exports only personNeedsSummary, the same one index.js exports [C7]', async () => {
  const door = await import(doorUrl);
  const index = await import(pathToFileURL(join(viewDir, 'index.js')).href);
  assert.deepEqual(Object.keys(door), ['personNeedsSummary']);
  assert.equal(door.personNeedsSummary, index.personNeedsSummary);
});
