/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private pulled-gate controls exercise failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { test } from 'node:test';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { pulledSubmit } from '../../../tests/fixtures/submit/outcome.js';
import { source } from '../../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../../tests/fixtures/submit/outcome.js';

describe('pulled submit refusals keep file identity and the exact assertion guard [V4,B3,H16]', { concurrency: true }, () => {
  test('ambiguous pulled duplicate titles keep each file identity and cannot submit [V4,B3,H16]', async t => {
    const box = await fixture(t, { beforeMain: beforeMain({ duplicate: true }) });
    const { gate, failures } = await pulledSubmit(t, box);
    assert.equal(gate.green, false, 'the pulled gate receipt is red');
    assert.ok(failures.length >= 2);
    assert.deepEqual(failures.map(row => row.file).sort(), ['test/inherited.test.js', 'test/second.test.js'], 'each shared title keeps its own file; neither arbitrarily selects the first file');
    assert.ok(failures.every(row => row.name === 'shared failure [G1]'));
    assert.equal((await submittedProof(box)), null);
  });


  test('a pulled same-title item regression stays red when its assertion differs from main [V4,B3,H16]', async t => {
    const box = await fixture(t, { beforeMain: beforeMain(), candidate: source('shared failure [G1]', 3) });
    const { gate, failures } = await pulledSubmit(t, box);
    assert.equal(gate.green, false, 'the pulled gate receipt is red');
    assert.equal(failures[0].file, 'test/inherited.test.js');
    assert.equal((await submittedProof(box)), null, 'complete file identity does not relax the exact assertion signature guard');
  });

});
