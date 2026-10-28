/** A real routing rule record keeps the exhaustive native/relay reader oracle complete [C7,H16]. */
import assert from 'node:assert/strict';

/** Record, repeat and revoke one rule through the genuine coordinator move; the oracle compares both readers after each. */
export async function seedRoutingRules({ board, box, store, exercise }) {
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Routing rule parity', criterion: 'A recorded rule reads identically on both readers' });
  const id = await exercise('setRoutingRule', () => store.setRoutingRule(board, { agentId: 'coordinator', act: 'review', scope: { item },
    effect: 'bar-seat', value: 'parity-barred-seat', source: 32288, note: 'Real private parity routing rule' }));
  assert.ok(Number.isSafeInteger(id), 'the rule must really be recorded, not a refused setup');
  assert.equal(store.routingRules(board).length, 1);
}
