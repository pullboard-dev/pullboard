/** requireApplier lets a person channel run only the one call for a row whose pending same-channel decision is an approve [C7,#9627,#10679]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireApplier } from '../../../../src/io/commands/spec/apply-row.js';

/** A person-channel call with one pending decision recorded on the same channel, of the given kind. */
function call(decision) {
  return {
    isMain: true, me: 'person', coordinator: 'coordinator', channel: 'view', values: { row: 'G1', commit: true },
    decisions: [{ id: 'G1', kind: 'spec', decision, event: 7, applied: false }],
    events: [{ event_id: 7, event_detail: JSON.stringify({ channel: 'view' }) }],
  };
}

test('cli.io-commands-spec-apply-row.decline-refused: clause 1: a pending same-channel decline is refused COORDINATOR_ONLY [C7,#10679]', () => {
  assert.throws(() => requireApplier(call('decline')), { code: 'COORDINATOR_ONLY' });
});

test('cli.io-commands-spec-apply-row.approve-applies: clause 2: a pending same-channel approve still applies [C7,#10679]', () => {
  assert.doesNotThrow(() => requireApplier(call('approve')));
});
