/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 175_000 }, async t => {
  const box = await mainAuditFixture(t, { landingShards: 1 });
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  const a = Date.now(); const w = box.startWorker(); let e=''; w.child.stderr.on('data',b=>{e+=b;}); await w.finish(); console.log(e.split('\n').filter(l=>l.startsWith('TT')).join(' | ')); console.log('WORKER ms', Date.now() - a);
});
