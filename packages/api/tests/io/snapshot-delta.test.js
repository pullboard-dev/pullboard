/** The cached board build's delta and JSON builders, moved out of the line-capped main.js, keep their behaviour [C7,#11876]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as snapshots from '../../src/io/snapshot-delta.js';

const state = items => ({ sequence: 1, milestones: [], items });

test('api.io-snapshot-delta.delta-carries-only-changed-entries: clause 2: a delta between two summaries that differ in one item sets only that item [C7,#11876]', () => {
  const before = state([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]);
  const after = state([{ id: 1, title: 'a' }, { id: 2, title: 'changed' }]);
  const delta = snapshots.stateDelta([snapshots.fingerprint(before)], snapshots.fingerprint(after), after);
  assert.deepEqual(delta.merge.items.set, [{ id: 2, title: 'changed' }]);
  assert.equal(delta.merge.items.key, 'id');
  assert.equal(delta.merge.items.ids, undefined, 'no entry moved, so no key order travels');
  assert.equal(delta.replace.items, undefined);
});

test('api.io-snapshot-delta.serialize-matches-json: clause 3: serializeState over prepared fields parses to the state, dynamic fields included [C7,#11876]', () => {
  const full = { ...state([{ id: 1 }]), unseen: { since: 0, count: 2 }, observedAt: '2026-11-19T00:00:00.000Z', claimOverlaps: {}, proofStats: { landed: 3, flow: { report: { hours: 1 } } } };
  assert.deepEqual(JSON.parse(snapshots.serializeState(full, snapshots.prepareStateJson(full))), full);
  assert.equal(snapshots.serializeState(full, null), JSON.stringify(full));
});
