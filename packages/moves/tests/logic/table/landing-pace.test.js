/** Landing select reads the item's frozen pace: steady and strict land verified work, sprint lands submitted work, and a sprint merge of submitted work records it landed [M2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemPace } from '../../../index.js';
import { landingEngine } from '../../../index.js';
import { runTable } from '../../../index.js';
import { selectBatch } from '../../../index.js';

/** The limits, fault codes and hold prefix the landing cell would hand in, written here so the test restates rather than imports them. */
const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY'], repeatHold: 'landing-repeat-test:' });
const ID = 70;
/** An item's frozen bar as the claim freeze writes it: sprint and strict are recorded, steady is recorded as nothing. */
const frozenAt = (pace) => JSON.stringify({ criterion: '1. lands [test]', ...(pace === 'steady' ? {} : { pace }) });

/** A submitted item with no landing receipt, carrying the pace its frozen bar reads as, with nothing else in its way. */
function selectSnapshot(pace, status = 'submitted') {
  const item = { id: ID, status, mergedCommit: null, holdReason: null, commit: 'c1', checked: 'c1', after: [], pace: itemPace({ item_frozen: frozenAt(pace) }), digest: 'd1', claimDigest: 'd1' };
  // Bar unchanged since claim and a green screen on base b1, so the sprint Always and screened rows pass [#8865].
  const screen = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b1', checks: { secrets: 'green', hooks: 'green' } };
  return { now: '2026-11-16T10:00:00.000Z', base: 'b1', item, items: { [ID]: item }, batches: [], waivers: [], unverified: [], collisionFree: false, io: { screen },
    picked: { count: 0, touched: {} }, pace: item.pace };
}
const select = (s) => runTable(ENGINE.tables.select, ENGINE.rules, structuredClone(s), { name: 'select', id: ID });
const merge = (pace, status, forced) => runTable(ENGINE.tables.merged, ENGINE.rules, { item: { id: ID, status, mergedCommit: null }, pace },
  { name: 'merged', id: ID, actor: 'coordinator', commit: 'f'.repeat(40), ...(forced ? { forced } : {}) });

test('clause 2: a submitted item frozen at pace sprint, with no landing receipt, passes landing-select [M2]', () => {
  const s = selectSnapshot('sprint');
  assert.equal(s.item.pace, 'sprint', 'the frozen bar reads as sprint');
  const out = select(s);
  assert.equal(out.refused, undefined);
  assert.deepEqual([out.via, out.events], [['ready'], [{ kind: 'candidate', item: ID, detail: { id: ID, commit: 'c1' } }]]);
  assert.deepEqual(selectBatch(ENGINE, { ...s, pace: undefined }, 4).ready.map(entry => entry.id), [ID], 'the selection walk offers it under its own pace');
  assert.equal(select({ ...s, item: { ...s.item, mergedCommit: 'm1' } }).refused.code, 'NOT_PENDING', 'a landed sprint item is not pending');
  assert.equal(select({ ...s, item: { ...s.item, status: 'claimed' } }).refused.row, 'pending-submitted', 'unsubmitted work is not pending under sprint');
});

test('clause 3: the same item frozen at pace steady is refused with NOT_PENDING [M2]', () => {
  const s = selectSnapshot('steady');
  assert.equal(s.item.pace, 'steady', 'a bar frozen with no pace reads as steady');
  const out = select(s);
  assert.deepEqual([out.refused?.code, out.refused?.row, out.refused?.message], ['NOT_PENDING', 'pending', `#${ID} is submitted`]);
  assert.deepEqual(select({ ...s, pace: undefined }).refused, out.refused, 'a snapshot with no pace runs as steady');
  assert.deepEqual(selectBatch(ENGINE, { ...s, pace: undefined }, 4).ready, [], 'the selection walk does not offer it');
  assert.equal(select(selectSnapshot('strict')).refused.code, 'NOT_PENDING', 'strict lands verified work only');
  assert.deepEqual(select(selectSnapshot('steady', 'verified')).via, ['ready'], 'verified work still lands under steady');
});

test('#8863: an unforced sprint merge of submitted work records it landed, while steady still merges verified work only [M2]', () => {
  assert.deepEqual(merge('sprint', 'submitted').patch, { mergedCommit: 'f'.repeat(40) }, 'landed, not withdrawn');
  assert.deepEqual(merge('sprint', 'submitted').events.map(event => event.kind), ['merged']);
  assert.equal(merge('sprint', 'claimed').refused.row, 'submitted');
  assert.equal(merge('steady', 'submitted').refused.code, 'NOT_VERIFIED');
  assert.equal(merge(undefined, 'submitted').refused.row, 'verified');
  assert.deepEqual(merge('sprint', 'submitted', 'by hand').via, ['forced-unfinished'], 'a forced merge of unfinished work still withdraws it');
});
