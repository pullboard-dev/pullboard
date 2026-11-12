/** @pullboard-test-input packages/runners/src/io/tooling/committed.js */
/** A shared controller export is swept when its last run finishes, and at most 8 are kept [E28,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { committedRunnerController } from '../../../src/io/tooling/committed.js';
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

test('a shared export is removed when its last run finishes [E28,C7]', t => {
  const { repo } = fixture(t);
  const first = committedRunnerController(repo, { shared: true });
  const second = committedRunnerController(repo, { shared: true });
  assert.equal(first.root, second.root);
  first.cleanup();
  assert.ok(existsSync(second.root), 'a run is still using the folder');
  second.cleanup();
  assert.equal(existsSync(second.root), false);
});

test('at most 8 shared exports remain after a sweep, newest kept, in-use never removed [E28,C7]', t => {
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
