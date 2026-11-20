/** The flow tune fixes map names the one setting each window stage answers, and the last change is read back from the events [C7,#1099]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastTuneChange } from '../../../../index.js';
import { tuneFixes } from '../../../../index.js';
import { tuneRecord } from '../../../../index.js';

const definitions = {
  wipPerReviewer: { min: 1.5, max: 3 },
  landingBatchSize: { min: 1, max: 8 },
  takeoverMinutes: { min: 15, max: 60 },
};
const settings = { wipPerReviewer: 2, landingBatchSize: 4, takeoverMinutes: 30 };

test('stats.flow-tune-fixes.maps-each-window-stage: clause 1: tuneFixes maps build and review to a seat call, reviewWait, mergeWait and sendBackIdle to one setting each, and omits a setting whose value is not a number [C7,#1099]', () => {
  const fixes = tuneFixes(settings, definitions);
  assert.deepEqual(fixes.build, { needs: 'seat' });
  assert.deepEqual(fixes.review, { needs: 'seat' });
  assert.deepEqual(fixes.reviewWait, { needs: 'setting', key: 'wipPerReviewer', value: 2, min: 1.5, max: 3, step: 0.25 });
  assert.deepEqual(fixes.mergeWait, { needs: 'setting', key: 'landingBatchSize', value: 4, min: 1, max: 8, step: 1 });
  assert.deepEqual(fixes.sendBackIdle, { needs: 'setting', key: 'takeoverMinutes', value: 30, min: 15, max: 60, step: -5 });
  const partial = tuneFixes({ ...settings, landingBatchSize: 'off', takeoverMinutes: null }, definitions);
  assert.equal('mergeWait' in partial, false);
  assert.equal('sendBackIdle' in partial, false);
  assert.equal(partial.reviewWait.value, 2);
});

test('stats.flow-tune-fixes.last-change-round-trips: clause 2: tuneRecord writes the reason and numeric window, and lastTuneChange reads the newest flow tune line_setting event back for revertTuning [C7,#1099]', () => {
  const choice = { kind: 'setting', stage: 'reviewWait', key: 'wipPerReviewer', from: 2, to: 2.25 };
  const record = tuneRecord(choice, { windowMinutes: 240, overTargetMinutes: 90, landed: 6 });
  assert.equal(record.reason, 'flow tune: reviewWait over target; wipPerReviewer 2 to 2.25');
  assert.deepEqual(record.window, { windowMinutes: 240, overTargetMinutes: 90, landed: 6, from: 2, to: 2.25 });
  const event = (kind, detail) => ({ event_kind: kind, event_detail: JSON.stringify(detail) });
  const events = [
    event('line_setting', { key: 'wipPerReviewer', value: 2.25, ...record }),
    event('claim', {}),
    event('line_setting', { key: 'agingMinutes', value: 30, reason: 'manual change', window: { windowMinutes: 60 } }),
  ];
  assert.deepEqual(lastTuneChange(events), { stage: 'reviewWait', key: 'wipPerReviewer', from: 2, to: 2.25, before: { overTargetMinutes: 90, landed: 6 } }, 'a later event with another reason does not hide it');
  assert.equal(lastTuneChange([events[1], events[2]]), null);
  assert.equal(lastTuneChange([]), null);
});

test('stats.flow-tune-fixes.exported-through-the-front-door: clause 3: tuneFixes, tuneRecord and lastTuneChange are functions exported from the stats front door [C7,#1099]', () => {
  for (const fn of [tuneFixes, tuneRecord, lastTuneChange]) assert.equal(typeof fn, 'function');
});
