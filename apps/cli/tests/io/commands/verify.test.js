/** @pullboard-test-input source-cell apps/cli */
/** The verify guard refuses a folder whose dependencies link outside it [C7,#1112]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { refuseLinkedDependencies } from '../../../src/io/commands/verify.js';

test('cli.io-commands-verify.deps-outside-tree-refused: refuseLinkedDependencies throws DEPS_OUTSIDE_TREE naming each linked package and returns quietly for an in-tree entry [C7,#1112]', (t) => {
  const dir = privateFixtureFiles('verify-deps-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'review');
  const outside = join(dir, 'elsewhere');
  mkdirSync(join(folder, 'node_modules', 'kept-pkg'), { recursive: true });
  mkdirSync(outside);
  refuseLinkedDependencies(folder);
  symlinkSync(outside, join(folder, 'node_modules', 'left-pad'));
  assert.throws(() => refuseLinkedDependencies(folder), (error) => error.code === 'DEPS_OUTSIDE_TREE' && error.message.includes('left-pad') && !error.message.includes('kept-pkg'));
});
