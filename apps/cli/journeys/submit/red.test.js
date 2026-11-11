/** A recorded open Main red repair owns a red submit when exact-main comparison is unavailable [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cli,
  fixture,
  submittedProof,
} from '../../tests/fixtures/submit/red.js';

test('clause 1 and clause 2: a red submit names its open Main red repair when exact-main comparison has no named test [C7,V4]', async t => {
  const box = fixture(t, {
    check: 'node test/runner.js test/inherited.test.js',
    affectedTests: 'false',
    waitMainRedBaseline: true,
  });
  const accepted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const report = JSON.parse(accepted.stdout);
  assert.equal(report.gate.green, false, 'the inherited case remains visibly red in the submission proof');
  assert.deepEqual(report.gate.knownMainReworks, [
    { file: 'test/inherited.test.js', name: 'shared failure [G1]', item: box.rework },
  ]);
  const event = submittedProof(box);
  const known = event.submissionProof.knownMainFailures;
  assert.equal(known.main, box.main);
  assert.deepEqual(known.failures.map(({ file, name, item }) => ({ file, name, item })), [
    { file: 'test/inherited.test.js', name: 'shared failure [G1]', item: box.rework },
  ]);
});
