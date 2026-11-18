/** Queue mode reads the source pack from the job folder after source.pack.ready, and ends on a lost transport [C7,#5467]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../cli/tests/fixtures/child.js';
import { QUEUE_JOB_ENV } from '../../../src/io/worker/queue.js';
import { queueJobFolder } from '../../../src/io/worker/queue.js';
import { receiveQueuedPack } from '../../../src/io/worker/queue.js';

/** A private job folder removed when the case ends. */
function folder(t) {
  const dir = privateFixtureFiles('pb-queue-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('runner.queue.without-the-queue-folder-the-worker-keeps: without the queue folder the worker keeps the stdin path, and a relative folder is refused [C7,#5467]', async t => {
  assert.equal(queueJobFolder({}), null);
  assert.equal(await receiveQueuedPack({ transportLost: false }, join(folder(t), 'pack'), { env: {} }), false);
  assert.throws(() => queueJobFolder({ [QUEUE_JOB_ENV]: 'relative/job' }), /queue job folder is invalid/u);
});

test('runner.queue.the-pack-is-copied-only-after-source: the pack is copied only after source.pack.ready appears, however late [C7,#5467]', async t => {
  const dir = folder(t);
  const pack = join(dir, 'worker.pack');
  writeFileSync(join(dir, 'source.pack'), 'pack-bytes');
  let waits = 0;
  const wait = async () => {
    waits += 1;
    assert.equal(existsSync(pack), false, 'nothing is read before the ready marker');
    if (waits === 3) writeFileSync(join(dir, 'source.pack.ready'), '');
  };
  assert.equal(await receiveQueuedPack({ transportLost: false }, pack, { env: { [QUEUE_JOB_ENV]: dir }, wait }), true);
  assert.equal(waits, 3, 'the worker waited until the marker existed');
  assert.equal(readFileSync(pack, 'utf8'), 'pack-bytes');
});

test('runner.queue.a-lost-transport-cancel-or-an-expired: a lost transport (cancel or an expired wanted file) ends the wait for the pack [C7,#5467]', async t => {
  const dir = folder(t);
  const S = { transportLost: false };
  const wait = async () => { S.transportLost = true; };
  await assert.rejects(receiveQueuedPack(S, join(dir, 'worker.pack'), { env: { [QUEUE_JOB_ENV]: dir }, wait }), /runner transport was lost/u);
  assert.equal(existsSync(join(dir, 'worker.pack')), false);
});

test('runner.queue.a-pack-that-never-arrives-or-a: a pack that never arrives, or a vanished job folder, ends the wait with a named refusal that frees the pin [C7,#5624]', async t => {
  const dir = folder(t);
  const env = { [QUEUE_JOB_ENV]: dir };
  let clock = 0;
  const wait = async ms => { clock += ms; };
  await assert.rejects(
    receiveQueuedPack({ transportLost: false }, join(dir, 'worker.pack'), { env, wait, now: () => clock, limitMs: 1000 }),
    error => error.code === 'SOURCE_PACK_TIMEOUT' && /pin is released/u.test(error.message));
  rmSync(dir, { recursive: true, force: true });
  await assert.rejects(
    receiveQueuedPack({ transportLost: false }, join(dir, 'worker.pack'), { env, wait, now: () => clock }),
    error => error.code === 'SOURCE_PACK_ORPHANED');
});
