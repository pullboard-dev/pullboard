/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 175_000 }, async t => {
  const s = Date.now();
  const box = await mainAuditFixture(t, { landingShards: 1 });
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  const w = Date.now(); await box.runWorker();
  console.log('LAP fixture', w - s, 'worker', Date.now() - w);
  const dir = join(box.directory, box.key);
  console.log('LAP PROFILE', readFileSync(join(dir, 'profile.json'), 'utf8').slice(0, 2500));
  console.log('LAP GATELOG', JSON.stringify(readFileSync(join(dir, 'gate.log'), 'utf8').split('\n').filter(l => /run-tests|phases|wall|admission|slot|shard|queue/i.test(l)).join('\n').slice(0, 2500)));
  console.log('LAP JOB', JSON.stringify(JSON.parse(readFileSync(join(box.directory, box.key + '.json'), 'utf8')).runSeconds));
});
