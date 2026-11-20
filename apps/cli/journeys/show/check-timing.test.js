/** pullboard show prints the exclusive gate slot line for a timed item and none for an untimed one [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, LIGHT_BRIEF } = e2e;
const LINE = 'check timing: exclusive gate slot; the gate runs this check alone, so runner load does not decide it';

test('cli.journeys-show-check-timing.show-prints-the-exclusive-slot-line: clause 2: show prints the exclusive gate slot line after the check of a timed item, and no timing line for an untimed one [C7]', async () => {
  const box = project('true');
  const file = (title, ...extra) => assert.equal(fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', 'the original check passes',
    '--brief', LIGHT_BRIEF, '--check', 'test -d web', ...extra).code, 0);
  file('Timed bar', '--check-timing', 'true');
  file('Untimed bar');
  const timed = await box.runLocal(box.repo, 'show', '1');
  assert.equal(timed.code, 0, timed.err);
  const rows = timed.out.split('\n');
  const check = rows.findIndex(row => row.startsWith('check: '));
  assert.ok(check >= 0, 'the timed item prints its check');
  assert.ok(rows.slice(check + 1, check + 3).includes(LINE), 'the exclusive slot line follows the check and its digest');
  const untimed = await box.runLocal(box.repo, 'show', '2');
  assert.equal(untimed.code, 0, untimed.err);
  assert.ok(!untimed.out.includes('check timing:'), 'an untimed item prints no timing line');
});
