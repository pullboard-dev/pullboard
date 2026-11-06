/** The handoff dispatcher's lock proves its loop is alive, and an error out of the loop frees it [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoffQueueDirectory, listResources, takeResource } from '../packages/resources/index.js';

/** Run with a private machine home, restoring the environment afterwards. */
async function withHome(action) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-dispatcher-live-')));
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  try { return await action(dir); }
  finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lock holder's heartbeat, read straight from the machine pool. */
function heartbeatOf(name) {
  const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT beat FROM holder WHERE name = ?').get(name).beat; }
  finally { db.close(); }
}

test('clause 1: a loop-driven lock heartbeat moves only when the loop renews it, so a wedged loop goes stale [C7]', () => withHome(async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const lock = await takeResource({ name: 'liveness-probe', capacity: 1, scope: 'machine', agent: 'probe', loopHeartbeat: true });
  try {
    const first = heartbeatOf('liveness-probe');
    mock.timers.tick(10_000); // far longer than the 3 s timer heartbeat
    assert.equal(heartbeatOf('liveness-probe'), first, 'no timer renews a loop-driven lock');
    lock.renew();
    assert.ok(heartbeatOf('liveness-probe') > first, 'the loop renews it');
  } finally { lock.release(); mock.timers.reset(); }
}));

test('clause 2: an error out of the drain loop releases the dispatcher lock and the process exits [C7]', () => withHome(async () => {
  mkdirSync(handoffQueueDirectory(), { recursive: true });
  writeFileSync(join(handoffQueueDirectory(), '0001-broken.json'), '{ not json');
  const entry = fileURLToPath(new URL('../bin/handoff-worker-dispatcher.js', import.meta.url));
  const run = spawnSync(process.execPath, [entry], { env: process.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /HANDOFF_QUEUE_SOURCE|cannot read queued worker/u);
  const held = listResources({ scope: 'machine' }).find(row => row.name === 'submit-handoff-dispatcher');
  assert.ok(!held?.holders?.length, 'the dispatcher lock is free for the next submit to take');
}));
