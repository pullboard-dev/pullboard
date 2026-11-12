import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from './child.js';
import { runFixtureChild } from './child.js';
import { runFixtureGit } from './child.js';

/**
 * A one-commit repo and a lease whose runner is a stub: it writes `stdout` to the capture, reports `stderr` and a
 * receipt that authenticates exactly those bytes, so only the remote step's own output varies between cases.
 */
export function fixture(stdout, stderr, code) {
  const root = privateFixtureFiles('refusal-result-').root;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  const init = runFixtureChild('git', ['init', '--quiet', '-b', 'main'], { cwd: root, env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.failure);
  git('config', 'pullboard.trunk', 'refs/heads/main');
  writeFileSync(join(root, 'a.txt'), 'x\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'one');
  const main = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const bytes = Buffer.from(stdout);
  const lease = { runner: { host: 'stub' }, executionServices: { runners: { runOnRunnerAsync: async (_root, _shell, options) => {
    writeFileSync(options.rawOutputPath, bytes);
    return { executionRunner: 'stub', executionSource: { commit: main, tree }, rawOutputPath: options.rawOutputPath, stderr,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, code, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } } } } };
  } } } };
  return { root, main, lease, item: { item_frozen: JSON.stringify({ criterion: 'c' }), item_title: 't' } };
}
