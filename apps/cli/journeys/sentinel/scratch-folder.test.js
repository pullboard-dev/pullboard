/** scratchFolder and moveAcross: one scratch root, EXDEV-safe moves [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  moveAcross,
  scratchFolder,
} from '../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** A real private folder, removed after the test. */
function folder(t) {
  const { root } = privateFixtureFiles('pullboard-scratch-folder-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('scratchFolder creates under the scratch root when set [C7]', t => {
  const root = folder(t);
  const made = scratchFolder('pb-', { scratch: root }, {});
  assert.equal(dirname(made), realpathSync(root));
  assert.ok(existsSync(made));
});

test('scratchFolder uses os.tmpdir() when unset [C7]', t => {
  const made = scratchFolder('pb-', {}, {});
  t.after(() => rmSync(made, { recursive: true, force: true }));
  assert.equal(dirname(made), tmpdir());
});

test('a scratch root on another volume never fails on EXDEV [C7]', t => {
  const root = folder(t);
  const from = join(root, 'src');
  mkdirSync(from);
  writeFileSync(join(from, 'a.txt'), 'hi');
  const to = join(root, 'dst');
  const rename = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  moveAcross(from, to, { rename });
  assert.equal(readFileSync(join(to, 'a.txt'), 'utf8'), 'hi');
  assert.equal(existsSync(from), false);
  assert.throws(() => moveAcross(from, to, { rename: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), { code: 'ENOENT' });
});
