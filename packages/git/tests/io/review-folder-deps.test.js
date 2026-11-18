/** @pullboard-test-input source-cell packages/git */
/** A review folder lists dependencies that resolve outside it [C7,#11068]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { linkedDependencies } from "../../src/io/review-folder-deps.js";

/** A folder and a sibling directory outside it. */
function fixture(t) {
  const dir = privateFixtureFiles('review-deps-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'review');
  const outside = join(dir, 'elsewhere');
  mkdirSync(join(folder, 'node_modules'), { recursive: true });
  mkdirSync(outside);
  return { folder, outside, modules: join(folder, 'node_modules') };
}

test('git.review-folder-deps.outside-links: clause 1: linkedDependencies(folder) returns the name of each node_modules entry whose real path is outside the folder, and an empty list when every entry is inside [C7,#11068]', (t) => {
  const { folder, outside, modules } = fixture(t);
  mkdirSync(join(modules, 'real'));
  writeFileSync(join(modules, 'real', 'index.js'), '');
  assert.deepEqual(linkedDependencies(folder), []);
  symlinkSync(outside, join(modules, 'linked'));
  mkdirSync(join(modules, '@scope'));
  symlinkSync(outside, join(modules, '@scope', 'pkg'));
  mkdirSync(join(modules, '@scope', 'own'));
  assert.deepEqual(linkedDependencies(folder), ['@scope/pkg', 'linked']);
});
