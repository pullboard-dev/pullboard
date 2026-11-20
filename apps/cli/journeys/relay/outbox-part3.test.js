import { recordedRelayRefusal } from '../../tests/fixtures/relay/refusal.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberCreatedItems } from '../../../../packages/link/index.js';
import {
  bindRefs,
  resolveMove,
} from '../../../../packages/outbox/index.js';

test('cli.journeys-relay-outbox-part3.a-relay-refusal-after-a-recorded: a relay refusal after a recorded move says it was recorded [C6,N26,H16]', recordedRelayRefusal);

test('cli.journeys-relay-outbox-part3.created-item-bindings-distinguish-repair-outputs: created-item bindings distinguish repair outputs and survive reordered multi-repair results [B26,H16,H17]', () => {
  const publication = { move: { id: 'publication', operation: 'recordPublishFinding' } };
  rememberCreatedItems(publication, { item: 9, repair: 12 });
  const gate = { move: { id: 'gate', operation: 'recordGateRun' } };
  rememberCreatedItems(gate, { quarantined: [{ file: 'test/a.test.js', name: 'a', item: 13 },
    { file: 'test/b.test.js', name: 'b', item: 14 }] });
  const outbox = { moves: [publication, gate], results: {} };
  const move = { operation: 'addItem', args: [{ parentId: 12, after: [13, 14, 9] }] };
  const entry = { move, refs: bindRefs(outbox, move) };
  assert.equal(entry.refs.length, 3, 'the original publication item is not a newly created repair');
  outbox.results.publication = { item: 9, repair: 22 };
  outbox.results.gate = { quarantined: [{ file: 'test/b.test.js', name: 'b', item: 24 },
    { file: 'test/a.test.js', name: 'a', item: 23 }] };
  const resolved = resolveMove(entry, outbox);
  assert.deepEqual(resolved.move.args, [{ parentId: 22, after: [23, 24, 9] }]);
  assert.deepEqual(resolved.lost, []);
  outbox.results.gate.quarantined.shift();
  assert.deepEqual(resolveMove(entry, outbox).lost, [14], 'a missing repair is lost rather than bound to a different array member');
  outbox.results.publication = null;
  assert.deepEqual(resolveMove(entry, outbox).lost, [12, 14], 'a refused creator cannot redirect its dependent move');
  rememberCreatedItems(gate, { quarantined: [{ file: 'test/a.test.js', name: 'a', item: 33 },
    { file: 'test/b.test.js', name: 'b', item: 34 }] });
  rememberCreatedItems(publication, { item: 9, repair: 32 });
  assert.deepEqual(resolveMove(entry, outbox, { local: true }).move.args, [{ parentId: 32, after: [33, 34, 9] }],
    'partial replay uses each newly shown local repair identity');
});

test('cli.journeys-relay-outbox-part3.selector-gap-binds-only-a-newly: selector gap binds only a newly filed repair item [B26,H16]', () => {
  const created = { move: { id: 'gap', operation: 'recordSelectorGap' } };
  rememberCreatedItems(created, { item: 7, filed: true });
  const existing = { move: { id: 'existing', operation: 'recordSelectorGap' } };
  rememberCreatedItems(existing, { item: 9, filed: false });
  assert.deepEqual(existing.created, [], 'an existing repair is not newly created');
  const outbox = { moves: [created, existing], results: { gap: { item: 12, filed: true } } };
  const move = { operation: 'addItem', args: [{ parentId: 7, after: [9] }] };
  const refs = bindRefs(outbox, move);
  assert.equal(refs.length, 1, 'only the newly filed item receives a binding');
  assert.deepEqual(resolveMove({ move, refs }, outbox).move.args, [{ parentId: 12, after: [9] }]);
});
