/** @pullboard-test-input source-tree */
import { test } from 'node:test';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';
test('probe [C7]', { timeout: 170_000 }, async t => {
  const s0 = Date.now(); const lap = n => console.log('LAP', Date.now() - s0, n);
  const box = await mainAuditFixture(t); lap('fixture');
  runFixtureChild('git', ['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  const audit = join(box.repo, 'apps/cli/src/io/landing/audit.js');
  const r = await runFixtureChildAsync(process.execPath, [audit, box.repo, crypto.randomUUID()], { cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000 });
  lap('worker status=' + r.status + ' signal=' + r.signal);
  console.log('LAP OUT', JSON.stringify(String(r.stdout).slice(-800)), JSON.stringify(String(r.stderr).slice(-1500)));
  console.log('LAP FILES', readdirSync(box.directory).join(','));
  console.log('LAP JOB', readFileSync(join(box.directory, box.key + '.json'), 'utf8').slice(0, 1500));
  console.log('LAP QUEUE', JSON.stringify(box.queue()));
});
