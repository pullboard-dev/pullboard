/** The scratch setting names one root for throwaway folders [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sep } from 'node:path';
import { test } from 'node:test';
import { scratchRoot } from '../../../../packages/config/index.js';
import { runCheckAt } from '../../../../packages/rigor/index.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** A real private folder, removed after the test. */
function folder(t) {
  const { root } = privateFixtureFiles('pullboard-scratch-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('with scratch set, the resolver returns that realpath root [C7]', t => {
  const dir = join(folder(t), 'real');
  mkdirSync(dir);
  const link = join(dir, '..', 'link');
  symlinkSync(dir, link);
  assert.equal(scratchRoot({ scratch: link }, {}), realpathSync(dir));
  assert.equal(scratchRoot({}, { PULLBOARD_SCRATCH: dir }), realpathSync(dir));
  assert.equal(scratchRoot({ scratch: dir }, { PULLBOARD_SCRATCH: '/nonexistent-elsewhere' }), realpathSync(dir));
});

test('a relative or missing scratch root is refused with the fix [C7]', t => {
  const dir = folder(t);
  assert.throws(() => scratchRoot({ scratch: 'relative/dir' }, {}), error => error.code === 'BAD_SCRATCH_ROOT' && /absolute/u.test(error.message) && /pullboard settings scratch/u.test(error.message));
  assert.throws(() => scratchRoot({}, { PULLBOARD_SCRATCH: join(dir, 'missing') }), error => error.code === 'BAD_SCRATCH_ROOT' && /existing folder/u.test(error.message));
});

test('with scratch unset, folders go to os.tmpdir() as before [C7]', () => {
  assert.equal(scratchRoot(undefined, {}), tmpdir());
  assert.equal(scratchRoot({}, { PULLBOARD_SCRATCH: '' }), tmpdir());
});

/** Name a scratch root for this test (PULLBOARD_SCRATCH), restored after it. */
function otherScratch(t) {
  const dir = folder(t);
  const before = process.env.PULLBOARD_SCRATCH;
  process.env.PULLBOARD_SCRATCH = dir;
  t.after(() => {
    if (before === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = before;
  });
  return realpathSync(dir);
}

test('a scratch root on another volume never fails on EXDEV: the rigor proof folder sits under scratch [C7]', async t => {
  const box = await fixture(t);
  const root = box.root;
  const commit = box.git(root, 'rev-parse', 'HEAD').trim();
  const scratch = otherScratch(t);
  const { parseProcessCensus } = await import('../../../../packages/kernel/src/logic/census.js');
  const run = await runCheckAt(root, commit, 'unused', { executable: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] }, { parseProcessCensus });
  assert.equal(run.exit, 0, run.stderr);
  assert.ok(realpathSync(run.stdout).startsWith(`${scratch}${sep}pullboard-rigor-proof-`), `${run.stdout} is under ${scratch}`);
});

test('a scratch root on another volume never fails on EXDEV: the sentinel trunk folder sits under scratch [C7]', async t => {
  const box = await fixture(t);
  const root = box.root;
  const scratch = otherScratch(t);
  const { withSentinelTrunk } = await import('../../../../packages/sentinels/src/io/runner.js');
  let seen;
  await withSentinelTrunk(root, checkout => { seen = realpathSync(checkout); return []; });
  assert.ok(seen.startsWith(`${scratch}${sep}pullboard-sentinel-trunk-`), `${seen} is under ${scratch}`);
  assert.deepEqual(readdirSync(scratch), [], 'the trunk folder is removed afterwards');
});
