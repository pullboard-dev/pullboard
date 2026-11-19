/** With state.milestoneDelta on, the page merges a one-milestone delta and derives the forecast a full state carries; off, it applies the delta as today [C7,#9849]. */
/** @pullboard-world-pin runs the page script's embedded delta merge against plain state objects; the page itself needs a browser. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStateDelta } from '../../../../../packages/api/index.js';
import { milestoneForecast } from '../../../../../packages/roadmap/index.js';
import { pageScriptPart3 } from '../../../src/io/page/boards.js';
import { deriveMilestoneForecasts } from '../../../src/logic/page/milestone-merge.js';

/** The merge the page runs after a delta, cut from the script the page serves with the setting on or off. */
function pageMerge(on) {
  const script = pageScriptPart3({ applyStateDelta, deriveMilestoneForecasts, milestoneForecast: on ? milestoneForecast : null, costPrices: {}, costTabScript: () => '', expandItemSummaries() {}, privateCost: false });
  const start = script.indexOf('const applyStateDelta =');
  const end = script.indexOf('// Expand the opt-in wire dictionary');
  assert.ok(start >= 0 && end > start, 'the page embeds its delta merge');
  const read = script.slice(script.indexOf('const applied = applyStateDelta'), script.indexOf('\n', script.indexOf('const state = MILESTONE_DELTA')));
  const merge = new Function(`${script.slice(start, end)}\nreturn (base, delta) => { ${read.replace('base.state', 'base').replace('reply.delta', 'delta')}; return state; };`)();
  return merge;
}

/** A milestone with `left` items to go, a pace, and the forecast that pace gives it. */
function milestone(id, left, pace) {
  return { id, name: `M${id}`, shipped: false, summary: { total: left + 2, left, landed: 2, pace, ...milestoneForecast(left, pace, false) } };
}

const PACE = { last2h: 2, last6h: 6, last24h: 20 };
const MOVED = { last2h: 4, last6h: 12, last24h: 30 };
const base = () => ({ sequence: 1, milestones: Array.from({ length: 50 }, (_, n) => milestone(`m${n}`, n + 3, PACE)) });

test('view.x-io-page-milestone-merge.clause-1-with-state-milestonedelta-on-a: clause 1: with state.milestoneDelta on, a delta of one milestone leaves the other 49 unchanged [C7,#9849]', () => {
  const state = base();
  const changed = milestone('m7', 2, PACE);
  const merged = pageMerge(true)(state, { replace: { sequence: 2 }, merge: { milestones: { key: 'id', set: [changed] } } });
  assert.equal(merged.milestones.length, 50);
  assert.deepEqual(merged.milestones[7], changed);
  assert.deepEqual(merged.milestones.filter((_, n) => n !== 7), state.milestones.filter((_, n) => n !== 7));
});

test('view.x-io-page-milestone-merge.clause-2-a-moved-pace-alone-gives: clause 2: a moved pace alone gives every milestone the forecast a full state would [C7,#9849]', () => {
  const state = base();
  const merged = pageMerge(true)(state, { replace: { sequence: 2 }, merge: {}, milestonePace: MOVED });
  const full = state.milestones.map((entry) => milestone(entry.id, entry.summary.left, MOVED));
  assert.deepEqual(merged.milestones, full);
  assert.notDeepEqual(merged.milestones[0].summary.estimate, state.milestones[0].summary.estimate, 'the forecast really moved with the pace');
});

test('view.x-io-page-milestone-merge.clause-3-with-the-setting-off-the: clause 3: with the setting off the delta is applied as sent and nothing is derived [C7,#9849]', () => {
  const state = base();
  const delta = { replace: { sequence: 2 }, merge: {}, milestonePace: MOVED };
  const merged = pageMerge(false)(state, delta);
  assert.deepEqual(merged, applyStateDelta(state, delta));
  assert.deepEqual(merged.milestones[0].summary.estimate, state.milestones[0].summary.estimate, 'the old forecast stays: the server sends a changed one itself');
});
