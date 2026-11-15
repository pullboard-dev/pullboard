// pullboard: browser
/** DIAGNOSTIC: one delete-tagged journey in the checkout and in an exported copy [C7]. */
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

const root = resolve(import.meta.dirname, '../../../..');
const file = 'apps/cli/journeys/relay/installable.test.js';

test('diagnostic copy vs checkout [C7]', () => {
  const temp = privateFixtureFiles('diag-copy-').root;
  try {
    execFileSync('git', ['archive', '--format=tar', '-o', join(temp, 'h.tar'), 'HEAD'], { cwd: root });
    execFileSync('mkdir', [join(temp, 'tree')]);
    execFileSync('tar', ['-xf', join(temp, 'h.tar'), '-C', join(temp, 'tree')]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const [label, cwd] of [['copy', join(temp, 'tree')], ['checkout', root]]) {
      const ran = spawnSync(process.execPath, ['--test', file], { cwd, env, encoding: 'utf8', timeout: 80000 });
      const text = `${ran.stdout}\n${ran.stderr}`.split('\n').filter((line) => /error|Error|ENOENT|REFUSED|\[[A-Z_]+\]|not ok|annot|# (pass|fail)/u.test(line)).slice(0, 10).map((line) => line.slice(0, 300)).join('\n');
      console.log(`DIAG ${label} ${file} status=${ran.status} signal=${ran.signal}\n${text}`);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
