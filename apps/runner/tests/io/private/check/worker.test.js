/** @pullboard-test-input apps/runner/src/io/private/check/worker.js */
/** Real private shells preserve output and deadlines without the unrelated Sandbox startup closure [C7,V18,V2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../../packages/gate/tests/fixtures/child.js';
import { privateWorkerFixture } from '../../../fixtures/private-worker.js';


/** Require a real executed shell timeout, exact captured output and identical durable pipe output. */
function timed(result, output) {
  assert.equal(result.status, 0, result.failure);
  assert.equal(result.reply.executed, true);
  assert.deepEqual(result.reply.error, { code: 'ETIMEDOUT' });
  assert.equal(result.reply.signal, 'SIGKILL');
  assert.equal(result.reply.logError, null);
  assert.equal(result.reply.output, output);
  assert.equal(result.log, output);
  assert.ok(result.report.shellPid > 0);
  assert.notEqual(result.report.shellPid, process.pid);
  assert.throws(() => process.kill(result.report.shellPid, 0), { code: 'ESRCH' });
}

test('runner.worker.unrelated-startup: clause 1: unavailable unrelated Sandbox initialization cannot prevent genuine timeout stdout [C7,V18,V2]', t => {
  const box = privateWorkerFixture(t, privateFixtureFiles('pullboard-private-worker-'));
  const command = 'echo install-started; while :; do :; done';
  timed(box.runWorker(command, { blockFull: true }), 'install-started\n');
});

test('runner.worker.empty-timeout: clause 1: a genuine silent shell timeout retains empty output [C7,V18,V2]', t => {
  const box = privateWorkerFixture(t, privateFixtureFiles('pullboard-private-worker-'));
  timed(box.runWorker('while :; do :; done'), '');
});

test('runner.worker.shell-unavailable: clause 1: an unavailable shell remains an unexecuted ENOENT failure [C7,V18,V2]', t => {
  const box = privateWorkerFixture(t, privateFixtureFiles('pullboard-private-worker-'));
  const result = box.runWorker('echo forbidden-shell-ran', { path: '/nonexistent-private-fixture-path' });
  assert.equal(result.status, 0, result.failure);
  assert.equal(result.reply.executed, false);
  assert.deepEqual(result.reply.error, { code: 'ENOENT' });
  assert.equal(result.reply.output, '');
  assert.equal(result.log, '');
  assert.equal(result.report, null);
});
