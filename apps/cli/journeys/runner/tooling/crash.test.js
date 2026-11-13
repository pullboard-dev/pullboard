/** A pinned-tooling crash refuses RUNNER_TOOLING_CRASH once; a signal, timeout or mismatched output stays RUNNER_RESULT_INVALID [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellSandbox } from '../../../../../packages/store/tests/fixtures/cell.js';
import { trustedRunnerStep } from '../../../src/io/submit/gate.js';
import { INFRASTRUCTURE_CODES } from '../../../../../packages/store/src/io/submit/handoff/retry.js';

/** Commit one file so main and source are distinct real commits. */
function commit(sandbox, root, name, message) {
  writeFileSync(join(root, name), `${message}\n`);
  sandbox.git(root, 'add', name);
  sandbox.git(root, 'commit', '-q', '-m', message);
  return sandbox.git(root, 'rev-parse', 'HEAD').trim();
}

const STACK = [
  'file:///tmp/pullboard-trusted-main-Ab12/packages/codemap/src/io/analysis.js:41',
  '  throw new TypeError(\'x is not a function\');',
  '        ^',
  '',
  'TypeError: x is not a function',
  '    at analyse (file:///tmp/pullboard-trusted-main-Ab12/packages/codemap/src/io/analysis.js:41:9)',
  '    at file:///tmp/pullboard-trusted-main-Ab12/packages/codemap/src/io/run.js:7:1',
].join('\n');

/** Run the step against a fake runner whose single phase ends as `end` says; return the refusal it threw. */
async function refusalFor(t, end) {
  const sandbox = cellSandbox(t);
  const root = sandbox.dir;
  sandbox.git(root, 'init', '-q', '-b', 'main');
  sandbox.git(root, 'config', 'pullboard.trunk', 'refs/heads/main');
  const main = commit(sandbox, root, 'main.txt', 'main base');
  const source = commit(sandbox, root, 'source.txt', 'source build');
  const tree = sandbox.git(root, 'rev-parse', `${source}^{tree}`).trim();
  const lease = { runner: { host: 'fixture-host', node: 'node' }, executionServices: { runners: { runOnRunnerAsync: async (_root, _shell, options) => {
    const output = end.output ?? '';
    writeFileSync(options.rawOutputPath, output);
    const bytes = Buffer.from(output);
    return { executionRunner: 'fixture-host', executionSource: { commit: source, tree }, rawOutputPath: options.rawOutputPath, stderr: end.stderr ?? '',
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true, phases: { check: {
        offset: 0, code: end.code ?? 1, signal: end.signal ?? null, timedOut: end.timedOut === true, length: bytes.length,
        sha256: end.sha256 ?? createHash('sha256').update(bytes).digest('hex') } } } } };
  } } } };
  try {
    await trustedRunnerStep(root, { main, source, stage: 'analysis', entry: 'analysis.js', data: { trunk: main } }, lease, join(root, 'artifacts'));
  } catch (error) { return error; }
  assert.fail('the step should have refused');
}

test('crash refuses once, signal stays RUNNER_RESULT_INVALID [C7]', async t => {
  const crash = await refusalFor(t, { code: 1, stderr: STACK });
  assert.equal(crash.code, 'RUNNER_TOOLING_CRASH');
  assert.match(crash.message, /TypeError: x is not a function/u);
  assert.match(crash.message, /packages\/codemap\/src\/io\/analysis\.js:41:9/u);
  assert.equal(INFRASTRUCTURE_CODES.has('RUNNER_TOOLING_CRASH'), false, 'a crash is never retried as infrastructure');
  for (const end of [{ code: null, signal: 'SIGKILL', stderr: STACK }, { code: 1, timedOut: true, stderr: STACK }, { code: 1, stderr: STACK, sha256: 'f'.repeat(64) },
    { code: 1, stderr: 'plain failure' }, { code: 1, stderr: STACK, output: 'PULLBOARD_TRUSTED_RESULT {}\n' }]) {
    const refusal = await refusalFor(t, end);
    assert.equal(refusal.code, 'RUNNER_RESULT_INVALID', JSON.stringify(end));
  }
  assert.equal(INFRASTRUCTURE_CODES.has('RUNNER_RESULT_INVALID'), true);
});
