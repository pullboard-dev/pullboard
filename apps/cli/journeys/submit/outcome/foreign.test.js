/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private pulled-gate controls exercise failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { test } from 'node:test';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { pulledSubmit } from '../../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../../tests/fixtures/submit/outcome.js';

describe('pulled submits refuse foreign native outcome records [V4,B3,H16]', { concurrency: true }, () => {
  for (const control of [
    { name: 'foreign', corrupt: 'foreign' },
    ]) {
    test(`a pulled submit refuses ${control.name} native outcome records [V4,B3,H16]`, async t => {
      const box = await fixture(t, { beforeMain: beforeMain(control) });
      const { gate } = await pulledSubmit(t, box);
      assert.equal(gate.green, false, 'the pulled gate receipt is red');
      assert.equal((await submittedProof(box)), null, 'native diagnostics cannot authorize an unbound failure account');
    });
  }
});
