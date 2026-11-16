/** An empty writer.lock left by a writer killed between create and write never stalls the resource write queue [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { enterResourceQueue } from '../../../src/io/write/queue.js';
import { resourceQueueDirectory } from '../../../src/io/write/queue.js';

/** A private queue folder holding an empty writer.lock last touched ageMs ago, and one queued release behind it. */
function queueWithEmptyLock(t, ageMs) {
  const home = privateFixtureFiles('pullboard-empty-lock-').root;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'resources.sqlite');
  const dir = resourceQueueDirectory(file);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'writer.lock');
  writeFileSync(lock, '');
  const at = new Date(Date.now() - ageMs);
  utimesSync(lock, at, at);
  writeFileSync(join(dir, `${'1'.padStart(24, '0')}-000000-o-${process.pid}-0-0000abcd`), JSON.stringify({ op: 'release', token: 'queued' }));
  return { file, dir };
}

test('clause 1: an empty writer.lock older than the stale window is taken over and the queued writes apply [C7]', t => {
  const { file, dir } = queueWithEmptyLock(t, 60_000);
  const applied = [];
  const leave = enterResourceQueue(file, { apply: entry => applied.push(entry.token), deadlineMs: 2_000 });
  leave();
  assert.deepEqual(applied, ['queued'], 'the write queued behind the empty lock applied');
  assert.deepEqual(readdirSync(dir), [], 'the queue drained and the writer was given up');
});

test('clause 2: an empty writer.lock younger than the stale window still holds the writer [C7]', t => {
  const { file, dir } = queueWithEmptyLock(t, 0);
  const applied = [];
  assert.throws(() => enterResourceQueue(file, { apply: entry => applied.push(entry.token), deadlineMs: 300 }),
    error => error.code === 'SLOT_DB_LOCKED');
  assert.deepEqual(applied, [], 'nothing applied while a just-created lock may still be filled');
  assert.ok(readdirSync(dir).includes('writer.lock'), 'the fresh lock was left in place');
});
