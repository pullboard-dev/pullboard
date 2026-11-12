/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private SSH worker/CLI controls exercise remote failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe } from 'node:test';
import { test } from 'node:test';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { beforeMain } from '../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../tests/fixtures/submit/outcome.js';
import { readProfile } from '../../tests/fixtures/submit/outcome.js';
import { remote } from '../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../tests/fixtures/submit/outcome.js';
import { SUITE_TIMING_PREFIX } from '../../../../packages/gate/index.js';
import { timingAccountingStages } from '../../../../packages/gate/index.js';
import { testOutputSummary } from '../../../../packages/gate/index.js';
import { accountedFailures } from '../../../../packages/landing/index.js';

describe('a real remote submit retains the failing source file and exact main failure receipt [V4,B3,H16]', { concurrency: true }, () => {
  test('a real remote submit retains the failing source file and exact main failure receipt [V4,B3,H16]', async t => {
    const box = await fixture(t, { beforeMain: beforeMain({ phases: true }), check: 'node test/check-runner.js' });
    const requests = await remote(box);
    const result = await cliAsync(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout), gate = report.gate;
    assert.equal(gate.green, false, 'the inherited assertion remains red');
    assert.equal(gate.knownMainFailures.main, box.main);
    assert.deepEqual(gate.knownMainFailures.failures.map(({ file, name }) => ({ file, name })),
      [{ file: 'test/inherited.test.js', name: 'shared failure [G1]' }]);
    const phase = readProfile(gate.proofProfilePath), combined = readProfile(gate.profilePath);
    assert.equal(phase.executionRunner, HOST);
    assert.equal(phase.executionSource.commit, box.head);
    const check = readProfile(gate.check.profilePath);
    assert.equal(check.executionRunner, HOST);
    assert.equal(check.executionSource.commit, box.head);
    assert.deepEqual(combined.testOutcomes.map(({ file, name, passed }) => ({ file, name, passed })), [
      { file: 'test/check-only.test.js', name: 'criterion only pass [G1]', passed: true },
      { file: 'test/shared-pass.test.js', name: 'shared phase pass [G1]', passed: true },
      { file: 'test/inherited.test.js', name: 'shared failure [G1]', passed: false },
    ], 'both phases survive and repeated identical source cases stay unique');
    const summary = testOutputSummary(gate.log, { root: box.builder, profile: combined });
    assert.equal(summary.failures[0].file, 'test/inherited.test.js');
    assert.equal(summary.failures[0].name, 'shared failure [G1]');
    assert.deepEqual((await submittedProof(box)).submissionProof.knownMainFailures, gate.knownMainFailures);
    const raw = readFileSync(gate.proofLog, 'utf8');
    const timingLine = raw.split('\n').find(line => line.startsWith(SUITE_TIMING_PREFIX));
    assert.ok(timingLine, 'the real private controller published its own suite timing');
    const timing = JSON.parse(timingLine.slice(SUITE_TIMING_PREFIX.length));
    const unbound = raw.split('\n').filter(line => !line.startsWith(SUITE_TIMING_PREFIX)).join('\n');
    const stages = timingAccountingStages([{ status: 1, pipeline: [
      { status: 1, output: raw }, { status: 1, output: unbound },
    ] }], timing.id, { head: timing.head, tree: timing.tree });
    assert.equal(stages[0].pipeline[0].testOutcomeRunId, timing.id);
    assert.equal(stages[0].pipeline[1].testOutcomeRunId, null, 'a sibling cannot lend its source-bound producer');
    assert.equal(accountedFailures({ isGreen: false, stages }, box.builder), null);
    const launched = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(launched.some(row => row.workerStarted), 'the real private worker executed');
  });

});
