/** The installed post-commit hook has no rule to run, so `pullboard hook post-commit` answers 0 before any module loads [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const BIN = fileURLToPath(new URL('../../pullboard.js', import.meta.url));

test('clause 2: pullboard hook post-commit exits 0 with empty stdout and stderr, even outside a repo [C7]', () => {
  const files = privateFixtureFiles('post-commit-thin-');
  files.write('.keep', '');
  const env = { PATH: process.env.PATH, HOME: files.root, PULLBOARD_HOME: `${files.root}/home`, PULLBOARD_MACHINE_HOME: `${files.root}/machine` };
  const result = runFixtureChild(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: files.root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
