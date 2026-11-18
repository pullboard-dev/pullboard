/** A remote analysis step reads the actual trunk while the policy stays pinned to main, so both trees pack [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trustedRunnerStep } from '../../../../src/io/submit/gate.js';

/** Run one git command in the fixture repository and return its trimmed output. */
function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

/** Commit one file so the three refs (main, source, actual trunk) are distinct real commits. */
function commit(root, name, message) {
  writeFileSync(join(root, name), `${message}\n`);
  git(root, 'add', name);
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

test('cli.io-submit-gate-pack.clause-1-and-clause-2-the-analysis: clause 1 and clause 2: the analysis step reads the actual trunk and pins the policy to main, so both trees pack [C7]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'remote-gate-trunk-'));
  t.after(() => execFileSync('rm', ['-rf', root]));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'pullboard.trunk', 'refs/heads/main');
  const main = commit(root, 'main.txt', 'main base');
  const source = commit(root, 'source.txt', 'source build');
  git(root, 'checkout', '-q', main);
  const trunk = commit(root, 'trunk.txt', 'trunk moved');
  assert.notEqual(trunk, main);
  assert.notEqual(trunk, source);
  const artifactDirectory = join(root, 'artifacts');
  let captured = null;
  const lease = { runner: { host: 'fixture-host', node: 'node' }, executionServices: { runners: { runOnRunnerAsync: async (_root, _shell, options) => {
    captured = options;
    throw new Error('stop after the request is built');
  } } } };
  await assert.rejects(trustedRunnerStep(root, { main, source, stage: 'analysis', entry: 'analysis.js', data: { trunk } }, lease, artifactDirectory),
    /stop after the request is built/u);
  assert.equal(captured.privateCheck.policyCommit, main, 'the policy stays pinned to main');
  assert.equal(captured.privateCheck.trunk.commit, trunk, 'the analysis reads the actual trunk');
  assert.equal(captured.checkedSource.commit, source, 'the checked source is the candidate');
});
