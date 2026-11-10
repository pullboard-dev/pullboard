/** The handoff dispatcher holds a flat number of resources database connections across passes, locked or not [C7,#3338]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SLOT_DB_LOCK_ENV } from '../../../../../index.js';
import { closeResourceConnections } from '../../../../../index.js';
import { drainHandoffQueue } from '../../../../../index.js';
import { listResources } from '../../../../../index.js';
import { reuseResourceConnections } from '../../../../../index.js';
import { takeResource } from '../../../../../index.js';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';

/** Build a private machine home and put the environment back afterwards. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-dispatcher-connections-'));
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, lock: process.env[SLOT_DB_LOCK_ENV] };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env[SLOT_DB_LOCK_ENV] = '100';
  /** Restore the environment and remove the private tree. */
  const cleanup = () => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], [SLOT_DB_LOCK_ENV, saved.lock]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, file: join(dir, 'home', 'resources.sqlite'), cleanup };
}

/** How many file descriptors of this process point at the resources database itself (not its wal or shm): /proc on Linux, lsof (either install path) elsewhere. */
function openHandles(file) {
  if (existsSync('/proc/self/fd')) return readdirSync('/proc/self/fd').filter(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { return false; } }).length;
  const lsof = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(path => existsSync(path));
  assert.ok(lsof, 'neither /proc nor lsof is available to count open handles');
  const output = execFileSync(lsof, ['-n', '-P', '-F', 'n', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return output.split('\n').filter(line => line === `n${file}`).length;
}

test('clause 1 and clause 2: 200 drain passes leave the open-handle count on the resources database flat and at most 3 [C7,#3338]', async () => {
  const box = fixture();
  try {
    await drainHandoffQueue({ capacity: 4, pollMs: 1 });
    const first = openHandles(box.file);
    for (let pass = 0; pass < 200; pass++) await drainHandoffQueue({ capacity: 4, pollMs: 1 });
    const last = openHandles(box.file);
    assert.equal(last, first, 'handles grew across passes');
    assert.ok(last <= 3, `${last} handles open`);
  } finally { box.cleanup(); }
});

test('clause 2: a pass whose slot call throws SLOT_DB_LOCKED leaves no extra connection behind [C7,#3338]', async () => {
  const box = fixture();
  try {
    await drainHandoffQueue({ capacity: 4, pollMs: 1 });
    const blocker = new DatabaseSync(box.file);
    blocker.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    try {
      await drainHandoffQueue({ capacity: 4, pollMs: 1 });
      const first = openHandles(box.file);
      for (let pass = 0; pass < 15; pass++) await drainHandoffQueue({ capacity: 4, pollMs: 1 });
      assert.equal(openHandles(box.file), first, 'locked passes leaked connections');
    } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  } finally { box.cleanup(); }
});

test('clause 1: takeResource, listResources, renew and release reuse one connection opened once and closed on exit [C7,#3338]', async () => {
  const box = fixture();
  try {
    reuseResourceConnections();
    listResources({ scope: 'machine' });
    assert.equal(openHandles(box.file), 1, 'the first call opens the one connection');
    for (let round = 0; round < 25; round++) {
      const lease = await takeResource({ name: 'reuse-probe', capacity: 1, scope: 'machine', agent: 'reuse' });
      listResources({ scope: 'machine' });
      lease.renew();
      lease.release();
    }
    assert.equal(openHandles(box.file), 1, 'twenty-five rounds of every slot call still use the one connection');
    closeResourceConnections();
    assert.equal(openHandles(box.file), 0, 'closing the process connections releases the handle');
  } finally { closeResourceConnections(); box.cleanup(); }
});
