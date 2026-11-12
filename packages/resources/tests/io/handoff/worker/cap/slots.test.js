/** With runnersOnly the handoff worker cap is every runner slot, and a running dispatcher picks up a raised cap [C7,#3061]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  drainHandoffQueue,
  handoffWorkerCapacity,
  queueHandoffLaunch,
  reserveHandoffTicket,
} from '../../../../../index.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** A real worker logs its start, then holds its slot until the release marker exists. */
const WORKER = `const { appendFileSync, existsSync, watch } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const directory = dirname(process.argv[2]), id = basename(directory);
const release = join(dirname(dirname(directory)), 'release');
let ended = false;
const watcher = watch(dirname(release), finish);
function finish() {
  if (ended || !existsSync(release)) return;
  ended = true; watcher.close();
  appendFileSync(process.env.HANDOFF_TEST_LOG, 'end ' + id + '\\n');
}
appendFileSync(process.env.HANDOFF_TEST_LOG, 'start ' + id + '\\n');
finish();
`;

/** Build a private machine home, a captured tools tree and one queued ticket per job; returns the box and its cleanup. */
async function fixture(t, count) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-slots-')));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, log: process.env.HANDOFF_TEST_LOG };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HANDOFF_TEST_LOG = log;
  t.after(() => {
    writeFileSync(join(dir, 'release'), 'go');
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['HANDOFF_TEST_LOG', saved.log]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (let index = 0; index < count; index++) {
    const job = `job${index}`;
    const directory = join(dir, 'jobs', job);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job }) + '\n');
    queueHandoffLaunch({ directory, tools, commonDir: dir, job }, await reserveHandoffTicket(job));
  }
  return { dir, log };
}

/** How many workers have started so far, read from the real workers' shared log. */
function startedCount(log) { return readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('start ')).length; }

test('with runnersOnly the worker cap follows the runner slots up to the machine bound: 9 for one runner of 9, 16 for 7 of them [C7,#3061]', () => {
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 9, runnersOnly: true }), 9);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 63, runnersOnly: true }), 16, 'each worker holds a process pair on this machine for its gate, so the fleet never raises it past the bound');
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 63 }), 12, 'without runnersOnly one per five slots still applies');
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 4, runnerSlots: 0, runnersOnly: true }), 4, 'no runners leaves the local cap');
  assert.equal(handoffWorkerCapacity({ env: { PULLBOARD_HANDOFF_WORKERS: '5' }, cores: 10, runnerSlots: 63, runnersOnly: true }), 5, 'the override still wins');
});

test('a running dispatcher picks up a raised capacity without a restart [C7,#3061]', async t => {
  const box = await fixture(t, 3);
  let capacity = 1;
  const draining = drainHandoffQueue({ capacity: () => capacity, pollMs: 50 });
  const failEarly = draining.then(() => { throw new Error('dispatcher finished before its workers were released'); });
  await Promise.race([waitForCondition(() => startedCount(box.log) === 1, 'the first worker fills the cap of 1', { signal: t.signal }), failEarly]);
  assert.equal(startedCount(box.log), 1, 'a cap of 1 holds the other two tickets');
  capacity = 3;
  await Promise.race([waitForCondition(() => startedCount(box.log) === 3, 'the raised cap starts the waiting tickets', { signal: t.signal }), failEarly]);
  writeFileSync(join(box.dir, 'release'), 'go');
  const { started } = await draining;
  assert.deepEqual(started, ['job0', 'job1', 'job2'], 'the same dispatcher started all three in submit order');
});
