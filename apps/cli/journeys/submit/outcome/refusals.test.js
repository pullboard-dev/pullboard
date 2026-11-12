/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private SSH worker/CLI controls exercise remote failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { test } from 'node:test';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { remote } from '../../../tests/fixtures/submit/outcome.js';
import { source } from '../../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../../tests/fixtures/submit/outcome.js';

describe('remote submit refusals keep file identity and the exact assertion guard [V4,B3,H16]', { concurrency: true }, () => {
  test('ambiguous remote duplicate titles keep missing file identity and cannot submit [V4,B3,H16]', async t => {
    const box = await fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
    await remote(box);
    const result = await cliAsync(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, 'GATE_RED');
    assert.ok(report.failures.length >= 2);
    assert.ok(report.failures.every(row => row.file === null), 'neither title arbitrarily selects the first file');
    assert.ok(report.failures.every(row => row.name === 'shared failure [G1]'));
    assert.equal((await submittedProof(box)), null);
  });


  test('a remote same-title item regression stays red when its assertion differs from main [V4,B3,H16]', async t => {
    const box = await fixture(t, { beforeMain: beforeMain(), candidate: source('shared failure [G1]', 3) });
    await remote(box);
    const result = await cliAsync(box, box.builder, 'submit', String(box.item));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, 'GATE_RED');
    assert.equal(report.failures[0].file, 'test/inherited.test.js');
    assert.equal((await submittedProof(box)), null, 'complete file identity does not relax the exact assertion signature guard');
  });

});
