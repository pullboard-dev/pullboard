/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 175_000 }, async t => {
  const T0 = Date.now(), L = l => process.stderr.write(`PP ${l} ${Date.now() - T0}\n`);
  const box = await mainAuditFixture(t, { landingShards: 1 }); L('fixture');
  await box.runWorker(); L('worker1 noFF');
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  {const w=box.startWorker();w.child.stderr.on('data',b=>{for(const l of String(b).split('\n'))if(l.startsWith('TT'))L(l);});await w.finish();} L('worker2 audit');
});
