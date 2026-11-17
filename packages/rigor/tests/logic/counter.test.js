/** Every history prefix retains the legacy repeat and exact person-decline semantics [D1,N19,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceRigorCounter } from '../../index.js';
import { rigorCounterEligible } from '../../index.js';
import { rigorCounterKeys } from '../../index.js';
import { rigorCounterResult } from '../../index.js';
import { sortRigorCounters } from '../../index.js';
import { undraftedRigor } from '../../index.js';
import { rigorSource } from '../../../store/index.js';
import { automaticRigorSource } from '../../../store/index.js';
import { HEALTH_SENTINEL_ENGINE } from '../../../store/index.js';
import { BOARD_SENTINEL_ENGINE } from '../../../state/light.js';
import { NATIVE_FLAKE_ENGINE } from '../../../state/light.js';

/** Produce a real typed row source; an ordinary prose note must never suppress a repeat. */
function source(key) {
  const cause = { key, items: [], occurrences: 0, neverAgain: false };
  const proof = { check: 'test -f fixed', red: { commit: 'a'.repeat(40), exit: 1 }, green: { commit: 'b'.repeat(40), exit: 0 } };
  return `- G9 [draft, must] A proved rule | source: ${rigorSource(cause, proof)}`;
}

/** A board-generated unproved proposal is also a typed person-decline source after #1138. */
function automaticSource(key) {
  const cause = { key, items: [{ id: 6, commits: ['a'.repeat(40)] }, { id: 7, commits: ['b'.repeat(40)] }],
    occurrences: 2, neverAgain: false };
  return `- G10 [draft, must] A proposal Source: ${automaticRigorSource(cause, [1, 2])}`;
}

/** Build events in their durable append order, with deliberate old and null-item cases. */
function history() {
  const rows = [];
  /** Preserve exact native event fields used by both the independent oracle and new fold. */
  const add = (kind, item, detail, by = 'tests-1') => rows.push({ event_id: rows.length + 1,
    event_at: new Date(Date.UTC(2026, 0, 1) + rows.length * 1000).toISOString(),
    event_kind: kind, event_by: by, item_id: item, event_detail: JSON.stringify(detail) });
  add('reject', 1, { cause: 'row:G1', commit: 'a'.repeat(40) });
  add('reopen', 1, { cause: 'row:G1', commit: 'a'.repeat(40) });
  add('reject', 1, { cause: 'row:G1', commit: 'b'.repeat(40) });
  add('row_decision', null, { record: { decision: 'decline', source: source('row:G1') } }, 'person');
  add('reject', 1, { cause: 'row:G1', commit: 'c'.repeat(40) });
  add('reject', 2, { cause: 'row:G1', commit: 'c'.repeat(40) });
  add('row_decision', null, { record: { decision: 'decline', source: source('row:G1') } }, 'person');
  add('fact', 1, { cause: 'doctrine:C3', neverAgain: true }, 'person');
  add('fact', 2, { cause: 'doctrine:C4', neverAgain: true }, 'tests-1');
  add('reject', 3, { cause: 'refusal:MERGE_CONFLICT' });
  add('reject', 4, { cause: 'refusal:MERGE_CONFLICT' });
  add('reopen', 3, { landingFailure: { tests: [{ file: 'test/one.js', name: 'fails' }, { file: 'test/one.js', name: 'fails' }] } });
  add('reject', 4, { cause: 'test:test/one.js::fails' });
  add('row_decision', null, { record: { decision: 'decline', source: source('test:test/one.js::fails') } }, 'tests-1');
  add('row_decision', null, { record: { decision: 'decline', source: 'ordinary prose' } }, 'person');
  for (const engine of [HEALTH_SENTINEL_ENGINE - 1, HEALTH_SENTINEL_ENGINE, HEALTH_SENTINEL_ENGINE]) {
    add('health-failure', null, { cause: 'sentinel:health', engine }, 'sentinel');
  }
  add('health-failure', null, { cause: 'sentinel:forged', engine: HEALTH_SENTINEL_ENGINE }, 'tests-1');
  for (const engine of [BOARD_SENTINEL_ENGINE - 1, BOARD_SENTINEL_ENGINE, BOARD_SENTINEL_ENGINE]) {
    add('sentinel-failure', null, { cause: 'sentinel:board', engine }, 'sentinel');
  }
  for (const engine of [NATIVE_FLAKE_ENGINE - 1, NATIVE_FLAKE_ENGINE, NATIVE_FLAKE_ENGINE]) {
    add('flake-observation', null, { engine, observation: { classification: 'flake', file: 'test/flake.js', name: 'sometimes' } });
  }
  add('row_decision', null, { record: { decision: 'decline', source: source('sentinel:health') } }, 'person');
  add('health-failure', null, { cause: 'sentinel:health', engine: HEALTH_SENTINEL_ENGINE }, 'sentinel');
  add('health-failure', 5, { cause: 'sentinel:health', engine: HEALTH_SENTINEL_ENGINE }, 'sentinel');
  add('reject', 6, { causes: ['row:G2', 'conflict:src/hot.js', 'row:G2'], commit: 'a'.repeat(40) });
  add('reopen', 7, { causes: ['row:G2', 'conflict:src/hot.js'], commit: 'b'.repeat(40) });
  add('row_decision', null, { record: { decision: 'decline', source: automaticSource('row:G2') } }, 'person');
  add('reject', 7, { cause: 'row:G2', commit: 'c'.repeat(40) });
  add('reject', 8, { cause: 'row:G2', commit: 'd'.repeat(40) });
  return rows;
}

test('rigor.counter.compact-equals-legacy: compact Rigor causes equal the unchanged legacy oracle after every prefix [D1,N19,H16]', () => {
  const events = history(), shards = new Map();
  for (let n = 0; n < events.length; n += 1) {
    const event = events[n];
    for (const key of rigorCounterKeys(event, 'person')) shards.set(key, advanceRigorCounter(shards.get(key), key, event, 'person'));
    const actual = sortRigorCounters([...shards.values()].filter(rigorCounterEligible).map(rigorCounterResult));
    const expected = undraftedRigor(events.slice(0, n + 1), { spec: [], practice: [] }, { person: 'person' });
    assert.deepEqual(actual, expected, `history prefix ${n + 1}: ${event.event_kind}`);
    if (n === 2) assert.deepEqual(actual.find(cause => cause.key === 'row:G1').items[0].commits, ['a'.repeat(40), 'b'.repeat(40)]);
    if (n === 4) assert.ok(!actual.some(cause => cause.key === 'row:G1'), 'a new commit on an old item does not override the person');
    if (n === 5) assert.ok(actual.some(cause => cause.key === 'row:G1'), 'a genuinely new item revives the declined cause');
  }
  const final = sortRigorCounters([...shards.values()].filter(rigorCounterEligible).map(rigorCounterResult));
  assert.ok(final.some(cause => cause.key === 'doctrine:C3' && cause.neverAgain && cause.occurrences === 0));
  assert.ok(!final.some(cause => ['doctrine:C4', 'refusal:MERGE_CONFLICT', 'sentinel:forged', 'conflict:src/hot.js'].includes(cause.key)));
  assert.equal(final.find(cause => cause.key === 'sentinel:health').occurrences, 4);
  assert.equal(final.find(cause => cause.key === 'test:test/flake.js::sometimes').occurrences, 2);
});
