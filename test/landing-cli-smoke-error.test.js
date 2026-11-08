/** The landing smoke names the tool and the error when it cannot read a commit [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { runCommitCliSmoke } from '../packages/landing/index.js';
import { temporaryDirectory } from './board-fixture.js';
import { temporaryRepository } from './board-submit-fixture.js';

/** Commit a trivial CLI entry so the smoke tries to extract the tree. */
function commitCli(repo) {
  mkdirSync(join(repo, 'bin'));
  writeFileSync(join(repo, 'bin', 'pullboard.js'), '// entry\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  for (const args of [['add', '-A'], ['commit', '-q', '-m', 'feat: add cli']]) assert.equal(spawnSync('git', args, { cwd: repo, env }).status, 0);
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
}

test('clause 1: a failed archive read names the failing tool and its error [C7]', t => {
  const repo = temporaryRepository(t, 'pullboard-smoke-error-');
  const commit = commitCli(repo);
  const stubs = temporaryDirectory('pullboard-smoke-tar-');
  t.after(() => rmSync(stubs, { recursive: true, force: true }));
  writeFileSync(join(stubs, 'tar'), '#!/bin/sh\necho "tar: stub cannot unpack" >&2\nexit 2\n');
  chmodSync(join(stubs, 'tar'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${stubs}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });
  assert.throws(() => runCommitCliSmoke(repo, commit), error => error.code === 'LAND_CLI_SMOKE' && /tar failed: tar: stub cannot unpack/u.test(error.message));
});
