/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 175_000 }, async t => {
  const box = await mainAuditFixture(t, { landingShards: 1 });
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  const sampler = runFixtureChildAsync('sh', ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do sleep 8; echo "== $i"; ps -axo etime=,command= | grep "pullboard main audit" | grep -v grep | cut -c1-260; done'], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 150_000 });
  const w = box.startWorker();
  await Promise.race([w.closed, sampler]);
  const r = await sampler;
  console.log('LAP SAMPLES', JSON.stringify(String(r.stdout)));
});
