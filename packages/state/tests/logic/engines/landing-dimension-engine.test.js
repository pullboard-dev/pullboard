/** The landing-dimension engine floor declares the pull_out, pulled and published event kinds; older boards refuse them [M1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANDING_DIMENSION_ENGINE } from '../../../light.js';
import { EVENT_KIND_ENGINES } from '../../../light.js';
import { eventKindEngine } from '../../../light.js';
import { eventKindRefusal } from '../../../light.js';
import { ENGINE_VERSION } from '../../../light.js';

test('state.logic-engines-landing-dimension-engine.clause-2-pull-out-pulled-and-published: clause 2: pull_out, pulled and published are declared at the landing-dimension engine [M1]', () => {
  for (const kind of ['pull_out', 'pulled', 'published']) {
    assert.equal(EVENT_KIND_ENGINES[kind], 'LANDING_DIMENSION_ENGINE');
    assert.equal(eventKindEngine(kind), LANDING_DIMENSION_ENGINE);
  }
  assert.ok(LANDING_DIMENSION_ENGINE <= ENGINE_VERSION, 'this code runs the floor it declares');
  for (const kind of ['merged', 'claim', 'withdraw']) assert.equal(eventKindEngine(kind), null, 'older kinds stay ungated');
});

test('state.logic-engines-landing-dimension-engine.clause-3-a-board-recorded-below-the: clause 3: a board recorded below the landing-dimension engine refuses a pull_out event and names the upgrade [M1]', () => {
  const older = { executionEngineVersion: LANDING_DIMENSION_ENGINE - 1 };
  const refusal = eventKindRefusal(older, 'pull_out');
  assert.equal(refusal.code, 'ENGINE_VERSION');
  assert.ok(refusal.message.includes(`requires engine ${LANDING_DIMENSION_ENGINE}`));
  assert.match(refusal.message, /upgrade Pullboard/u);
  assert.match(refusal.next, /upgrade Pullboard/u);
  assert.equal(eventKindRefusal(older, 'merged'), null, 'kinds every engine knows still write');
  assert.equal(eventKindRefusal({ executionEngineVersion: LANDING_DIMENSION_ENGINE }, 'pull_out'), null);
  assert.equal(eventKindRefusal({}, 'published'), null, 'a board at its origin runs every engine this code declares');
});
