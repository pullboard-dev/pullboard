/** @pullboard-test-input source-cell apps/cli */
/** pullboard doctor names a project whose test script and affectedTests command disagree [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../fixtures/api.js';
import { runCliInProcess } from '../../../fixtures/process.js';

test('cli.io-commands-doctor-affected-runner.mismatch-listed: clause 3: doctor in a project with a jest test script and affectedTests node --test prints AFFECTED_RUNNER_MISMATCH with its next step [C7]', async t => {
  const box = apiHttpFixture(t);
  writeFileSync(join(box.root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'jest' } }));
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), affectedTests: 'node --test' }));
  const ran = await runCliInProcess(['doctor'], { cwd: box.root, env: box.env });
  const out = ran.stdout + ran.stderr;
  assert.match(out, /AFFECTED_RUNNER_MISMATCH/u, out);
  assert.match(out, /pullboard settings affectedTests/u, out);
});
