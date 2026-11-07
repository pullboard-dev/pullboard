/** The handoff dispatcher holds a flat number of resources database connections across passes, locked or not [C7,#3338]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SLOT_DB_LOCK_ENV, drainHandoffQueue } from '../packages/resources/index.js';
import { temporaryDirectory } from './board-fixture.js';

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

/** How many file descriptors of this process point at the resources database itself (not its wal or shm). */
function openHandles(file) {
  const output = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-F', 'n', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
    blocker.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM resource');
    try {
      await drainHandoffQueue({ capacity: 4, pollMs: 1 });
      const first = openHandles(box.file);
      for (let pass = 0; pass < 15; pass++) await drainHandoffQueue({ capacity: 4, pollMs: 1 });
      assert.equal(openHandles(box.file), first, 'locked passes leaked connections');
    } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  } finally { box.cleanup(); }
});
