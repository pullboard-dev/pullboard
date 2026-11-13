/** A pull runner prunes old test results and dead job environment folders by age and a disk floor, keeping live jobs [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { pruneRunnerStores } from '../../../../packages/drive/index.js';

const HOUR = 3_600_000, MIB = 1024 ** 2, GIB = 1024 ** 3;

/** A folder holding one file of the given size, both stamped as last changed `hours` ago. */
function seed(path, hours, now, mib = 1) {
  mkdirSync(path, { recursive: true });
  const file = join(path, 'data');
  writeFileSync(file, Buffer.alloc(mib * MIB, 1));
  const at = new Date(now - hours * HOUR);
  utimesSync(file, at, at); utimesSync(path, at, at);
}

/** A runner root with a pull cache under it, removed when the test ends. */
function runner(t) {
  const root = privateFixtureFiles('pullboard-prune-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cache: join(root, 'pull'), now: Date.now() };
}

test('clause 1: results older than 24 h and dead pull env folders are removed, young ones and live job folders kept [P7]', t => {
  const { root, cache, now } = runner(t);
  const oldResult = join(root, 'test-results', 'repo', 'inputs', 'old'), newResult = join(root, 'test-results', 'repo', 'green', 'new');
  const deadEnv = join(cache, 'env', 'gate-dead-1'), liveEnv = join(cache, 'env', 'gate-live-1'), freshEnv = join(cache, 'env', 'gate-fresh-1');
  seed(oldResult, 30, now); seed(newResult, 2, now);
  seed(deadEnv, 30, now); seed(liveEnv, 30, now); seed(freshEnv, 1, now);
  const done = pruneRunnerStores({ root, cache, live: new Set(['gate-live-1']), now, floorBytes: 0 });
  assert.equal(existsSync(oldResult), false, 'the old result is gone');
  assert.equal(existsSync(deadEnv), false, 'the dead env folder is gone');
  assert.equal(existsSync(newResult), true, 'the young result stays');
  assert.equal(existsSync(freshEnv), true, 'a recent env folder stays');
  assert.equal(existsSync(liveEnv), true, 'the live job folder stays however old');
  assert.equal(done.removed.length, 2);
});

test('clause 1: below the disk floor the oldest young folders go first until free space is above it, and live folders stay [P7]', t => {
  const { root, cache, now } = runner(t);
  const oldest = join(root, 'test-results', 'repo', 'green', 'a'), middle = join(cache, 'env', 'gate-b-1'), newest = join(root, 'test-results', 'repo', 'inputs', 'c');
  const live = join(cache, 'env', 'gate-live-1');
  seed(oldest, 5, now, 4); seed(middle, 3, now, 4); seed(newest, 1, now, 4); seed(live, 9, now, 4);
  // Simulated space: 2 GiB free against a 2 GiB + 6 MiB floor, so about two 4 MiB folders must go.
  const done = pruneRunnerStores({ root, cache, live: new Set(['gate-live-1']), now, floorBytes: 2 * GIB + 6 * MIB, space: () => ({ freeBytes: 2 * GIB, totalBytes: 100 * GIB }) });
  assert.equal(existsSync(oldest), false, 'the oldest goes first');
  assert.equal(existsSync(middle), false, 'the next oldest goes while still short');
  assert.equal(existsSync(newest), true, 'removal stops once free space clears the floor');
  assert.equal(existsSync(live), true, 'the live job folder is never removed for space');
  assert.ok(done.freeBytes >= 2 * GIB + 6 * MIB, 'free space ends above the floor');
});
