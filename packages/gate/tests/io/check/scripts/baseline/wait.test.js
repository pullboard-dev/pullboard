/** @pullboard-test-input source-tree packages/gate/src/io/inventory.js packages/gate/src/io/check/baseline/worker.js */
/** @pullboard-world-pin: clause 1 reads the real inventory.js and worker.js sources to prove they name no app path. */
/** add --wait returns only after its baseline worker has exited, so no worker write races the next command [V2,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { startCheckBaseline } from '../../../../../index.js';
import { privateFixtureFiles } from '../../../../fixtures/child.js';

const worker = fileURLToPath(new URL('../../../../../../../apps/lib/src/io/check/baseline.js', import.meta.url));
const files = privateFixtureFiles('pullboard-baseline-wait-');
after(() => rmSync(files.root, { recursive: true, force: true }));

test('gate.io-check-scripts-baseline-wait.a-waited-baseline-settles-only-once: clause 1: a waited baseline settles only once its worker process has exited [V2,H16]', async () => {
  const pending = { result: 'pending', request: randomUUID() };
  const waited = await startCheckBaseline(files.root, 1, pending, { wait: true, worker });
  assert.equal(waited?.exited, true, 'wait returns the worker exit, not the moment it spawned');
  const detached = await startCheckBaseline(files.root, 1, { result: 'pending', request: randomUUID() }, { worker });
  assert.equal(detached, undefined, 'without wait the worker stays detached and the caller moves on');
  assert.equal(await startCheckBaseline(files.root, 1, { result: 'ready' }, { wait: true, worker }), undefined, 'a settled baseline starts no worker');
});

test('gate.io-check-scripts-baseline-wait.inventory-js-and-the-baseline-worker: clause 1: inventory.js and the baseline worker name no apps/ path; the app passes the worker in [C7]', async () => {
  for (const file of ['../../../../../src/io/inventory.js', '../../../../../src/io/check/baseline/worker.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /apps\//u, `${file} names no app path`);
  }
  await assert.rejects(startCheckBaseline(files.root, 1, { result: 'pending', request: randomUUID() }), TypeError, 'a caller that passes no worker is refused');
});
