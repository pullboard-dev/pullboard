/** The landing CLI smoke runs in the checkout it is given, and a merged commit whose tree already passed it is not smoked again [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gitSpawnSync } from '../../../../git/index.js';
import { recordSmokeReceipt } from '../../../index.js';
import { runCommitCliSmoke } from '../../../index.js';
import { runLandingCliSmoke } from '../../../index.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };

/**
 * A git launcher that records every command it is asked to run, then runs it.
 *
 * @param {string[][]} calls - Receives each argument list.
 * @returns {typeof gitSpawnSync}
 */
function spy(calls) {
  return (args, options) => { calls.push(args); return gitSpawnSync(args, options); };
}

/**
 * Commit a CLI entry that throws at import, so a real smoke of it is refused and a reused receipt is visible.
 *
 * @param {string} repo
 * @param {string} message
 * @returns {string} The new commit.
 */
function commitBrokenCli(repo, message) {
  mkdirSync(join(repo, 'apps/cli'), { recursive: true });
  writeFileSync(join(repo, 'apps/cli/pullboard.js'), `throw new Error('import cycle ${message}');\n`);
  for (const args of [['add', '-A'], ['commit', '-q', '-m', `feat: ${message}`]]) assert.equal(spawnSync('git', args, { cwd: repo, env: ENV }).status, 0);
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: ENV, encoding: 'utf8' }).stdout.trim();
}

test('clause 1: a batch smoke runs in the existing worktree with no git archive and leaves its git status unchanged [C7]', { timeout: 180_000 }, () => {
  const status = () => spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  const before = status();
  const calls = [];
  const { ran } = runLandingCliSmoke(ROOT, { git: spy(calls) });
  assert.ok(ran.includes('status'), 'the smoke ran every command from the worktree');
  assert.equal(calls.some(args => args.includes('archive')), false, 'no git archive');
  assert.equal(status(), before, 'the worktree git status is unchanged');
});

test('clause 2: a second smoke of a tree whose batch recorded a green receipt reuses it and runs none [C7]', t => {
  const repo = temporaryRepository(t, 'pullboard-smoke-receipt-');
  const first = commitBrokenCli(repo, 'one');
  assert.throws(() => runCommitCliSmoke(repo, first), error => error.code === 'LAND_CLI_SMOKE', 'with no receipt the broken CLI is smoked and refused');
  assert.equal(recordSmokeReceipt(repo), true, 'the batch worktree records its tree id');
  const calls = [];
  assert.deepEqual(runCommitCliSmoke(repo, first, { git: spy(calls) }), { ran: [], reused: true });
  assert.equal(calls.some(args => args.includes('archive')), false, 'no git archive for a receipted tree');
  const second = commitBrokenCli(repo, 'two');
  assert.throws(() => runCommitCliSmoke(repo, second), error => error.code === 'LAND_CLI_SMOKE', 'a different tree id gets no reuse');
});
