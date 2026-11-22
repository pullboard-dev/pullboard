/** @pullboard-test-input apps/runner/src/io/private/check/worker.js */
/** The actual worker entry records native import and real shell startup evidence on each committed revision [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../../../packages/gate/tests/fixtures/child.js';
import { gzipSync } from 'node:zlib';
import { privateWorkerFixture } from '../../../../fixtures/private-worker.js';

const ENTRY = new URL('../../../../../src/io/private/check/worker.js', import.meta.url);

test('runner.worker.import-startup: clause 2: actual worker entry reports native closure and real child startup [C7]', t => {
  const box = privateWorkerFixture(t, privateFixtureFiles('pullboard-private-worker-'));
  const result = box.runWorker('echo install-started; while :; do :; done');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.reply.executed, true);
  assert.deepEqual(result.reply.error, { code: 'ETIMEDOUT' });
  assert.equal(result.reply.signal, 'SIGKILL');
  assert.equal(result.reply.logError, null);
  assert.equal(result.reply.output, 'install-started\n');
  assert.equal(result.log, 'install-started\n');
  assert.ok(result.report.modules.includes(ENTRY.href), 'the actual source entry was loaded');
  assert.notEqual(result.report.shellPid, process.pid);
  assert.throws(() => process.kill(result.report.shellPid, 0), { code: 'ESRCH' });
  const sourceSha256 = createHash('sha256').update(readFileSync(ENTRY)).digest('hex');
  t.diagnostic('PULLBOARD_PRIVATE_WORKER_CLOSURE_GZIP ' + gzipSync(JSON.stringify(result.report.modules)).toString('base64'));
  t.diagnostic('PULLBOARD_PRIVATE_WORKER_STARTUP ' + JSON.stringify({ sourceSha256, elapsedMs: result.elapsedMs,
    startupMs: result.report.startupMs, modules: result.report.modules.length }));
});
