/** Intake takes --brief so a pull request files on the mid route; without it the refusal names --brief [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  fixtureJSON,
  intakeFixture,
} from '../../tests/fixtures/intake.js';

const BAR = ['--criterion', 'The contributed behavior works.', '--check', 'node --test test/contribution.test.js'];

test('intake --brief files a mid-route item [C7]', t => {
  const box = intakeFixture(t);
  const brief = 'Files: test/contribution.test.js\n\nTest: test/contribution.test.js asserts the outside change.';
  const filed = fixtureJSON(box, box.repo, 'intake', box.pull.html_url, ...BAR, '--brief', brief);
  const item = fixtureJSON(box, box.repo, 'show', String(filed.item?.item_id ?? filed.id));
  assert.equal(item.item_route, 'mid');
  assert.match(item.item_brief, /Files: test\/contribution\.test\.js/u);
});

test('intake without --brief refuses NO_BRIEF naming --brief [C7]', async t => {
  const box = intakeFixture(t);
  const result = await runCliInProcess(['intake', box.pull.html_url, '--criterion', 'The contributed behavior works.', '--check', 'npm test', '--route', 'mid', '--json'], { cwd: box.repo, env: box.env });
  assert.notEqual(result.code, 0);
  const error = JSON.parse(result.out || result.err).error;
  assert.equal(error.code, 'NO_BRIEF');
  assert.match(`${error.message ?? ''}${error.next ?? ''}`, /--brief/u);
});
