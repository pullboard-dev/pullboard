/** Native audit coverage must survive a directory named file and preserve red outcomes [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mainAuditFixture } from '../../../tests/fixtures/main/audit/project.js';
import { readAuditJob } from '../../../tests/fixtures/main/audit/project.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';

test('audit retains native coverage and failures with a file directory [C7]', { timeout: 180_000 }, async t => {
  const box = await mainAuditFixture(t);
  runFixtureGit(['merge', '--ff-only', box.tip], { cwd: box.repo, env: box.env });
  await box.runWorker();
  const audit = readAuditJob(box.directory, box.key);
  const output = readFileSync(join(box.directory, box.key, 'gate.log'), 'utf8');
  assert.equal(audit.state, 'complete', output);
  assert.equal(audit.green, false, 'a real red test remains red');
  assert.equal(audit.cleanupVerified, true, 'owned processes were drained');
  const samples = output.split('\n').filter(line => line.startsWith('# pullboard-audit-coverage '))
    .map(line => JSON.parse(line.slice('# pullboard-audit-coverage '.length)));
  assert.ok(samples.length, 'the independent reporter retained native coverage');
  assert.ok(samples.some(sample => sample.summary.files.some(file => file.path.includes('/file/'))), 'coverage includes a real file directory');
  assert.match(output, /audit failure alpha/u, 'the original failing test remains visible');
});
