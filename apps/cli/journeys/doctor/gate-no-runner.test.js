/** Doctor names a gate job nobody claimed for 2 minutes while no runner is live [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createJob } from '../../../../packages/jobs/index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

/** A scratch board with one gate job queued `ageMs` ago and unclaimed, and the machine's runners as given. */
function boxWithQueuedGate(helpers, ageMs, runners) {
  const box = helpers.privateCheckSubmission({ check: 'true' });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { runners });
  const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'));
  try { createJob(db, { id: 'gate:1:abc123', kind: 'gate', item: 1, now: Date.now() - ageMs }); } finally { db.close(); }
  return box;
}

test('doctor reports a gate job unclaimed over 2 minutes with no runner, and names the next step [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = boxWithQueuedGate(helpers, 5 * 60_000, []);
  const result = await runCliInProcess(['doctor'], { cwd: box.repo, env: box.env });
  assert.equal(result.code, 1, result.out + result.err);
  assert.match(result.out, /problem: gate job gate:1:abc123 waited over 2 min with no runner; repair: .*pullboard runner add/u);
});

test('a fresh job, or any registered runner, is not reported [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const fresh = boxWithQueuedGate(helpers, 10_000, []);
  assert.doesNotMatch((await runCliInProcess(['doctor'], { cwd: fresh.repo, env: fresh.env })).out, /with no runner/u);
  const served = boxWithQueuedGate(helpers, 5 * 60_000, [{ host: 'remote-a', slots: 1, browser: 0, node: process.execPath }]);
  assert.doesNotMatch((await runCliInProcess(['doctor'], { cwd: served.repo, env: served.env })).out, /with no runner/u);
});
