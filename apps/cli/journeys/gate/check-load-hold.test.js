/** With machine.holdHeavyAboveLoad on, pullboard check waits in the local resource line above the load ceiling and says so [C7,#10141]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { WAIT_LINE } from '../../tests/fixtures/check-hold.js';
import { checkUnderLoad } from '../../tests/fixtures/check-hold.js';
import { e2e } from '../../tests/fixtures/check-hold.js';
import { holdSettings } from '../../tests/fixtures/check-hold.js';
import { seat } from '../../tests/fixtures/check-hold.js';

after(e2e.cleanup);

test('cli.journeys-gate-check-load-hold.with-the-setting-on-and-the: clause 1: with the setting on and the load over machine.loadCeiling, pullboard check waits in the local resource line before it reports [C7,#10141]', { timeout: 180_000 }, async t => { // budget: hang ceiling for one real in-process check; not a speed target.
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: true });
  const answer = await checkUnderLoad(t, box);
  assert.match(answer.seen, new RegExp(`${WAIT_LINE}: load: holding heavy local work`, 'u'), answer.result.err);
  assert.equal(answer.result.code, 0, answer.result.out + answer.result.err);
  assert.match(answer.result.out, /check green in/u, 'once the load drops the held check runs and reports');
});
