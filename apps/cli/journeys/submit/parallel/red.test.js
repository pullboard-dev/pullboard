/** A red criterion or proof refuses a concurrent submit and retains both independent raw receipts [V4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project } from '../../../tests/fixtures/submit/parallel.js';
import { submit } from '../../../tests/fixtures/submit/parallel.js';

for (const role of ['criterion', 'proof']) {
  test(`a red ${role} refuses submit and retains both independent raw receipts [V4,C7]`, async t => {
    const { box } = project(t, 25);
    const { gate } = await submit(t, box, `fail-${role}`);
    assert.equal(gate?.green, false, `the pulled gate ends red: ${JSON.stringify(gate)}`);
    // A pulled gate posts one receipt whose phases are the two commands' own raw results, not one board receipt each.
    const phases = gate?.phases ?? [];
    assert.deepEqual(phases.map(phase => phase.role).toSorted(), ['check', 'proof'], 'the passing sibling also finishes and records its result');
    assert.deepEqual(phases.map(phase => phase.status).toSorted(), [0, 1]);
    assert.equal(new Set(phases.map(phase => phase.sha256)).size, 2);
  });
}
