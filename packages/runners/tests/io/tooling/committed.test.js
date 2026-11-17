/** @pullboard-test-input packages/runners/src/io/tooling/committed.js packages/runners/src/io/dispatch.js packages/runners/src/io/pull/delegate.js */
/** @pullboard-world-pin: clause 1 reads the real dispatch.js and delegate.js sources to prove they name no app path. */
/** A shared controller export is swept when its last run finishes, and at most 8 are kept [E28,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { startFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { committedRunnerController } from '../../../src/io/tooling/committed.js';
import { runnerControllerEntry } from '../../../src/io/tooling/committed.js';
import { pruneSharedExports } from '../../../src/io/tooling/committed.js';
import { SHARED_KEEP_COUNT } from '../../../src/io/tooling/committed.js';

/** The committed repository this test runs in, whose HEAD holds a controller; TMPDIR points at a private folder. */
function fixture(t) {
  const scratch = privateFixtureFiles('pb-committed-test-');
  const saved = process.env.TMPDIR;
  const temp = join(scratch.root, 'tmp');
  mkdirSync(temp);
  process.env.TMPDIR = temp;
  t.after(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; rmSync(scratch.root, { recursive: true, force: true }); });
  return { repo: resolve(import.meta.dirname, '../../../../..'), temp };
}

test('runners.committed.a-shared-export-is-removed-when: a shared export is removed when its last run finishes [E28,C7]', t => {
  const { repo } = fixture(t);
  const first = committedRunnerController(repo, { shared: true });
  const second = committedRunnerController(repo, { shared: true });
  assert.equal(first.root, second.root);
  first.cleanup();
  assert.ok(existsSync(second.root), 'a run is still using the folder');
  second.cleanup();
  assert.equal(existsSync(second.root), false);
});

test('runners.committed.at-most-8-shared-exports-remain: at most 8 shared exports remain after a sweep, newest kept, in-use never removed [E28,C7]', t => {
  const { repo, temp } = fixture(t);
  const live = committedRunnerController(repo, { shared: true });
  const now = Date.now() / 1000;
  utimesSync(live.root, now - 10_000, now - 10_000);
  for (let i = 0; i < 12; i += 1) {
    const dir = join(temp, `pullboard-committed-runner-${String(i).padStart(32, '0')}`);
    mkdirSync(dir);
    utimesSync(dir, now - 1000 + i, now - 1000 + i);
  }
  pruneSharedExports(null, temp);
  const left = readdirSync(temp).filter(name => name.startsWith('pullboard-committed-runner-'));
  assert.ok(existsSync(live.root), 'the in-use folder stays though oldest');
  assert.equal(left.length, SHARED_KEEP_COUNT + 1);
  assert.ok(left.includes(`pullboard-committed-runner-${String(11).padStart(32, '0')}`), 'newest kept');
  assert.equal(left.includes(`pullboard-committed-runner-${String(0).padStart(32, '0')}`), false, 'oldest swept');
  live.cleanup();
});

test('runners.committed.a-shared-export-another-process-holds: a shared export another process holds survives this process releasing and pruning it [C7]', async t => {
  const { repo, temp } = fixture(t);
  const mine = committedRunnerController(repo, { shared: true });
  // Another live process leases the same export, as its own committedRunnerController call would.
  const other = startFixtureChild('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => other.kill());
  const lease = join(temp, 'pullboard-committed-leases', `${basename(mine.root).slice('pullboard-committed-runner-'.length)}.${other.pid}`);
  writeFileSync(lease, '');
  mine.cleanup();
  assert.ok(existsSync(mine.root), 'releasing here leaves the folder another process runs from');
  utimesSync(mine.root, 1, 1);
  for (let i = 0; i < SHARED_KEEP_COUNT; i += 1) mkdirSync(join(temp, `pullboard-committed-runner-${String(i).padStart(32, '0')}`));
  pruneSharedExports(null, temp);
  assert.ok(existsSync(mine.root), 'a sweep here leaves the folder another process runs from');
  other.kill();
  await once(other, 'exit');
  pruneSharedExports(null, temp);
  assert.equal(existsSync(mine.root), false, 'once that process is gone, its lease no longer keeps the folder');
  assert.equal(existsSync(lease), false, 'the dead process lease is removed on sight');
});

test('runners.committed.dispatch-js-and-delegate-js-name: clause 1: dispatch.js and delegate.js name no apps/ path and take the checkout controller from the tooling file [C7]', () => {
  for (const file of ['../../../src/io/dispatch.js', '../../../src/io/pull/delegate.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /apps\//u, `${file} names no app path`);
    assert.match(source, /runnerControllerEntry\(/u, `${file} asks the tooling file for the controller entry`);
  }
  assert.equal(runnerControllerEntry('/repo'), '/repo/apps/runner/src/io/controller.js');
});
