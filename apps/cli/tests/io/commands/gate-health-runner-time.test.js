/** pullboard gate-health reports runner minutes by purpose from the runner-time sidecar, and the unattributed share [C7,#8184]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { recordRunnerTime } from '../../../../../packages/resources/index.js';

test('clause 1: gate-health prints runner minutes by purpose read from the sidecar [C7]', async t => {
  const box = apiHttpFixture(t);
  const end = Date.now();
  recordRunnerTime(box.root, { startedAt: end - 120_000, endedAt: end, host: 'runner-a', item: '4000', kind: 'gate' });
  recordRunnerTime(box.root, { startedAt: end - 60_000, endedAt: end, host: 'runner-a', item: 'landing batch', kind: 'landing-smoke' });
  const ran = await runCliInProcess(['gate-health', '--since', '2h'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /runner time by purpose \(2 dispatches, 3\.0 minutes\):/u);
  assert.match(ran.stdout, /gate\s+1 dispatches\s+2\.0 min/u);
  assert.match(ran.stdout, /landing-smoke\s+1 dispatches\s+1\.0 min/u);
});

test('clause 2: gate-health reports the unattributed share of runner minutes, in its text and its JSON [C7]', async t => {
  const box = apiHttpFixture(t);
  const end = Date.now();
  recordRunnerTime(box.root, { startedAt: end - 180_000, endedAt: end, host: 'runner-a', item: '4000', kind: 'gate' });
  recordRunnerTime(box.root, { startedAt: end - 60_000, endedAt: end, host: 'runner-a', item: '', kind: '' });
  const text = await runCliInProcess(['gate-health', '--since', '2h'], { cwd: box.root, env: box.env });
  assert.match(text.stdout, /unattributed share of runner minutes: 25\.0%/u);
  const json = await runCliInProcess(['gate-health', '--since', '2h', '--json'], { cwd: box.root, env: box.env });
  const report = JSON.parse(json.stdout);
  const runnerTime = report.result?.runnerTime ?? report.runnerTime;
  assert.equal(runnerTime.unattributedShare, 0.25);
  assert.deepEqual(runnerTime.unattributed, { dispatches: 1, minutes: 1 });
});
