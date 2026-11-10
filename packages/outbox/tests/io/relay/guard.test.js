/** Same-process asynchronous callers share a real SQLite guard without sharing authority [H21,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  hostname,
  tmpdir,
} from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { withFileLock } from '../../../src/io/relay/guard.js';

/** A deterministic asynchronous handoff, without a sleep deciding which caller owns the guard. */
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** A private real SQLite guard whose directory outlives all its callers. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-outbox-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'guard.sqlite');
}

test('unrelated asynchronous callers cannot enter the same outbox guard together [H21,H16]', async t => {
  t.diagnostic(JSON.stringify({ node: process.version, host: hostname(), execPath: process.execPath,
    binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const file = fixture(t);
  const entered = barrier();
  const release = barrier();
  const order = [];
  const first = withFileLock(file, async () => {
    order.push('first entered');
    entered.release();
    await release.promise;
    order.push('first finished');
  });
  await entered.promise;
  const second = withFileLock(file, () => { order.push('second entered'); });
  try {
    await setImmediate();
    assert.deepEqual(order, ['first entered'], 'a different asynchronous caller must wait even in the same process');
  } finally {
    release.release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(order, ['first entered', 'first finished', 'second entered']);
});

test('a guard permits genuine nested work, independent files and reuse after a thrown operation [H21,H16]', async t => {
  const file = fixture(t);
  const other = join(file, '..', 'other.sqlite');
  const failure = new Error('fixture operation failed');
  const order = [];
  await assert.rejects(withFileLock(file, async () => {
    order.push('outer');
    await withFileLock(file, () => { order.push('nested'); });
    await withFileLock(other, () => { order.push('other file'); });
    throw failure;
  }), error => error === failure);
  await withFileLock(file, () => { order.push('next owner'); });
  assert.deepEqual(order, ['outer', 'nested', 'other file', 'next owner']);
});

test('a detached descendant cannot reuse an expired guard context while another caller owns it [H21,H16]', async t => {
  const file = fixture(t);
  const startChild = barrier();
  const releaseOwner = barrier();
  let descendant;
  let entered = false;
  await withFileLock(file, () => {
    descendant = (async () => {
      await startChild.promise;
      return withFileLock(file, () => { entered = true; });
    })();
  });
  const nextOwner = withFileLock(file, async () => {
    startChild.release();
    await releaseOwner.promise;
  });
  try {
    await setImmediate();
    assert.equal(entered, false, 'an expired parent does not make its detached child the current owner');
  } finally {
    releaseOwner.release();
    await Promise.all([nextOwner, descendant]);
  }
  assert.equal(entered, true, 'the detached caller enters after the current owner releases the guard');
});
