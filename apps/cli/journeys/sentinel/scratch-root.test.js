/** The scratch setting names one root for throwaway folders [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scratchRoot } from '../../../../packages/config/index.js';
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
