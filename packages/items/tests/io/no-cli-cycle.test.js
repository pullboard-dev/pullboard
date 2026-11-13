/** The items front door loads on its own without reaching apps/cli; the items-then-CLI order is proved by the apps/cli journey [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('clause 2: the items front door loads and exports its API [C7]', async () => {
  const items = await import('../../index.js');
  assert.ok(Object.keys(items).length > 0, 'the items front door exports its API');
});
