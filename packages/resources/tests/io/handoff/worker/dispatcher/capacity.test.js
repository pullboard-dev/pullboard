/** A dispatcher adopts existing worker capacity and preserves the single machine dispatcher [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  HANDOFF_WORKER_RESOURCE,
  drainHandoffQueue,
  handoffQueueDirectory,
  listResources,
  queueHandoffLaunch,
  reserveHandoffTicket,
  takeResource,
} from '../../../../../index.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

const fixtures = [];
after(() => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });

/** Create isolated queue storage and captured worker tooling for a dispatcher run. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-dispatcher-capacity-')));
  fixtures.push(dir);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const savedReady = process.env.HANDOFF_TEST_READY;
  const savedRelease = process.env.HANDOFF_TEST_RELEASE;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  delete process.env.HANDOFF_TEST_READY;
  delete process.env.HANDOFF_TEST_RELEASE;
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), [
    "const { appendFileSync, existsSync, watch } = require('node:fs');",
    "const { dirname, join } = require('node:path');",
    'const ready = process.env.HANDOFF_TEST_READY, release = process.env.HANDOFF_TEST_RELEASE;',
    "if (ready) appendFileSync(ready, 'started\\n');",
    'if (release) {',
    '  const done = () => { if (existsSync(release)) { watcher.close(); process.exit(0); } };',
    '  const watcher = watch(dirname(release), done); done();',
    '}',
    '',
  ].join('\n'));
  const restore = () => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    if (savedReady === undefined) delete process.env.HANDOFF_TEST_READY; else process.env.HANDOFF_TEST_READY = savedReady;
    if (savedRelease === undefined) delete process.env.HANDOFF_TEST_RELEASE; else process.env.HANDOFF_TEST_RELEASE = savedRelease;
  };
  return { dir, tools, restore };
}

/** Queue one worker while preserving the native ticket and launch format. */
async function queueWorker(box, job) {
  const directory = join(box.dir, 'jobs', job);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job }) + '\n');
  const ticket = await reserveHandoffTicket(job);
  queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job }, ticket);
  return directory;
}

test('clause 1: capacity 16 is retained when automatic capacity is 11 and the dispatcher drains queued work [C7]', async () => {
  const box = fixture();
  let holder;
  try {
    holder = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 16, scope: 'machine', agent: 'existing-worker' });
    const directory = await queueWorker(box, 'job-1');
    writeFileSync(join(box.dir, 'release'), 'go');
    assert.deepEqual((await drainHandoffQueue({ capacity: 11, pollMs: 10 })).started, ['job-1']);
    const resource = listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_WORKER_RESOURCE);
    assert.equal(resource.capacity, 16, 'dispatcher keeps the existing worker capacity');
    assert.ok(resource.holders.some(row => row.agent === 'existing-worker'), 'the existing holder retains its lease');
    assert.equal(readFileSync(join(directory, 'request.json'), 'utf8'), '{"job":"job-1"}\n');
    assert.deepEqual(listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_DISPATCHER_RESOURCE)?.holders, []);
    assert.deepEqual(readdirSync(handoffQueueDirectory()).filter(name => name.endsWith('.json')), []);
  } finally { holder?.release(); box.restore(); }
});

test('clause 2: concurrent starts keep one dispatcher and do not lower capacity under live holders [C7]', async t => {
  const box = fixture();
  let holder;
  try {
    holder = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 16, scope: 'machine', agent: 'existing-worker' });
    const ready = join(box.dir, 'ready');
    const release = join(box.dir, 'release');
    process.env.HANDOFF_TEST_READY = ready;
    process.env.HANDOFF_TEST_RELEASE = release;
    await queueWorker(box, 'job-2');
    const draining = drainHandoffQueue({ capacity: 11, pollMs: 10 });
    await waitForCondition(() => existsSync(ready) && readFileSync(ready, 'utf8').includes('started'), 'the first dispatcher starts its worker', { signal: t.signal });
    assert.deepEqual((await drainHandoffQueue({ capacity: 11, pollMs: 10 })).started, [], 'the concurrent dispatcher defers to the live dispatcher');
    const resource = listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_WORKER_RESOURCE);
    assert.equal(resource.capacity, 16, 'a concurrent start preserves the configured capacity');
    assert.ok(resource.holders.length >= 2, 'the existing and dispatched workers both retain leases');
    writeFileSync(release, 'go');
    assert.deepEqual((await draining).started, ['job-2']);
    assert.equal(listResources({ scope: 'machine' }).find(row => row.name === HANDOFF_DISPATCHER_RESOURCE)?.holders.length ?? 0, 0);
  } finally { holder?.release(); box.restore(); }
});
