/** The hand-off drain retries a failed worker-gone sweep on every drain [C7,#3450]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { drainHandoffQueue } from '../../../../../../packages/resources/index.js';
import { handoffDispatcherLog } from '../../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../../packages/resources/index.js';
import { waitForCondition } from '../../../fixtures/runner/holders.js';

/** A real worker that stays running until its release file appears, so the drain it belongs to lasts. */
const WORKER = `const { existsSync } = require('node:fs');
const deadline = Date.now() + 120000;
while (!existsSync(process.env.HANDOFF_TEST_RELEASE) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
`;

/** Build a private machine home and a captured tools tree holding the waiting worker. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-sweep-replaced-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const release = join(dir, 'release');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, release: process.env.HANDOFF_TEST_RELEASE };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HANDOFF_TEST_RELEASE = release;
  /** Let any worker end, put the environment back and remove the private tree. */
  const cleanup = () => {
    writeFileSync(release, '');
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['HANDOFF_TEST_RELEASE', saved.release]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, release, cleanup };
}

/** The dispatcher log text, empty before the first line. */
function dispatcherLog() { return existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : ''; }

test('clause 2: a failed pass is retried on the next drain: a sweep that fails while a worker runs is run again before that drain ends [C7,#3450]', async t => {
  const box = fixture();
  try {
    const directory = join(box.dir, 'jobs', 'job1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
    queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: 'job1' }, await reserveHandoffTicket('job1'));
    let sweeps = 0;
    const sweep = async () => { sweeps++; if (sweeps === 1) throw new Error('sweep exited 1'); };
    const drained = drainHandoffQueue({ capacity: 1, pollMs: 20, sweep, sweepEveryMs: 50 });
    await waitForCondition(() => sweeps >= 2, 'the failed sweep run again while the worker still runs', { signal: t.signal });
    assert.equal(existsSync(box.release), false, 'clause 2: the retry came inside the same busy drain, before its worker ended');
    assert.match(dispatcherLog(), /worker-gone sweep of .* failed: ERROR sweep exited 1; it runs again on a later pass/u, 'clause 2: the failed sweep is logged');
    writeFileSync(box.release, '');
    assert.deepEqual((await drained).started, ['job1']);
  } finally { box.cleanup(); }
});
