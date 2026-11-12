/** The post-commit hook is installed with the other hooks and reported when it does not delegate to pullboard [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  installHooks,
  unwiredHookProblems,
} from '../../../../packages/commits/index.js';
import { temporaryRepository } from '../../tests/fixtures/board/submit.js';

test('post-commit is installed with the other hooks and reported when it stops delegating to pullboard [C7]', (t) => {
  const root = temporaryRepository(t, 'pullboard-post-commit-');
  installHooks(root);
  const file = join(root, '.githooks/post-commit');
  assert.ok(existsSync(file), 'installHooks writes .githooks/post-commit');
  assert.equal(statSync(file).mode & 0o777, 0o755);
  assert.match(readFileSync(file, 'utf8'), /hook post-commit/u);
  assert.deepEqual(unwiredHookProblems(root), []);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  const problems = unwiredHookProblems(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /\.githooks\/post-commit/u);
});
