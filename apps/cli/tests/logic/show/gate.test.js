/** show prints no refusal or next step from an infrastructure stop that no longer covers the item's claim or bar (#3325) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  queuedGateLines,
  supersededStop,
} from '../../../src/logic/show/gate.js';

const STOP = { state: 'infrastructure', agentId: 'core-1324', digest: 'old', commit: 'c'.repeat(40), executionCommit: 'c'.repeat(40),
  error: { code: 'GATE_INFRA_EXHAUSTED', message: 'the gate stopped on infrastructure 4 times', next: 'nothing to do as the builder: the coordinator restores the named runner and requeues this gate' } };

/** The lines show prints for `job` on `item`, built as show builds its queued-gate record. */
function lines(job, item) {
  return queuedGateLines({ ...job, ...(supersededStop(job, item) ? { superseded: { agentId: job.agentId } } : {}) }).join('\n');
}

test('clause 1: a stop by another seat, or under an older bar, prints no refusal or next step (#3325) [C7]', () => {
  const cases = [
    ['another seat holds it', { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'old' }],
    ['refrozen under the same seat', { item_status: 'claimed', item_owner: 'core-1324', item_frozen_digest: 'new' }],
    ['open after a refreeze', { item_status: 'open', item_owner: null, item_frozen_digest: 'new' }],
  ];
  for (const [label, item] of cases) {
    const shown = lines(STOP, item);
    assert.doesNotMatch(shown, /GATE_INFRA_EXHAUSTED|next:|nothing to do as the builder/u, label);
    assert.match(shown, /^earlier gate: infrastructure at c{40} for core-1324 .*does not cover this claim$/u, label);
  }
});

test('clause 1: the stop still prints its refusal and next step for the claim and bar it was built for [C7]', () => {
  for (const item of [{ item_status: 'claimed', item_owner: 'core-1324', item_frozen_digest: 'old' },
    { item_status: 'open', item_owner: null, item_frozen_digest: 'old' }]) {
    const shown = lines(STOP, item);
    assert.match(shown, /^queued gate: infrastructure at c{40}\nGATE_INFRA_EXHAUSTED: .*\nnext: nothing to do as the builder/u, item.item_status);
  }
});

test('clause 1: only an infrastructure stop is ever superseded; a red gate keeps its refusal [C7]', () => {
  const red = { ...STOP, state: 'red', error: { code: 'GATE_RED', message: 'red', next: 'fix it' } };
  assert.equal(supersededStop(red, { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'new' }), false);
  assert.match(lines(red, { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'new' }), /GATE_RED: red\nnext: fix it/u);
});
