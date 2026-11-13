/** @pullboard-test-input packages/gate/src/io/test/outcomes.js */
/** Real private SSH worker/CLI controls exercise remote failure identity and exact main matching [V4,B3,H16]. */
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { test } from 'node:test';
import { beforeMain } from '../../../tests/fixtures/submit/outcome.js';
import { cliAsync } from '../../../tests/fixtures/submit/outcome.js';
import { fixture } from '../../../tests/fixtures/submit/outcome.js';
import { remote } from '../../../tests/fixtures/submit/outcome.js';
import { submittedProof } from '../../../tests/fixtures/submit/outcome.js';

describe('remote submits refuse foreign native outcome records [V4,B3,H16]', { concurrency: true }, () => {
  for (const control of [
    { name: 'foreign', corrupt: 'foreign' },
    ]) {
    test(`a real remote submit refuses ${control.name} native outcome records [V4,B3,H16]`, async t => {
      const box = await fixture(t, { beforeMain: beforeMain(control) });
      await remote(box);
      const result = await cliAsync(box, box.builder, 'submit', String(box.item));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
      assert.equal((await submittedProof(box)), null, 'native diagnostics cannot authorize an unbound failure account');
    });
  }
});
