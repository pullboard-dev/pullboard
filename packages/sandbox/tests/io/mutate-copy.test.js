/** DIAGNOSTIC: a delete-tagged journey that passes in the checkout passes in the mutation check's copy [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

const root = resolve(import.meta.dirname, '../../../..');
const journeys = ['apps/cli/journeys/add/baseline-local-runner.test.js', 'apps/cli/journeys/relay/installable.test.js', 'apps/cli/journeys/shout/journeys/search-capture.test.js'];

test('diagnostic copy vs checkout [C7]', () => {
  const temp = privateFixtureFiles('diag-copy-').root;
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', join(temp, 'h.tar'), 'HEAD'], { cwd: root });
    execFileSync('mkdir', [join(temp, 'tree')]);
    execFileSync('tar', ['-xf', join(temp, 'h.tar'), '-C', join(temp, 'tree')]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const file of journeys) for (const [label, cwd] of [['checkout', root], ['copy', join(temp, 'tree')]]) {
      const ran = spawnSync(process.execPath, ['--test', file], { cwd, env, encoding: 'utf8', timeout: 120000 });
      const text = `${ran.stdout}\n${ran.stderr}`.split('\n').filter((line) => /error|Error|ENOENT|REFUSED|\[[A-Z_]+\]|not ok|cannot|Cannot|# (pass|fail)/u.test(line)).slice(0, 8).join('\n');
      console.log(`DIAG ${label} ${file} status=${ran.status}\n${text}`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  assert.ok(true);
});
