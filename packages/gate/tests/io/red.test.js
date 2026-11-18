/** A red submit stage stops its already running runner job and returns its slot promptly [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  watch,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGateStages } from '../../index.js';
import { spawnCaptured } from '../../../sandbox/index.js';

/** Wait until the child process confirms its admitted job has started. */
async function waitForFile(path, directory) {
  const watcher = watch(directory);
  try {
    while (!existsSync(path)) {
      const changed = Promise.race([once(watcher, 'change'), once(watcher, 'rename')]);
      if (existsSync(path)) break;
      await changed;
    }
  } finally { watcher.close(); }
}

test('gate.red.second-red-cancels-first: a second red stage cancels the first running job and frees its slot within a second [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cancel-on-red-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const started = join(directory, 'started');
  let firstSettled;
  const settled = new Promise(resolve => { firstSettled = resolve; });
  const gate = runGateStages([
    { name: 'first', run: async signal => {
      const result = await spawnCaptured(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`], {
        stdio: ['ignore', 'ignore', 'ignore'], signal,
      });
      firstSettled(result);
      return result;
    } },
    { name: 'second', run: async () => {
      await waitForFile(started, directory);
      throw new Error('second stage is red');
    } },
  ]);
  await assert.rejects(gate, /second stage is red/u);
  // budget: the frozen C7 fixture requires the started job to release within one second of the red stage.
  const deadline = AbortSignal.timeout(900);
  const result = await Promise.race([
    settled,
    once(deadline, 'abort').then(() => { throw new Error('the started job did not stop within a second'); }),
  ]);
  assert.equal(result.signal, 'SIGKILL', 'the exact owned job process group was stopped after its grace period');
});
