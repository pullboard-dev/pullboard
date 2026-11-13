/** The items front door never reaches apps/cli, so loading it before the CLI front door cannot hit a half-built help or view module [C7]. A test file runs in its own process, so these imports are the first load of both graphs. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('clause 2: items then apps/cli front doors both load in a fresh process [C7]', async () => {
  const items = await import('../../../../packages/items/index.js');
  const cli = await import('../../index.js');
  assert.ok(Object.keys(items).length > 0, 'the items front door exports its API');
  assert.ok(Object.keys(cli).length > 0, 'the CLI front door exports its API after items loaded');
});
