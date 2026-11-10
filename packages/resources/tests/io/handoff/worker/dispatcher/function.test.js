/** @pullboard-test-input source-tree */
/** The dispatcher joins existing capacity with a capacity function, and says why it died [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HANDOFF_WORKER_RESOURCE } from '../../../../../index.js';
import { drainHandoffQueue } from '../../../../../index.js';
import { handoffDispatcherLog } from '../../../../../index.js';
import { handoffQueueDirectory } from '../../../../../index.js';
import { listResources } from '../../../../../index.js';
import { queueHandoffLaunch } from '../../../../../index.js';
import { reserveHandoffTicket } from '../../../../../index.js';
import { takeResource } from '../../../../../index.js';

const DISPATCHER = fileURLToPath(new URL('../../../../../../../apps/lib/src/io/handoff/dispatcher.js', import.meta.url));

/** A worker that records its own result at once, so the drain ends without a timed hold. */
const WORKER = `const { writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
writeFileSync(join(dirname(process.argv[2]), 'result.json'), '{}');
`;

/** A private machine home and one job directory with a captured tools tree. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-dispatcher-capacity-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const directory = join(dir, 'jobs', 'job1');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  /** Restore the environment and remove the private tree. */
  const cleanup = () => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, directory, cleanup };
}

/** The machine capacity of the handoff worker resource, or undefined before anything took it. */
function workerCapacity() { return listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_WORKER_RESOURCE)?.capacity; }

/** Queue the fixture's one job. */
async function queueJob(box) {
  queueHandoffLaunch({ directory: box.directory, tools: box.tools, commonDir: box.dir, job: 'job1' }, await reserveHandoffTicket('job1'));
}

test('clause 1: a function capacity drives the drain, takes the worker resource at a positive integer and joins a larger existing capacity [C7]', async () => {
  const box = fixture();
  try {
    await queueJob(box);
    const { started } = await drainHandoffQueue({ capacity: () => 3 });
    assert.deepEqual(started, ['job1'], 'the ticket launches');
    assert.equal(workerCapacity(), 3, 'the worker resource was taken at the function value');
    assert.ok(Number.isInteger(workerCapacity()) && workerCapacity() > 0);
    rmSync(join(box.dir, 'home'), { recursive: true, force: true });
    const big = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 5, scope: 'machine', agent: 'seed' });
    big.release();
    assert.equal(workerCapacity(), 5, 'a machine row of 5 exists');
    await queueJob(box);
    assert.deepEqual((await drainHandoffQueue({ capacity: () => 3 })).started, ['job1']);
    assert.equal(workerCapacity(), 5, 'the larger existing capacity wins');
  } finally { box.cleanup(); }
});

test('clause 2: a dispatcher whose first pass throws logs the code, message and capacity, and exits non-zero [C7]', async () => {
  const box = fixture();
  try {
    await queueJob(box);
    // An unreadable ticket makes the first pass refuse HANDOFF_QUEUE_SOURCE after the worker resource is taken.
    const ticket = readdirSyncTickets();
    writeFileSync(join(handoffQueueDirectory(), ticket), '{ not json');
    const run = spawnSync(process.execPath, [DISPATCHER], { env: { ...process.env, PULLBOARD_MACHINE_HOME: process.env.PULLBOARD_MACHINE_HOME }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, 'the dispatcher exits non-zero');
    const log = readFileSync(handoffDispatcherLog(), 'utf8');
    assert.match(log, /HANDOFF_QUEUE_SOURCE/u, 'the refusal code is logged');
    assert.match(log, /cannot read queued worker/u, 'the message is logged');
    assert.match(log, /capacity \d+/u, 'the computed capacity value is logged');
  } finally { box.cleanup(); }
});

/** The name of the one queued launch ticket. */
function readdirSyncTickets() {
  const names = readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.json$/u.test(name));
  assert.equal(names.length, 1);
  return names[0];
}
