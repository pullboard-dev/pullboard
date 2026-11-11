/** add --wait returns only after its baseline worker has exited, so no worker write races the next command [V2,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { startCheckBaseline } from '../../../../../index.js';
import { privateFixtureFiles } from '../../../../../../../apps/cli/tests/fixtures/child.js';

const files = privateFixtureFiles('pullboard-baseline-wait-');
after(() => rmSync(files.root, { recursive: true, force: true }));

test('clause 1: a waited baseline settles only once its worker process has exited [V2,H16]', async () => {
  const pending = { result: 'pending', request: randomUUID() };
  const waited = await startCheckBaseline(files.root, 1, pending, { wait: true });
  assert.equal(waited?.exited, true, 'wait returns the worker exit, not the moment it spawned');
  const detached = await startCheckBaseline(files.root, 1, { result: 'pending', request: randomUUID() });
  assert.equal(detached, undefined, 'without wait the worker stays detached and the caller moves on');
  assert.equal(await startCheckBaseline(files.root, 1, { result: 'ready' }, { wait: true }), undefined, 'a settled baseline starts no worker');
});
