/** finishLanding runs the finish steps in one fixed order and returns one record per step [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishLanding } from '../../index.js';
import { LANDING_FINISH_STEPS } from '../../index.js';
import { Refused } from '../../../kernel/index.js';

/** Steps that log their name into `calls`. */
function recording(calls, names = LANDING_FINISH_STEPS) {
  return Object.fromEntries(names.map(name => [name, async () => { calls.push(name); return `${name} done`; }]));
}

test('landing.finish.finishlanding-calls-amendlandingengines-the-gate-the: clause 1: finishLanding calls amendLandingEngines, the gate, the main move, the main-red refresh, postLandSuite, the audits and the stale-verdict return in order [C7]', async () => {
  const calls = [];
  await finishLanding({}, { steps: recording(calls) });
  assert.deepEqual(calls, ['amendLandingEngines', 'gate', 'moveMain', 'refreshMainReds', 'refreshLandedMain', 'postLandSuite', 'activateMainAudits', 'returnStaleVerdicts']);
  assert.ok(calls.indexOf('gate') < calls.indexOf('moveMain') && calls.indexOf('moveMain') < calls.indexOf('refreshMainReds') && calls.indexOf('refreshMainReds') < calls.indexOf('postLandSuite'));
});

test('landing.finish.each-step-result-comes-back-in: clause 2: each step result comes back in one record, with earlier steps named [C7]', async () => {
  const calls = [];
  const names = LANDING_FINISH_STEPS.filter(name => name !== 'gate');
  const record = await finishLanding({}, { steps: recording(calls, names), earlier: ['gate'] });
  assert.equal(record.refused, null);
  assert.deepEqual(record.steps.map(step => step.name), [...LANDING_FINISH_STEPS]);
  assert.deepEqual(record.steps.find(step => step.name === 'gate'), { name: 'gate', status: 'earlier' });
  assert.equal(record.steps.find(step => step.name === 'moveMain').result, 'moveMain done');
  assert.ok(!calls.includes('gate'));
});

test('landing.finish.a-refusing-step-stops-the-sequence: clause 2: a refusing step stops the sequence and is named in the record and on the error [C7]', async () => {
  const calls = [];
  const steps = recording(calls);
  steps.moveMain = async () => { throw new Refused('LAND_MAIN_MOVED', 'main moved'); };
  await assert.rejects(finishLanding({}, { steps }), error => {
    assert.equal(error.code, 'LAND_MAIN_MOVED');
    assert.equal(error.finish.refused, 'moveMain');
    assert.deepEqual(error.finish.steps.map(step => step.status), ['ran', 'ran', 'refused']);
    return true;
  });
  assert.deepEqual(calls, ['amendLandingEngines', 'gate'], 'steps after the refusal never run');
});
