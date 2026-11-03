/** Every landing runs the candidate's help, init, add, list, show, claim, next and status on a scratch board before main moves [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runCommitCliSmoke, runLandingCliSmoke } from '../packages/landing/index.js';

const ROOT = resolve(import.meta.dirname, '..');

/** A candidate tree whose CLI entry throws on import, committed in a throwaway repository. */
function brokenCandidate(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-smoke-candidate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'pullboard.js'), "throw new Error('import cycle in the command catalog');\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'feat: broken help']]) {
    assert.equal(spawnSync('git', args, { cwd: dir, env }).status, 0);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  return { dir, commit };
}

test('a healthy candidate passes help, init, add, list, show, claim, next and status on a scratch board [C7]', () => {
  const { ran } = runLandingCliSmoke(ROOT);
  for (const command of ['help', 'init', 'add', 'list', 'show', 'claim', 'next', 'status']) assert.ok(ran.includes(command), `${command} ran and exited 0`);
});

test('a candidate whose help throws at import is refused, naming the failing command [C7]', t => {
  const { dir } = brokenCandidate(t);
  assert.throws(() => runLandingCliSmoke(dir), error => error.code === 'LAND_CLI_SMOKE' && /pullboard help/u.test(error.message) && /import cycle/u.test(error.message));
});

test('a hand landing smokes the recorded commit the same way, from a tree it extracts itself [C7]', t => {
  const { dir, commit } = brokenCandidate(t);
  assert.throws(() => runCommitCliSmoke(dir, commit), error => error.code === 'LAND_CLI_SMOKE' && /pullboard help/u.test(error.message));
});

test('a candidate that ships no CLI entry has nothing to smoke [C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-smoke-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(runLandingCliSmoke(dir), { ran: [] });
});
