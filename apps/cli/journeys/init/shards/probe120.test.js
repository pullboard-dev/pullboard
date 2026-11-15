/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 175_000 }, async t => {
  let s = Date.now(); const lap = n => { console.log('LAP', n, Date.now() - s); s = Date.now(); };
  const box = await mainAuditFixture(t); lap('fixture');
  await box.runWorker(); lap('worker no FF');
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  await box.runWorker(); lap('worker real audit A');
  await box.runWorker(); lap('worker repeat (no-op)');
  box.appendBatch(); lap('appendBatch');
  await box.runWorker(); lap('worker real audit B');
});
