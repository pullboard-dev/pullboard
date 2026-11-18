/** A public export projects out private proof-receipt linkage and lease tokens, and keeps a fact's receipt ref [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicSnapshot } from '../../src/logic/public.js';

const ID = '018fc314-57c9-7318-a11f-55a08a28a101';
const receipt = { id: ID, commit: 'a'.repeat(40), tree: 'b'.repeat(40), main: 'c'.repeat(40), submitReusePlan: 'd'.repeat(64), command: 'e'.repeat(64), submitReuse: true };
const publicReceipt = { id: ID, commit: 'a'.repeat(40), tree: 'b'.repeat(40), submitReuse: true };

test('view.x-public.a-submit-reuse-receipt-drops-its-trunk: a submit-reuse receipt drops its trunk, plan and command digests in every history projection [N26]', () => {
  const document = { state: { state: { items: [{ thread: [{ kind: 'proof-run', detail: { receipt } }] }],
    events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt }) }] } },
  events: { events: [{ event_kind: 'proof-run', event_detail: JSON.stringify({ receipt }) }] } };
  const exported = publicSnapshot(document);
  assert.deepEqual(exported.state.state.items[0].thread[0].detail.receipt, publicReceipt);
  assert.deepEqual(JSON.parse(exported.state.state.events[0].event_detail).receipt, publicReceipt);
  assert.deepEqual(JSON.parse(exported.events.events[0].event_detail).receipt, publicReceipt);
});

test('view.x-public.a-fact-keeps-its-ref-to-the: a fact keeps its ref to the receipt id, and a landing lease drops its token [N26]', () => {
  const fact = { id: '018fc314-57c9-7318-a11f-55a08a28a102', kind: 'measurement', text: 'Tier-1 shadow for gate receipt (see ref): green.', ref: { kind: 'proof-run', id: ID }, supersedes: null };
  const document = { state: { state: { items: [{ thread: [{ type: 'fact', kind: 'fact', ...fact }] }],
    events: [{ event_kind: 'fact', event_detail: JSON.stringify(fact) }, { event_kind: 'landing_lease', event_detail: JSON.stringify({ token: ID, state: 'held' }) }] } } };
  const exported = publicSnapshot(document);
  assert.equal(exported.state.state.items[0].thread[0].ref.id, ID);
  assert.equal(JSON.parse(exported.state.state.events[0].event_detail).ref.id, ID);
  assert.deepEqual(JSON.parse(exported.state.state.events[1].event_detail), { state: 'held' });
});

test('view.x-public.native-claim-submit-and-reject-digests-keep: native claim, submit and reject digests keep their exact identity widths [N26]', () => {
  const events = [{ event_kind: 'claim', event_detail: JSON.stringify({ digest: 'a'.repeat(64), policyRefreshed: 'b'.repeat(64) }) },
    { event_kind: 'submit', event_detail: JSON.stringify({ commit: 'a'.repeat(40), tooling: 'c'.repeat(40) }) },
    { event_kind: 'reject', event_detail: JSON.stringify({ commit: 'a'.repeat(40), barKey: 'd'.repeat(64) }) }];
  const document = { events: { events } };
  assert.deepEqual(publicSnapshot(document), document);
  for (const [kind, detail] of [['claim', { policyRefreshed: 'b'.repeat(40) }], ['submit', { tooling: 'c'.repeat(64) }], ['accept', { barKey: 'd'.repeat(64) }]]) {
    assert.throws(() => publicSnapshot({ events: { events: [{ event_kind: kind, event_detail: JSON.stringify(detail) }] } }), error => error.code === 'PUBLIC_EXPORT_BLOCKED', kind);
  }
});

test('view.x-public.the-same-values-anywhere-else-are-still: the same values anywhere else are still refused [N26]', () => {
  for (const forged of [
    { main: 'c'.repeat(40) }, { submitReusePlan: 'd'.repeat(64) }, { command: 'e'.repeat(64) },
    { events: { events: [{ event_kind: 'fact', event_detail: JSON.stringify({ receipt }) }] } },
    { events: { events: [{ event_kind: 'claim', event_detail: JSON.stringify({ ref: { id: ID } }) }] } },
    { events: { events: [{ event_kind: 'claim', event_detail: JSON.stringify({ token: ID }) }] } },
    { ref: { id: ID } },
  ]) assert.throws(() => publicSnapshot(forged), error => error.code === 'PUBLIC_EXPORT_BLOCKED', JSON.stringify(Object.keys(forged)));
});
