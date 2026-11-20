/** pullboard health reports a runner id that claims from the same host and runner folder as another, and says nothing when there is none [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { claimJob } from '../../../../../packages/api/index.js';

/** Make the api module refuse a second runner id at one place, the way a doubled service does. */
function doubleRunner(t, host) {
  const board = cellBoard(t, join(privateFixtureFiles(`pullboard-health-${host}-`).root, 'board.sqlite')).db;
  const place = { host, root: '/runner/health' };
  const now = Date.now();
  claimJob(board, { runner: `${host}-a`, place, now });
  assert.throws(() => claimJob(board, { runner: `${host}-b`, place, now: now + 1000 }), error => error.code === 'RUNNER_DUPLICATE');
}

// The api keeps its refusals in module state for the whole process, so the case that needs none runs before any duplicate is made.
test('cli.io-commands-health.prints-runner-duplicate-line: clause 2: the health text prints a RUNNER_DUPLICATE problem line with the next step when there is a duplicate, and none when there is not [C7]', async t => {
  const box = apiHttpFixture(t);
  const none = await runCliInProcess(['health'], { cwd: box.root, env: box.env });
  assert.doesNotMatch(none.stdout, /RUNNER_DUPLICATE/u);
  doubleRunner(t, 'mini-line');
  const ran = await runCliInProcess(['health'], { cwd: box.root, env: box.env });
  assert.match(ran.stdout, /RUNNER_DUPLICATE: runners mini-line-a and mini-line-b claim from host mini-line, runner folder \/runner\/health; on the host, stop the older service/u);
});

test('cli.io-commands-health.reports-runner-duplicates: clause 1: run in health.js reports a runnerDuplicates entry naming the place and both runner ids when duplicateRunnerPlaces returns one [C7]', async t => {
  const box = apiHttpFixture(t);
  doubleRunner(t, 'mini-dup');
  const ran = await runCliInProcess(['health', '--json'], { cwd: box.root, env: box.env });
  const report = JSON.parse(ran.stdout);
  const found = (report.result?.runnerDuplicates ?? report.runnerDuplicates).find(row => row.host === 'mini-dup');
  assert.deepEqual(found, { host: 'mini-dup', root: '/runner/health', runners: ['mini-dup-a', 'mini-dup-b'] });
});
