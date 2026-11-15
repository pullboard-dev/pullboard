/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 170_000 }, async t => {
  let s = Date.now(); const lap = n => { console.log('LAP', n, Date.now() - s); s = Date.now(); };
  const box = await mainAuditFixture(t); lap('fixture');
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  lap('ff');
  const r = runFixtureChild(process.execPath, ['apps/cli/src/io/run/tests.js'], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  lap('gate direct status=' + r.status);
  console.log('LAP OUT', JSON.stringify(String(r.stdout).slice(-1500)), JSON.stringify(String(r.stderr).slice(-1500)));
});
