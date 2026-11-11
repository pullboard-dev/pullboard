/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import {
  HOST,
  fixture,
  scenario,
  landingGate,
  marks,
} from '../../../../tests/fixtures/init/shards.js';

test('a landing shard whose runner is killed mid-shard reruns locally [C7,V4]', { timeout: 170_000 }, async (t) => { // budget: one killed-runner landing on a fresh fixture.
  const box = fixture();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  // A runner killed mid-shard: its shard reruns locally with a named line and the gate stays green.
  scenario(box, 'drop', { dropOnce: true });
  const dropped = await landingGate(box, 'killed runner', 150_000);
  assert.equal(dropped.isGreen, true, dropped.output);
  const rerun = /^landing shard (\d\/3): runner fixture-host failed mid-shard; rerunning shard \1 locally$/mu.exec(dropped.output);
  assert.ok(rerun, `the rerun is named\n${dropped.output}`);
  const label = rerun[1].replace('/', '\\/');
  // Both attempts stay in the log and the profile: the failed runner attempt first, then the local rerun.
  assert.match(dropped.output, new RegExp(`^# landing shard ${label} attempt 1 on ${HOST}: infrastructure \\(runner transport lost\\) in \\d+ ms(?: \\(.*\\))?$`, 'mu'));
  assert.match(dropped.output, new RegExp(`^# landing shard ${label} attempt 2 on local: green in \\d+ ms(?: \\(.*\\))?$`, 'mu'));
  const attempts = dropped.profile.landingShards.shards.filter(shard => shard.shard === rerun[1]);
  assert.deepEqual(attempts.map(shard => [shard.attempt, shard.host, shard.status]), [[1, HOST, 'infrastructure'], [2, 'local', 'green']]);
  assert.ok(marks(box, '.runner.started').length > 0, 'the shard had started on the runner');
  assert.deepEqual(marks(box, '.finished').filter(name => name.endsWith('.local.finished')).length, 6, 'every file finished locally');
});
