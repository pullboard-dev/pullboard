import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from './fixture-child.js';
import { runFixtureGit } from './fixture-child.js';
import { remoteSubmitCells } from '../apps/cli/src/shell/submit-cells-remote.js';
import { submitCellsRemoteCommand } from '../apps/cli/src/shell/submit-cells-remote.js';
import { submitUntilSettled } from '../apps/lib/src/shell/submit-infra-requeue.js';
import { infrastructureFailure } from '../apps/lib/src/shell/submit-infra-requeue.js';

/**
 * A one-commit repo and a lease whose runner is a stub: it writes `stdout` to the capture, reports `stderr` and a
 * receipt that authenticates exactly those bytes, so only the remote step's own output varies between cases.
 */
function fixture(stdout, stderr, code) {
  const root = privateFixtureFiles('refusal-result-').root;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '--quiet', '-b', 'main'); git('config', 'pullboard.trunk', 'refs/heads/main');
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

test('clause 1: a retryable refusal line from the remote step requeues the same candidate, never RUNNER_RESULT_INVALID [C7]', async () => {
  const line = 'PULLBOARD_TRUSTED_RESULT ' + JSON.stringify({ refusal: { code: 'CELLS_INVENTORY_PENDING', message: 'accepted inventory is warming', retryable: true } }) + '\n';
  const { root, main, lease, item } = fixture(line, '', 0);
  try {
    await assert.rejects(() => remoteSubmitCells(root, main, main, item, lease, () => [], join(root, 'out')), error => {
      assert.equal(error.code, 'CELLS_INVENTORY_PENDING');
      assert.equal(error.retryable, true);
      assert.notEqual(error.code, 'RUNNER_RESULT_INVALID');
      return true;
    });
    const settled = await submitUntilSettled(async attempt => {
      if (attempt === 1) return remoteSubmitCells(root, main, main, item, lease, () => [], join(root, 'out'));
      return 'landed';
    }, { healthy: async () => true, wait: async () => {} });
    assert.equal(settled.result, 'landed');
    assert.equal(settled.attempts[0].code, 'CELLS_INVENTORY_PENDING');
    const refusedLine = 'PULLBOARD_TRUSTED_RESULT ' + JSON.stringify({ refusal: { code: 'CELLS_SUBMIT_RED', message: 'a cell is red', retryable: false } }) + '\n';
    const second = fixture(refusedLine, '', 0);
    try {
      await assert.rejects(() => remoteSubmitCells(second.root, second.main, second.main, second.item, second.lease, () => [], join(second.root, 'out')), error => error.code === 'CELLS_SUBMIT_RED' && infrastructureFailure(error) === null);
    } finally { rmSync(second.root, { recursive: true, force: true }); }
    const command = submitCellsRemoteCommand({ main, source: main, criterion: 'c', cutRows: [] });
    assert.match(command, /PULLBOARD_TRUSTED_RESULT/u);
    assert.match(command, /refusal: \{ code: error\.code/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clause 2: the remote step stderr is kept as stderr.log capped at 64 KiB and named in the refusal message [C7]', async () => {
  const text = 'boom: the runner said this\n' + 'x'.repeat(100 * 1024);
  const { root, main, lease, item } = fixture('', text, 1);
  try {
    await assert.rejects(() => remoteSubmitCells(root, main, main, item, lease, () => [], join(root, 'out')), error => {
      const named = /runner stderr is in (\S+stderr\.log)/u.exec(error.message)?.[1];
      assert.ok(named, error.message);
      assert.ok(existsSync(named));
      const kept = readFileSync(named, 'utf8');
      assert.ok(kept.startsWith('boom: the runner said this'));
      assert.equal(kept.length, 64 * 1024);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
