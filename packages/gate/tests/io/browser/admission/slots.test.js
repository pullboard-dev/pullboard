/** Gate-slot and red-gate lease cases split from resources.test.js: a waiter retries a locked slot database, a red gate releases its lease [Q4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redGateReleaseSource } from '../../../fixtures/execution.js';
import { awaitNestedRun } from '../../../../src/io/test/file/pool.js';
import { runFixtureChild as spawnSync } from '../../../fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_RUNNER } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { waitForMarker } from '../../../fixtures/admission/pool.js';
import { startNodeChild } from '../../../fixtures/admission/pool.js';
import { runNodeChildAsync } from '../../../fixtures/admission/pool.js';

test('gate.io-browser-admission-resources.q4-a-red-gate-releases-its: [Q4] a red gate releases its lease before the same process starts another gate', async () => {
  const box = fixture();
  const command = join(box.dir, 'red-then-green.cjs');
  const counter = join(box.dir, 'gate-count');
  const eventsFile = join(box.dir, 'gate-runs.log');
  writeFileSync(command, [
    "const fs = require('node:fs');",
    'const [counter, events] = process.argv.slice(2);',
    'const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0);',
    'fs.writeFileSync(counter, String(count + 1));',
    "fs.appendFileSync(events, 'start\\nend\\n');",
    'process.exit(count === 0 ? 7 : 0);',
  ].join('\n'));
  const gateCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(command)} ${JSON.stringify(counter)} ${JSON.stringify(eventsFile)}`;
  const worker = redGateReleaseSource();
  const child = startNodeChild(['--input-type=module', '-e', worker, gateCommand], {
    cwd: box.first, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the red gate kept its lease and blocked the same process')), 5_000); }), // budget: hang ceiling for the same process to reacquire its released gate slot.
    ]);
    assert.equal(result.code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { firstGreen: false, secondGreen: true });
    assert.deepEqual(readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/u), ['start', 'end', 'start', 'end']);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
});

/** A write lock on the slot database delays a queued run; only a lock past the deadline stops it, as never ran [C7]. */
test('gate.io-browser-admission-resources.a-gate-slot-waiter-retries-a: a gate-slot waiter retries a locked slot database [C7]', async () => {
  const box = fixture();
  mkdirSync(box.home, { recursive: true });
  const released = join(box.dir, 'lock-released');
  // The waiter's test passes only if the lock was already released when it ran.
  writeFileSync(join(box.first, 'ran.test.js'), `import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('the waiter ran', () => assert.ok(existsSync(${JSON.stringify(released)})));\n`);
  // The runner refuses a repository with no commit (NO_POLICY), so commit the waiter's test file first.
  for (const args of [['add', 'ran.test.js'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture']]) {
    const committed = spawnSync('git', args, { cwd: box.first, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.failure);
  }
  const env = { ...box.env, PULLBOARD_SLOT_DB_LOCK_MS: '6000' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete env[key];
  /** Hold a write lock on the machine slot database from another process for `ms`; wrapped so awaiting it waits only for the lock. */
  const holdLock = async (ms) => {
    const marker = join(box.dir, `locked-${ms}`);
    const locker = runNodeChildAsync(['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync } from 'node:fs';
      const [file, marker, ms, released] = process.argv.slice(1);
      const db = new DatabaseSync(file);
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS lock_probe (x)');
      writeFileSync(marker, 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
      db.exec('COMMIT');
      writeFileSync(released, 'released');`, join(box.home, 'resources.sqlite'), marker, String(ms), released], { env });
    await waitForMarker(marker);
    return { done: locker, pid: locker.child.pid, stop: () => locker.child.kill('SIGKILL') };
  };
  /** Run one named test file through the real runner, which waits for a machine gate slot. */
  const runWaiter = () => awaitNestedRun(runNodeChildAsync([TEST_RUNNER, 'ran.test.js'], { cwd: box.first, env }));

  const shortLock = await holdLock(3_000);
  const kept = await runWaiter();
  assert.equal((await shortLock.done).status, 0, 'the 3 s lock was taken and released');
  assert.equal(kept.status, 0, `${kept.context}\n${kept.stdout}`);
  assert.match(kept.stdout, /ok \d+ - the waiter ran/u);
  assert.match(kept.stdout, /^# fail 0$/mu);

  rmSync(released);
  const longLock = await holdLock(60_000);
  try {
    const stopped = await runWaiter();
    assert.equal(stopped.status, 75, stopped.context);
    assert.match(stopped.stderr, /never ran/u);
    assert.match(stopped.stderr, /not a test failure/u);
    assert.match(stopped.stderr, new RegExp(`pid ${longLock.pid}\\b`, 'u'), 'names the process holding the lock');
    assert.doesNotMatch(stopped.stdout, /the waiter ran/u);
  } finally { longLock.stop(); await longLock.done; }
});
