import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runnerIdleReply } from '../../src/io/transport.js';
import { parseProcessCensus } from '../../../kernel/index.js';

/** A runner home whose resource queue still lists one gate holder under the given pid. */
function homeWithHolder(pid) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-idle-home-'));
  const db = new DatabaseSync(join(home, 'resources.sqlite'));
  db.exec('CREATE TABLE holder (token TEXT, name TEXT, pid INTEGER, agent TEXT)');
  db.prepare('INSERT INTO holder VALUES (?, ?, ?, ?)').run(randomUUID(), 'gate', pid, `pid-${pid}`);
  db.close();
  return home;
}

/** Ask the idle proof with the machine home pointed at the given folder, restoring the environment after. */
function idleReplyWithHome(home, root) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return runnerIdleReply(root, { nonce: randomUUID() }, parseProcessCensus); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

test('a gate holder whose process is gone does not keep a runner from proving idle, while a live one does [C7]', () => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-idle-root-'));
  mkdirSync(join(root, 'jobs'));
  const exited = spawnSync(process.execPath, ['-e', '0']);
  const deadHome = homeWithHolder(exited.pid);
  const liveHome = homeWithHolder(process.pid);
  try {
    const dead = idleReplyWithHome(deadHome, root);
    assert.equal(dead.idle, true, dead.reason);
    assert.equal(dead.writable, true, dead.reason);
    const live = idleReplyWithHome(liveHome, root);
    assert.equal(live.idle, false);
    assert.equal(live.reason, 'runner resource lease is active');
  } finally {
    for (const folder of [root, deadHome, liveHome]) rmSync(folder, { recursive: true, force: true });
  }
});
